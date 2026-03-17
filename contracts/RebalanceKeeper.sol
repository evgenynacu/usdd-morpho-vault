// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IRebalanceable {
    function rebalance(uint256 newTargetLTV) external;
    function targetLTV() external view returns (uint256);
}

/// @title RebalanceKeeper
/// @notice Batch rebalance multiple vaults, skipping those in IDLE_MODE
/// @dev Must be granted KEEPER_ROLE on each vault
contract RebalanceKeeper is Ownable {
    uint256 private constant IDLE_MODE = type(uint256).max;

    event RebalanceResult(address indexed vault, bool success);

    constructor(address _owner) Ownable(_owner) {}

    /// @notice Rebalance all vaults to a new LTV (skips vaults in IDLE_MODE)
    /// @dev Cannot set IDLE_MODE — vaults in idle stay idle
    function rebalanceAll(address[] calldata vaults, uint256 newTargetLTV) external onlyOwner returns (bool[] memory ok) {
        require(newTargetLTV != IDLE_MODE, "Cannot set IDLE_MODE");
        ok = new bool[](vaults.length);
        for (uint256 i = 0; i < vaults.length; i++) {
            try IRebalanceable(vaults[i]).targetLTV() returns (uint256 current) {
                if (current == IDLE_MODE) {
                    emit RebalanceResult(vaults[i], false);
                    continue;
                }
            } catch {
                emit RebalanceResult(vaults[i], false);
                continue;
            }
            try IRebalanceable(vaults[i]).rebalance(newTargetLTV) {
                ok[i] = true;
            } catch {}
            emit RebalanceResult(vaults[i], ok[i]);
        }
    }
}
