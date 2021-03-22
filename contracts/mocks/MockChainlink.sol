// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

contract MockChainlink {
    function lastestAnswer() external pure returns (uint256) {
        return 1e8;
    }
}
