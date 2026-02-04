// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "../interfaces/IPSM.sol";
import "./Constants.sol";

/// @title SwapHelper
/// @notice Library for swapping between USDT and sUSDD via PSM and sUSDD vault
/// @dev All functions are internal and operate on behalf of the calling contract
///
/// PSM Fee Assumption:
/// This library assumes PSM tin/tout fees are 0 (current mainnet state).
/// If PSM governance enables fees, swap functions will revert and the vault
/// will need to be upgraded. This simplifies code and saves gas.
/// Probability of fee change is low; upgrade path exists if needed.
library SwapHelper {
    using SafeERC20 for IERC20;

    /// @notice Swap USDT to sUSDD: USDT -> USDD (via PSM) -> sUSDD (via stake)
    /// @param usdtAmount Amount of USDT to swap (6 decimals)
    /// @return susddAmount Amount of sUSDD received (18 decimals)
    function swapUSDTtoSUSDD(uint256 usdtAmount) internal returns (uint256 susddAmount) {
        if (usdtAmount == 0) return 0;

        IERC20 usdt = IERC20(Constants.USDT);
        IERC20 usdd = IERC20(Constants.USDD);
        IPSM psm = IPSM(Constants.PSM);
        IERC4626 susdd = IERC4626(Constants.SUSDD);

        // Step 1: USDT -> USDD via PSM
        address gemJoin = psm.gemJoin();
        usdt.forceApprove(gemJoin, usdtAmount);

        // sellGem: sends USDT, receives USDD (1:1 when tin=0)
        uint256 usddBalanceBefore = usdd.balanceOf(address(this));
        psm.sellGem(address(this), usdtAmount);
        uint256 usddReceived = usdd.balanceOf(address(this)) - usddBalanceBefore;

        // Step 2: USDD -> sUSDD via staking
        usdd.forceApprove(Constants.SUSDD, usddReceived);
        susddAmount = susdd.deposit(usddReceived, address(this));
    }

    /// @notice Swap sUSDD to USDT: sUSDD -> USDD (via unstake) -> USDT (via PSM)
    /// @param susddAmount Amount of sUSDD to swap (18 decimals)
    /// @return usdtAmount Amount of USDT received (6 decimals)
    function swapSUSDDtoUSDT(uint256 susddAmount) internal returns (uint256 usdtAmount) {
        if (susddAmount == 0) return 0;

        IERC20 usdt = IERC20(Constants.USDT);
        IERC20 usdd = IERC20(Constants.USDD);
        IPSM psm = IPSM(Constants.PSM);
        IERC4626 susdd = IERC4626(Constants.SUSDD);

        // Step 1: sUSDD -> USDD via unstaking
        uint256 usddReceived = susdd.redeem(susddAmount, address(this), address(this));

        // Step 2: USDD -> USDT via PSM
        usdd.forceApprove(Constants.PSM, usddReceived);

        // When tout=0: gemAmt = usddReceived (scaled to 6 decimals)
        uint256 gemAmt = usddReceived / 1e12;

        uint256 usdtBalanceBefore = usdt.balanceOf(address(this));
        psm.buyGem(address(this), gemAmt);
        usdtAmount = usdt.balanceOf(address(this)) - usdtBalanceBefore;
    }

    /// @notice Get the current sUSDD rate (USDD per sUSDD)
    /// @return rate Exchange rate with 18 decimals (1e18 = 1:1)
    function getSUSDDRate() internal view returns (uint256 rate) {
        IERC4626 susdd = IERC4626(Constants.SUSDD);
        rate = susdd.convertToAssets(Constants.WAD);
    }

    /// @notice Calculate the USDT value of sUSDD amount (for NAV calculation)
    /// @dev Assumes 1:1 USDD:USDT peg (tin/tout = 0)
    /// @param susddAmount Amount of sUSDD (18 decimals)
    /// @return usdtValue USDT value (6 decimals)
    function getUSDTValue(uint256 susddAmount) internal view returns (uint256 usdtValue) {
        if (susddAmount == 0) return 0;

        IERC4626 susdd = IERC4626(Constants.SUSDD);

        // sUSDD -> USDD value
        uint256 usddValue = susdd.convertToAssets(susddAmount);

        // USDD -> USDT (1:1 when tout=0)
        usdtValue = usddValue / 1e12;
    }

    /// @notice Preview sUSDD amount for USDT deposit
    /// @param usdtAmount Amount of USDT (6 decimals)
    /// @return susddAmount Expected sUSDD amount (18 decimals)
    function previewSwapUSDTtoSUSDD(uint256 usdtAmount) internal view returns (uint256 susddAmount) {
        if (usdtAmount == 0) return 0;

        IERC4626 susdd = IERC4626(Constants.SUSDD);

        // USDT -> USDD (1:1 when tin=0)
        uint256 usddAmount = usdtAmount * 1e12;

        // USDD -> sUSDD
        susddAmount = susdd.previewDeposit(usddAmount);
    }

    /// @notice Preview USDT amount for sUSDD redemption
    /// @param susddAmount Amount of sUSDD (18 decimals)
    /// @return usdtAmount Expected USDT amount (6 decimals)
    function previewSwapSUSDDtoUSDT(uint256 susddAmount) internal view returns (uint256 usdtAmount) {
        if (susddAmount == 0) return 0;

        IERC4626 susdd = IERC4626(Constants.SUSDD);

        // sUSDD -> USDD
        uint256 usddAmount = susdd.previewRedeem(susddAmount);

        // USDD -> USDT (1:1 when tout=0)
        usdtAmount = usddAmount / 1e12;
    }

    /// @notice Calculate sUSDD needed to receive a given USDT amount
    /// @param usdtAmount Amount of USDT to receive (6 decimals)
    /// @return susddAmount Amount of sUSDD needed (18 decimals)
    function previewSUSDDNeededForUSDT(uint256 usdtAmount) internal view returns (uint256 susddAmount) {
        if (usdtAmount == 0) return 0;

        IERC4626 susdd = IERC4626(Constants.SUSDD);

        // USDT -> USDD needed (1:1 when tout=0)
        uint256 usddNeeded = usdtAmount * 1e12;

        // How many sUSDD shares to burn for this USDD amount
        susddAmount = susdd.previewWithdraw(usddNeeded);
    }
}
