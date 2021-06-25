// SPDX-License-Identifier: agpl-3.0
pragma solidity 0.8.1;

interface IStakingPool {
	function claim(address tokenOut, address to, uint amount) external;
	function ADXToken() external returns (address);
	function enterTo(address recipient, uint amount) external;
}
