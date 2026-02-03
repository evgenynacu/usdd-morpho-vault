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
        // Approve USDT to PSM's gemJoin
        address gemJoin = psm.gemJoin();
        usdt.forceApprove(gemJoin, usdtAmount);

        // Call sellGem: sends USDT, receives USDD (minus tin fee)
        uint256 usddBalanceBefore = usdd.balanceOf(address(this));
        psm.sellGem(address(this), usdtAmount);
        uint256 usddReceived = usdd.balanceOf(address(this)) - usddBalanceBefore;

        // Step 2: USDD -> sUSDD via staking
        // Approve USDD to sUSDD vault
        usdd.forceApprove(Constants.SUSDD, usddReceived);

        // Deposit USDD, receive sUSDD shares
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

        // Step 1: sUSDD -> USDD via unstaking (redeem shares)
        uint256 usddReceived = susdd.redeem(susddAmount, address(this), address(this));

        // Step 2: USDD -> USDT via PSM
        // Approve USDD to PSM
        usdd.forceApprove(Constants.PSM, usddReceived);

        // Calculate how much USDT we can get for our USDD
        // buyGem requires USDD = gemAmt + (gemAmt * tout / WAD)
        // So gemAmt = usddReceived * WAD / (WAD + tout)
        uint256 tout = psm.tout();
        uint256 gemAmt = (usddReceived * Constants.WAD) / (Constants.WAD + tout);
        // Scale from 18 decimals (USDD) to 6 decimals (USDT)
        gemAmt = gemAmt / 1e12;

        // Call buyGem: sends USDD, receives USDT
        uint256 usdtBalanceBefore = usdt.balanceOf(address(this));
        psm.buyGem(address(this), gemAmt);
        usdtAmount = usdt.balanceOf(address(this)) - usdtBalanceBefore;
    }

    /// @notice Get the current sUSDD rate (USDD per sUSDD)
    /// @return rate Exchange rate with 18 decimals (1e18 = 1:1)
    function getSUSDDRate() internal view returns (uint256 rate) {
        IERC4626 susdd = IERC4626(Constants.SUSDD);
        // convertToAssets returns how much USDD you get for 1 sUSDD
        rate = susdd.convertToAssets(Constants.WAD);
    }

    /// @notice Calculate the USDT value of sUSDD amount (for NAV calculation)
    /// @dev Accounts for: sUSDD->USDD rate and PSM tout fee
    /// @param susddAmount Amount of sUSDD (18 decimals)
    /// @return usdtValue Estimated USDT value (6 decimals)
    function getUSDTValue(uint256 susddAmount) internal view returns (uint256 usdtValue) {
        if (susddAmount == 0) return 0;

        IERC4626 susdd = IERC4626(Constants.SUSDD);
        IPSM psm = IPSM(Constants.PSM);

        // Step 1: sUSDD -> USDD value
        uint256 usddValue = susdd.convertToAssets(susddAmount);

        // Step 2: Account for PSM tout fee when converting USDD -> USDT
        // USDT out = usddValue * WAD / (WAD + tout)
        uint256 tout = psm.tout();
        uint256 usdtValue18 = (usddValue * Constants.WAD) / (Constants.WAD + tout);

        // Scale from 18 decimals to 6 decimals
        usdtValue = usdtValue18 / 1e12;
    }

    /// @notice Calculate how much sUSDD you get for a given USDT amount
    /// @param usdtAmount Amount of USDT (6 decimals)
    /// @return susddAmount Expected sUSDD amount (18 decimals)
    function previewSwapUSDTtoSUSDD(uint256 usdtAmount) internal view returns (uint256 susddAmount) {
        if (usdtAmount == 0) return 0;

        IERC4626 susdd = IERC4626(Constants.SUSDD);
        IPSM psm = IPSM(Constants.PSM);

        // Step 1: Calculate USDD received after tin fee
        // USDD out = usdtAmount * (WAD - tin) / WAD
        uint256 tin = psm.tin();
        uint256 usddReceived = (usdtAmount * 1e12 * (Constants.WAD - tin)) / Constants.WAD;

        // Step 2: Preview sUSDD shares for USDD deposit
        susddAmount = susdd.previewDeposit(usddReceived);
    }

    /// @notice Calculate how much USDT you get for a given sUSDD amount
    /// @param susddAmount Amount of sUSDD (18 decimals)
    /// @return usdtAmount Expected USDT amount (6 decimals)
    function previewSwapSUSDDtoUSDT(uint256 susddAmount) internal view returns (uint256 usdtAmount) {
        if (susddAmount == 0) return 0;

        IERC4626 susdd = IERC4626(Constants.SUSDD);
        IPSM psm = IPSM(Constants.PSM);

        // Step 1: Preview USDD received from redeeming sUSDD
        uint256 usddReceived = susdd.previewRedeem(susddAmount);

        // Step 2: Calculate USDT after tout fee
        // gemAmt = usddReceived * WAD / (WAD + tout)
        uint256 tout = psm.tout();
        uint256 usdtValue18 = (usddReceived * Constants.WAD) / (Constants.WAD + tout);

        // Scale from 18 decimals to 6 decimals
        usdtAmount = usdtValue18 / 1e12;
    }

    /// @notice Calculate how much sUSDD is needed to receive a given USDT amount
    /// @dev Inverse of previewSwapSUSDDtoUSDT - accounts for tout fee and sUSDD rate
    /// @param usdtAmount Amount of USDT to receive (6 decimals)
    /// @return susddAmount Amount of sUSDD needed (18 decimals)
    function previewSUSDDNeededForUSDT(uint256 usdtAmount) internal view returns (uint256 susddAmount) {
        if (usdtAmount == 0) return 0;

        IERC4626 susdd = IERC4626(Constants.SUSDD);
        IPSM psm = IPSM(Constants.PSM);

        // Step 1: Calculate USDD needed to get usdtAmount from PSM
        // buyGem: user pays (gemAmt + gemAmt * tout / WAD) USDD to get gemAmt USDT
        // So: usddNeeded = usdtAmount * (WAD + tout) / WAD
        uint256 tout = psm.tout();
        uint256 usddNeeded = (usdtAmount * 1e12 * (Constants.WAD + tout)) / Constants.WAD;

        // Step 2: Calculate sUSDD needed to get usddNeeded from redeem
        // Using previewWithdraw: how many shares to burn to get `assets` amount
        susddAmount = susdd.previewWithdraw(usddNeeded);
    }
}
