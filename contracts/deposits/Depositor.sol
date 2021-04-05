// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "../OUTPACE.sol";
import "../interfaces/IERC20.sol";

contract Depositor {
	constructor(OUTPACE outpace, OUTPACE.Channel memory channel, address depositor) {
		uint amount = IERC20(channel.tokenAddr).balanceOf(address(this));
		SafeERC20.approve(channel.tokenAddr, address(outpace), amount);
		outpace.deposit(channel, depositor, amount);
		assembly {
			selfdestruct(depositor)
		}
	}
}
