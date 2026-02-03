// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/SwapHelper.sol";

/// @title SwapHelperHarness
/// @notice Test harness to expose SwapHelper internal functions for testing
/// @dev Only for testing - not for production use
contract SwapHelperHarness {
    function swapUSDTtoSUSDD(uint256 usdtAmount) external returns (uint256) {
        return SwapHelper.swapUSDTtoSUSDD(usdtAmount);
    }

    function swapSUSDDtoUSDT(uint256 susddAmount) external returns (uint256) {
        return SwapHelper.swapSUSDDtoUSDT(susddAmount);
    }

    function getSUSDDRate() external view returns (uint256) {
        return SwapHelper.getSUSDDRate();
    }

    function getUSDTValue(uint256 susddAmount) external view returns (uint256) {
        return SwapHelper.getUSDTValue(susddAmount);
    }

    function previewSwapUSDTtoSUSDD(uint256 usdtAmount) external view returns (uint256) {
        return SwapHelper.previewSwapUSDTtoSUSDD(usdtAmount);
    }

    function previewSwapSUSDDtoUSDT(uint256 susddAmount) external view returns (uint256) {
        return SwapHelper.previewSwapSUSDDtoUSDT(susddAmount);
    }

    function previewSUSDDNeededForUSDT(uint256 usdtAmount) external view returns (uint256) {
        return SwapHelper.previewSUSDDNeededForUSDT(usdtAmount);
    }
}
