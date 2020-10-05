// SPDX-License-Identifier: agpl-3.0

pragma solidity ^0.6.12;
pragma experimental ABIEncoderV2;

import "./Identity.sol";

library RecoveryRequestLibrary {
    struct RecoveryRequest {
        address identity;
        address newWalletAddress;
    }

    function hash(RecoveryRequest memory request)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(
            address(this),
            request.identity,
            request.newWalletAddress
        ));
    }
}

contract AdExRecoveryDAO {
    using SafeMath for uint256;
    using RecoveryRequestLibrary for RecoveryRequestLibrary.RecoveryRequest;

    address public adminAddr;
    uint256 public immutable MINIMUM_RECOVERY_DELAY; // in seconds
    uint256 public recoveryDelay; // in seconds

    mapping(address => bool) public proposers;
    // recovery request hash to finalize time
    mapping(bytes32 => uint256) public recovery;

    event LogAddProposer(address proposer, uint256 timestamp);
    event LogRemoveProposer(address proposer, uint256 timestamp);
    event LogProposeRecovery(bytes32 recoveryId, address proposer, address identity, uint256 timestamp);
    event LogFinalizeRecovery(bytes32 recoveryId, address proposer, address identity, uint256 timestamp);
    event LogCancelRecovery(bytes32 recoveryId, address identity, uint256 timestamp);
    event LogChangeAdmin(address oldAmin, address newAdmin);
    event LogChangeRecoveryDelay(uint256 previousDelay, uint256 newDelay);

    constructor(address admin, uint256 minDelay, uint256 delay) public {
        require(delay > 0, 'INVALID_DELAY');
        require(minDelay > 0, 'INVALID_MIN_DELAY');
        require(admin != address(0), 'INVALID_ADMIN');

        adminAddr = admin; 
        recoveryDelay = delay;
        MINIMUM_RECOVERY_DELAY = minDelay;
    }

    /**
     * @notice Only the admin is allowed to add a proposer
     * @param proposer The address of the proposer
     */
    function addProposer(address proposer) external {
        require(msg.sender == adminAddr, 'ONLY_ADMIN_CAN_ADD_PROPOSER');
        proposers[proposer] = true;
        emit LogAddProposer(proposer, now);
    }

    /**
     * @notice Only the admin is allowed to remove a proposer
     * @param proposer The address of the proposer
     */
    function removeProposer(address proposer) external {
        require(msg.sender == adminAddr, 'ONLY_ADMIN_CAN_REMOVE_PROPOSER');
        delete proposers[proposer];
        emit LogRemoveProposer(proposer, now);
    }

    /**
     * @notice Only proposers are allowed to a propose recovery request
     * @param request The details of the recovery request
     */
    function proposeRecovery(RecoveryRequestLibrary.RecoveryRequest memory request) external {
        require(proposers[msg.sender] == true, 'ONLY_WHITELISTED_PROPOSER');
        bytes32 recoveryId = request.hash();
        recovery[recoveryId] = recoveryDelay.add(now);
        emit LogProposeRecovery(recoveryId, msg.sender, request.identity, now);
    }
    
    /**
     * @notice Any proposer can finalize a propose recovery request after the delay period
     * @param request The details of the recovery request
     */
    function finalizeRecovery(RecoveryRequestLibrary.RecoveryRequest memory request) external {
        bytes32 recoveryId = request.hash();
        require(proposers[msg.sender] == true, 'ONLY_WHITELISTED_PROPOSERS');
        require(recovery[recoveryId] > 0 , 'RECOVERY_REQUEST_DOES_NOT_EXIST');
        require(now >= recovery[recoveryId], 'ACTIVE_DELAY');
        
        Identity.Transaction[] memory recoverTransaction = new Identity.Transaction[](1);
        recoverTransaction[0] = Identity.Transaction(
            request.identity,
            Identity(request.identity).nonce(),
            address(0),
            0,
            request.identity,
            0,
            abi.encodeWithSelector(
                Identity.setAddrPrivilege.selector,
                request.newWalletAddress,
                uint8(Identity.PrivilegeLevel.Transactions)
            )
        );

        Identity(request.identity).executeBySender(recoverTransaction);
        delete recovery[recoveryId];
        emit LogFinalizeRecovery(recoveryId, msg.sender, request.identity, now);
    }

    /**
     * @notice Admin, any proposer or the identity being recovered can cancel a recovery request
     * @param request The details of the recovery request
     */
    function cancelRecovery(RecoveryRequestLibrary.RecoveryRequest memory request) external {
        require(
            request.identity == msg.sender ||
            msg.sender == adminAddr || 
            proposers[msg.sender] == true, 
            'ONLY_IDENTITY_PROPOSER_OR_ADMIN_CAN_CANCEL'
        );
        bytes32 recoveryId = request.hash();
        require(recovery[recoveryId] > 0, 'RECOVERY_REQUEST_DOES_NOT_EXIST');
        delete recovery[recoveryId];
        emit LogCancelRecovery(recoveryId, msg.sender, now);
    }
    
    /**
     * @notice Only Admin can replace themself
     * @param newAdmin The address of the new admin
     */
    function changeAdmin(address newAdmin) external {
        require(msg.sender == adminAddr, 'ONLY_ADMIN_CAN_CALL');
        require(newAdmin != adminAddr, 'INVALID_NEW_ADMIN');
        adminAddr = newAdmin;
        emit LogChangeAdmin(msg.sender, newAdmin);
    }

    /**
     * @notice Only the Admin can change recovery delay period
     * @param newDelay The new delay in seconds
     */
    function changeRecoveryDelay(uint256 newDelay) external {
        require(msg.sender == adminAddr, 'ONLY_ADMIN_CAN_CALL');
        require(newDelay >= MINIMUM_RECOVERY_DELAY, 'NEW_DELAY_BELOW_MINIMUM');
        uint256 oldDelay = recoveryDelay;
        recoveryDelay = newDelay;
        emit LogChangeRecoveryDelay(oldDelay, newDelay);
    }
}
