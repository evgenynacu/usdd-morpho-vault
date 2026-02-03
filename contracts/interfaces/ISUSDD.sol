// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @title ISUSDD
/// @notice Interface for Savings USDD (sUSDD) at 0xc5d6a7b61d18afa11435a889557b068bb9f29930
/// @dev sUSDD is an ERC4626 vault where USDD is the underlying asset
interface ISUSDD is IERC4626 {
    // sUSDD is a standard ERC4626, so all functions are inherited from IERC4626
    // Key functions:
    // - deposit(assets, receiver) -> shares
    // - withdraw(assets, receiver, owner) -> shares
    // - mint(shares, receiver) -> assets
    // - redeem(shares, receiver, owner) -> assets
    // - convertToAssets(shares) -> assets
    // - convertToShares(assets) -> shares
    // - previewDeposit(assets) -> shares
    // - previewWithdraw(assets) -> shares
    // - totalAssets() -> assets
}
