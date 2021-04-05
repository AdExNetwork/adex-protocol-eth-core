const ensure = require('./ensureTypes')

function Withdraw(args) {
	this.channel = args.channel
	this.balanceTreeAmount = ensure.Uint256(args.balanceTreeAmount)
	this.stateRoot = ensure.Bytes32(args.stateRoot)
	this.sigLeader = ensure.Bytes32Array(args.sigLeader, 3)
	this.sigFollower = ensure.Bytes32Array(args.sigFollower, 3)
	this.proof = ensure.Bytes32Array(args.proof, -1)

	Object.freeze(this)

	return this
}

Withdraw.prototype.toSolidityTuple = function() {
	// etherjs doesn't seem to want BN.js instances; hex is the lowest common denominator for web3/ethers
	return [
		this.channel.toSolidityTuple(),
		`0x${this.balanceTreeAmount.toString(16)}`,
		this.stateRoot,
		this.sigLeader,
		this.sigFollower,
		this.proof
	]
}

module.exports = { Withdraw }
