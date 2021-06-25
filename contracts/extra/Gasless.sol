// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.8.1;

import "../interfaces/IERC20.sol";
import "../libs/SafeERC20.sol";
import "../interfaces/IStakingPool.sol";

contract GaslessSweeper {
	function sweep(IStakingPool pool, address[] memory depositors) external {
		address token = pool.ADXToken();
		for (uint i = 0; i < depositors.length; i++) {
			new GaslessDepositor{ salt: bytes32(0) }(token, pool, depositors[i]);
		}
	}
}

contract GaslessDepositor {
	constructor(address token, IStakingPool pool, address depositor) {
		uint amount = IERC20(token).balanceOf(address(this));
		SafeERC20.approve(token, address(pool), amount);
		pool.enterTo(depositor, amount);
		assembly {
			selfdestruct(depositor)
		}
	}
}
