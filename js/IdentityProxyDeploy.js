const wrapper = require('solc/wrapper')
const abi = require('ethereumjs-abi')
const keccak256 = require('js-sha3').keccak256
const assert = require('assert')

function getMappingSstore(slotNumber, keyType, key, value) {
	// https://blog.zeppelin.solutions/ethereum-in-depth-part-2-6339cf6bddb9
	const buf = abi.rawEncode([keyType, 'bool'], [key, slotNumber])
	const slot = keccak256(buf)
	return `sstore(0x${slot}, ${value})`
}

// opts:
// * privSlot: the storage slots used by the proxiedAddr
// * unsafeERC20: true OR safeERC20Artifact
// solcWrapper:
// * wannabe temp solution to work in browsers https://github.com/ethereum/solc-js#browser-usage
// * For node usage: pass ./solc { solcModule }
function getProxyDeployBytecode(proxiedAddr, privLevels, opts, solcModule) {
	assert.ok(opts, 'opts not passed')
	const { privSlot } = opts
	assert.ok(typeof privSlot === 'number', 'privSlot must be a number')

	const privLevelsCode = privLevels
		.map(([addr, level]) => getMappingSstore(privSlot, 'address', addr, level))
		.join('\n')

	let erc20Header = ''
	let feeCode = ''
	if (opts.fee) {
		const fee = opts.fee
		// This is fine if we're only accepting whitelisted tokens
		if (fee.unsafeERC20) {
			erc20Header = `interface GeneralERC20 { function transfer(address to, uint256 value) external; }`
			feeCode = `GeneralERC20(${fee.tokenAddr}).transfer(${fee.recepient}, ${fee.amount});`
		} else {
			assert.ok(fee.safeERC20Artifact, 'opts: either unsafeERC20 or safeERC20Artifact required')
			erc20Header = fee.safeERC20Artifact.source
				.split('\n')
				.filter(x => !x.startsWith('pragma '))
				.join('\n')
			feeCode = `SafeERC20.transfer(${fee.tokenAddr}, ${fee.recepient}, ${fee.amount});`
		}
	}

	const content = `
pragma solidity ^0.5.6;
${erc20Header}
contract IdentityProxy {
	constructor()
		public
	{
		assembly {
			${privLevelsCode}
		}
		${feeCode}
	}

	function () external
	{
		address to = address(${proxiedAddr});
		assembly {
			calldatacopy(0, 0, calldatasize())
			let result := delegatecall(sub(gas, 10000), to, 0, calldatasize(), 0, 0)
			returndatacopy(0, 0, returndatasize)
			switch result case 0 {revert(0, returndatasize)} default {return (0, returndatasize)}
		}
	}
}`
	const input = {
		language: 'Solidity',
		sources: { 'Proxy.sol': { content } },
		settings: {
			outputSelection: {
				'*': {
					'*': ['evm.bytecode']
				}
			},
			optimizer: {
				enabled: true,
				runs: 200
			}
		}
	}
	const solc = wrapper(solcModule)
	const output = JSON.parse(solc.compile(JSON.stringify(input)))
	assert.ifError(output.errors)
	return `0x${output.contracts['Proxy.sol'].IdentityProxy.evm.bytecode.object}`
}

function getStorageSlotsFromArtifact(IdentityArtifact) {
	// Find storage locations of privileges
	const identityNode = IdentityArtifact.ast.nodes.find(
		({ name, nodeType }) => nodeType === 'ContractDefinition' && name === 'Identity'
	)
	assert.ok(identityNode, 'Identity contract definition not found')
	const storageVariableNodes = identityNode.nodes.filter(
		n => n.nodeType === 'VariableDeclaration' && !n.constant && n.stateVariable
	)
	const privSlot = storageVariableNodes.findIndex(x => x.name === 'privileges')
	assert.notEqual(privSlot, -1, 'privSlot was not found')

	return { privSlot }
}

module.exports = { getProxyDeployBytecode, getStorageSlotsFromArtifact }
