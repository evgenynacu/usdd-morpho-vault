// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IMorpho, Id, MarketParams, Market, Position} from "@morpho-org/morpho-blue/src/interfaces/IMorpho.sol";
import {IMorphoFlashLoanCallback} from "@morpho-org/morpho-blue/src/interfaces/IMorphoCallbacks.sol";
import {MarketParamsLib} from "@morpho-org/morpho-blue/src/libraries/MarketParamsLib.sol";
import {MorphoBalancesLib} from "@morpho-org/morpho-blue/src/libraries/periphery/MorphoBalancesLib.sol";
import {SharesMathLib} from "@morpho-org/morpho-blue/src/libraries/SharesMathLib.sol";
import "./interfaces/IPSM.sol";
import "./libraries/Constants.sol";
import "./libraries/SwapHelper.sol";

/// @title SUSDDVault
/// @notice Leveraged ERC4626 vault: USDT deposits → leveraged sUSDD position in Morpho Blue
/// @dev Users deposit USDT, vault creates leveraged sUSDD/USDT position using flash loans
contract SUSDDVault is
    Initializable,
    ERC4626Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    IMorphoFlashLoanCallback
{
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;
    using SharesMathLib for uint256;

    // ============ Roles ============

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ============ Storage ============

    /// @notice Target LTV for new deposits (in WAD, e.g., 0.75e18 = 75%)
    uint256 public targetLTV;

    /// @notice Performance fee in basis points (e.g., 1000 = 10%)
    uint256 public performanceFeeBps;

    /// @notice High water mark for performance fee calculation (USDT value per share in WAD)
    uint256 public highWaterMark;

    /// @notice Recipient of performance fees
    address public feeRecipient;

    /// @notice Maximum total assets (TVL cap) in USDT
    uint256 public maxTotalAssets;

    /// @notice Cached Morpho market params
    MarketParams public marketParams;

    // ============ Whitelist ============

    /// @notice If true, only whitelisted addresses can deposit/redeem
    bool public whitelistEnabled;

    /// @notice Addresses allowed when whitelist is enabled
    mapping(address => bool) public whitelisted;

    // ============ Merkl Rewards ============

    /// @notice Merkl distributor contract address
    address public merklDistributor;

    /// @notice Storage gap for future upgrades
    uint256[47] private __gap;

    // ============ Constants ============

    uint256 private constant MAX_BPS = 10000;
    uint256 private constant MAX_PERFORMANCE_FEE_BPS = 3000; // 30% max
    uint256 private constant MAX_LTV = 0.9e18; // 90% max (below LLTV)

    /// @notice Special value for targetLTV meaning "idle USDT mode" (no position)
    /// @dev When targetLTV = IDLE_MODE:
    ///      - Deposits stay as idle USDT
    ///      - rebalance(IDLE_MODE) converts everything to idle USDT
    uint256 public constant IDLE_MODE = type(uint256).max;

    // Flash loan operation types
    uint8 private constant OP_DEPOSIT = 1;
    uint8 private constant OP_WITHDRAW = 2;
    uint8 private constant OP_LEVER_UP = 3;
    uint8 private constant OP_DELEVER = 4;

    // ============ Events ============

    event TargetLTVUpdated(uint256 oldLTV, uint256 newLTV);
    event PerformanceFeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeRecipientUpdated(address oldRecipient, address newRecipient);
    event MaxTotalAssetsUpdated(uint256 oldMax, uint256 newMax);
    event Rebalanced(uint256 oldLTV, uint256 newLTV, uint256 collateralBefore, uint256 debtBefore);
    event PerformanceFeeAccrued(uint256 feeShares, address indexed recipient);
    event WhitelistEnabledUpdated(bool enabled);
    event AddedToWhitelist(address indexed account);
    event RemovedFromWhitelist(address indexed account);
    event MerklDistributorUpdated(address oldDistributor, address newDistributor);
    event RewardsClaimed(uint256 usddReceived);

    /// @notice Vault state snapshot for Dune dashboard tracking
    /// @dev Emitted after deposit, redeem, rebalance, harvestFees
    event VaultSnapshot(uint256 totalAssets, uint256 totalSupply, uint256 pricePerShare, uint256 timestamp);

    // ============ Errors ============

    error InvalidLTV();
    error LTVExceedsLLTV();
    error InvalidFee();
    error InvalidRecipient();
    error MaxTotalAssetsExceeded();
    error FlashLoanCallbackFailed();
    error UnauthorizedCallback();
    error ZeroNAV();
    error DepositTooSmall();
    error NotWhitelisted(address account);
    error InvalidAdmin();
    error InvalidMerklDistributor();
    error NoRewardsReceived();
    error MerklClaimFailed();
    error NotSupported();

    // ============ Constructor & Initializer ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the vault (called once via proxy)
    /// @param _admin Address to receive all admin roles
    /// @param _feeRecipient Address to receive performance fees
    /// @param _targetLTV Target loan-to-value ratio (WAD), IDLE_MODE, or 0
    /// @param _performanceFeeBps Performance fee in basis points
    /// @param _maxTotalAssets Maximum total assets (TVL cap)
    function initialize(
        address _admin,
        address _feeRecipient,
        uint256 _targetLTV,
        uint256 _performanceFeeBps,
        uint256 _maxTotalAssets
    ) external initializer {
        // Validate before init
        if (_admin == address(0)) revert InvalidAdmin();
        if (_performanceFeeBps > MAX_PERFORMANCE_FEE_BPS) revert InvalidFee();
        if (_feeRecipient == address(0)) revert InvalidRecipient();

        // Initialize parent contracts (order matters for linearization)
        __ERC20_init("Leveraged sUSDD Vault", "lsUSDD");
        __ERC4626_init(IERC20(Constants.USDT));
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        // Cache market params (needed for LTV validation)
        IMorpho morpho = IMorpho(Constants.MORPHO);
        marketParams = morpho.idToMarketParams(Id.wrap(Constants.MARKET_ID));

        // Validate LTV: allow IDLE_MODE, 0 (unleveraged sUSDD), or valid leverage ratio
        if (_targetLTV != IDLE_MODE && _targetLTV != 0) {
            if (_targetLTV > MAX_LTV) revert InvalidLTV();
            if (_targetLTV >= marketParams.lltv) revert LTVExceedsLLTV();
        }

        // Setup roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
        _grantRole(MANAGER_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);

        // Initialize storage
        targetLTV = _targetLTV;
        performanceFeeBps = _performanceFeeBps;
        feeRecipient = _feeRecipient;
        maxTotalAssets = _maxTotalAssets;
        highWaterMark = 1e18; // Start at 1:1
        whitelistEnabled = true; // Whitelist active by default

        // Authorize Morpho to pull tokens
        IERC20(Constants.USDT).forceApprove(Constants.MORPHO, type(uint256).max);
        IERC20(Constants.SUSDD).forceApprove(Constants.MORPHO, type(uint256).max);
    }

    // ============ ERC4626 View Functions ============

    /// @notice Total assets under management in USDT terms
    /// @dev NAV = idle USDT + (sUSDD collateral value) - USDT debt
    /// @dev Uses MorphoBalancesLib to get expected debt including accrued interest
    function totalAssets() public view override returns (uint256) {
        // Idle USDT balance
        uint256 idleUsdt = IERC20(Constants.USDT).balanceOf(address(this));

        // Get position from Morpho
        IMorpho morpho = IMorpho(Constants.MORPHO);
        Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

        // Calculate debt in USDT using expected value (includes accrued interest)
        uint256 debtUsdt = morpho.expectedBorrowAssets(marketParams, address(this));

        // Calculate collateral value in USDT
        uint256 collateralUsdt = SwapHelper.getUSDTValue(pos.collateral);

        // NAV = idle + collateral value - debt
        if (collateralUsdt + idleUsdt > debtUsdt) {
            return idleUsdt + collateralUsdt - debtUsdt;
        }
        return 0; // Underwater (shouldn't happen with proper LTV management)
    }

    /// @notice Maximum deposit amount
    /// @dev Returns 0 if paused, TVL cap reached, underwater, or receiver not whitelisted
    function maxDeposit(address receiver) public view override returns (uint256) {
        if (paused()) return 0;

        // Whitelist check: if enabled, receiver must be whitelisted
        if (whitelistEnabled && !whitelisted[receiver]) return 0;

        uint256 currentAssets = totalAssets();

        // Underwater check: NAV=0 but shares exist → deposits blocked
        if (currentAssets == 0 && totalSupply() > 0) return 0;

        if (currentAssets >= maxTotalAssets) return 0;
        return maxTotalAssets - currentAssets;
    }

    /// @notice Maximum mint amount (returns 0 - mint not supported)
    function maxMint(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Maximum withdraw amount (returns 0 - withdraw not supported)
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Maximum redeem amount
    /// @dev Returns 0 if owner not whitelisted (when whitelist enabled)
    function maxRedeem(address owner) public view override returns (uint256) {
        if (whitelistEnabled && !whitelisted[owner]) return 0;
        return balanceOf(owner);
    }

    /// @notice Preview shares for deposit (Delta NAV approach)
    /// @dev Calculates expected NAV increase accounting for PSM fees and leverage
    /// @dev Returns 0 if vault is underwater (NAV=0 but supply>0) - deposits blocked
    function previewDeposit(uint256 assets) public view override returns (uint256) {
        if (assets == 0) return 0;

        uint256 nav = totalAssets();
        uint256 supply = totalSupply();

        if (supply == 0) {
            // First deposit: shares = estimated value
            return _estimateDepositValue(assets);
        }

        // Underwater check: NAV=0 but shares exist → deposits not possible
        if (nav == 0) return 0;

        // Delta NAV: shares proportional to value added
        uint256 estimatedValueAdded = _estimateDepositValue(assets);
        return (estimatedValueAdded * supply) / nav;
    }

    /// @notice Preview mint returns 0 (mint not supported)
    function previewMint(uint256) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Preview withdraw returns 0 (withdraw not supported)
    function previewWithdraw(uint256) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Convert assets to shares (consistent with Delta NAV)
    function convertToShares(uint256 assets) public view override returns (uint256) {
        return previewDeposit(assets);
    }

    // ============ ERC4626 Disabled ============

    /// @notice Mint is not supported - use deposit() instead
    /// @dev Delta NAV approach makes exact share minting impractical.
    function mint(uint256, address) public pure override returns (uint256) {
        revert NotSupported();
    }

    /// @notice Withdraw is not supported - use redeem() instead
    /// @dev With proportional withdrawal, specifying exact assets is impractical.
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert NotSupported();
    }

    // ============ Deposit ============

    /// @notice Deposit USDT and build leveraged position
    /// @dev Uses DELTA NAV approach: shares are calculated based on actual NAV increase,
    ///      not the deposited amount. This protects existing holders from PSM fee dilution.
    function _deposit(address caller, address receiver, uint256 assets, uint256 /* shares */)
        internal
        override
        nonReentrant
        whenNotPaused
    {
        // 0. Accrue performance fee before deposit (returns cached nav/supply)
        (uint256 navBefore, uint256 supplyBefore) = _accruePerformanceFee();

        if (assets + navBefore > maxTotalAssets) revert MaxTotalAssetsExceeded();

        // Block deposits if vault is underwater (NAV=0 but shares exist)
        // This prevents dilution of existing holders
        if (supplyBefore > 0 && navBefore == 0) revert ZeroNAV();

        // Check whitelist (both caller and receiver must be whitelisted)
        if (whitelistEnabled) {
            if (!whitelisted[caller]) revert NotWhitelisted(caller);
            if (!whitelisted[receiver]) revert NotWhitelisted(receiver);
        }

        // 2. Transfer USDT from caller
        SafeERC20.safeTransferFrom(IERC20(Constants.USDT), caller, address(this), assets);

        // 3. Build position based on targetLTV mode
        // IDLE_MODE: stay as idle USDT
        // 0: convert to sUSDD without leverage (unleveraged yield)
        // >0: build leveraged position
        if (targetLTV != IDLE_MODE && assets > 0) {
            _buildPosition(assets);
        }

        // 4. Snapshot NAV AFTER
        uint256 navAfter = totalAssets();

        // 5. Calculate shares based on ACTUAL value added (Delta NAV)
        uint256 actualShares;
        if (supplyBefore == 0) {
            // First deposit: use actual NAV as shares (1:1 value)
            actualShares = navAfter;
        } else {
            // Subsequent deposits: shares proportional to value added
            uint256 valueAdded = navAfter > navBefore ? navAfter - navBefore : 0;
            actualShares = (valueAdded * supplyBefore) / navBefore;
        }

        // No fallback: if shares=0, reject the deposit (protects existing holders)
        // This can happen due to rounding on very small deposits
        if (actualShares == 0 && assets > 0) revert DepositTooSmall();

        // 6. Mint shares based on actual value contribution
        _mint(receiver, actualShares);

        emit Deposit(caller, receiver, assets, actualShares);
        _emitSnapshot(navAfter, supplyBefore + actualShares);
    }

    /// @notice Estimate the NAV increase from depositing assets
    /// @dev Assumes PSM tin/tout = 0 (see requirements.md "PSM Fee Assumption")
    function _estimateDepositValue(uint256 assets) internal view returns (uint256) {
        if (targetLTV == IDLE_MODE) {
            // Idle mode: USDT stays idle, value = assets
            return assets;
        }

        if (targetLTV == 0) {
            // Unleveraged sUSDD: convert to sUSDD, no borrowing
            uint256 unleveragedSusdd = SwapHelper.previewSwapUSDTtoSUSDD(assets);
            return SwapHelper.getUSDTValue(unleveragedSusdd);
        }

        // With leverage:
        // borrowAmount = assets * LTV / (1 - LTV)
        // totalUSDT = assets + borrowAmount = assets / (1 - LTV)
        // sUSDD = swap(totalUSDT)
        // NAV increase = sUSDD_value - borrowAmount

        uint256 borrowAmount = (assets * targetLTV) / (Constants.WAD - targetLTV);
        uint256 totalUsdt = assets + borrowAmount;

        uint256 susddAmount = SwapHelper.previewSwapUSDTtoSUSDD(totalUsdt);
        uint256 susddValue = SwapHelper.getUSDTValue(susddAmount);

        // NAV increase = collateral value - debt
        if (susddValue > borrowAmount) {
            return susddValue - borrowAmount;
        }
        return 0;
    }

    /// @notice Build leveraged position from deposited USDT
    function _buildPosition(uint256 depositedUsdt) internal {
        // Calculate how much to borrow for target LTV
        // totalCollateralValue = depositedUsdt / (1 - targetLTV)
        // borrowAmount = totalCollateralValue * targetLTV = depositedUsdt * targetLTV / (1 - targetLTV)
        uint256 borrowAmount = (depositedUsdt * targetLTV) / (Constants.WAD - targetLTV);

        if (borrowAmount == 0) {
            // No leverage needed, just convert USDT to sUSDD and supply as collateral
            uint256 susddAmount = SwapHelper.swapUSDTtoSUSDD(depositedUsdt);
            IMorpho(Constants.MORPHO).supplyCollateral(marketParams, susddAmount, address(this), "");
            return;
        }

        // Use flash loan to build position atomically
        bytes memory data = abi.encode(OP_DEPOSIT, depositedUsdt);
        IMorpho(Constants.MORPHO).flashLoan(Constants.USDT, borrowAmount, data);
    }

    /// @notice Handle deposit flash loan callback
    function _handleDepositCallback(uint256 flashLoanAmount, uint256 depositedUsdt) internal {
        // Total USDT available = deposited + flash loan
        uint256 totalUsdt = depositedUsdt + flashLoanAmount;

        // Convert all USDT to sUSDD
        uint256 susddAmount = SwapHelper.swapUSDTtoSUSDD(totalUsdt);

        // Supply sUSDD as collateral
        IMorpho morpho = IMorpho(Constants.MORPHO);
        morpho.supplyCollateral(marketParams, susddAmount, address(this), "");

        // Borrow USDT to repay flash loan
        morpho.borrow(marketParams, flashLoanAmount, 0, address(this), address(this));
    }

    // ============ Withdraw ============

    /// @notice Redeem shares for USDT
    /// @dev Proportional withdrawal - user receives their share of idle USDT + position equity
    /// @param shares Amount of shares to burn
    /// @param receiver Address to receive USDT
    /// @param owner Address that owns the shares
    /// @return assets Actual USDT amount transferred
    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256)
    {
        // Accrue performance fee before withdrawal (returns cached supply)
        (, uint256 supplyBefore) = _accruePerformanceFee();

        uint256 maxShares = maxRedeem(owner);
        if (shares > maxShares) {
            revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);
        }

        address caller = _msgSender();
        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }

        // Check whitelist (both owner and receiver must be whitelisted)
        if (whitelistEnabled) {
            if (!whitelisted[owner]) revert NotWhitelisted(owner);
            if (!whitelisted[receiver]) revert NotWhitelisted(receiver);
        }

        // Calculate withdrawal ratio BEFORE burning (shares-based, no NAV needed)
        uint256 withdrawRatio = (shares * Constants.WAD) / supplyBefore;

        // Burn shares
        _burn(owner, shares);

        // Unwind position and get actual USDT amount
        uint256 assets = _unwindPosition(withdrawRatio, receiver);

        emit Withdraw(caller, receiver, owner, assets, shares);
        _emitSnapshot(totalAssets(), supplyBefore - shares);

        return assets;
    }

    /// @notice Unwind position to withdraw USDT
    /// @dev Uses PROPORTIONAL withdrawal for fairness: both idle USDT and position
    ///      are withdrawn in the same ratio. This ensures all users pay similar
    ///      gas/fees regardless of withdrawal order.
    /// @param withdrawRatio Proportion to withdraw (in WAD), calculated from shares
    /// @return assets Actual USDT amount transferred to receiver
    function _unwindPosition(uint256 withdrawRatio, address receiver) internal returns (uint256) {
        uint256 balanceBefore = IERC20(Constants.USDT).balanceOf(address(this));
        uint256 idleToWithdraw = (balanceBefore * withdrawRatio) / Constants.WAD;

        IMorpho morpho = IMorpho(Constants.MORPHO);
        Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

        // Proportionally unwind position (if exists)
        if (pos.collateral > 0) {
            uint256 sharesToRepay = (uint256(pos.borrowShares) * withdrawRatio) / Constants.WAD;
            uint256 collateralToWithdraw = (uint256(pos.collateral) * withdrawRatio) / Constants.WAD;

            if (sharesToRepay > 0 && collateralToWithdraw > 0) {
                // Both debt and collateral to withdraw - use flash loan
                (,, uint256 totalBorrowAssets, uint256 totalBorrowShares) = morpho.expectedMarketBalances(marketParams);
                uint256 flashLoanAmount = sharesToRepay.toAssetsUp(totalBorrowAssets, totalBorrowShares);

                bytes memory data = abi.encode(OP_WITHDRAW, sharesToRepay, collateralToWithdraw);
                morpho.flashLoan(Constants.USDT, flashLoanAmount, data);
            } else if (collateralToWithdraw > 0 && pos.borrowShares == 0) {
                // No debt at all, safe to just withdraw collateral
                morpho.withdrawCollateral(marketParams, collateralToWithdraw, address(this), address(this));
                SwapHelper.swapSUSDDtoUSDT(collateralToWithdraw);
            }
            // Edge cases where we skip position unwind (user gets only idle portion):
            // - sharesToRepay=0, collateralToWithdraw>0, debt exists → protects LTV
            // - sharesToRepay>0, collateralToWithdraw=0 → can't repay flash loan without collateral
            // - both round to 0 → nothing to unwind
        }

        // Transfer proportional idle + net gain from position unwind
        uint256 balanceAfter = IERC20(Constants.USDT).balanceOf(address(this));
        uint256 gainFromPosition = balanceAfter > balanceBefore ? balanceAfter - balanceBefore : 0;
        uint256 toTransfer = idleToWithdraw + gainFromPosition;
        IERC20(Constants.USDT).safeTransfer(receiver, toTransfer);

        return toTransfer;
    }

    /// @notice Handle withdraw flash loan callback
    /// @param sharesToRepay Exact borrow shares to repay (calculated proportionally)
    /// @param collateralToWithdraw Exact collateral to withdraw (calculated proportionally)
    function _handleWithdrawCallback(uint256 sharesToRepay, uint256 collateralToWithdraw) internal {
        IMorpho morpho = IMorpho(Constants.MORPHO);

        // Repay debt by shares - works for both full and partial withdrawal
        // Full: sharesToRepay = all shares, Partial: sharesToRepay = shares * ratio
        if (sharesToRepay > 0) {
            morpho.repay(marketParams, 0, sharesToRepay, address(this), "");
        }

        // Withdraw collateral
        if (collateralToWithdraw > 0) {
            morpho.withdrawCollateral(marketParams, collateralToWithdraw, address(this), address(this));
            SwapHelper.swapSUSDDtoUSDT(collateralToWithdraw);
        }

        // Flash loan will be repaid from the USDT we got
    }

    // ============ Rebalance (Keeper) ============

    /// @notice Rebalance the position to a new target LTV
    /// @dev targetLTV modes:
    ///      - IDLE_MODE: Exit to idle USDT (withdraw all collateral, repay all debt)
    ///      - 0: Unleveraged sUSDD (repay all debt, keep/build sUSDD collateral)
    ///      - 1..MAX_LTV: Leveraged position
    /// @param newTargetLTV New LTV target
    function rebalance(uint256 newTargetLTV) external onlyRole(KEEPER_ROLE) whenNotPaused nonReentrant {
        // Validate LTV (allow IDLE_MODE, 0, or valid leverage ratio)
        if (newTargetLTV != IDLE_MODE && newTargetLTV != 0) {
            if (newTargetLTV > MAX_LTV) revert InvalidLTV();
            if (newTargetLTV >= marketParams.lltv) revert LTVExceedsLLTV();
        }

        // Accrue fee and cache nav/supply
        (uint256 navCached, uint256 supply) = _accruePerformanceFee();

        IMorpho morpho = IMorpho(Constants.MORPHO);
        Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));
        uint256 debtBefore = morpho.expectedBorrowAssets(marketParams, address(this));
        uint256 collateralBefore = pos.collateral;

        // Check for underwater position BEFORE updating state (true no-op)
        // Underwater = idle + collateral value <= debt
        if (debtBefore > 0 && navCached == 0) {
            // Underwater - cannot rebalance, don't change state
            return;
        }

        // Update state only after underwater check passes
        uint256 oldTargetLTV = targetLTV;
        targetLTV = newTargetLTV;

        emit TargetLTVUpdated(oldTargetLTV, newTargetLTV);

        // IDLE_MODE: Full exit to USDT
        if (newTargetLTV == IDLE_MODE) {
            _exitToIdleUsdt(pos, debtBefore);
            emit Rebalanced(oldTargetLTV, newTargetLTV, collateralBefore, debtBefore);
            _emitSnapshot(totalAssets(), supply);
            return;
        }

        // LTV = 0: Unleveraged sUSDD mode
        if (newTargetLTV == 0) {
            _transitionToUnleveraged(pos, debtBefore);
            emit Rebalanced(oldTargetLTV, newTargetLTV, collateralBefore, debtBefore);
            _emitSnapshot(totalAssets(), supply);
            return;
        }

        // LTV > 0: Leveraged mode
        if (navCached == 0) {
            // Underwater or no assets - cannot rebalance
            emit Rebalanced(oldTargetLTV, newTargetLTV, collateralBefore, debtBefore);
            _emitSnapshot(navCached, supply);
            return;
        }

        // Calculate target debt for new LTV
        // targetDebt = nav * targetLTV / (1 - targetLTV)
        uint256 targetDebt = (navCached * newTargetLTV) / (Constants.WAD - newTargetLTV);

        if (targetDebt > debtBefore) {
            // Lever up: borrow more, add collateral (also deploys idle USDT)
            uint256 additionalDebt = targetDebt - debtBefore;
            _leverUp(additionalDebt);
        } else if (targetDebt < debtBefore) {
            // Delever: repay debt, remove collateral
            uint256 debtToRepay = debtBefore - targetDebt;
            _delever(debtToRepay, false);
        }

        emit Rebalanced(oldTargetLTV, newTargetLTV, collateralBefore, debtBefore);
        _emitSnapshot(totalAssets(), supply);
    }

    /// @notice Exit completely to idle USDT
    function _exitToIdleUsdt(Position memory pos, uint256 currentDebt) internal {
        if (currentDebt > 0) {
            // Has debt - full delever (repay all, withdraw all)
            _delever(currentDebt, true);
        } else if (pos.collateral > 0) {
            // No debt but has collateral - just withdraw and convert
            IMorpho(Constants.MORPHO).withdrawCollateral(marketParams, pos.collateral, address(this), address(this));
            SwapHelper.swapSUSDDtoUSDT(pos.collateral);
        }
        // else: already idle USDT, nothing to do
    }

    /// @notice Transition to unleveraged sUSDD (0% LTV)
    /// @dev Repays all debt but keeps collateral as sUSDD
    function _transitionToUnleveraged(Position memory, uint256 currentDebt) internal {
        if (currentDebt > 0) {
            // Repay all debt while keeping collateral
            // _delever with withdrawAllCollateral=false will:
            // - Auto-detect full debt repayment and use by-shares (no dust)
            // - Withdraw only enough collateral to repay flash loan
            _delever(currentDebt, false);
        }

        // Convert any idle USDT to sUSDD collateral
        uint256 idleUsdt = IERC20(Constants.USDT).balanceOf(address(this));
        if (idleUsdt > 0) {
            uint256 susddAmount = SwapHelper.swapUSDTtoSUSDD(idleUsdt);
            IMorpho(Constants.MORPHO).supplyCollateral(marketParams, susddAmount, address(this), "");
        }
    }

    /// @notice Lever up: borrow more and add collateral
    function _leverUp(uint256 additionalDebt) internal {
        if (additionalDebt == 0) return;

        bytes memory data = abi.encode(OP_LEVER_UP);
        IMorpho(Constants.MORPHO).flashLoan(Constants.USDT, additionalDebt, data);
    }

    /// @notice Handle lever up flash loan callback
    /// @param flashLoanAmount Amount of USDT flash loaned
    function _handleLeverUpCallback(uint256 flashLoanAmount) internal {
        // Convert all USDT to sUSDD and supply as collateral
        // Note: balanceOf already includes flashLoanAmount (Morpho sent it before callback)
        // So we just convert the entire balance (flash loan + any pre-existing idle)
        uint256 totalUsdt = IERC20(Constants.USDT).balanceOf(address(this));

        uint256 susddAmount = SwapHelper.swapUSDTtoSUSDD(totalUsdt);
        IMorpho morpho = IMorpho(Constants.MORPHO);
        morpho.supplyCollateral(marketParams, susddAmount, address(this), "");
        // Borrow only flashLoanAmount to repay flash loan (pre-existing idle was already ours)
        morpho.borrow(marketParams, flashLoanAmount, 0, address(this), address(this));
    }

    /// @notice Delever: repay debt and remove collateral
    /// @param debtToRepay Amount of debt to repay
    /// @param withdrawAllCollateral If true, withdraw ALL remaining collateral (for full delever)
    function _delever(uint256 debtToRepay, bool withdrawAllCollateral) internal {
        if (debtToRepay == 0) return;

        bytes memory data = abi.encode(OP_DELEVER, withdrawAllCollateral);
        IMorpho(Constants.MORPHO).flashLoan(Constants.USDT, debtToRepay, data);
    }

    /// @notice Handle delever flash loan callback
    /// @param flashLoanAmount Amount of USDT flash loaned
    /// @param withdrawAllCollateral If true, withdraw ALL collateral (for IDLE_MODE exit)
    function _handleDeleverCallback(uint256 flashLoanAmount, bool withdrawAllCollateral) internal {
        IMorpho morpho = IMorpho(Constants.MORPHO);
        Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

        // Determine if we're repaying all debt (use by-shares for clean repayment)
        uint256 actualDebt = morpho.expectedBorrowAssets(marketParams, address(this));
        bool repayingAllDebt = flashLoanAmount >= actualDebt;

        // Repay debt
        if (pos.borrowShares > 0) {
            if (repayingAllDebt) {
                // Full debt repayment: use by-shares to avoid dust
                morpho.repay(marketParams, 0, pos.borrowShares, address(this), "");
            } else {
                // Partial repayment: use by-assets
                morpho.repay(marketParams, flashLoanAmount, 0, address(this), "");
            }
        }

        // Determine collateral to withdraw
        uint256 collateralToWithdraw;
        if (withdrawAllCollateral) {
            // IDLE_MODE: withdraw everything
            collateralToWithdraw = pos.collateral;
        } else {
            // Keep collateral: withdraw only enough to repay flash loan
            collateralToWithdraw = SwapHelper.previewSUSDDNeededForUSDT(flashLoanAmount);
            // Add buffer for sUSDD rate accrual and rounding (10 bps = 0.1%)
            collateralToWithdraw = (collateralToWithdraw * (Constants.BPS_DENOMINATOR + Constants.DELEVER_BUFFER_BPS)) / Constants.BPS_DENOMINATOR;

            // Re-read position after repay to get current collateral
            pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));
            if (collateralToWithdraw > pos.collateral) {
                collateralToWithdraw = pos.collateral;
            }
        }

        // Withdraw and swap collateral
        if (collateralToWithdraw > 0) {
            morpho.withdrawCollateral(marketParams, collateralToWithdraw, address(this), address(this));
            SwapHelper.swapSUSDDtoUSDT(collateralToWithdraw);
        }
    }

    // ============ Manager Functions ============

    /// @notice Set performance fee
    function setPerformanceFee(uint256 newFeeBps) external onlyRole(MANAGER_ROLE) {
        if (newFeeBps > MAX_PERFORMANCE_FEE_BPS) revert InvalidFee();
        uint256 oldFee = performanceFeeBps;
        performanceFeeBps = newFeeBps;
        emit PerformanceFeeUpdated(oldFee, newFeeBps);
    }

    /// @notice Set fee recipient
    function setFeeRecipient(address newRecipient) external onlyRole(MANAGER_ROLE) {
        if (newRecipient == address(0)) revert InvalidRecipient();
        address oldRecipient = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(oldRecipient, newRecipient);
    }

    /// @notice Set max total assets
    function setMaxTotalAssets(uint256 newMax) external onlyRole(MANAGER_ROLE) {
        uint256 oldMax = maxTotalAssets;
        maxTotalAssets = newMax;
        emit MaxTotalAssetsUpdated(oldMax, newMax);
    }

    /// @notice Enable or disable whitelist mode
    function setWhitelistEnabled(bool enabled) external onlyRole(MANAGER_ROLE) {
        whitelistEnabled = enabled;
        emit WhitelistEnabledUpdated(enabled);
    }

    /// @notice Add address to whitelist
    function addToWhitelist(address account) external onlyRole(MANAGER_ROLE) {
        whitelisted[account] = true;
        emit AddedToWhitelist(account);
    }

    /// @notice Remove address from whitelist
    function removeFromWhitelist(address account) external onlyRole(MANAGER_ROLE) {
        whitelisted[account] = false;
        emit RemovedFromWhitelist(account);
    }

    /// @notice Batch add addresses to whitelist
    function addToWhitelistBatch(address[] calldata accounts) external onlyRole(MANAGER_ROLE) {
        for (uint256 i = 0; i < accounts.length; i++) {
            whitelisted[accounts[i]] = true;
            emit AddedToWhitelist(accounts[i]);
        }
    }

    // ============ Merkl Rewards ============

    /// @notice Set Merkl distributor address
    /// @dev Only admin can change this
    function setMerklDistributor(address _merklDistributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_merklDistributor == address(0)) revert InvalidMerklDistributor();
        address oldDistributor = merklDistributor;
        merklDistributor = _merklDistributor;
        emit MerklDistributorUpdated(oldDistributor, _merklDistributor);
    }

    /// @notice Claim USDD rewards from Merkl and/or harvest fees
    /// @dev If claimData is empty: just accrue fees + emit snapshot (heartbeat)
    ///      If claimData is provided: claim rewards, reinvest, emit snapshot
    ///      Reinvest logic depends on targetLTV:
    ///      - IDLE_MODE: USDD → USDT (PSM), leave as idle
    ///      - 0 or >0: USDD → sUSDD (stake), add to collateral (compounds yield)
    /// @param claimData Encoded call data for Merkl distributor (empty for heartbeat only)
    function claimRewards(bytes calldata claimData) external onlyRole(KEEPER_ROLE) nonReentrant {
        // 1. Accrue fees first
        (, uint256 supply) = _accruePerformanceFee();

        // 2. If claimData provided, claim from Merkl and reinvest
        if (claimData.length > 0) {
            if (merklDistributor == address(0)) revert InvalidMerklDistributor();

            // Check USDD balance before claim
            uint256 usddBefore = IERC20(Constants.USDD).balanceOf(address(this));

            // Call Merkl to claim rewards
            (bool success,) = merklDistributor.call(claimData);
            if (!success) revert MerklClaimFailed();

            // Check USDD balance after - must have increased
            uint256 usddAfter = IERC20(Constants.USDD).balanceOf(address(this));
            if (usddAfter <= usddBefore) revert NoRewardsReceived();
            uint256 usddReceived = usddAfter - usddBefore;

            // Reinvest based on targetLTV mode
            if (targetLTV == IDLE_MODE) {
                // IDLE_MODE: convert to USDT and leave as idle
                SwapHelper.swapUSDDtoUSDT(usddReceived);
            } else {
                // Leveraged or unleveraged sUSDD: stake and add to collateral
                IERC20(Constants.USDD).forceApprove(Constants.SUSDD, usddReceived);
                uint256 susddAmount = IERC4626(Constants.SUSDD).deposit(usddReceived, address(this));
                IMorpho(Constants.MORPHO).supplyCollateral(marketParams, susddAmount, address(this), "");
            }

            emit RewardsClaimed(usddReceived);
        }

        _emitSnapshot(totalAssets(), supply);
    }

    /// @notice Internal function to accrue performance fees
    /// @dev Called in deposit/redeem for continuous fee accrual
    /// @return nav Current NAV
    /// @return supply Current supply AFTER any fee mint
    function _accruePerformanceFee() internal returns (uint256 nav, uint256 supply) {
        supply = totalSupply();
        nav = totalAssets();

        if (performanceFeeBps == 0 || supply == 0) return (nav, supply);

        uint256 currentPPS = (nav * 1e18) / supply;
        if (currentPPS <= highWaterMark) return (nav, supply);

        uint256 profitPerShare = currentPPS - highWaterMark;
        uint256 feePerShare = (profitPerShare * performanceFeeBps) / MAX_BPS;
        uint256 feeShares = (supply * feePerShare) / (currentPPS - feePerShare);

        if (feeShares > 0) {
            _mint(feeRecipient, feeShares);
            supply += feeShares;
            highWaterMark = currentPPS;
            emit PerformanceFeeAccrued(feeShares, feeRecipient);
        }

        return (nav, supply);
    }

    /// @notice Emit VaultSnapshot with provided state (saves gas by avoiding re-reads)
    function _emitSnapshot(uint256 nav, uint256 supply) internal {
        uint256 pps = supply > 0 ? (nav * 1e18) / supply : 1e18;
        emit VaultSnapshot(nav, supply, pps, block.timestamp);
    }

    // ============ Pauser Functions ============

    /// @notice Pause deposits and rebalancing (withdrawals still allowed)
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Unpause the vault
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ============ Flash Loan Callback ============

    /// @notice Morpho flash loan callback
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        if (msg.sender != Constants.MORPHO) revert UnauthorizedCallback();

        uint8 operation = abi.decode(data, (uint8));

        if (operation == OP_DEPOSIT) {
            (, uint256 depositedUsdt) = abi.decode(data, (uint8, uint256));
            _handleDepositCallback(assets, depositedUsdt);
        } else if (operation == OP_WITHDRAW) {
            (, uint256 sharesToRepay, uint256 collateralToWithdraw) = abi.decode(data, (uint8, uint256, uint256));
            _handleWithdrawCallback(sharesToRepay, collateralToWithdraw);
        } else if (operation == OP_LEVER_UP) {
            _handleLeverUpCallback(assets);
        } else if (operation == OP_DELEVER) {
            (, bool withdrawAllCollateral) = abi.decode(data, (uint8, bool));
            _handleDeleverCallback(assets, withdrawAllCollateral);
        } else {
            revert FlashLoanCallbackFailed();
        }

        // Flash loan repayment: Morpho calls safeTransferFrom to pull back `assets`
        // Approval was set in constructor (infinite approve to Morpho)
        // IMPORTANT: Do NOT call forceApprove here — it would overwrite infinite approval
    }

    // ============ Upgrade Authorization ============

    /// @notice Authorize upgrade to new implementation
    /// @dev Only DEFAULT_ADMIN_ROLE can upgrade
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ============ Interface Support ============

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
