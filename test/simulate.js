/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
const { providers, Contract, ContractFactory, Wallet } = require('ethers')
const { Interface, getCreate2Address } = require('ethers').utils

const OUTPACE = artifacts.require('OUTPACE')
const Identity = artifacts.require('Identity')
const IdentityFactory = artifacts.require('IdentityFactory')
const MockToken = artifacts.require('./mocks/Token')
const Sweeper = artifacts.require('Sweeper')
const Depositor = artifacts.require('Depositor')

const { getBytes32, sampleChannel } = require('./')
const { zeroFeeTx, ethSign, getWithdrawData } = require('./lib')
const { splitSig, Transaction, Withdraw } = require('../js')
const { getProxyDeployBytecode, getStorageSlotsFromArtifact } = require('../js/IdentityProxyDeploy')
const { solcModule } = require('../js/solc')

const web3Provider = new providers.Web3Provider(web3.currentProvider)

// generate random address
function getRandomAddresses(size) {
	const addresses = []
	for (let i = 0; i < size; i += 1) {
		const wallet = Wallet.createRandom()
		addresses.push(wallet.address)
	}
	return addresses
}

function getRandomArbitrary(min, max) {
	return Math.random() * (max - min) + min
}

function logIdentityExecuteGasInfo(numberOfEarners, gasUsed, proof) {
	console.log('---------------------------- Gas Information -----------------------------------')
	console.log(
		`Identity.execute() GasUsed: ${gasUsed}, numberOfEarners: ${numberOfEarners}, proofSize: ${
			proof.length
		} `
	)
	console.log('---------------------------------------------------------------------------------')
}

const gasLimit = 5000000

contract('Simulate Bulk Withdrawal', function(accounts) {
	const idInterface = new Interface(Identity._json.abi)
	const outpaceInterface = new Interface(OUTPACE._json.abi)

	// The Identity contract factory
	let identityFactory
	// A dummy token
	let token
	let outpace
	// An instance of the OUTPACE contract
	let outpaceAddr
	// an Identity contract that will be used as a base for all proxies
	let baseIdentityAddr
	// The Identity contract instance that will be used
	let id

	const validators = accounts.slice(0, 2)
	const earnerAddr = accounts[3]
	const userAcc = accounts[4]

	before(async function() {
		const signer = web3Provider.getSigner(earnerAddr)
		const tokenWeb3 = await MockToken.new()
		token = new Contract(tokenWeb3.address, MockToken._json.abi, signer)
		const outpaceWeb3 = await OUTPACE.deployed()
		outpaceAddr = outpaceWeb3.address
		outpace = new Contract(outpaceWeb3.address, OUTPACE._json.abi, signer)

		// This IdentityFactory is used to test counterfactual deployment
		const idFactoryWeb3 = await IdentityFactory.new({ from: earnerAddr })
		identityFactory = new Contract(idFactoryWeb3.address, IdentityFactory._json.abi, signer)

		// deploy an Identity
		const idWeb3 = await Identity.new([])
		baseIdentityAddr = idWeb3.address

		const bytecode = getProxyDeployBytecode(
			baseIdentityAddr,
			[[userAcc, 2]],
			getStorageSlotsFromArtifact(Identity),
			solcModule
		)
		const receipt = await (await identityFactory.deploy(bytecode, 0, { gasLimit })).wait()
		const deployedEv = receipt.events.find(x => x.event === 'LogDeployed')
		id = new Contract(deployedEv.args.addr, Identity._json.abi, signer)

		await token.setBalanceTo(id.address, 1000000000)

		// init nonce so that we don't count the overhead of 20k for the storage slot
		const tx = await zeroFeeTx(
			id.address,
			idInterface.functions.setAddrPrivilege.encode([
				'0x0000000000000000000000000000000000000000',
				1
			]),
			0,
			id,
			token
		)
		const sigs = splitSig(await ethSign(tx.hashHex(), userAcc))
		await (await id.execute([tx.toSolidityTuple()], [sigs], { gasLimit })).wait()
	})

	it('deposits', async function() {
		const signer = web3Provider.getSigner(earnerAddr)
		const sweeperWeb3 = await Sweeper.new()
		const sweeper = new Contract(sweeperWeb3.address, Sweeper._json.abi, signer)
		const depositorAddr = accounts[7]
		const channel = sampleChannel(validators[0], validators[1], validators[0], token.address, 69)
		const amount = 196969
		const factory = new ContractFactory(Depositor.abi, Depositor.bytecode)
		const initCode = factory.getDeployTransaction(outpace.address, channel, depositorAddr).data
		const depositAddr = getCreate2Address({
			from: sweeper.address,
			salt: getBytes32(0),
			initCode
		})
		// send tokens to the deposit addr and then sweep it
		await token.setBalanceTo(depositAddr, amount)
		const receipt = await (await sweeper.sweep(outpace.address, channel.toSolidityTuple(), [
			depositorAddr
		])).wait()
		console.log(await token.balanceOf(depositAddr), 'must be 0')
		console.log(receipt, 'must have deposit logs')
		console.log(receipt.gasUsed.toNumber(), 'gas used')
		// do it again
		await token.setBalanceTo(depositAddr, amount)
		const receipt2 = await (await sweeper.sweep(outpace.address, channel.toSolidityTuple(), [
			depositorAddr
		])).wait()
		console.log(receipt2.gasUsed.toNumber(), 'gas used')
	})

	it('open a channel, execute w/o identity: withdraw', async function() {
		const minimumChannelEarners = 10
		const maximumChannelEarners = 20
		const tokenAmnt = 500

		// Open a channel via the identity
		const channel = sampleChannel(validators[0], validators[1], validators[0], token.address, 100)
		await token.setBalanceTo(userAcc, tokenAmnt)

		const userSigner = web3Provider.getSigner(userAcc)
		await (await outpace.connect(userSigner).deposit(channel, userAcc, tokenAmnt)).wait()

		const numberOfEarners = Math.floor(
			getRandomArbitrary(minimumChannelEarners, maximumChannelEarners)
		)
		const amtPerAddress = Math.floor(tokenAmnt / numberOfEarners)
		const earnerAddresses = [...getRandomAddresses(numberOfEarners), earnerAddr]
		const [stateRoot, vsig1, vsig2, proof] = await getWithdrawData(
			channel,
			earnerAddr,
			earnerAddresses,
			amtPerAddress,
			outpaceAddr
		)

		const receipt = await (await outpace.withdraw([
			channel.toSolidityTuple(),
			amtPerAddress,
			stateRoot,
			vsig1,
			vsig2,
			proof
		])).wait()

		console.log('\n------- Single Withdrawal w/o identity - channelWithdraw() --------')
		console.log(`Gas used: ${receipt.gasUsed.toNumber()}`)
		console.log('-------------------------------------------------------\n')
	})

	it('open a channel, execute: withdraw', async function() {
		const minimumChannelEarners = 10
		const maximumChannelEarners = 20
		const rounds = 15

		let totalGasUsed = 0
		for (let channelNonce = 10; channelNonce < rounds; channelNonce += 1) {
			const tokenAmnt = 500

			const fee = 0

			// Open a channel via the identity
			const channel = sampleChannel(
				validators[0],
				validators[1],
				validators[0],
				token.address,
				channelNonce
			)

			const openChannelTxn = await zeroFeeTx(
				outpaceAddr,
				outpaceInterface.functions.deposit.encode([
					channel.toSolidityTuple(),
					id.address,
					tokenAmnt
				]),
				0,
				id,
				token
			)
			const openChannelSig = splitSig(await ethSign(openChannelTxn.hashHex(), userAcc))

			await (await id.execute([openChannelTxn.toSolidityTuple()], [openChannelSig], {
				gasLimit
			})).wait()

			const numberOfEarners = Math.floor(
				getRandomArbitrary(minimumChannelEarners, maximumChannelEarners)
			)
			const amtPerAddress = Math.floor(tokenAmnt / (numberOfEarners * rounds))

			const earnerAddresses = [...getRandomAddresses(numberOfEarners), id.address]
			const [stateRoot, vsig1, vsig2, proof] = await getWithdrawData(
				channel,
				id.address,
				earnerAddresses,
				amtPerAddress,
				outpaceAddr
			)

			const channelWithdrawTx = new Transaction({
				identityContract: id.address,
				nonce: (await id.nonce()).toNumber(),
				feeTokenAddr: token.address,
				feeAmount: fee,
				to: outpaceAddr,
				data: outpaceInterface.functions.withdraw.encode([
					[channel.toSolidityTuple(), amtPerAddress, stateRoot, vsig1, vsig2, proof]
				])
			})

			const withdrawSigs = splitSig(await ethSign(channelWithdrawTx.hashHex(), userAcc))
			const { gasUsed } = await (await id.execute(
				[channelWithdrawTx.toSolidityTuple()],
				[withdrawSigs],
				{ gasLimit }
			)).wait()

			totalGasUsed += gasUsed.toNumber()
			logIdentityExecuteGasInfo(earnerAddresses.length, gasUsed, proof)
		}

		console.log(
			'\n------- Single Channel Identity Withdrawal - new channel every round - Identity.execute() --------'
		)
		console.log(`Total gas used: ${totalGasUsed}`)
		console.log('---------------------------------------------------------------------\n')
	})

	it('open a channel, execute many withdrawals with identity - same channel', async function() {
		const minimumChannelEarners = 10
		const maximumChannelEarners = 20
		const rounds = 10

		const transactions = []
		const signatures = []

		const tokenAmnt = 500
		const fee = 0

		const channel = sampleChannel(validators[0], validators[1], validators[0], token.address, 999)
		await token.setBalanceTo(earnerAddr, tokenAmnt)
		await (await outpace.deposit(channel.toSolidityTuple(), earnerAddr, tokenAmnt)).wait()

		const currentNonce = (await id.nonce()).toNumber()

		for (let channelNonce = 0; channelNonce < rounds; channelNonce += 1) {
			const numberOfEarners = Math.floor(
				getRandomArbitrary(minimumChannelEarners, maximumChannelEarners)
			)
			// even though by doing that we get a bigger balance tree than the max deposit, it's not fatal cause we only withdraw from one
			const amtPerAddress = Math.floor((tokenAmnt / rounds) * channelNonce)

			const earnerAddresses = [...getRandomAddresses(numberOfEarners), id.address]
			const [stateRoot, vsig1, vsig2, proof] = await getWithdrawData(
				channel,
				id.address,
				earnerAddresses,
				amtPerAddress,
				outpaceAddr
			)

			const channelWithdrawTx = new Transaction({
				identityContract: id.address,
				nonce: currentNonce + channelNonce,
				feeTokenAddr: token.address,
				feeAmount: fee,
				to: outpaceAddr,
				data: outpaceInterface.functions.withdraw.encode([
					[channel.toSolidityTuple(), amtPerAddress, stateRoot, vsig1, vsig2, proof]
				])
			})

			const withdrawSigs = splitSig(await ethSign(channelWithdrawTx.hashHex(), userAcc))

			transactions.push(channelWithdrawTx.toSolidityTuple())
			signatures.push(withdrawSigs)
		}

		const withdrawReceipt = await (await id.execute(transactions, signatures, {
			gasLimit
		})).wait()

		console.log(
			`\n------- Withdrawal Multiple via identity (${
				transactions.length
			} transactions) - Identity.execute() --------`
		)
		console.log(`Total gas used: ${withdrawReceipt.gasUsed.toNumber()}`)
		console.log('-------------------------------------------------------\n')
	})

	it('open a channel, execute many withdrawals with bulk() - same channel', async function() {
		const minimumChannelEarners = 10
		const maximumChannelEarners = 20
		const rounds = 10

		const withdrawals = []

		const tokenAmnt = 500
		const fee = 0

		const channel = sampleChannel(validators[0], validators[1], validators[0], token.address, 9999)
		await token.setBalanceTo(earnerAddr, tokenAmnt)
		await (await outpace.deposit(channel.toSolidityTuple(), earnerAddr, tokenAmnt)).wait()

		const currentNonce = (await id.nonce()).toNumber()

		for (let channelNonce = 0; channelNonce < rounds; channelNonce += 1) {
			const numberOfEarners = Math.floor(
				getRandomArbitrary(minimumChannelEarners, maximumChannelEarners)
			)
			// even though by doing that we get a bigger balance tree than the max deposit, it's not fatal cause we only withdraw from one
			const amtPerAddress = Math.floor((tokenAmnt / rounds) * channelNonce)

			const earnerAddresses = [...getRandomAddresses(numberOfEarners), id.address]
			const [stateRoot, vsig1, vsig2, proof] = await getWithdrawData(
				channel,
				id.address,
				earnerAddresses,
				amtPerAddress,
				outpaceAddr
			)
			const withdraw = new Withdraw({
				channel,
				balanceTreeAmount: amtPerAddress,
				stateRoot,
				sigLeader: vsig1,
				sigFollower: vsig2,
				proof
			})
			withdrawals.push(withdraw.toSolidityTuple())
		}

		const channelWithdrawTx = new Transaction({
			identityContract: id.address,
			nonce: currentNonce,
			feeTokenAddr: token.address,
			feeAmount: fee,
			to: outpaceAddr,
			data: outpaceInterface.functions.bulkWithdraw.encode([id.address, id.address, withdrawals])
		})
		const withdrawSig = splitSig(await ethSign(channelWithdrawTx.hashHex(), userAcc))

		const withdrawReceipt = await (await id.execute(
			[channelWithdrawTx.toSolidityTuple()],
			[withdrawSig],
			{
				gasLimit
			}
		)).wait()

		console.log('\n------- Withdrawal Multiple via bulk --------')
		console.log(`Total gas used: ${withdrawReceipt.gasUsed.toNumber()}`)
		console.log('-------------------------------------------------------\n')
	})
})
