// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "./OUTPACE.sol";
import "./libs/SafeERC20.sol";

interface IStakingPool {
	function claim(address tokenOut, address to, uint amount) external;
}

contract Guardian {
	// validator => pool contract
	mapping (address => address) public poolForValidator;
	// validator -> refundInterestPromilles
	mapping (address => uint) public refundInterestPromilles;
	// channelId => spender => isRefunded
	mapping (bytes32 => mapping(address => bool)) public refunds;
	// The OUTPACE contract that this Guardian will work with
	OUTPACE outpace;

	constructor(OUTPACE _outpace) {
		outpace = _outpace;
	}

	function registerPool(address pool, uint interestPromilles) external {
		require(poolForValidator[msg.sender] == address(0), 'STAKING_ALREADY_REGISTERED');
		poolForValidator[msg.sender] = pool;
		require(interestPromilles < 500, 'REFUND_PROMILLES_BOUNDS');
		refundInterestPromilles[msg.sender] = interestPromilles;
		// NOTE: later on, we can implement an 'initiation fee' here
		// Which would be calling claim() here on some small amount, to ensure the claim process works for the given pool
	}

	function setRefundPromilles(uint interestPromilles) external {
		require(interestPromilles < 500, 'REFUND_PROMILLES_BOUNDS');
		refundInterestPromilles[msg.sender] = interestPromilles;
	}
	
	function getRefund(OUTPACE.Channel calldata channel, address spender, uint spentAmount, bytes32[] calldata proof, bool skipInterest) external {
		require(channel.guardian == address(this), 'NOT_GUARDIAN');
		bytes32 channelId = keccak256(abi.encode(channel));

		require(!refunds[channelId][spender], 'REFUND_ALREADY_RECEIVED');
		refunds[channelId][spender] = true;

		// Verify the spendable amount leaf
		bytes32 lastStateRoot = outpace.lastStateRoot(channelId);
		// if lastStateRoot is 0, spentAmount can also be 0 without verification
		if (!(spentAmount == 0 && lastStateRoot == bytes32(0))) {
			bytes32 balanceLeaf = keccak256(abi.encode(spender, 'spender', spentAmount));
			require(MerkleProof.isContained(balanceLeaf, proof, lastStateRoot), 'BALANCELEAF_NOT_FOUND');
		}

		uint totalDeposited = outpace.deposits(channelId, spender);
		uint refundablePrincipal = totalDeposited - spentAmount;
		address blamed = channel.leader; // getBlame(channel);
		address poolAddr = poolForValidator[blamed];

		// Ensure the channel is closed (fail if it can't be closed yet)
		uint challengeExpires = outpace.challenges(channelId);
		if (challengeExpires != type(uint256).max) {
			// Allow another 5 days before we can call .close(), giving more time to participants to withdraw
			require(block.timestamp > challengeExpires + 5 days, 'TOO_EARLY');
			outpace.close(channel);
		}

		// Finally, distribute the funds, and only use claim() if needed
		SafeERC20.transfer(channel.tokenAddr, spender, refundablePrincipal);

		// Do not send interest if there is no lastStateRoot (channel has not been used)
		// cause without it, it's possible to open non-legit channels with real validators, let them expire and try to claim the interest
		// Only apply the interest if the channel has been used and there's a pool from which to get it, and there's no opt out
		uint interest = refundInterestPromilles[blamed];
		if (!skipInterest && poolAddr != address(0) && interest != 0 && lastStateRoot != bytes32(0)) {
			IStakingPool(poolAddr).claim(channel.tokenAddr, spender, (refundablePrincipal * interest) / 1000);
		}
	}
}
