const promisify = require('util').promisify
const { providers, Contract } = require('ethers')

const Outpace = artifacts.require('OUTPACE')
const MockToken = artifacts.require('Token')
const MockLibs = artifacts.require('Libs')
const Guardian = artifacts.require('Guardian')

const { moveTime, sampleChannel, expectEVMError, takeSnapshot, revertToSnapshot } = require('./')

const ethSign = promisify(web3.eth.sign.bind(web3))

const { Channel, MerkleTree, splitSig, Withdraw, ChannelState } = require('../js')

const web3Provider = new providers.Web3Provider(web3.currentProvider)
const threeDaysInSeconds = 259200

contract('OUTPACE', function(accounts) {
	let token
	let core
	let libMock
	let guardian

	const defaultTokenAmount = 2000
	const userAcc = accounts[0]
	const leader = accounts[1]
	const follower = accounts[2]
	const user2 = accounts[3]

	before(async function() {
		const tokenWeb3 = await MockToken.new()
		const coreWeb3 = await Outpace.deployed()
		const guardianWeb3 = await Guardian.new(coreWeb3.address)
		libMock = await MockLibs.new()
		// WARNING: all invokations to core/token will be from account[0]
		const signer = web3Provider.getSigner(userAcc)
		core = new Contract(coreWeb3.address, Outpace._json.abi, signer)
		token = new Contract(tokenWeb3.address, MockToken._json.abi, signer)
		guardian = new Contract(guardianWeb3.address, Guardian._json.abi, signer)
	})

	beforeEach(async function() {
		await token.setBalanceTo(userAcc, defaultTokenAmount)
	})

	it('SignatureValidator', async function() {
		const hash = '0x0202020202020202020202020202020202020202020202020202020202020202'
		const sig = splitSig(await ethSign(hash, userAcc))
		assert.isTrue(
			await libMock.isValidSig(hash, userAcc, sig),
			'isValidSig returns true for the signer'
		)
		assert.isNotTrue(
			await libMock.isValidSig(hash, accounts[1], sig),
			'isValidSig returns true for a non-signer'
		)
	})

	it('deposit', async function() {
		const channel = sampleChannel(leader, follower, userAcc, token.address, 0)
		await expectEVMError(core.deposit(channel.toSolidityTuple(), userAcc, 0), 'NO_DEPOSIT')

		const receipt = await (await core.deposit(
			channel.toSolidityTuple(),
			userAcc,
			defaultTokenAmount
		)).wait()

		const ev = receipt.events.find(x => x.event === 'LogChannelDeposit')
		assert.ok(ev, 'has LogChannelOpen event')

		assert.equal(await token.balanceOf(userAcc), 0, 'account balance is 0')
		assert.equal(
			await token.balanceOf(core.address),
			defaultTokenAmount,
			'contract balance is correct'
		)

		assert.equal(ev.args.channelId, channel.hashHex(), 'channel hash matches')

		// deposit is updated
		assert.equal(
			await core.deposits(channel.hashHex(), userAcc),
			defaultTokenAmount,
			'user core deposit balance is correct'
		)
		// remaining is updated
		assert.equal(
			await core.remaining(channel.hashHex()),
			defaultTokenAmount,
			'channel remaining balance is correct'
		)

		// close channel
		await (await core.challenge(channel.toSolidityTuple())).wait()
		await moveTime(web3, threeDaysInSeconds + 2)
		await (await core.close(channel.toSolidityTuple())).wait()

		// should prevent deposit on a closed channel
		await expectEVMError(core.deposit(channel.toSolidityTuple(), userAcc, 1), 'CHANNEL_CLOSED')
	})

	it('withdraw', async function() {
		const totalDeposit = defaultTokenAmount
		const channel = sampleChannel(leader, follower, guardian.address, token.address, 1)

		await (await core.deposit(channel.toSolidityTuple(), userAcc, totalDeposit)).wait()

		// Prepare the tree and sign the state root
		const userLeafAmnt = totalDeposit / 2
		const [stateRoot, validSigs, proof] = await balanceTreeToWithdrawArgs(
			channel,
			{ [userAcc]: userLeafAmnt },
			userAcc,
			userLeafAmnt
		)

		// valid withdraw
		const validWithdrawal = new Withdraw({
			channel,
			balanceTreeAmount: userLeafAmnt,
			stateRoot,
			sigLeader: validSigs[0],
			sigFollower: validSigs[1],
			proof
		})

		const validWithdrawReceipt = await (await core.withdraw(
			validWithdrawal.toSolidityTuple()
		)).wait()

		assert.ok(
			validWithdrawReceipt.events.find(x => x.event === 'LogChannelWithdraw'),
			'has LogChannelWithdraw event'
		)
		assert.equal(await token.balanceOf(userAcc), userLeafAmnt, 'user has a proper token balance')
		assert.equal(
			(await core.withdrawnPerUser(channel.hashHex(), userAcc)).toNumber(),
			userLeafAmnt,
			'invalid withdrawnPerUser'
		)

		// we can do it again, but it's not gonna give us more tokens
		const validWithdrawReceipt2 = await (await core.withdraw(
			validWithdrawal.toSolidityTuple()
		)).wait()
		const withdrawEvent = validWithdrawReceipt2.events.find(x => x.event === 'LogChannelWithdraw')
		assert.ok(withdrawEvent, 'has LogChannelWithdraw event')
		assert.equal(withdrawEvent.args.amount, 0, 'withdrawn amount is 0')
		assert.equal(
			(await core.remaining(channel.hashHex())).toNumber(),
			totalDeposit - userLeafAmnt,
			'channel has the right withdrawn value'
		)

		// Can't withdraw with invalid Leader signature
		const invalidLeaderSigWithdrawal = new Withdraw({
			channel,
			balanceTreeAmount: userLeafAmnt,
			stateRoot,
			sigLeader: validSigs[1],
			sigFollower: validSigs[1],
			proof
		})
		await expectEVMError(core.withdraw(invalidLeaderSigWithdrawal.toSolidityTuple()), 'LEADER_SIG')

		// can't withdraw with invalid follower signature
		const invalidFollowerSigWithdrawal = new Withdraw({
			channel,
			balanceTreeAmount: userLeafAmnt,
			stateRoot,
			sigLeader: validSigs[0],
			sigFollower: validSigs[0],
			proof
		})

		await expectEVMError(
			core.withdraw(invalidFollowerSigWithdrawal.toSolidityTuple()),
			'FOLLOWER_SIG'
		)

		// Can't withdraw with invalid balance leaf
		const invalidBalanceLeafWithdrawal = new Withdraw({
			channel,
			balanceTreeAmount: userLeafAmnt - 1,
			stateRoot,
			sigLeader: validSigs[0],
			sigFollower: validSigs[1],
			proof
		})

		await expectEVMError(
			core.withdraw(invalidBalanceLeafWithdrawal.toSolidityTuple()),
			'BALANCERLEAF_NOT_FOUND'
		)

		// Can't withdraw with lesser amount
		{
			// eslint-disable-next-line no-shadow
			const [stateRoot, validSigs, proof] = await balanceTreeToWithdrawArgs(
				channel,
				{ [userAcc]: userLeafAmnt - 1 },
				userAcc,
				userLeafAmnt - 1
			)

			const invalidLessAmountWithdrawal = new Withdraw({
				channel,
				balanceTreeAmount: userLeafAmnt - 1,
				stateRoot,
				sigLeader: validSigs[0],
				sigFollower: validSigs[1],
				proof
			})

			await expectEVMError(core.withdraw(invalidLessAmountWithdrawal.toSolidityTuple()), '')
		}

		// updated multiple balance tree args
		const updatedMultipleUserLeafAmount = userLeafAmnt + 3
		const [
			updatedMultipleBalanceStateRoot,
			updatedMultipleBalanceValidSigs,
			updatedMultipleBalanceProof
		] = await balanceTreeToWithdrawArgs(
			channel,
			{ [userAcc]: updatedMultipleUserLeafAmount, [leader]: 1, [follower]: 1 },
			userAcc,
			updatedMultipleUserLeafAmount
		)

		// valid withdraw
		const updatedMultipleBalanceValidWithdrawal = new Withdraw({
			channel,
			balanceTreeAmount: updatedMultipleUserLeafAmount,
			stateRoot: updatedMultipleBalanceStateRoot,
			sigLeader: updatedMultipleBalanceValidSigs[0],
			sigFollower: updatedMultipleBalanceValidSigs[1],
			proof: updatedMultipleBalanceProof
		})

		const updatedMultipleBalanceValidWithdrawReceipt = await (await core.withdraw(
			updatedMultipleBalanceValidWithdrawal.toSolidityTuple()
		)).wait()

		assert.ok(
			updatedMultipleBalanceValidWithdrawReceipt.events.find(x => x.event === 'LogChannelWithdraw'),
			'has LogChannelWithdraw event'
		)
		assert.equal(
			await token.balanceOf(userAcc),
			updatedMultipleUserLeafAmount,
			'user has a proper token balance'
		)
	})

	it('bulkWithdraw', async function() {
		const withdrawals = []

		const size = 4
		const depositAmount = defaultTokenAmount / size
		const userLeafAmnt = depositAmount / 2

		for (let i = 0; i < size; i += 1) {
			const channel = sampleChannel(leader, follower, guardian.address, token.address, 3 + i)
			// eslint-disable-next-line no-await-in-loop
			await (await core.deposit(channel.toSolidityTuple(), userAcc, depositAmount)).wait()
			// eslint-disable-next-line no-await-in-loop
			const [stateRoot, validSigs, proof] = await balanceTreeToWithdrawArgs(
				channel,
				{ [userAcc]: userLeafAmnt },
				userAcc,
				userLeafAmnt
			)
			const validWithdrawal = new Withdraw({
				channel,
				balanceTreeAmount: userLeafAmnt,
				stateRoot,
				sigLeader: validSigs[0],
				sigFollower: validSigs[1],
				proof
			})
			withdrawals.push(validWithdrawal.toSolidityTuple())
		}

		const bulkWithdrawReceipt = await (await core.bulkWithdraw(
			userAcc,
			userAcc,
			withdrawals
		)).wait()
		assert.ok(
			bulkWithdrawReceipt.events.find(x => x.event === 'LogChannelWithdraw'),
			'has LogChannelWithdraw event'
		)
		assert.equal(
			(await token.balanceOf(userAcc)).toNumber(),
			userLeafAmnt * size,
			'user has a proper token balance'
		)

		// can't bulkWithdraw with different assets
		const differentToken = await MockToken.new()
		const channelWithDifferentAsset = sampleChannel(
			leader,
			follower,
			guardian.address,
			differentToken.address,
			4 + size
		)
		const [stateRoot, validSigs, proof] = await balanceTreeToWithdrawArgs(
			channelWithDifferentAsset,
			{ [userAcc]: userLeafAmnt },
			userAcc,
			userLeafAmnt
		)
		const withdrawalWithDifferentAsset = new Withdraw({
			channel: channelWithDifferentAsset,
			balanceTreeAmount: userLeafAmnt,
			stateRoot,
			sigLeader: validSigs[0],
			sigFollower: validSigs[1],
			proof
		})
		withdrawals.push(withdrawalWithDifferentAsset.toSolidityTuple())
		await expectEVMError(core.bulkWithdraw(userAcc, userAcc, withdrawals), 'MUST_USE_SAME_TOKEN')

		// can't bulkWithdraw with empty
		await expectEVMError(core.bulkWithdraw(userAcc, userAcc, []), 'NO_WITHDRAWALS')
	})

	it('challenge', async function() {
		const totalDeposit = defaultTokenAmount

		const channel = sampleChannel(leader, follower, user2, token.address, 9)

		await (await core.deposit(channel.toSolidityTuple(), userAcc, totalDeposit)).wait()

		// can't challenge because unauthorized
		await expectEVMError(core.challenge(channel.toSolidityTuple()), 'NOT_AUTHORIZED')
		// users that can challenge a channel ie.e leader, follower & guardian
		const challengers = [leader, follower, user2]

		let snapShotId
		// eslint-disable-next-line no-restricted-syntax
		for (const challenger of challengers) {
			// eslint-disable-next-line no-await-in-loop
			snapShotId = (await takeSnapshot(web3)).result
			// eslint-disable-next-line no-await-in-loop
			const challengeReceipt = await (await core
				.connect(web3Provider.getSigner(challenger))
				.challenge(channel.toSolidityTuple())).wait()

			const ev = challengeReceipt.events.find(x => x.event === 'LogChannelChallenge')
			assert.ok(ev, 'has LogChannelChallenge event')
			// eslint-disable-next-line no-await-in-loop
			await revertToSnapshot(web3, snapShotId)
		}

		// challenge again
		await (await core
			.connect(web3Provider.getSigner(leader))
			.challenge(channel.toSolidityTuple())).wait()

		// confirm the expires date
		assert.equal(
			(await core.challenges(channel.hashHex())).toNumber(),
			(await web3.eth.getBlock('latest')).timestamp + threeDaysInSeconds,
			'has the proper expires timestamp'
		)

		// can't challenge because channel already challenged
		await expectEVMError(
			core.connect(web3Provider.getSigner(leader)).challenge(channel.toSolidityTuple()),
			'CHANNEL_ALREADY_CHALLENGED'
		)
	})

	it('resume', async function() {
		const totalDeposit = defaultTokenAmount
		const channel = sampleChannel(leader, follower, guardian.address, token.address, 10)

		await (await core.deposit(channel.toSolidityTuple(), userAcc, totalDeposit)).wait()

		// can't resume a channel not challenged
		await expectEVMError(
			core
				.connect(web3Provider.getSigner(leader))
				.resume(
					channel.toSolidityTuple(),
					[
						'0x021c000000000000000000000000000000000000000000000000000000000000',
						'0x7b9e8cda6333566e7fbac3e1ccf62d66964f5114db5930dde0da9029a4fe3961',
						'0x65f5eefaf22451539a5146c7017e24141d24a06ba62544a343172a1aa2a3734f'
					],
					[
						'0x021c000000000000000000000000000000000000000000000000000000000000',
						'0x7b9e8cda6333566e7fbac3e1ccf62d66964f5114db5930dde0da9029a4fe3961',
						'0x65f5eefaf22451539a5146c7017e24141d24a06ba62544a343172a1aa2a3734f'
					]
				),
			'CHANNEL_NOT_CHALLENGED'
		)

		// challenge
		await (await core
			.connect(web3Provider.getSigner(leader))
			.challenge(channel.toSolidityTuple())).wait()

		const expires = await core.challenges(channel.hashHex())
		const root = channel.getResumeSignableMessageHex(expires.toNumber())

		const sig1 = splitSig(await ethSign(root, leader))
		const sig2 = splitSig(await ethSign(root, follower))

		// invalid leader signature
		await expectEVMError(
			core.connect(web3Provider.getSigner(leader)).resume(channel.toSolidityTuple(), sig2, sig2),
			'INVALID_LEADER_SIG'
		)

		// invalid follower signature
		await expectEVMError(
			core.connect(web3Provider.getSigner(leader)).resume(channel.toSolidityTuple(), sig1, sig1),
			'INVALID_FOLLOWER_SIG'
		)

		// resume
		const resumeReceipt = await (await core
			.connect(web3Provider.getSigner(leader))
			.resume(channel.toSolidityTuple(), sig1, sig2)).wait()

		const ev = resumeReceipt.events.find(x => x.event === 'LogChannelResume')
		assert.ok(ev, 'has LogChannelResume event')

		// confirm reset challenges
		assert.equal(
			(await core.challenges(channel.hashHex())).toNumber(),
			0,
			'should reset challenges value for channel'
		)
	})

	it('close', async function() {
		// msg.sender
		const totalDeposit = defaultTokenAmount
		// leader is the guardian of the channel
		const channel = sampleChannel(leader, follower, userAcc, token.address, 12)

		await (await core.deposit(channel.toSolidityTuple(), userAcc, totalDeposit)).wait()

		// must be called by guardian
		await expectEVMError(
			core.connect(web3Provider.getSigner(leader)).close(channel.toSolidityTuple()),
			'NOT_GUARDIAN'
		)

		await expectEVMError(core.close(channel.toSolidityTuple()), 'CHANNEL_NOT_CHALLENGED')
		// challenge
		await (await core.challenge(channel.toSolidityTuple())).wait()

		await expectEVMError(core.close(channel.toSolidityTuple()), 'CHANNEL_NOT_CLOSABLE')

		await moveTime(web3, Math.floor(Date.now() / 1000) + threeDaysInSeconds)

		const closeReceipt = await (await core.close(channel.toSolidityTuple())).wait()
		const ev = closeReceipt.events.find(x => x.event === 'LogChannelClose')
		assert.ok(ev, 'has LogChannelResume event')

		// check states
		assert.equal((await core.remaining(channel.hashHex())).toNumber(), 0, 'incorrect remaining')
		assert.equal(
			(await core.challenges(channel.hashHex())).toString('hex'),
			ChannelState.Challenged,
			'incorrect challenge state'
		)

		await expectEVMError(core.close(channel.toSolidityTuple()), 'CHANNEL_NOT_CHALLENGED')
	})

	// Bench: creating these: (elem1, elem2, elem3, tree, proof, stateRoot, hashToSignHex, sig1), 1000 times, takes ~6000ms
	// Bench: creating these: (elem1, elem2, elem3, tree, proof, stateRoot, hashtoSignHex), 1000 times, takes ~300ms
	// Bench: creating these: (tree, proof, stateRoot, hashtoSignHex), 1000 times, takes ~300ms
	async function balanceTreeToWithdrawArgs(channel, balances, acc, amnt) {
		const elements = Object.entries(balances).map(([leafAcc, leafAmnt]) =>
			Channel.getBalanceLeaf(leafAcc, leafAmnt)
		)
		const tree = new MerkleTree(elements)
		const elemToWithdraw = Channel.getBalanceLeaf(acc, amnt)
		const proof = tree.proof(elemToWithdraw)
		const stateRoot = tree.getRoot()
		const hashToSignHex = channel.hashToSignHex(core.address, stateRoot)
		const sig1 = splitSig(await ethSign(hashToSignHex, leader))
		const sig2 = splitSig(await ethSign(hashToSignHex, follower))
		return [stateRoot, [sig1, sig2], proof, amnt]
	}
})
