/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
const { providers, Contract, Wallet } = require('ethers')
const { Interface, hexlify } = require('ethers').utils

const OUTPACE = artifacts.require('OUTPACE')
const Identity = artifacts.require('Identity')
const IdentityFactory = artifacts.require('IdentityFactory')
const MockToken = artifacts.require('./mocks/Token')

const { zeroFeeTx, ethSign, getWithdrawData } = require('./lib')
const { splitSig, Transaction } = require('../js')
const { getProxyDeployBytecode, getStorageSlotsFromArtifact } = require('../js/IdentityProxyDeploy')
const { solcModule } = require('../js/solc')

const web3Provider = new providers.Web3Provider(web3.currentProvider)

const getBytes32 = n => {
	const nonce = Buffer.alloc(32)
	nonce.writeUInt32BE(n)
	return hexlify(nonce)
}

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
const DAY_SECONDS = 24 * 60 * 60

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
	const relayerAddr = accounts[3]
	const userAcc = accounts[4]

	before(async function() {
		const signer = web3Provider.getSigner(relayerAddr)
		const tokenWeb3 = await MockToken.new()
		token = new Contract(tokenWeb3.address, MockToken._json.abi, signer)
		const outpaceWeb3 = await OUTPACE.deployed()
		outpaceAddr = outpaceWeb3.address
		outpace = new Contract(outpaceWeb3.address, OUTPACE._json.abi, signer)

		// This IdentityFactory is used to test counterfactual deployment
		const idFactoryWeb3 = await IdentityFactory.new({ from: relayerAddr })
		identityFactory = new Contract(idFactoryWeb3.address, IdentityFactory._json.abi, signer)

		// deploy an Identity
		const idWeb3 = await Identity.new([], [])
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

	it('open a channel, execute w/o identity: withdraw', async function() {
		const minimumChannelEarners = 10
		const maximumChannelEarners = 20
		const tokenAmnt = 500

		// Open a channel via the identity
		const channel = [...validators, validators[0], token.address, getBytes32(100)]
		await token.setBalanceTo(userAcc, tokenAmnt)

		const userSigner = web3Provider.getSigner(userAcc)
		await (await outpace.connect(userSigner).deposit(channel, getBytes32(0), tokenAmnt)).wait()

		const numberOfEarners = Math.floor(
			getRandomArbitrary(minimumChannelEarners, maximumChannelEarners)
		)
		const amtPerAddress = Math.floor(tokenAmnt / numberOfEarners)
		const earnerAddresses = [...getRandomAddresses(numberOfEarners), relayerAddr]
		const [stateRoot, vsig1, vsig2, proof] = await getWithdrawData(
			channel,
			relayerAddr,
			earnerAddresses,
			amtPerAddress,
			outpaceAddr
		)

		const receipt = await (await outpace.withdraw([
			channel,
			amtPerAddress,
			stateRoot,
			vsig1,
			vsig2,
			proof,
		])).wait()

		console.log('\n------- Single Withdrawal w/o identity - channelWithdraw() --------')
		console.log(`Gas used: ${receipt.gasUsed.toNumber()}`)
		console.log('-------------------------------------------------------\n')
	})

	/*
	it('open a channel, execute: channelWithdraw', async function() {
		const minimumChannelEarners = 10
		const maximumChannelEarners = 20
		const rounds = 20

		let totalGasUsed = 0
		for (let channelNonce = 10; channelNonce < rounds; channelNonce += 1) {
			const tokenAmnt = 500

			const fee = 20

			// Open a channel via the identity
			const channel = [...validators, validators[0], token.address, getBytes32(channelNonce)]

			const openChannelTxn = await zeroFeeTx(
				id.address,
				idInterface.functions.channelOpen.encode([outpaceAddr, channel.toSolidityTuple()]),
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
				data: outpaceInterface.functions.channelWithdraw.encode([
					channel.toSolidityTuple(),
					stateRoot,
					[vsig1, vsig2],
					proof,
					amtPerAddress
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

		console.log('\n------- Single Channel Bulk Withdrawal  - Identity.execute() --------')
		console.log(`Total gas used: ${totalGasUsed}`)
		console.log('---------------------------------------------------------------------\n')
	})

	it('open a channel, execute bulk: channelWithdraw', async function() {
		const minimumChannelEarners = 10
		const maximumChannelEarners = 20
		const rounds = 10

		const transactions = []
		const signatures = []

		const tokenAmnt = 500
		const fee = 20

		const currentNonce = (await id.nonce()).toNumber()
		let nonceOffset = 0

		for (let channelNonce = 0; channelNonce < rounds; channelNonce += 1) {
			const channel = [...validators, validators[0], token.address, getBytes32(channelNonce)]

			const openChannelTxn = await zeroFeeTx(
				id.address,
				idInterface.functions.channelOpen.encode([outpaceAddr, channel.toSolidityTuple()]),
				nonceOffset,
				id,
				token
			)
			const openChannelSig = splitSig(await ethSign(openChannelTxn.hashHex(), userAcc))

			transactions.push(openChannelTxn.toSolidityTuple())
			signatures.push(openChannelSig)

			nonceOffset += 1

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
				nonce: currentNonce + nonceOffset,
				feeTokenAddr: token.address,
				feeAmount: fee,
				to: outpaceAddr,
				data: outpaceInterface.functions.channelWithdraw.encode([
					channel.toSolidityTuple(),
					stateRoot,
					[vsig1, vsig2],
					proof,
					amtPerAddress
				])
			})
			nonceOffset += 1

			const withdrawSigs = splitSig(await ethSign(channelWithdrawTx.hashHex(), userAcc))

			transactions.push(channelWithdrawTx.toSolidityTuple())
			signatures.push(withdrawSigs)
		}

		const withdrawReceipt = await (await id.execute(transactions, signatures, {
			gasLimit
		})).wait()

		console.log('\n------- Bulk Withdrawal - Identity.execute() --------')
		console.log(`Total gas used: ${withdrawReceipt.gasUsed.toNumber()}`)
		console.log('-------------------------------------------------------\n')
	})
	*/
})