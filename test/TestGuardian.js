// const promisify = require('util').promisify
// const { providers, Contract } = require('ethers')
const { providers, Contract } = require('ethers')

const { expectEVMError } = require('./')

const Guardian = artifacts.require('Guardian')
const Outpace = artifacts.require('OUTPACE')

const web3Provider = new providers.Web3Provider(web3.currentProvider)
const { moveTime, sampleChannel } = require('./')
const { Withdraw } = require('../js')
const { getWithdrawData, parseADX } = require('./lib')
const { deployTestStakingPool } = require('./deploy')

contract('Guardian', function(accounts) {
	let adxToken
	let prevToken
	let core
	let guardian
	let stakingPool

	const defaultTokenAmount = 2000
	const userAcc = accounts[0]
	const leader = accounts[1]
	const follower = accounts[2]
	// const pool = accounts[4]

	before(async function() {
		const coreWeb3 = await Outpace.deployed()
		const guardianWeb3 = await Guardian.new(coreWeb3.address)

		const signer = web3Provider.getSigner(userAcc)
		core = new Contract(coreWeb3.address, Outpace._json.abi, signer)
		guardian = new Contract(guardianWeb3.address, Guardian._json.abi, signer)
		// deploy staking pool
		;({ stakingPool, adxToken, prevToken } = await deployTestStakingPool([
			userAcc,
			guardian.address,
			leader,
			userAcc
		]))
	})

	it('registerPool', async function() {
		expectEVMError(guardian.registerPool(stakingPool.address, 1000), 'REFUND_PROMILLES_BOUNDS')
		await guardian.registerPool(stakingPool.address, 100)
		expectEVMError(guardian.registerPool(stakingPool.address, 1000), 'STAKING_ALREADY_REGISTERED')
		// check
		assert.equal((await guardian.refundInterestPromilles(userAcc)).toNumber(), 100)
		assert.equal((await guardian.poolForValidator(userAcc)).toString(), stakingPool.address)
	})

	it('setRefundPromilles', async function() {
		expectEVMError(guardian.setRefundPromilles(1000), 'REFUND_PROMILLES_BOUNDS')

		await guardian.setRefundPromilles(50)
	})

	it('getRefund', async function() {
		// set user balance
		await prevToken.setBalanceTo(userAcc, defaultTokenAmount)
		await adxToken.swap(defaultTokenAmount)

		const wrongChannel = sampleChannel(leader, follower, userAcc, adxToken.address, 0)
		await expectEVMError(
			guardian.getRefund(wrongChannel.toSolidityTuple(), userAcc, 1, [], false),
			'NOT_GUARDIAN'
		)

		const channel = sampleChannel(leader, follower, guardian.address, adxToken.address, 0)

		// approve outpace to pull funds
		await (await adxToken.approve(core.address, parseADX('1000'))).wait()
		await (await core.deposit(channel.toSolidityTuple(), userAcc, defaultTokenAmount)).wait()

		// Prepare the tree and sign the state root
		const userLeafAmnt = defaultTokenAmount / 2
		const [stateRoot, vsig1, vsig2, proof, spenderProof] = await getWithdrawData(
			channel,
			userAcc,
			[userAcc],
			userLeafAmnt,
			core.address,
			{ [userAcc]: userLeafAmnt },
			userAcc
		)

		// valid withdraw
		const validWithdrawal = new Withdraw({
			channel,
			balanceTreeAmount: userLeafAmnt,
			stateRoot,
			sigLeader: vsig1,
			sigFollower: vsig2,
			proof
		})
		// challenge the channel
		await (await core
			.connect(web3Provider.getSigner(leader))
			.challenge(channel.toSolidityTuple())).wait()

		// update the state root
		await (await core.withdraw(validWithdrawal.toSolidityTuple())).wait()

		await expectEVMError(
			guardian.getRefund(channel.toSolidityTuple(), userAcc, userLeafAmnt, spenderProof, false),
			'TOO_EARLY'
		)

		const fiveDaysInSeconds = 432000
		await moveTime(web3, Math.floor(Date.now() / 1000) + fiveDaysInSeconds + 1)

		// correct call
		await guardian.getRefund(channel.toSolidityTuple(), userAcc, userLeafAmnt, spenderProof, true)

		await expectEVMError(
			guardian.getRefund(channel.toSolidityTuple(), userAcc, userLeafAmnt, spenderProof, false),
			'REFUND_ALREADY_RECEIVED'
		)
	})
})
