const promisify = require('util').promisify
const { providers, Contract } = require('ethers')
const { Interface, randomBytes, getAddress } = require('ethers').utils
const { generateAddress2 } = require('ethereumjs-util')

const Outpace = artifacts.require('OUTPACE')
const Identity = artifacts.require('Identity')
const IdentityFactory = artifacts.require('IdentityFactory')
const MockToken = artifacts.require('./mocks/Token')

const { sampleChannel, expectEVMError } = require('./')
const { Withdraw } = require('../js')

const { Transaction, Channel, splitSig, MerkleTree } = require('../js')
const { getProxyDeployBytecode, getStorageSlotsFromArtifact } = require('../js/IdentityProxyDeploy')
const { solcModule } = require('../js/solc')

const ethSign = promisify(web3.eth.sign.bind(web3))

const web3Provider = new providers.Web3Provider(web3.currentProvider)

// WARNING
// READ THIS!
// gasLimit must be hardcoded cause ganache cannot estimate it properly
// that's cause of the call() that we do here; see https://github.com/AdExNetwork/adex-protocol-eth/issues/55
const gasLimit = 1000000

contract('Identity', function(accounts) {
	const idInterface = new Interface(Identity._json.abi)
	const coreInterface = new Interface(Outpace._json.abi)

	// The Identity contract factory
	let identityFactory
	// A dummy token
	let token
	// An instance of the OUTPACE contract
	let coreAddr
	// an Identity contract that will be used as a base for all proxies
	let baseIdentityAddr
	// The Identity contract instance that will be used
	let id

	const leader = accounts[1]
	const follower = accounts[2]
	const relayerAddr = accounts[3]
	const userAcc = accounts[4]
	const evilAcc = accounts[5]
	const anotherAccount = accounts[7]

	before(async function() {
		const signer = web3Provider.getSigner(relayerAddr)
		const tokenWeb3 = await MockToken.new()
		token = new Contract(tokenWeb3.address, MockToken._json.abi, signer)
		const coreWeb3 = await Outpace.deployed()
		coreAddr = coreWeb3.address

		// This IdentityFactory is used to test counterfactual deployment
		const idFactoryWeb3 = await IdentityFactory.new({ from: relayerAddr })
		identityFactory = new Contract(idFactoryWeb3.address, IdentityFactory._json.abi, signer)

		// deploy an Identity
		const idWeb3 = await Identity.new([])
		baseIdentityAddr = idWeb3.address

		const bytecode = getProxyDeployBytecode(
			baseIdentityAddr,
			[[userAcc, 1]],
			{
				...getStorageSlotsFromArtifact(Identity)
			},
			solcModule
		)
		const receipt = await (await identityFactory.deploy(bytecode, 0, { gasLimit })).wait()
		const deployedEv = receipt.events.find(x => x.event === 'LogDeployed')
		id = new Contract(deployedEv.args.addr, Identity._json.abi, signer)

		await token.setBalanceTo(id.address, 10000)
	})

	it('protected methods', async function() {
		await expectEVMError(id.setAddrPrivilege(userAcc, true, { gasLimit }), 'ONLY_IDENTITY_CAN_CALL')
	})

	it('deploy an Identity, counterfactually, and pay the fee', async function() {
		const feeAmnt = 250

		// Generating a proxy deploy transaction
		const [bytecode, salt, expectedAddr] = createAccount([[userAcc, 1]], {
			fee: {
				tokenAddr: token.address,
				recepient: relayerAddr,
				amount: feeAmnt,
				// Using this option is fine if the token.address is a token that reverts on failures
				unsafeERC20: true
			},
			...getStorageSlotsFromArtifact(Identity)
		})
		const deploy = identityFactory.deploy.bind(identityFactory, bytecode, salt, { gasLimit })
		// Without any tokens to pay for the fee, we should revert
		// if this is failing, then the contract is probably not trying to pay the fee
		await expectEVMError(deploy(), 'FAILED_DEPLOYING')

		// set the balance so that we can pay out the fee when deploying
		await token.setBalanceTo(expectedAddr, 10000)

		// deploy the contract, which should also pay out the fee
		const deployReceipt = await (await deploy()).wait()

		// The counterfactually generated expectedAddr matches
		const deployEv = deployReceipt.events.find(x => x.event === 'LogDeployed')
		assert.ok(deployEv, 'has deployedEv')
		assert.equal(expectedAddr, deployEv.args.addr, 'counterfactual contract address matches')

		// privilege level is OK
		const newIdentity = new Contract(
			expectedAddr,
			Identity._json.abi,
			web3Provider.getSigner(relayerAddr)
		)
		assert.equal(await newIdentity.privileges(userAcc), true, 'privilege level is OK')
		// it's usually around 155k
		assert.ok(deployReceipt.gasUsed.toNumber() < 200000, 'gas used for deploying is under 200k')
		// check if deploy fee is paid out
		assert.equal(await token.balanceOf(relayerAddr), feeAmnt, 'fee is paid out')
	})

	it('relay a tx: setAddrPrivilege', async function() {
		const initialBal = await token.balanceOf(relayerAddr)
		const initialNonce = (await id.nonce()).toNumber()
		const relayerTx = new Transaction({
			identityContract: id.address,
			nonce: initialNonce,
			feeTokenAddr: token.address,
			feeAmount: 25,
			to: id.address,
			data: idInterface.functions.setAddrPrivilege.encode([anotherAccount, true])
		})
		const hash = relayerTx.hashHex()

		// Non-authorized address does not work
		const invalidSig = splitSig(await ethSign(hash, evilAcc))
		await expectEVMError(
			id.execute([relayerTx.toSolidityTuple()], [invalidSig]),
			'INSUFFICIENT_PRIVILEGE_TRANSACTION'
		)

		// Do the execute() correctly, verify if it worked
		const relayerTxSig = splitSig(await ethSign(hash, userAcc))
		const receipt = await (await id.execute([relayerTx.toSolidityTuple()], [relayerTxSig], {
			gasLimit
		})).wait()

		assert.equal(await id.privileges(anotherAccount), true, 'privilege level changed')
		assert.equal(
			await token.balanceOf(relayerAddr),
			initialBal.toNumber() + relayerTx.feeAmount.toNumber(),
			'relayer has received the tx fee'
		)
		assert.ok(
			receipt.events.find(x => x.event === 'LogPrivilegeChanged'),
			'LogPrivilegeChanged event found'
		)
		assert.equal((await id.nonce()).toNumber(), initialNonce + 1, 'nonce has increased with 1')
		// console.log('relay cost', receipt.gasUsed.toString(10))

		// A nonce can only be used once
		await expectEVMError(id.execute([relayerTx.toSolidityTuple()], [relayerTxSig]), 'WRONG_NONCE')

		// Try to downgrade the privilege: should not be allowed
		const relayerDowngradeTx = await zeroFeeTx(
			id.address,
			idInterface.functions.setAddrPrivilege.encode([userAcc, false])
		)
		const newHash = relayerDowngradeTx.hashHex()
		const newSig = splitSig(await ethSign(newHash, userAcc))
		await expectEVMError(
			id.execute([relayerDowngradeTx.toSolidityTuple()], [newSig]),
			'PRIVILEGE_NOT_DOWNGRADED'
		)

		// Try to run a TX from an acc with insufficient privilege (unauthorized account)
		const relayerTxEvil = await zeroFeeTx(
			id.address,
			idInterface.functions.setAddrPrivilege.encode([evilAcc, true])
		)
		const hashEvil = relayerTxEvil.hashHex()
		const sigEvil = splitSig(await ethSign(hashEvil, evilAcc))
		await expectEVMError(
			id.execute([relayerTxEvil.toSolidityTuple()], [sigEvil]),
			'INSUFFICIENT_PRIVILEGE_TRANSACTION'
		)
	})

	// Relay two transactions
	// this could be quite useful in real applications, e.g. approve and call into a contract in one TX
	it('relay multiple transactions', async function() {
		const getTuples = txns => txns.map(tx => new Transaction(tx).toSolidityTuple())
		const getSigs = function(txns) {
			return Promise.all(
				txns.map(args => {
					const tx = new Transaction(args)
					const hash = tx.hashHex()
					return ethSign(hash, userAcc).then(sig => splitSig(sig))
				})
			)
		}

		const initialBal = await token.balanceOf(relayerAddr)
		const initialNonce = (await id.nonce()).toNumber()
		const txns = [100, 200].map((n, i) => ({
			identityContract: id.address,
			nonce: initialNonce + i,
			feeTokenAddr: token.address,
			feeAmount: 5,
			to: id.address,
			data: idInterface.functions.setAddrPrivilege.encode([userAcc, true])
		}))
		const totalFee = txns.map(x => x.feeAmount).reduce((a, b) => a + b, 0)

		// Cannot use an invalid identityContract
		const invalidTxns1 = [txns[0], { ...txns[1], identityContract: token.address }]
		await expectEVMError(
			id.execute(getTuples(invalidTxns1), await getSigs(invalidTxns1)),
			'TRANSACTION_NOT_FOR_CONTRACT'
		)

		// Cannot use a different fee token
		const invalidTxns2 = [txns[0], { ...txns[1], feeTokenAddr: accounts[8] }]
		await expectEVMError(
			id.execute(getTuples(invalidTxns2), await getSigs(invalidTxns2)),
			'EXECUTE_NEEDS_SINGLE_TOKEN'
		)

		const receipt = await (await id.execute(getTuples(txns), await getSigs(txns), {
			gasLimit
		})).wait()
		// 2 times LogPrivilegeChanged, 1 transfer (fee)
		assert.equal(receipt.events.length, 3, 'has the right events length')
		assert.equal(
			receipt.events.filter(x => x.event === 'LogPrivilegeChanged').length,
			2,
			'LogPrivilegeChanged happened twice'
		)
		assert.equal(
			await token.balanceOf(relayerAddr),
			initialBal.toNumber() + totalFee,
			'fee was paid out for all transactions'
		)
	})

	it('execute by sender', async function() {
		const relayerTx = await zeroFeeTx(
			id.address,
			idInterface.functions.setAddrPrivilege.encode([userAcc, true])
		)

		await expectEVMError(
			id.executeBySender([relayerTx.toSolidityTuple()]),
			'INSUFFICIENT_PRIVILEGE_SENDER'
		)

		const idWithUser = new Contract(id.address, Identity._json.abi, web3Provider.getSigner(userAcc))
		const receipt = await (await idWithUser.executeBySender([relayerTx.toSolidityTuple()], {
			gasLimit
		})).wait()
		assert.equal(receipt.events.length, 1, 'right number of events emitted')

		const initialNonce = parseInt(relayerTx.nonce, 10)
		assert.equal((await id.nonce()).toNumber(), initialNonce + 1, 'nonce has increased with 1')

		const invalidNonceTx = new Transaction({
			...relayerTx,
			nonce: initialNonce
		})
		await expectEVMError(
			idWithUser.executeBySender([invalidNonceTx.toSolidityTuple()]),
			'WRONG_NONCE'
		)
	})

	it('actions: channel deposit, withdraw', async function() {
		const tokenAmnt = 500

		const fee = 20

		// Deposit on a channel via the identity
		const channel = sampleChannel(leader, follower, leader, token.address, 0)
		const txns = [
			// we use the deposit on Outpace here
			await zeroFeeTx(
				coreAddr,
				coreInterface.functions.deposit.encode([channel.toSolidityTuple(), id.address, tokenAmnt])
			)
		]
		const sigs = await Promise.all(
			txns.map(async tx => splitSig(await ethSign(tx.hashHex(), userAcc)))
		)
		await (await id.execute(txns.map(x => x.toSolidityTuple()), sigs, { gasLimit })).wait()

		// getting this far, we should have a channel open; now let's withdraw from it
		// Prepare all the data needed for withdrawal
		const [stateRoot, vsig1, vsig2, proof] = await getWithdrawData(channel, id.address, tokenAmnt)
		const withdrawal = new Withdraw({
			channel,
			balanceTreeAmount: tokenAmnt,
			stateRoot,
			sigLeader: vsig1,
			sigFollower: vsig2,
			proof
		})

		const withdrawTxn = [
			new Transaction({
				identityContract: id.address,
				nonce: (await id.nonce()).toNumber(),
				feeTokenAddr: token.address,
				feeAmount: fee,
				to: coreAddr,
				data: coreInterface.functions.withdraw.encode([withdrawal.toSolidityTuple()])
			})
		]
		const withdrawTxnSigs = await Promise.all(
			withdrawTxn.map(async tx => splitSig(await ethSign(tx.hashHex(), userAcc)))
		)

		const [initialIdentityBal, initialRelayerBal] = await Promise.all([
			token.balanceOf(id.address),
			token.balanceOf(relayerAddr)
		])

		const withdrawTxnsTuple = withdrawTxn.map(x => x.toSolidityTuple())
		const executeWithdrawTxn = id.execute.bind(id, withdrawTxnsTuple, withdrawTxnSigs, {
			gasLimit
		})
		const executeWithdrawnReceipt = await (await executeWithdrawTxn()).wait()
		const balAfter = (await token.balanceOf(id.address)).toNumber()
		assert.equal(
			balAfter - initialIdentityBal.toNumber(),
			tokenAmnt - fee,
			'token amount withdrawn is right'
		)
		// withdraw (channel to Identity), LogChannelWithdraw, Transfer (fee)
		assert.equal(executeWithdrawnReceipt.events.length, 3, 'right number of events')

		assert.equal(
			await token.balanceOf(relayerAddr),
			initialRelayerBal.toNumber() + fee,
			'relayer has received the fee'
		)
	})

	it('IdentityFactory: deployAndExecute', async function() {
		const tokenAmnt = 1000
		const feeAmount = 120
		await token.setBalanceTo(userAcc, tokenAmnt)

		const [initialFactoryBal, initialRelayerBal] = await Promise.all([
			await token.balanceOf(identityFactory.address),
			await token.balanceOf(relayerAddr)
		])

		const channel = sampleChannel(leader, follower, userAcc, token.address, 122)

		const core = new Contract(coreAddr, Outpace._json.abi, web3Provider.getSigner(userAcc))
		await (await core.deposit(channel.toSolidityTuple(), userAcc, tokenAmnt)).wait()

		const [bytecode, salt, expectedAddr] = createAccount([[userAcc, 2]], {
			...getStorageSlotsFromArtifact(Identity)
		})
		assert.equal(
			(await token.balanceOf(expectedAddr)).toNumber(),
			0,
			'the balance of the new Identity is 0'
		)

		// Prepare all the data needed for withdrawal
		const [stateRoot, vsig1, vsig2, proof] = await getWithdrawData(channel, expectedAddr, tokenAmnt)

		const withdrawal = new Withdraw({
			channel,
			balanceTreeAmount: tokenAmnt,
			stateRoot,
			sigLeader: vsig1,
			sigFollower: vsig2,
			proof
		})

		// Make the tx that will call the rotuines
		const tx1 = new Transaction({
			identityContract: expectedAddr,
			nonce: 0,
			feeTokenAddr: token.address,
			feeAmount,
			to: coreAddr,
			data: coreInterface.functions.withdraw.encode([withdrawal.toSolidityTuple()])
		})

		const sig = splitSig(await ethSign(tx1.hashHex(), userAcc))

		const receipt = await (await identityFactory.deployAndExecute(
			bytecode,
			salt,
			[tx1.toSolidityTuple()],
			[sig],
			{
				gasLimit
			}
		)).wait()
		// LogChannelWithdraw, Transfer (withdraw), Transfer (tx fee), LogDeployed
		assert.equal(receipt.events.length, 4, 'proper events length')
		assert.equal(
			(await token.balanceOf(expectedAddr)).toNumber(),
			tokenAmnt - feeAmount,
			'Identity balance is correct'
		)
		assert.equal(
			(await token.balanceOf(identityFactory.address)).toNumber(),
			initialFactoryBal.toNumber() + feeAmount,
			'IdentityFactory balance is correct'
		)

		// Only relayer allowed to withdraw fee
		const identityFactoryEvil = new Contract(
			identityFactory.address,
			IdentityFactory._json.abi,
			web3Provider.getSigner(evilAcc)
		)
		await expectEVMError(
			identityFactoryEvil.withdraw(token.address, evilAcc, feeAmount, { gasLimit }),
			'ONLY_CREATOR'
		)

		// Relayer can withdraw the fee
		await (await identityFactory.withdraw(token.address, relayerAddr, feeAmount, {
			gasLimit
		})).wait()
		assert.equal(
			await token.balanceOf(relayerAddr),
			initialRelayerBal.toNumber() + feeAmount,
			'relayer balance is correct'
		)
	})

	// This is a "super-counterfactual" test: we will create an account, this account will earn from a channel,
	// and THEN we will, at once, create the contract, sweep the channel and allow the account to withdraw their funds
	it('IdentityFactory: deployAndExecute: create a new account after it has already earned from channels, withdraw via routines', async function() {
		const tokenAmnt = 500
		await token.setBalanceTo(userAcc, tokenAmnt * 3)

		const txFeeAmount = 100

		const [initialRelayerBal, initialFactoryBal] = await Promise.all([
			token.balanceOf(relayerAddr),
			token.balanceOf(identityFactory.address)
		])

		const maxToWithdraw = tokenAmnt - txFeeAmount
		const accountToWithdrawTo = accounts[9]

		// Create a new channel
		const channel = sampleChannel(leader, follower, userAcc, token.address, 122)

		const core = new Contract(coreAddr, Outpace._json.abi, web3Provider.getSigner(userAcc))
		await (await core.deposit(channel.toSolidityTuple(), userAcc, tokenAmnt)).wait()

		// Create a new account
		const [bytecode, salt, expectedAddr] = createAccount([[userAcc, 1]], {
			...getStorageSlotsFromArtifact(Identity)
		})

		// Prepare all the data needed for withdrawal
		const [stateRoot, vsig1, vsig2, proof] = await getWithdrawData(channel, expectedAddr, tokenAmnt)
		const withdrawal = new Withdraw({
			channel,
			balanceTreeAmount: tokenAmnt,
			stateRoot,
			sigLeader: vsig1,
			sigFollower: vsig2,
			proof
		})

		// Make the tx that will call the rotuines
		const withdrawTx = new Transaction({
			identityContract: expectedAddr,
			nonce: 0,
			feeTokenAddr: token.address,
			feeAmount: 0,
			to: coreAddr,
			data: coreInterface.functions.withdraw.encode([withdrawal.toSolidityTuple()])
		})

		// Now the regular tx to withdraw our funds out of our Identity
		const tokenInterface = new Interface(MockToken._json.abi)
		const txToWithdraw = new Transaction({
			identityContract: expectedAddr,
			nonce: 1,
			feeTokenAddr: token.address,
			feeAmount: txFeeAmount,
			to: token.address,
			data: tokenInterface.functions.transfer.encode([accountToWithdrawTo, maxToWithdraw])
		})
		const txns = [withdrawTx, txToWithdraw]
		const sigs = await Promise.all(
			txns.map(async tx => splitSig(await ethSign(tx.hashHex(), userAcc)))
		)

		const handle = await identityFactory.deployAndExecute(
			bytecode,
			salt,
			txns.map(tx => tx.toSolidityTuple()),
			sigs,
			{ gasLimit }
		)

		const receipt = await handle.wait()
		assert.ok(receipt.events.some(x => x.event === 'LogDeployed'))
		// LogDeployed, LogChannelWithdraw, channel sweep Transfer, 1 fee Transfers, the withdraw Transfer
		assert.equal(receipt.events.length, 5, 'events length is right')
		// console.log('gas used:', receipt.gasUsed.toNumber())

		assert.equal(
			(await token.balanceOf(accountToWithdrawTo)).toNumber(),
			maxToWithdraw,
			'we managed to withdraw our balance out of the identity'
		)

		// since the factory is the sender...
		assert.equal(
			(await token.balanceOf(identityFactory.address)).toNumber(),
			initialFactoryBal.toNumber() + txFeeAmount,
			'factory has received fee'
		)

		assert.equal(
			(await token.balanceOf(relayerAddr)).toNumber(),
			initialRelayerBal.toNumber(),
			'relayer balance is unchanged'
		)

		// we should be able to withdraw to relayer addr
		const amountToWithdraw = (await token.balanceOf(identityFactory.address)).toNumber()
		await expectEVMError(
			identityFactory
				.connect(web3Provider.getSigner(userAcc))
				.withdraw(token.address, relayerAddr, amountToWithdraw),
			'ONLY_CREATOR'
		)
		const factoryWithdrawReceipt = await (await identityFactory.withdraw(
			token.address,
			relayerAddr,
			amountToWithdraw
		)).wait()
		assert.equal(factoryWithdrawReceipt.events.length, 1, 'events length is right')
		assert.equal(
			(await token.balanceOf(relayerAddr)).toNumber(),
			amountToWithdraw + initialRelayerBal.toNumber(),
			'withdraw earnings from IdentityFactory'
		)
	})

	function createAccount(privileges, opts) {
		const bytecode = getProxyDeployBytecode(baseIdentityAddr, privileges, opts, solcModule)
		const salt = `0x${Buffer.from(randomBytes(32)).toString('hex')}`
		const expectedAddr = getAddress(
			`0x${generateAddress2(identityFactory.address, salt, bytecode).toString('hex')}`
		)
		return [bytecode, salt, expectedAddr]
	}

	async function getWithdrawData(channel, addr, tokenAmnt) {
		const elem1 = Channel.getBalanceLeaf(addr, tokenAmnt)
		const tree = new MerkleTree([elem1])
		const proof = tree.proof(elem1)
		const stateRoot = tree.getRoot()
		const hashToSignHex = channel.hashToSignHex(coreAddr, stateRoot)
		const [sig1, sig2] = await Promise.all([leader, follower].map(v => ethSign(hashToSignHex, v)))
		return [stateRoot, splitSig(sig1), splitSig(sig2), proof]
	}

	async function zeroFeeTx(to, data, nonceOffset = 0) {
		return new Transaction({
			identityContract: id.address,
			nonce: (await id.nonce()).toNumber() + nonceOffset,
			feeTokenAddr: token.address,
			feeAmount: 0,
			to,
			data
		})
	}
})
