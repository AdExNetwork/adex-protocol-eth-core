/** globals afterEach */
const { providers, Contract } = require('ethers')
const { bigNumberify, parseUnits } = require('ethers').utils

const { expectEVMError, takeSnapshot, revertToSnapshot, moveTime } = require('./')
const { UnbondCommitment } = require('../js')

const StakingPoolArtifact = artifacts.require('StakingPool')
const MockChainlink = artifacts.require('MockChainlink')
const MockUniswap = artifacts.require('MockUniswap')
const MockToken = artifacts.require('Token')
const ADXSupplyController = artifacts.require('ADXSupplyController')
const ADXToken = artifacts.require('ADXToken')

const web3Provider = new providers.Web3Provider(web3.currentProvider)

const parseADX = v => parseUnits(v, 18)
const DAY_SECONDS = 24 * 60 * 60

contract('StakingPool', function(accounts) {
	let stakingPool
	// let token
	let prevToken
	// eslint-disable-next-line no-unused-vars
	let chainlink
	// eslint-disable-next-line no-unused-vars
	let uniswap
	let adxSupplyController
	let adxToken
	let snapShotId
	const userAcc = accounts[0]
	const guardianAddr = accounts[1]
	const validatorAddr = accounts[2]
	const governanceAddr = accounts[3]
	const governanceSigner = web3Provider.getSigner(governanceAddr)

	before(async function() {
		const tokenWeb3 = await MockToken.new()

		// WARNING: all invokations to core/token will be from account[0]
		const signer = web3Provider.getSigner(userAcc)
		prevToken = new Contract(tokenWeb3.address, MockToken._json.abi, signer)

		const adxTokenWeb3 = await ADXToken.new(userAcc, prevToken.address)
		adxToken = new Contract(adxTokenWeb3.address, ADXToken._json.abi, signer)

		const adxSupplyControllerWeb3 = await ADXSupplyController.new(adxToken.address)
		adxSupplyController = new Contract(
			adxSupplyControllerWeb3.address,
			ADXSupplyController._json.abi,
			signer
		)

		await adxToken.changeSupplyController(adxSupplyController.address)

		const chainlinkWeb3 = await MockChainlink.new()
		const uniswapWeb3 = await MockUniswap.new()
		const stakingPoolWeb3 = await StakingPoolArtifact.new(
			adxToken.address,
			uniswapWeb3.address,
			chainlinkWeb3.address,
			guardianAddr,
			validatorAddr,
			governanceAddr,
			adxToken.address
		)

		stakingPool = new Contract(stakingPoolWeb3.address, StakingPoolArtifact._json.abi, signer)
		chainlink = new Contract(chainlinkWeb3.address, MockChainlink._json.abi, signer)
		uniswap = new Contract(uniswapWeb3.address, MockUniswap._json.abi, signer)
	})

	beforeEach(async function() {
		snapShotId = (await takeSnapshot(web3)).result
	})

	// eslint-disable-next-line no-undef
	afterEach(async function() {
		await revertToSnapshot(web3, snapShotId)
	})

	it('name', async function() {
		assert.equal(await stakingPool.name(), 'AdEx Staking Token', 'invalid name')
	})

	it('decimals', async function() {
		assert.equal(await stakingPool.decimals(), 18, 'invalid decimals')
	})

	it('symbol', async function() {
		assert.equal(await stakingPool.symbol(), 'ADX-STAKING', 'invalid symbol')
	})

	it('guardian', async function() {
		assert.equal(await stakingPool.guardian(), guardianAddr, 'invalid guardian address')
	})

	it('validator', async function() {
		assert.equal(await stakingPool.validator(), validatorAddr, 'invalid validator address')
	})

	it('governance', async function() {
		assert.equal(await stakingPool.governance(), governanceAddr, 'invalid governance address')
	})

	it('setGovernance', async function() {
		expectEVMError(stakingPool.setGovernance(userAcc), 'NOT_GOVERNANCE')
		await stakingPool.connect(governanceSigner).setGovernance(userAcc)

		assert.equal(await stakingPool.governance(), userAcc, 'change governance address')
	})

	it('setDailyPenaltyMax', async function() {
		expectEVMError(stakingPool.setDailyPenaltyMax(1), 'NOT_GOVERNANCE')
		expectEVMError(
			stakingPool.connect(governanceSigner).setDailyPenaltyMax(1000),
			'DAILY_PENALTY_TOO_LARGE'
		)
		const newDailyPenalty = 200
		await stakingPool.connect(governanceSigner).setDailyPenaltyMax(newDailyPenalty)

		assert.equal(
			await stakingPool.maxDailyPenaltiesPromilles(),
			newDailyPenalty,
			'change penalty max value'
		)
		// @TODO reset limits
	})

	it('setRageReceived', async function() {
		expectEVMError(stakingPool.setRageReceived(1), 'NOT_GOVERNANCE')
		expectEVMError(stakingPool.connect(governanceSigner).setRageReceived(4000), 'TOO_LARGE')

		const newRageReceived = 300
		await stakingPool.connect(governanceSigner).setRageReceived(newRageReceived)

		assert.equal(
			await stakingPool.rageReceivedPromilles(),
			newRageReceived,
			'change rage received value'
		)
	})

	it('setTimeToUnbond', async function() {
		expectEVMError(stakingPool.setTimeToUnbond(1), 'NOT_GOVERNANCE')
		const threeDaysInSeconds = 259200
		expectEVMError(stakingPool.connect(governanceSigner).setTimeToUnbond(259200 * 30), 'BOUNDS')

		await stakingPool.connect(governanceSigner).setTimeToUnbond(threeDaysInSeconds)

		assert.equal(
			await stakingPool.timeToUnbond(),
			threeDaysInSeconds,
			'change time to unbond value'
		)
	})

	it('enter', async function() {
		const amountToEnter = bigNumberify('1000000')
		// set user balance
		await prevToken.setBalanceTo(userAcc, amountToEnter)
		await adxToken.swap(amountToEnter)

		// approve Staking pool
		await (await adxToken.approve(stakingPool.address, parseADX('1000'))).wait()

		const receipt = await (await stakingPool.enter(parseADX('10'))).wait()
		assert.equal(receipt.events.length, 3, 'should emit event')

		const prevBal = await stakingPool.balanceOf(userAcc)
		assert.equal(
			prevBal.toString(),
			parseADX('10').toString(),
			'should mint equivalent pool tokens'
		)

		// set incentive
		await (await adxSupplyController.setIncentive(stakingPool.address, parseADX('0.1'))).wait()

		await moveTime(web3, DAY_SECONDS * 10)
		await (await stakingPool.enter(parseADX('10'))).wait()

		assert.ok((await stakingPool.balanceOf(userAcc)).gt(prevBal), 'should mint additional shares')
	})

	it('enterTo', async function() {
		const amountToEnter = bigNumberify('1000000')
		// set user balance
		await prevToken.setBalanceTo(userAcc, amountToEnter)
		await adxToken.swap(amountToEnter)

		// approve Staking pool
		await (await adxToken.approve(stakingPool.address, parseADX('1000'))).wait()

		const receipt = await (await stakingPool.enterTo(guardianAddr, parseADX('10'))).wait()
		assert.equal(receipt.events.length, 3, 'should emit event')

		assert.equal(
			(await stakingPool.balanceOf(guardianAddr)).toString(),
			parseADX('10').toString(),
			'should mint equivalent pool tokens'
		)
	})

	it('leave', async function() {
		const amountToEnter = bigNumberify('1000000')
		// set user balance
		await prevToken.setBalanceTo(userAcc, amountToEnter)
		await adxToken.swap(amountToEnter)

		// approve Staking pool
		await (await adxToken.approve(stakingPool.address, parseADX('1000'))).wait()
		// enter staking pool
		const sharesToMint = parseADX('10')
		await (await stakingPool.enter(sharesToMint)).wait()

		await expectEVMError(stakingPool.leave(parseADX('10000'), false), 'INSUFFICIENT_SHARES')

		const receipt = await (await stakingPool.leave(sharesToMint, false)).wait()
		const currentBlockTimestamp = (await web3.eth.getBlock('latest')).timestamp
		assert.equal(receipt.events.length, 2, 'should emit LogLeave event')

		const logLeaveEv = receipt.events.find(ev => ev.event === 'LogLeave')
		assert.ok(logLeaveEv, 'should have LogLeave event')
		assert.ok(
			currentBlockTimestamp + (await stakingPool.timeToUnbond()).toNumber(),
			logLeaveEv.args.unlocksAt.toNumber(),
			'should have correct unlocksAt'
		)

		const unbondCommitment = new UnbondCommitment({
			...logLeaveEv.args,
			shares: logLeaveEv.args.shares.toString(),
			unlocksAt: logLeaveEv.args.unlocksAt.toString()
		})

		assert.equal(
			(await stakingPool.commitments(unbondCommitment.hashHex())).toString(),
			sharesToMint.toString()
		)

		assert.equal(
			(await stakingPool.lockedShares(logLeaveEv.args.owner)).toString(),
			sharesToMint.toString()
		)
	})

	it('withdraw', async function() {
		const amountToEnter = bigNumberify('1000000')
		await prevToken.setBalanceTo(userAcc, amountToEnter)
		await adxToken.swap(amountToEnter)

		await (await adxToken.approve(stakingPool.address, parseADX('1000'))).wait()
		const sharesToMint = parseADX('10')
		await (await stakingPool.enter(sharesToMint)).wait()

		console.log('1 - to debug out of gas')
		const leaveReceipt = await (await stakingPool.leave(parseADX('10'), false)).wait()
		const logLeaveEv = leaveReceipt.events.find(ev => ev.event === 'LogLeave')
		await expectEVMError(
			stakingPool.withdraw(sharesToMint, logLeaveEv.args.unlocksAt.toNumber(), false),
			'UNLOCK_TOO_EARLY'
		)

		await moveTime(web3, logLeaveEv.args.unlocksAt.toNumber() + 10)

		await expectEVMError(
			stakingPool.withdraw(sharesToMint, logLeaveEv.args.unlocksAt.toNumber() + 1000, false),
			'NO_COMMITMENT'
		)

		console.log('2 - to debug out of gas')
		const withdrawReceipt = await (await stakingPool.withdraw(
			sharesToMint,
			logLeaveEv.args.unlocksAt.toNumber(),
			false
		)).wait()

		const logWithdrawEv = withdrawReceipt.events.find(ev => ev.event === 'LogWithdraw')
		assert.ok(logWithdrawEv, 'should have LogWithdraw ev')

		console.log('3 - to debug out of gas')
		const unbondCommitment = new UnbondCommitment({
			...logLeaveEv.args,
			shares: logLeaveEv.args.shares.toString(),
			unlocksAt: logLeaveEv.args.unlocksAt.toString()
		})

		assert.equal((await stakingPool.commitments(unbondCommitment.hashHex())).toString(), '0')

		assert.equal((await stakingPool.lockedShares(logLeaveEv.args.owner)).toString(), '0')
		// @TODO check shares amount
	})

	it('rageLeave', async function() {
		const amountToEnter = bigNumberify('1000000')
		await prevToken.setBalanceTo(userAcc, amountToEnter)
		await adxToken.swap(amountToEnter)

		await (await adxToken.approve(stakingPool.address, parseADX('1000'))).wait()
		const sharesToMint = parseADX('10')
		await (await stakingPool.enter(sharesToMint)).wait()
		const currentBalance = await adxToken.balanceOf(userAcc)
		const leaveReceipt = await (await stakingPool.rageLeave(parseADX('10'), false)).wait()
		const logRageLeaveEv = leaveReceipt.events.find(ev => ev.event === 'LogRageLeave')

		assert.equal(
			(await adxToken.balanceOf(userAcc)).toString(),
			currentBalance.add(logRageLeaveEv.args.receivedTokens).toString(),
			'should receive tokens'
		)
	})

	it('claim', async function() {
		const amountToEnter = bigNumberify('1000000')
		await prevToken.setBalanceTo(userAcc, amountToEnter)
		await adxToken.swap(amountToEnter)

		await (await adxToken.approve(stakingPool.address, parseADX('1000'))).wait()
		const sharesToMint = parseADX('30')
		await (await stakingPool.enter(sharesToMint)).wait()

		await expectEVMError(
			stakingPool.claim(prevToken.address, guardianAddr, parseADX('8')),
			'NOT_GUARDIAN'
		)

		await expectEVMError(
			stakingPool
				.connect(web3Provider.getSigner(guardianAddr))
				.claim(prevToken.address, guardianAddr, parseADX('8')),
			'TOKEN_NOT_WHITELISTED'
		)

		await expectEVMError(
			stakingPool
				.connect(web3Provider.getSigner(guardianAddr))
				.claim(adxToken.address, guardianAddr, parseADX('100')),
			'INSUFFICIENT_ADX'
		)

		await stakingPool.connect(governanceSigner).setDailyPenaltyMax(1)

		const receipt = await (await stakingPool
			.connect(web3Provider.getSigner(guardianAddr))
			.claim(adxToken.address, guardianAddr, parseADX('8'))).wait()

		// eslint-disable-next-line no-console
		console.log(`claim gasUsed; ${receipt.gasUsed.toString()}`)
	})

	it('penalize', async function() {
		const amountToEnter = bigNumberify('1000000')
		await prevToken.setBalanceTo(userAcc, amountToEnter)
		await adxToken.swap(amountToEnter)

		await (await adxToken.approve(stakingPool.address, parseADX('1000'))).wait()
		const sharesToMint = parseADX('30')
		await (await stakingPool.enter(sharesToMint)).wait()

		await expectEVMError(stakingPool.penalize(parseADX('8')), 'NOT_GUARDIAN')
	})
})
