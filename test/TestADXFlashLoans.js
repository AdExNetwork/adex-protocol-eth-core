const { providers, Contract } = require('ethers')
const { Interface } = require('ethers').utils
const { promisify } = require('util')

const MockToken = artifacts.require('./mocks/Token')
const ADXFlashLoans = artifacts.require('ADXFlashLoans')
const Identity = artifacts.require('Identity')

const { expectEVMError } = require('./')
const { Transaction, splitSig } = require('../js')

const ethSign = promisify(web3.eth.sign.bind(web3))
const web3Provider = new providers.Web3Provider(web3.currentProvider)

const tokenInterface = new Interface(MockToken._json.abi)

contract('ADXFlashLoans', function(accounts) {
	const userAddr = accounts[1]

	let mockToken
	let flashLoans
	let id

	function zeroFeeTx(nonce, to, data) {
		return new Transaction({
			identityContract: id.address,
			nonce,
			feeTokenAddr: mockToken.address,
			feeAmount: 0,
			to,
			data
		})
	}

	before(async function() {
		const signer = web3Provider.getSigner(userAddr)

		const tokenWeb3 = await MockToken.new()
		mockToken = new Contract(tokenWeb3.address, MockToken._json.abi, signer)
		const flashLoanWeb3 = await ADXFlashLoans.new()
		flashLoans = new Contract(flashLoanWeb3.address, ADXFlashLoans._json.abi, signer)

		const identityWeb3 = await Identity.new([userAddr])
		id = new Contract(identityWeb3.address, Identity._json.abi, signer)
	})

	it('flash loan', async function() {
		const fullAmnt = 15000
		await mockToken.setBalanceTo(flashLoans.address, fullAmnt)

		const maliciousData = tokenInterface.functions.transfer.encode([userAddr, fullAmnt])
		const maliciousTx = zeroFeeTx(0, mockToken.address, maliciousData)
		const maliciousSig = splitSig(await ethSign(maliciousTx.hashHex(), userAddr))
		// Try to get all the tokens by sending them to ourselves (by calling the token)
		await expectEVMError(
			flashLoans.flash(
				mockToken.address,
				fullAmnt,
				id.address,
				[maliciousTx.toSolidityTuple()],
				[maliciousSig]
			),
			'INSUFFICIENT_FUNDS'
		)

		// This should be OK as we approve the tokens to be sent back to the flash loans contract
		const goodData = tokenInterface.functions.approve.encode([flashLoans.address, fullAmnt])
		const goodTx = zeroFeeTx(0, mockToken.address, goodData)
		const goodSig = splitSig(await ethSign(goodTx.hashHex(), userAddr))
		const receipt = await (await flashLoans.flash(
			mockToken.address,
			fullAmnt,
			id.address,
			[goodTx.toSolidityTuple()],
			[goodSig]
		)).wait()
		assert.equal(receipt.events.length, 2, '2 events for Transfer')
		assert.equal(await mockToken.balanceOf(flashLoans.address), fullAmnt, 'balance is consistent')
	})
})
