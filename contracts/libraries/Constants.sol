// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Constants
/// @notice External contract addresses for mainnet
library Constants {
    /// @notice USDT token address (6 decimals)
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    /// @notice USDD token address (18 decimals)
    address internal constant USDD = 0x4f8e5DE400DE08B164E7421B3EE387f461beCD1A;

    /// @notice Savings USDD (sUSDD) ERC4626 vault address (18 decimals)
    address internal constant SUSDD = 0xC5d6A7B61d18AfA11435a889557b068BB9f29930;

    /// @notice USDD Peg Stability Module (PSM) address
    address internal constant PSM = 0xcE355440c00014A229bbEc030A2B8f8EB45a2897;

    /// @notice Morpho Blue lending protocol address
    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

    /// @notice Market ID for sUSDD/USDT market on Morpho Blue
    bytes32 internal constant MARKET_ID = 0x29ae8cad946d861464d5e829877245a863a18157c0cde2c3524434dafa34e476;

    /// @notice WAD = 1e18, used for fixed-point math
    uint256 internal constant WAD = 1e18;

    /// @notice USDT decimals
    uint8 internal constant USDT_DECIMALS = 6;

    /// @notice USDD/sUSDD decimals
    uint8 internal constant USDD_DECIMALS = 18;
}
