// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockSUSDD
/// @notice Simple ERC4626-like mock with configurable exchange rate
/// @dev Does not inherit ERC4626 to avoid storage issues with hardhat_setCode
///      All relevant addresses are immutable (stored in bytecode)
contract MockSUSDD is ERC20 {
    using SafeERC20 for IERC20;

    // Immutable so it survives hardhat_setCode
    address public immutable asset;

    // Rate stored in storage - need to set after hardhat_setCode
    uint256 private _rate;

    constructor(address asset_, string memory name, string memory symbol) ERC20(name, symbol) {
        asset = asset_;
        _rate = 1e18; // Start at 1:1
    }

    /// @notice Set the exchange rate (assets per 1e18 shares)
    function setRate(uint256 newRate) external {
        _rate = newRate;
    }

    /// @notice Get current rate
    function getRate() external view returns (uint256) {
        // Default to 1e18 if not set (storage = 0 after hardhat_setCode)
        return _rate == 0 ? 1e18 : _rate;
    }

    function _getRate() internal view returns (uint256) {
        return _rate == 0 ? 1e18 : _rate;
    }

    /// @notice Convert assets to shares
    function convertToShares(uint256 assets) public view returns (uint256) {
        return (assets * 1e18) / _getRate();
    }

    /// @notice Convert shares to assets
    function convertToAssets(uint256 shares) public view returns (uint256) {
        return (shares * _getRate()) / 1e18;
    }

    /// @notice Preview deposit (shares for given assets)
    function previewDeposit(uint256 assets) public view returns (uint256) {
        return convertToShares(assets);
    }

    /// @notice Preview withdraw (shares needed for given assets)
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        uint256 shares = convertToShares(assets);
        // Round up
        if (convertToAssets(shares) < assets) {
            shares += 1;
        }
        return shares;
    }

    /// @notice Preview redeem (assets for given shares)
    function previewRedeem(uint256 shares) public view returns (uint256) {
        return convertToAssets(shares);
    }

    /// @notice Deposit assets and receive shares
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);

        // Pull assets from sender
        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);

        // Mint shares to receiver
        _mint(receiver, shares);
    }

    /// @notice Withdraw assets by burning shares
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        shares = previewWithdraw(assets);

        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        _burn(owner, shares);
        IERC20(asset).safeTransfer(receiver, assets);
    }

    /// @notice Redeem shares for assets
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        assets = convertToAssets(shares);

        if (msg.sender != owner) {
            _spendAllowance(owner, msg.sender, shares);
        }

        _burn(owner, shares);
        IERC20(asset).safeTransfer(receiver, assets);
    }

    /// @notice Total assets in the vault
    function totalAssets() public view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }
}
