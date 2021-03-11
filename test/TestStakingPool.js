/** globals afterEach */
const { providers, Contract } = require('ethers')
const { bigNumberify } = require('ethers').utils

const { expectEVMError, takeSnapshot, revertToSnapshot } = require('./')

const StakingPool = artifacts.require('StakingPool')
const MockChainlink = artifacts.require('MockChainlink')
const MockUniswap = artifacts.require('MockUniswap')
const MockToken = artifacts.require('Token')

const web3Provider = new providers.Web3Provider(web3.currentProvider)

contract('StakingPool', function(accounts) {
	let stakingPool
	let token
	let chainlink
	let uniswap
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
		token = new Contract(tokenWeb3.address, MockToken._json.abi, signer)

		const chainlinkWeb3 = await MockChainlink.new()
		const uniswapWeb3 = await MockUniswap.new()
		const stakingPoolWeb3 = await StakingPool.new(
			tokenWeb3.address,
			uniswapWeb3.address,
			chainlinkWeb3.address,
			guardianAddr,
			validatorAddr,
			governanceAddr
		)

		stakingPool = new Contract(stakingPoolWeb3.address, StakingPool._json.abi, signer)
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
		const newDailyPenalty = 300
		await stakingPool.connect(governanceSigner).setDailyPenaltyMax(newDailyPenalty)

		assert.equal(
			await stakingPool.MAX_DAILY_PENALTIES_PROMILLES(),
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
			await stakingPool.RAGE_RECEIVED_PROMILLES(),
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
			await stakingPool.TIME_TO_UNBOND(),
			threeDaysInSeconds,
			'change time to unbond value'
		)
	})

    it.only('enter', async function() {
        const amountToEnter = 1000
        // approve Staking pool 
        await (await token.approve(StakingPool.address, 1000).wait()
    })
    
})
