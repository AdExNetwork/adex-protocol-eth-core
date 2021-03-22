// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "./interfaces/IADXToken.sol";

contract ADXSupplyController {
	enum GovernanceLevel { None, Mint, All }

	uint public constant CAP = 150000000 * 1e18;
	// This amount was burned on purpose when migrating from Tom pool 2 (Staking with token 0xade) to Tom pool 3 (StakingPool with token 0xade)

	uint public constant BURNED_MIN = 35000000 * 1e18;
	IADXToken public immutable ADX;

	mapping (address => uint8) public governance;
	// Some addresses (eg StakingPools) are incentivized with a certain allowance of ADX per year
	mapping (address => uint) public incentivePerSecond;
	// Keep track of when incentive tokens were last minted for a given addr
	mapping (address => uint) public incentiveLastMint;

	constructor(IADXToken token) {
		governance[msg.sender] = uint8(GovernanceLevel.All);
		ADX = token;
	}

	function changeSupplyController(address newSupplyController) external {
		require(governance[msg.sender] >= uint8(GovernanceLevel.All), 'NOT_GOVERNANCE');
		ADX.changeSupplyController(newSupplyController);
	}

	function setGovernance(address addr, uint8 level) external {
		require(governance[msg.sender] >= uint8(GovernanceLevel.All), 'NOT_GOVERNANCE');
		governance[addr] = level;
	}

	function setIncentive(address addr, uint amountPerSecond) external {
		require(governance[msg.sender] >= uint8(GovernanceLevel.All), 'NOT_GOVERNANCE');
		// no more than 1 ADX per second
		require(amountPerSecond < 1e18, 'AMOUNT_TOO_LARGE');
		incentiveLastMint[addr] = block.timestamp;
		incentivePerSecond[addr] = amountPerSecond;
	}

	function innerMint(IADXToken token, address owner, uint amount) internal {
		uint totalSupplyAfter = token.totalSupply() + amount;
		require(totalSupplyAfter <= CAP + BURNED_MIN, 'MINT_TOO_LARGE');
		token.mint(owner, amount);
	}

	// Kept because it's used for ADXLoyaltyPool
	function mint(IADXToken token, address owner, uint amount) external {
		require(governance[msg.sender] >= uint8(GovernanceLevel.Mint), 'NOT_GOVERNANCE');
		innerMint(token, owner, amount);
	}

	// Incentive mechanism
	function mintableIncentive(address addr) public view returns (uint) {
		return (block.timestamp - incentiveLastMint[addr]) * incentivePerSecond[addr];
	}

	function mintIncentive(address addr) external {
		uint amount = mintableIncentive(addr);
		incentiveLastMint[addr] = block.timestamp;
		innerMint(ADX, addr, amount);
	}
}
