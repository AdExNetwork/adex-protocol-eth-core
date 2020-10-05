const { Channel } = require('../js')

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000'

async function expectEVMError(promise, errString, prefix = '') {
	try {
		await promise
		assert.isOk(false, `should have failed with ${errString}`)
	} catch (e) {
		const expectedString = errString
			? `${prefix}VM Exception while processing transaction: revert ${errString}`
			: 'VM Exception while processing transaction: revert'
		assert.equal(e.message, expectedString, 'error message is incorrect')
	}
}

function sampleChannel(accounts, tokenAddr, creator, amount, validUntil, nonce) {
	const spec = Buffer.alloc(32)
	spec.writeUInt32BE(nonce)
	return new Channel({
		creator,
		tokenAddr,
		tokenAmount: amount,
		validUntil,
		validators: [accounts[0], accounts[1]],
		spec
	})
}

function handleJsonRPCErr(resolve, reject, err, res) {
	if (err) reject(err)
	else if (res.error) reject(res.error)
	else resolve(res)
}

function moveTime(web3, time) {
	return new Promise(function(resolve, reject) {
		web3.currentProvider.send(
			{
				jsonrpc: '2.0',
				method: 'evm_increaseTime',
				params: [time],
				id: 0
			},
			handleJsonRPCErr.bind(null, resolve, reject)
		)
	})
}

async function setTime(web3, time) {
	// Doesn't work cause of a ganache bug: `e.getTime is not a function` cause it doesn't construct a date from the JSONRPC input
	return new Promise(function(resolve, reject) {
		web3.currentProvider.send(
			{
				jsonrpc: '2.0',
				method: 'evm_setTime',
				params: [new Date(time * 1000)],
				id: 0
			},
			handleJsonRPCErr.bind(null, resolve, reject)
		)
	})
}

function toUnixTimestamp(timestamp) {
	return Math.floor(timestamp / 1000)
}

function currentTimestamp() {
	return toUnixTimestamp(Date.now())
}

function takeSnapshot(web3) {
	return new Promise((resolve, reject) => {
		web3.currentProvider.send(
			{
				jsonrpc: '2.0',
				method: 'evm_snapshot',
				params: [],
				id: new Date().getTime()
			},
			(err, result) => {
				if (err) {
					return reject(err)
				}

				return resolve(result.result)
			}
		)
	})
}

function revertToSnapshot(web3, snapShotId) {
	return new Promise((resolve, reject) => {
		web3.currentProvider.send(
			{
				jsonrpc: '2.0',
				method: 'evm_revert',
				params: [snapShotId],
				id: new Date().getTime()
			},
			err => {
				if (err) {
					return reject(err)
				}

				return resolve()
			}
		)
	})
}
module.exports = {
	expectEVMError,
	sampleChannel,
	moveTime,
	setTime,
	toUnixTimestamp,
	currentTimestamp,
	takeSnapshot,
	revertToSnapshot,
	NULL_ADDRESS
}
