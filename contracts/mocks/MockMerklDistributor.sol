// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockMerklDistributor
/// @notice Mock contract for testing Merkl rewards claiming
contract MockMerklDistributor {
    IERC20 public rewardToken;
    uint256 public rewardAmount;
    bool public shouldFail;

    constructor(address _rewardToken) {
        rewardToken = IERC20(_rewardToken);
    }

    /// @notice Set the reward amount to be distributed on next claim
    function setRewardAmount(uint256 amount) external {
        rewardAmount = amount;
    }

    /// @notice Set whether claims should fail
    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    /// @notice Mock claim function - transfers rewards to caller
    /// @dev In real Merkl, this is claim(users, tokens, amounts, proofs)
    function claim(
        address[] calldata,
        address[] calldata,
        uint256[] calldata,
        bytes32[][] calldata
    ) external {
        if (shouldFail) {
            revert("Claim failed");
        }
        if (rewardAmount > 0) {
            rewardToken.transfer(msg.sender, rewardAmount);
        }
    }
}
