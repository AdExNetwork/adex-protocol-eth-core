// const promisify = require('util').promisify
// const { providers, Contract } = require('ethers')
const { providers, Contract } = require('ethers')
const { bigNumberify } = require('ethers').utils

const { expectEVMError } = require('./')

const Guardian = artifacts.require('Guardian')
const MockToken = artifacts.require('Token')
const Outpace = artifacts.require('OUTPACE')

const web3Provider = new providers.Web3Provider(web3.currentProvider)

contract('Guardian', function(accounts) {
	let token
	let core
	let guardian

	const defaultTokenAmount = 2000
	const userAcc = accounts[0]
	const leader = accounts[1]
	const follower = accounts[2]
	const user2 = accounts[3]
	const pool = accounts[4]

	before(async function() {
		const tokenWeb3 = await MockToken.new()
		const coreWeb3 = await Outpace.deployed()
		const guardianWeb3 = await Guardian.new(coreWeb3.address)

		const signer = web3Provider.getSigner(userAcc)
		core = new Contract(coreWeb3.address, Outpace._json.abi, signer)
		token = new Contract(tokenWeb3.address, MockToken._json.abi, signer)
		guardian = new Contract(guardianWeb3.address, Guardian._json.abi, signer)
	})

	it('registerPool', async function() {
		expectEVMError(guardian.registerPool(pool, 1000), 'REFUND_PROMILLES_BOUNDS')
		await guardian.registerPool(pool, 100)
		expectEVMError(guardian.registerPool(pool, 1000), 'STAKING_ALREADY_REGISTERED')
		// check
		assert.equal((await guardian.refundInterestPromilles(userAcc)).toNumber(), 100)
		assert.equal((await guardian.poolForValidator(userAcc)).toString(), pool)
	})

	it('setRefundPromilles', async function() {
		await guardian.setRefundPromilles(50)
	})

	it('getRefund', async function() {
        
    })
})
