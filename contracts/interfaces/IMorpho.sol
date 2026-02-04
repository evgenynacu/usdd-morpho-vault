// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.20;

/// @notice Type definition for market ID
type Id is bytes32;

/// @notice Contains the `loanToken` and `collateralToken` addresses, `oracle`, `irm`, and `lltv`.
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @notice Contains the `supplyShares`, `borrowShares`, and `collateral` of a user.
struct Position {
    uint256 supplyShares;
    uint128 borrowShares;
    uint128 collateral;
}

/// @notice Contains the market state data.
struct Market {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

/// @title IMorpho
/// @notice Interface for the Morpho Blue protocol at 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
interface IMorpho {
    /// @notice Supplies `assets` or `shares` to the given market on behalf of `onBehalf`.
    /// @param marketParams The market parameters.
    /// @param assets The amount of assets to supply. Pass 0 to supply shares.
    /// @param shares The amount of shares to mint. Pass 0 to supply assets.
    /// @param onBehalf The address that will receive the supply position.
    /// @param data Arbitrary data to pass to the `onMorphoSupply` callback. Pass empty data if not needed.
    /// @return assetsSupplied The amount of assets supplied.
    /// @return sharesSupplied The amount of shares minted.
    function supply(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied);

    /// @notice Withdraws `assets` or `shares` from the given market on behalf of `onBehalf` to `receiver`.
    /// @param marketParams The market parameters.
    /// @param assets The amount of assets to withdraw. Pass 0 to withdraw shares.
    /// @param shares The amount of shares to burn. Pass 0 to withdraw assets.
    /// @param onBehalf The address of the owner of the supply position.
    /// @param receiver The address that will receive the withdrawn assets.
    /// @return assetsWithdrawn The amount of assets withdrawn.
    /// @return sharesWithdrawn The amount of shares burned.
    function withdraw(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);

    /// @notice Supplies `assets` of collateral to the given market on behalf of `onBehalf`.
    /// @param marketParams The market parameters.
    /// @param assets The amount of collateral to supply.
    /// @param onBehalf The address that will receive the collateral position.
    /// @param data Arbitrary data to pass to the `onMorphoSupplyCollateral` callback. Pass empty data if not needed.
    function supplyCollateral(
        MarketParams memory marketParams,
        uint256 assets,
        address onBehalf,
        bytes memory data
    ) external;

    /// @notice Withdraws `assets` of collateral from the given market on behalf of `onBehalf` to `receiver`.
    /// @param marketParams The market parameters.
    /// @param assets The amount of collateral to withdraw.
    /// @param onBehalf The address of the owner of the collateral position.
    /// @param receiver The address that will receive the collateral assets.
    function withdrawCollateral(
        MarketParams memory marketParams,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external;

    /// @notice Borrows `assets` or `shares` from the given market on behalf of `onBehalf` to `receiver`.
    /// @param marketParams The market parameters.
    /// @param assets The amount of assets to borrow. Pass 0 to borrow shares.
    /// @param shares The amount of shares to mint. Pass 0 to borrow assets.
    /// @param onBehalf The address that will own the borrow position.
    /// @param receiver The address that will receive the borrowed assets.
    /// @return assetsBorrowed The amount of assets borrowed.
    /// @return sharesBorrowed The amount of shares minted.
    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    /// @notice Repays `assets` or `shares` to the given market on behalf of `onBehalf`.
    /// @param marketParams The market parameters.
    /// @param assets The amount of assets to repay. Pass 0 to repay shares.
    /// @param shares The amount of shares to burn. Pass 0 to repay assets.
    /// @param onBehalf The address of the owner of the borrow position.
    /// @param data Arbitrary data to pass to the `onMorphoRepay` callback. Pass empty data if not needed.
    /// @return assetsRepaid The amount of assets repaid.
    /// @return sharesRepaid The amount of shares burned.
    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);

    /// @notice Flash loans `assets` of `token` to the caller.
    /// @dev The flash loan fee is 0.
    /// @param token The token to flash loan.
    /// @param assets The amount of assets to flash loan.
    /// @param data Arbitrary data to pass to the `onMorphoFlashLoan` callback.
    function flashLoan(
        address token,
        uint256 assets,
        bytes calldata data
    ) external;

    /// @notice Liquidates the given `borrower` on the given market.
    /// @param marketParams The market parameters.
    /// @param borrower The address of the borrower to liquidate.
    /// @param seizedAssets The amount of collateral to seize. Pass 0 to seize by repaid shares.
    /// @param repaidShares The amount of shares to repay. Pass 0 to repay by seized assets.
    /// @param data Arbitrary data to pass to the `onMorphoLiquidate` callback. Pass empty data if not needed.
    /// @return The amount of collateral seized.
    /// @return The amount of debt repaid.
    function liquidate(
        MarketParams memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes memory data
    ) external returns (uint256, uint256);

    /// @notice Sets the authorization for `authorized` to manage `authorizer`'s positions.
    /// @param authorized The address to authorize.
    /// @param newIsAuthorized The new authorization status.
    function setAuthorization(address authorized, bool newIsAuthorized) external;

    /// @notice Returns the market state for the given market.
    /// @param id The market id.
    /// @return m The market state.
    function market(Id id) external view returns (Market memory m);

    /// @notice Returns the position of `user` in the given market.
    /// @param id The market id.
    /// @param user The user address.
    /// @return p The position of `user`.
    function position(Id id, address user) external view returns (Position memory p);

    /// @notice Returns the market params for the given market id.
    /// @param id The market id.
    /// @return The market params.
    function idToMarketParams(Id id) external view returns (MarketParams memory);

    /// @notice Returns whether `authorized` is authorized to manage `authorizer`'s positions.
    /// @param authorizer The authorizer address.
    /// @param authorized The authorized address.
    /// @return True if authorized, false otherwise.
    function isAuthorized(address authorizer, address authorized) external view returns (bool);

    /// @notice Returns the borrow shares of `user` in the given market.
    /// @param id The market id.
    /// @param user The user address.
    /// @return The borrow shares of `user`.
    function borrowShares(Id id, address user) external view returns (uint256);

    /// @notice Returns the supply shares of `user` in the given market.
    /// @param id The market id.
    /// @param user The user address.
    /// @return The supply shares of `user`.
    function supplyShares(Id id, address user) external view returns (uint256);

    /// @notice Returns the collateral of `user` in the given market.
    /// @param id The market id.
    /// @param user The user address.
    /// @return The collateral of `user`.
    function collateral(Id id, address user) external view returns (uint256);
}

/// @title IMorphoFlashLoanCallback
/// @notice Interface that users willing to use `flashLoan`'s callback must implement.
interface IMorphoFlashLoanCallback {
    /// @notice Callback called when a flash loan occurs.
    /// @dev The callback is called only if data is not empty.
    /// @param assets The amount of assets that was flash loaned.
    /// @param data Arbitrary data passed to the `flashLoan` function.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

/// @title MarketParamsLib
/// @notice Library to convert MarketParams to Id
library MarketParamsLib {
    /// @notice Returns the id of the market `marketParams`.
    function id(MarketParams memory marketParams) internal pure returns (Id) {
        return Id.wrap(keccak256(abi.encode(marketParams)));
    }
}
