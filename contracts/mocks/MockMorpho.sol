// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Id, MarketParams, Market, Position} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import {IMorphoFlashLoanCallback} from "@morpho-org/morpho-blue/src/interfaces/IMorphoCallbacks.sol";
import {MarketParamsLib} from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";

/// @title MockMorpho
/// @notice Stateful mock of Morpho Blue for unit testing
/// @dev Tracks positions, handles flash loans with callbacks
contract MockMorpho {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;

    // ============ Storage ============

    /// @notice Market params by id
    mapping(Id => MarketParams) public marketParamsStorage;

    /// @notice Market state by id
    mapping(Id => Market) public marketStorage;

    /// @notice Positions by market id and user
    mapping(Id => mapping(address => Position)) public positionStorage;

    /// @notice Whether a market is created
    mapping(Id => bool) public marketCreated;

    /// @notice Default market ID for testing (allows any ID to work)
    Id public defaultMarketId;
    bool public useDefaultMarket;

    // ============ Setup Functions ============

    /// @notice Create a market with given params
    function createMarket(MarketParams memory params) external {
        Id id = params.id();
        require(!marketCreated[id], "Market exists");

        marketCreated[id] = true;
        marketParamsStorage[id] = params;

        // Initialize market with virtual liquidity to avoid division by zero
        marketStorage[id] = Market({
            totalSupplyAssets: 1,
            totalSupplyShares: 1,
            totalBorrowAssets: 0,
            totalBorrowShares: 0,
            lastUpdate: uint128(block.timestamp),
            fee: 0
        });
    }

    /// @notice Create a market with a specific ID (for testing with hardcoded IDs)
    /// @dev This allows mocking markets where the ID doesn't match hash(params)
    /// @dev Idempotent - if market already exists, just updates the params and default ID
    function createMarketWithId(Id id, MarketParams memory params) external {
        if (marketCreated[id]) {
            // Market already exists - update params and default ID pointer
            marketParamsStorage[id] = params;
            defaultMarketId = id;
            useDefaultMarket = true;
            return;
        }

        marketCreated[id] = true;
        marketParamsStorage[id] = params;
        defaultMarketId = id;
        useDefaultMarket = true;

        // Initialize market
        marketStorage[id] = Market({
            totalSupplyAssets: 1,
            totalSupplyShares: 1,
            totalBorrowAssets: 0,
            totalBorrowShares: 0,
            lastUpdate: uint128(block.timestamp),
            fee: 0
        });
    }

    /// @notice Set market fee
    function setFee(Id id, uint128 fee) external {
        marketStorage[id].fee = fee;
    }

    // ============ View Functions ============

    /// @dev Resolve ID - use default if set and requested ID doesn't exist
    function _resolveId(Id id) internal view returns (Id) {
        if (marketCreated[id]) return id;
        if (useDefaultMarket) return defaultMarketId;
        return id;
    }

    function market(Id id) external view returns (Market memory) {
        return marketStorage[_resolveId(id)];
    }

    function position(Id id, address user) external view returns (Position memory) {
        return positionStorage[_resolveId(id)][user];
    }

    function idToMarketParams(Id id) external view returns (MarketParams memory) {
        return marketParamsStorage[_resolveId(id)];
    }

    /// @notice Get borrow shares for a user (used by MorphoLib)
    function borrowShares(Id id, address user) external view returns (uint256) {
        return positionStorage[_resolveId(id)][user].borrowShares;
    }

    /// @notice Get supply shares for a user
    function supplyShares(Id id, address user) external view returns (uint256) {
        return positionStorage[_resolveId(id)][user].supplyShares;
    }

    /// @notice Get collateral for a user
    function collateral(Id id, address user) external view returns (uint256) {
        return positionStorage[_resolveId(id)][user].collateral;
    }

    /// @notice Required by MorphoLib - reads storage slots directly
    /// @dev LIMITATION: Returns zeros, so MorphoBalancesLib functions won't work correctly.
    ///
    /// Impact on unit tests:
    /// - expectedBorrowAssets() returns 0 or incorrect values
    /// - Tests relying on accurate debt calculation need fork tests
    ///
    /// What IS tested in unit tests:
    /// - Access control, pausable, parameter validation
    /// - Basic deposit/withdraw flow (without interest accrual)
    /// - Role management, fee settings
    ///
    /// What requires fork tests:
    /// - Accurate NAV calculation with interest
    /// - Debt rounding behavior
    /// - Full withdraw share-based repay logic
    function extSloads(bytes32[] memory) external pure returns (bytes32[] memory result) {
        result = new bytes32[](1);
        return result;
    }

    // ============ Core Functions ============

    /// @notice Supply collateral
    function supplyCollateral(
        MarketParams memory params,
        uint256 assets,
        address onBehalf,
        bytes memory /* data */
    ) external {
        Id id = _resolveId(params.id());
        require(marketCreated[id], "Market not created");

        // Transfer collateral from caller
        IERC20(params.collateralToken).safeTransferFrom(msg.sender, address(this), assets);

        // Update position
        positionStorage[id][onBehalf].collateral += uint128(assets);
    }

    /// @notice Withdraw collateral
    function withdrawCollateral(
        MarketParams memory params,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external {
        Id id = _resolveId(params.id());
        require(positionStorage[id][onBehalf].collateral >= assets, "Insufficient collateral");

        // Update position
        positionStorage[id][onBehalf].collateral -= uint128(assets);

        // Transfer collateral to receiver
        IERC20(params.collateralToken).safeTransfer(receiver, assets);
    }

    /// @notice Borrow assets
    function borrow(
        MarketParams memory params,
        uint256 assets,
        uint256 /* shares */,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed) {
        Id id = _resolveId(params.id());
        Market storage mkt = marketStorage[id];

        assetsBorrowed = assets;

        // Calculate shares (simplified: 1:1 if no existing borrows, otherwise proportional)
        if (mkt.totalBorrowAssets == 0) {
            sharesBorrowed = assets;
        } else {
            sharesBorrowed = (assets * mkt.totalBorrowShares) / mkt.totalBorrowAssets;
        }

        // Update market state
        mkt.totalBorrowAssets += uint128(assets);
        mkt.totalBorrowShares += uint128(sharesBorrowed);

        // Update position
        positionStorage[id][onBehalf].borrowShares += uint128(sharesBorrowed);

        // Transfer loan token to receiver
        IERC20(params.loanToken).safeTransfer(receiver, assets);
    }

    /// @notice Repay debt
    function repay(
        MarketParams memory params,
        uint256 assets,
        uint256 /* shares */,
        address onBehalf,
        bytes memory /* data */
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid) {
        Id id = _resolveId(params.id());
        Market storage mkt = marketStorage[id];
        Position storage pos = positionStorage[id][onBehalf];

        assetsRepaid = assets;

        // Calculate shares to burn
        if (mkt.totalBorrowAssets > 0 && mkt.totalBorrowShares > 0) {
            sharesRepaid = (assets * mkt.totalBorrowShares) / mkt.totalBorrowAssets;
        } else {
            sharesRepaid = assets;
        }

        // Cap at user's borrow shares
        if (sharesRepaid > pos.borrowShares) {
            sharesRepaid = pos.borrowShares;
            if (mkt.totalBorrowShares > 0) {
                assetsRepaid = (sharesRepaid * mkt.totalBorrowAssets) / mkt.totalBorrowShares;
            }
        }

        // Transfer loan token from caller
        IERC20(params.loanToken).safeTransferFrom(msg.sender, address(this), assetsRepaid);

        // Update market state
        mkt.totalBorrowAssets -= uint128(assetsRepaid);
        mkt.totalBorrowShares -= uint128(sharesRepaid);

        // Update position
        pos.borrowShares -= uint128(sharesRepaid);
    }

    /// @notice Execute flash loan
    function flashLoan(
        address token,
        uint256 assets,
        bytes calldata data
    ) external {
        // Transfer tokens to caller
        IERC20(token).safeTransfer(msg.sender, assets);

        // Call the callback
        IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);

        // Verify tokens were returned
        // In real Morpho, this is implicit via balance check
        // Here we explicitly transfer back
        IERC20(token).safeTransferFrom(msg.sender, address(this), assets);
    }

    // ============ Helper Functions for Testing ============

    /// @notice Mint loan tokens to Morpho (simulates liquidity)
    function mintLoanToken(address token, uint256 amount) external {
        // Assumes token is MockERC20
        (bool success,) = token.call(abi.encodeWithSignature("mint(address,uint256)", address(this), amount));
        require(success, "Mint failed");
    }

    /// @notice Set position directly for testing
    function setPosition(
        Id id,
        address user,
        uint256 collateral_,
        uint128 borrowShares_
    ) external {
        positionStorage[id][user].collateral = uint128(collateral_);
        positionStorage[id][user].borrowShares = borrowShares_;
    }

    /// @notice Set market state directly for testing
    function setMarketState(
        Id id,
        uint128 totalBorrowAssets_,
        uint128 totalBorrowShares_
    ) external {
        marketStorage[id].totalBorrowAssets = totalBorrowAssets_;
        marketStorage[id].totalBorrowShares = totalBorrowShares_;
    }
}
