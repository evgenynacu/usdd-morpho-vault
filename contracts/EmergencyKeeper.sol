// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IVault {
    function rebalance(uint256 newTargetLTV) external;
    function pause() external;
}

/// @title EmergencyKeeper
/// @notice One-click emergency shutdown for multiple vaults
/// @dev Must be granted KEEPER_ROLE + PAUSER_ROLE on each vault
contract EmergencyKeeper is Ownable {
    uint256 private constant IDLE_MODE = type(uint256).max;

    event IdleResult(address indexed vault, bool success);
    event PauseResult(address indexed vault, bool success);

    constructor(address _owner) Ownable(_owner) {}

    /// @notice Rebalance all vaults to IDLE_MODE (withdraw all positions to USDT)
    function idleAll(address[] calldata vaults) external onlyOwner returns (bool[] memory ok) {
        ok = new bool[](vaults.length);
        for (uint256 i = 0; i < vaults.length; i++) {
            try IVault(vaults[i]).rebalance(IDLE_MODE) {
                ok[i] = true;
            } catch {}
            emit IdleResult(vaults[i], ok[i]);
        }
    }

    /// @notice Pause all vaults (blocks deposits and rebalancing)
    function pauseAll(address[] calldata vaults) external onlyOwner returns (bool[] memory ok) {
        ok = new bool[](vaults.length);
        for (uint256 i = 0; i < vaults.length; i++) {
            try IVault(vaults[i]).pause() {
                ok[i] = true;
            } catch {}
            emit PauseResult(vaults[i], ok[i]);
        }
    }

    /// @notice Emergency: idle + pause all vaults in one tx
    function emergencyAll(address[] calldata vaults) external onlyOwner {
        for (uint256 i = 0; i < vaults.length; i++) {
            try IVault(vaults[i]).rebalance(IDLE_MODE) {
                emit IdleResult(vaults[i], true);
            } catch {
                emit IdleResult(vaults[i], false);
            }
            try IVault(vaults[i]).pause() {
                emit PauseResult(vaults[i], true);
            } catch {
                emit PauseResult(vaults[i], false);
            }
        }
    }
}
