// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "./Identity.sol";

contract IdentityFactory {
	event LogDeployed(address addr, uint256 salt);

	address public creator;
	constructor() {
		creator = msg.sender;
	}

	function deploy(bytes memory code, uint256 salt) public {
		deploySafe(code, salt);
	}

	// When the relayer needs to act upon an /execute call, it'll either call execute on the Identity directly
	// if it's already deployed, or call `deployAndExecute` if the account is still counterfactual
	// can't have deployAndExecuteBySender, because the sender will be the factory
	function deployAndExecute(
		bytes memory code, uint256 salt,
		Identity.Transaction[] memory txns, bytes32[3][] memory signatures
	) public {
		address addr = deploySafe(code, salt);
		Identity(addr).execute(txns, signatures);
	}

	// Withdraw the earnings from various fees (deploy fees and execute fees earned cause of `deployAndExecute`)
	function withdraw(address tokenAddr, address to, uint256 tokenAmount) public {
		require(msg.sender == creator, 'ONLY_CREATOR');
		SafeERC20.transfer(tokenAddr, to, tokenAmount);
	}

	// This is done to mitigate possible frontruns where, for example, deploying the same code/salt via deploy()
	// would make a pending deployAndExecute fail
	// The way we mitigate that is by checking if the contract is already deployed and if so, we continue execution
	function deploySafe(bytes memory code, uint256 salt) internal returns (address) {
		address expectedAddr = address(uint160(uint256(
			keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(code)))
		)));
		uint size;
		assembly { size := extcodesize(expectedAddr) }
		// If there is code at that address, we can assume it's the one we were about to deploy,
		// because of how CREATE2 and keccak256 works
		if (size == 0) {
			address addr;
			assembly { addr := create2(0, add(code, 0x20), mload(code), salt) }
			require(addr != address(0), 'FAILED_DEPLOYING');
			require(addr == expectedAddr, 'FAILED_MATCH');
			emit LogDeployed(addr, salt);
		}
		return expectedAddr;
	}
}
