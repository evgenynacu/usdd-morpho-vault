// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPSM
 * @notice Interface for the USDD Peg Stability Module (PSM) at 0xcE355440c00014A229bbEc030A2B8f8EB45a2897
 * @dev Based on MakerDAO's dss-psm design (https://github.com/makerdao/dss-psm)
 *
 * The PSM allows 1:1 swaps between USDT and USDD (minus fees):
 * - sellGem: USDT -> USDD (user receives USDD minus tin fee)
 * - buyGem: USDD -> USDT (user pays USDD plus tout fee)
 *
 * Fee calculation:
 * - sellGem: daiOut = gemAmt - (gemAmt * tin / WAD)
 * - buyGem: daiIn = gemAmt + (gemAmt * tout / WAD)
 *
 * Usage:
 * - Before sellGem: gem.approve(gemJoin, amount)
 * - Before buyGem: dai.approve(psm, amount + fee)
 */
interface IPSM {
    // ============ Events ============

    /// @notice Emitted when authorization is granted to an address
    event Rely(address indexed usr);

    /// @notice Emitted when authorization is revoked from an address
    event Deny(address indexed usr);

    /// @notice Emitted when a parameter is updated
    event File(bytes32 indexed what, uint256 data);

    /// @notice Emitted when gems are sold for DAI/USDD
    /// @param owner The address receiving the DAI/USDD
    /// @param value The amount of gems sold (in gem decimals)
    /// @param fee The fee charged (in 18 decimals)
    event SellGem(address indexed owner, uint256 value, uint256 fee);

    /// @notice Emitted when gems are bought with DAI/USDD
    /// @param owner The address receiving the gems
    /// @param value The amount of gems bought (in gem decimals)
    /// @param fee The fee charged (in 18 decimals)
    event BuyGem(address indexed owner, uint256 value, uint256 fee);

    // ============ View Functions ============

    /// @notice Returns the Vat contract address
    function vat() external view returns (address);

    /// @notice Returns the GemJoin adapter contract address
    /// @dev Approve gems to this address before calling sellGem
    function gemJoin() external view returns (address);

    /// @notice Returns the DAI/USDD token contract address
    function dai() external view returns (address);

    /// @notice Returns the DaiJoin adapter contract address
    function daiJoin() external view returns (address);

    /// @notice Returns the collateral type identifier
    function ilk() external view returns (bytes32);

    /// @notice Returns the surplus recipient address (vow)
    function vow() external view returns (address);

    /// @notice Returns the fee for selling gems (tin)
    /// @dev Fee in WAD (18 decimals). 1% = 0.01e18 = 10000000000000000
    /// @return Fee rate where WAD (1e18) = 100%
    function tin() external view returns (uint256);

    /// @notice Returns the fee for buying gems (tout)
    /// @dev Fee in WAD (18 decimals). 1% = 0.01e18 = 10000000000000000
    /// @return Fee rate where WAD (1e18) = 100%
    function tout() external view returns (uint256);

    /// @notice Returns the authorization status for an address
    /// @param usr The address to check
    /// @return 1 if authorized, 0 otherwise
    function wards(address usr) external view returns (uint256);

    // ============ Core Functions ============

    /**
     * @notice Sell gems (USDT) for DAI/USDD
     * @dev Swaps gems at 1:1 rate minus the tin fee
     *
     * Prerequisites:
     * - Caller must approve gemJoin for gemAmt of the gem token
     *
     * Fee calculation:
     * - fee = gemAmt * tin / WAD
     * - daiReceived = gemAmt - fee (in 18 decimals)
     *
     * Example (1% tin fee, 100 USDT):
     * - gemAmt = 100e6 (USDT has 6 decimals)
     * - fee = 100e18 * 0.01e18 / 1e18 = 1e18
     * - daiReceived = 100e18 - 1e18 = 99e18 USDD
     *
     * @param usr The address to receive the DAI/USDD
     * @param gemAmt The amount of gems to sell (in gem decimals, e.g., 6 for USDT)
     */
    function sellGem(address usr, uint256 gemAmt) external;

    /**
     * @notice Buy gems (USDT) with DAI/USDD
     * @dev Swaps DAI/USDD for gems at 1:1 rate plus the tout fee
     *
     * Prerequisites:
     * - Caller must approve PSM contract for (gemAmt + fee) of DAI/USDD
     *
     * Fee calculation:
     * - fee = gemAmt * tout / WAD
     * - daiRequired = gemAmt + fee (in 18 decimals)
     *
     * Example (1% tout fee, 100 USDT):
     * - gemAmt = 100e6 (USDT has 6 decimals)
     * - fee = 100e18 * 0.01e18 / 1e18 = 1e18
     * - daiRequired = 100e18 + 1e18 = 101e18 USDD
     *
     * @param usr The address to receive the gems
     * @param gemAmt The amount of gems to buy (in gem decimals, e.g., 6 for USDT)
     */
    function buyGem(address usr, uint256 gemAmt) external;

    // ============ Admin Functions ============

    /// @notice Grant authorization to an address
    /// @param usr The address to authorize
    function rely(address usr) external;

    /// @notice Revoke authorization from an address
    /// @param usr The address to deauthorize
    function deny(address usr) external;

    /// @notice Update a parameter (tin or tout)
    /// @param what The parameter name ("tin" or "tout")
    /// @param data The new value
    function file(bytes32 what, uint256 data) external;

    /// @notice Allow an address to transfer vat balance
    /// @param usr The address to allow
    function hope(address usr) external;

    /// @notice Disallow an address from transferring vat balance
    /// @param usr The address to disallow
    function nope(address usr) external;
}
