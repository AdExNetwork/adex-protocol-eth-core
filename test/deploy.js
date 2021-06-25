const { providers, Contract } = require('ethers')

const StakingPoolArtifact = artifacts.require('StakingPool')
const MockChainlink = artifacts.require('MockChainlink')
const MockUniswap = artifacts.require('MockUniswap')
const MockToken = artifacts.require('Token')
const ADXSupplyController = artifacts.require('ADXSupplyController')
const ADXToken = artifacts.require('ADXToken')
const web3Provider = new providers.Web3Provider(web3.currentProvider)

async function deployTestStakingPool([userAcc, guardianAddr, validatorAddr, governanceAddr]) {
	const tokenWeb3 = await MockToken.new()

	const signer = web3Provider.getSigner(userAcc)
	const prevToken = new Contract(tokenWeb3.address, MockToken._json.abi, signer)

	const adxTokenWeb3 = await ADXToken.new(userAcc, prevToken.address)
	const adxToken = new Contract(adxTokenWeb3.address, ADXToken._json.abi, signer)

	const adxSupplyControllerWeb3 = await ADXSupplyController.new(adxToken.address)
	const adxSupplyController = new Contract(
		adxSupplyControllerWeb3.address,
		ADXSupplyController._json.abi,
		signer
	)

	await adxToken.changeSupplyController(adxSupplyController.address)

	const chainlinkWeb3 = await MockChainlink.new()
	const uniswapWeb3 = await MockUniswap.new()
	const stakingPoolWeb3 = await StakingPoolArtifact.new(
		adxToken.address,
		uniswapWeb3.address,
		chainlinkWeb3.address,
		guardianAddr,
		validatorAddr,
		governanceAddr,
		adxToken.address
	)

	const stakingPool = new Contract(stakingPoolWeb3.address, StakingPoolArtifact._json.abi, signer)
	const chainlink = new Contract(chainlinkWeb3.address, MockChainlink._json.abi, signer)
	const uniswap = new Contract(uniswapWeb3.address, MockUniswap._json.abi, signer)

	return { stakingPool, chainlink, uniswap, adxToken, prevToken }
}

module.exports = { deployTestStakingPool }
