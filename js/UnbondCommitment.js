const abi = require('ethereumjs-abi')
const keccak256 = require('js-sha3').keccak256
const ensure = require('./ensureTypes')

function UnbondCommitment(args) {
	this.owner = ensure.Address(args.owner)
	this.shares = ensure.Uint256(args.shares)
	this.unlocksAt = ensure.Uint256(args.unlocksAt)

	Object.freeze(this)
	return this
}

UnbondCommitment.prototype.hash = function() {
	const buf = abi.rawEncode(
		['address', 'uint256', 'uint256'],
		[this.owner, this.shares, this.unlocksAt]
	)
	return Buffer.from(keccak256.arrayBuffer(buf))
}

UnbondCommitment.prototype.hashHex = function() {
	return `0x${this.hash().toString('hex')}`
}

module.exports = { UnbondCommitment }
