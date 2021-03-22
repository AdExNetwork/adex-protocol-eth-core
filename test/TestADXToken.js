const { providers, Contract } = require('ethers')
const { bigNumberify } = require('ethers').utils

const { expectEVMError } = require('./')

const MockToken = artifacts.require('./mocks/Token')
const ADXToken = artifacts.require('ADXToken')
const ADXSupplyController = artifacts.require('ADXSupplyController')

const web3Provider = new providers.Web3Provider(web3.currentProvider)

contract('ADXToken', function(accounts) {
	const userAddr = accounts[1]
	const governance = accounts[2]
	const anotherUser = accounts[3]

	let prevToken
	let adxToken
	let adxSupplyController

	before(async function() {
		const signer = web3Provider.getSigner(userAddr)
		const signerWithGovernance = web3Provider.getSigner(governance)

		const tokenWeb3 = await MockToken.new()
		prevToken = new Contract(tokenWeb3.address, MockToken._json.abi, signer)
		const adxTokenWeb3 = await ADXToken.new(userAddr, prevToken.address)

		const adxSupplyControllerWeb3 = await ADXSupplyController.new(adxTokenWeb3.address, {
			from: governance
		})
		adxSupplyController = new Contract(
			adxSupplyControllerWeb3.address,
			ADXSupplyController._json.abi,
			signerWithGovernance
		)
		adxToken = new Contract(adxTokenWeb3.address, ADXToken._json.abi, signer)
		// change supply controller to appropriate contract
		await adxToken.changeSupplyController(adxSupplyController.address)
	})

	it('token meta', async function() {
		const allMeta = [adxToken.name(), adxToken.symbol(), adxToken.decimals()]
		assert.deepEqual(await Promise.all(allMeta), ['AdEx Network', 'ADX', 18])
	})

	it('cannot change supply controller externally', async function() {
		await expectEVMError(adxToken.changeSupplyController(userAddr), 'NOT_SUPPLYCONTROLLER')
	})

	it('swap previous tokens', async function() {
		await expectEVMError(adxToken.swap(100000), 'INSUFFICIENT_FUNDS')

		await prevToken.setBalanceTo(userAddr, 15000)
		const receipt = await (await adxToken.swap(10000)).wait()
		const expectedAmnt = bigNumberify('1000000000000000000')
		assert.deepEqual(await adxToken.balanceOf(userAddr), expectedAmnt, 'migrated amount is correct')
		assert.equal(
			(await prevToken.balanceOf(userAddr)).toNumber(),
			5000,
			'prev token amount is 5000'
		)
		assert.equal(receipt.events.length, 2, '2 Transfer events')
		assert.ok(receipt.gasUsed.toNumber() < 105000, 'gas usage is OK')

		assert.deepEqual(await adxToken.totalSupply(), expectedAmnt, 'total supply is reflected')

		await adxToken.swap(5000)
		assert.deepEqual(
			await adxToken.totalSupply(),
			bigNumberify('1500000000000000000'),
			'total supply is reflected'
		)
	})

	it('transfer some tokens', async function() {
		const transferredAmount = bigNumberify('550000000000000000')
		const receipt = await (await adxToken.transfer(anotherUser, transferredAmount)).wait()
		assert.deepEqual(
			await adxToken.balanceOf(anotherUser),
			transferredAmount,
			'transferredAmount amount is correct'
		)
		assert.equal(receipt.events.length, 1, '1 event')
		assert.equal(receipt.events[0].event, 'Transfer', 'event is a transfer')
		assert.deepEqual(receipt.events[0].args.amount, transferredAmount, 'transfer amount is OK')
		assert.ok(receipt.gasUsed.toNumber() < 56000, 'gas usage is OK')
	})

	it.only('supply controller - mint and step down', async function() {
		const tokenAddr = adxToken.address
		const [initialSupply, initialBal] = await Promise.all([
			adxToken.totalSupply(),
			adxToken.balanceOf(userAddr)
		])

		const largeAmnt = bigNumberify('60000000000000000000000000')
		const totalSupply = (await adxToken.totalSupply()).toString()
		console.log({ totalSupply })
		await expectEVMError(
			adxSupplyController.mint(tokenAddr, userAddr, largeAmnt.mul(5)),
			'MINT_TOO_LARGE'
		)
		// const receipt = await (await adxSupplyController.mint(tokenAddr, userAddr, largeAmnt)).wait()
		// assert.equal(receipt.events.length, 1, 'has one transfer event')
		// // assert.equal(receipt.events[0].event, 'Transfer', 'event is a transfer')
		// // assert.deepEqual(receipt.events[0].amount, largeAmnt, 'Transfer amount is OK')
		// assert.deepEqual(await adxToken.totalSupply(), initialSupply.add(largeAmnt), 'supply is OK')
		// assert.deepEqual(await adxToken.balanceOf(userAddr), initialBal.add(largeAmnt), 'balance is OK')

		// // Governance can step down
		// await adxSupplyController.setGovernance(governance, 0)
		// await expectEVMError(adxSupplyController.mint(tokenAddr, userAddr, largeAmnt), 'NOT_GOVERNANCE')
	})
})
