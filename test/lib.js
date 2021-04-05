const promisify = require('util').promisify
const { Transaction, Channel, splitSig, MerkleTree } = require('../js')

const ethSign = promisify(web3.eth.sign.bind(web3))

async function getWithdrawData(channel, id, addresses, tokenAmnt, outpaceAddr) {
	const elems = addresses.map(addr => {
		return Channel.getBalanceLeaf(addr, tokenAmnt)
	})
	const idElem = Channel.getBalanceLeaf(id, tokenAmnt)
	const tree = new MerkleTree(elems)
	const proof = tree.proof(idElem)
	const stateRoot = tree.getRoot()
	const hashToSignHex = channel.hashToSignHex(outpaceAddr, stateRoot)
	const sig1 = splitSig(await ethSign(hashToSignHex, channel.leader))
	const sig2 = splitSig(await ethSign(hashToSignHex, channel.follower))
	return [stateRoot, sig1, sig2, proof]
}

async function zeroFeeTx(to, data, nonceOffset = 0, id, token) {
	return new Transaction({
		identityContract: id.address,
		nonce: (await id.nonce()).toNumber() + nonceOffset,
		feeTokenAddr: token.address,
		feeAmount: 0,
		to,
		data
	})
}

module.exports = { getWithdrawData, zeroFeeTx, ethSign }
