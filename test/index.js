const { hexlify } = require('ethers').utils
const { Channel } = require('../js')

async function expectEVMError(promise, errString) {
	try {
		await promise
		assert.isOk(false, `should have failed with ${errString}`)
	} catch (e) {
		const expectedString = errString
			? `VM Exception while processing transaction: revert ${errString}`
			: 'VM Exception while processing transaction: revert'
		assert.equal(e.message, expectedString, 'error message is incorrect')
	}
}

function sampleChannel(leader, follower, guardian, tokenAddr, nonce) {
	const nonceBytes = Buffer.alloc(32)
	nonceBytes.writeUInt32BE(nonce)
	return new Channel({
		leader,
		follower,
		guardian,
		tokenAddr,
		nonce: nonceBytes
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

function takeSnapshot(web3) {
	return new Promise((resolve, reject) => {
		web3.currentProvider.send(
			{
				jsonrpc: '2.0',
				method: 'evm_snapshot',
				params: [],
				id: Date.now()
			},
			handleJsonRPCErr.bind(null, resolve, reject)
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
				id: Date.now()
			},
			handleJsonRPCErr.bind(null, resolve, reject)
		)
	})
}

const getBytes32 = n => {
	const nonce = Buffer.alloc(32)
	nonce.writeUInt32BE(n)
	return hexlify(nonce)
}

module.exports = {
	expectEVMError,
	sampleChannel,
	moveTime,
	setTime,
	takeSnapshot,
	revertToSnapshot,
	getBytes32
}
