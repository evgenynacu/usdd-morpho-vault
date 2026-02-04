// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../mocks/MockERC20.sol";

/// @title MockPSM
/// @notice Mock PSM (Peg Stability Module) for testing
/// @dev Simulates USDT <-> USDD swaps with configurable tin/tout fees
contract MockPSM {
    using SafeERC20 for IERC20;

    uint256 public constant WAD = 1e18;

    IERC20 public immutable gem;  // USDT (6 decimals)
    IERC20 public immutable dai;  // USDD (18 decimals)

    uint256 public tin;  // Fee for selling gem (USDT -> USDD), in WAD
    uint256 public tout; // Fee for buying gem (USDD -> USDT), in WAD

    // gemJoin is immutable (stored in bytecode, not storage) so it survives hardhat_setCode
    address public immutable gemJoin;

    /// @param gem_ USDT address
    /// @param dai_ USDD address
    /// @param targetAddress The address where this mock will be deployed via hardhat_setCode
    ///        Pass this so gemJoin points to the correct address after code copy
    constructor(address gem_, address dai_, address targetAddress) {
        gem = IERC20(gem_);
        dai = IERC20(dai_);
        gemJoin = targetAddress; // Will be correct after hardhat_setCode
    }

    /// @notice Set tin fee (for sellGem: USDT -> USDD)
    function setTin(uint256 tin_) external {
        tin = tin_;
    }

    /// @notice Set tout fee (for buyGem: USDD -> USDT)
    function setTout(uint256 tout_) external {
        tout = tout_;
    }

    /// @notice Sell gem (USDT) for dai (USDD)
    /// @param usr Recipient of USDD
    /// @param gemAmt Amount of USDT to sell (6 decimals)
    function sellGem(address usr, uint256 gemAmt) external {
        // Transfer USDT from caller
        gem.safeTransferFrom(msg.sender, address(this), gemAmt);

        // Calculate USDD amount: gemAmt * 1e12 * (WAD - tin) / WAD
        uint256 daiAmt = (gemAmt * 1e12 * (WAD - tin)) / WAD;

        // Mint USDD to user
        MockERC20(address(dai)).mint(usr, daiAmt);
    }

    /// @notice Buy gem (USDT) with dai (USDD)
    /// @param usr Recipient of USDT
    /// @param gemAmt Amount of USDT to buy (6 decimals)
    function buyGem(address usr, uint256 gemAmt) external {
        // Calculate USDD needed: gemAmt * 1e12 * (WAD + tout) / WAD
        uint256 daiAmt = (gemAmt * 1e12 * (WAD + tout)) / WAD;

        // Transfer USDD from caller and burn
        dai.safeTransferFrom(msg.sender, address(this), daiAmt);
        MockERC20(address(dai)).burn(address(this), daiAmt);

        // Transfer USDT to user (must have been deposited via sellGem or minted)
        gem.safeTransfer(usr, gemAmt);
    }

    /// @notice Mint USDT to PSM (for testing - simulates liquidity)
    function mintGem(uint256 amount) external {
        MockERC20(address(gem)).mint(address(this), amount);
    }
}
