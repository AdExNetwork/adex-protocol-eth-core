const { parseUnits } = require('ethers').utils
const promisify = require('util').promisify
const { Transaction, Channel, splitSig, MerkleTree } = require('../js')

const ethSign = promisify(web3.eth.sign.bind(web3))

// @param spender object of address to amount
async function getWithdrawData(
	channel,
	id,
	addresses,
	tokenAmnt,
	outpaceAddr,
	spender,
	spenderProofId
) {
	let elems = addresses.map(addr => {
		return Channel.getBalanceLeaf(addr, tokenAmnt)
	})

	// include spender information
	if (spender) {
		elems = [
			...elems,
			...Object.entries(spender).map(([acc, amount]) => Channel.getSpenderBalanceLeaf(acc, amount))
		]
	}

	const idElem = Channel.getBalanceLeaf(id, tokenAmnt)
	const tree = new MerkleTree(elems)
	const proof = tree.proof(idElem)

	let spenderProof = []
	if (spender && spenderProofId) {
		const spenderElem = Channel.getSpenderBalanceLeaf(spenderProofId, spender[spenderProofId])
		spenderProof = tree.proof(spenderElem)
	}
	const stateRoot = tree.getRoot()
	const hashToSignHex = channel.hashToSignHex(outpaceAddr, stateRoot)
	const sig1 = splitSig(await ethSign(hashToSignHex, channel.leader))
	const sig2 = splitSig(await ethSign(hashToSignHex, channel.follower))
	return [stateRoot, sig1, sig2, proof, spenderProof]
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

const parseADX = v => parseUnits(v, 18)

module.exports = { getWithdrawData, zeroFeeTx, ethSign, parseADX }
