// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockVault
/// @notice Mock implementation of IVault for testing EmergencyKeeper
contract MockVault {
    uint256 public lastRebalanceLTV;
    bool public paused;
    uint256 public rebalanceCallCount;
    uint256 public pauseCallCount;

    bool public shouldRevertOnRebalance;
    bool public shouldRevertOnPause;

    function rebalance(uint256 newTargetLTV) external {
        if (shouldRevertOnRebalance) {
            revert("MockVault: rebalance reverted");
        }
        lastRebalanceLTV = newTargetLTV;
        rebalanceCallCount++;
    }

    function pause() external {
        if (shouldRevertOnPause) {
            revert("MockVault: pause reverted");
        }
        paused = true;
        pauseCallCount++;
    }

    function setRevertOnRebalance(bool _shouldRevert) external {
        shouldRevertOnRebalance = _shouldRevert;
    }

    function setRevertOnPause(bool _shouldRevert) external {
        shouldRevertOnPause = _shouldRevert;
    }
}
