// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
contract SUSDDVault is ERC4626, AccessControl, Pausable, ReentrancyGuard, IMorphoFlashLoanCallback {
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

    // ============ Constants ============

    uint256 private constant MAX_BPS = 10000;
    uint256 private constant MAX_PERFORMANCE_FEE_BPS = 3000; // 30% max
    uint256 private constant MAX_LTV = 0.9e18; // 90% max (below LLTV)

    // Flash loan operation types
    uint8 private constant OP_DEPOSIT = 1;
    uint8 private constant OP_WITHDRAW = 2;
    uint8 private constant OP_REBALANCE = 3;

    // ============ Events ============

    event TargetLTVUpdated(uint256 oldLTV, uint256 newLTV);
    event PerformanceFeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeRecipientUpdated(address oldRecipient, address newRecipient);
    event MaxTotalAssetsUpdated(uint256 oldMax, uint256 newMax);
    /// @notice Emitted after rebalance completes
    /// @param oldLTV Previous target LTV setting
    /// @param newLTV New target LTV setting
    /// @param collateralBefore Collateral amount BEFORE rebalance operation
    /// @param debtBefore Debt amount BEFORE rebalance operation
    event Rebalanced(uint256 oldLTV, uint256 newLTV, uint256 collateralBefore, uint256 debtBefore);
    event PerformanceFeeHarvested(uint256 feeShares, address recipient);

    // ============ Errors ============

    error InvalidLTV();
    error LTVExceedsLLTV();
    error InvalidFee();
    error InvalidRecipient();
    error MaxTotalAssetsExceeded();
    error FlashLoanCallbackFailed();
    error UnauthorizedCallback();
    error InsufficientWithdrawBalance();
    error ZeroNAV();
    error DepositTooSmall();

    // ============ Constructor ============

    constructor(
        address _admin,
        address _feeRecipient,
        uint256 _targetLTV,
        uint256 _performanceFeeBps,
        uint256 _maxTotalAssets
    )
        ERC20("Leveraged sUSDD Vault", "lsUSDD")
        ERC4626(IERC20(Constants.USDT))
    {
        if (_performanceFeeBps > MAX_PERFORMANCE_FEE_BPS) revert InvalidFee();
        if (_feeRecipient == address(0)) revert InvalidRecipient();

        // Cache market params first (needed for LTV validation)
        IMorpho morpho = IMorpho(Constants.MORPHO);
        marketParams = morpho.idToMarketParams(Id.wrap(Constants.MARKET_ID));

        // Validate LTV against both MAX_LTV and market LLTV
        if (_targetLTV > MAX_LTV) revert InvalidLTV();
        if (_targetLTV >= marketParams.lltv) revert LTVExceedsLLTV();

        // Setup roles
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(KEEPER_ROLE, _admin);
        _grantRole(MANAGER_ROLE, _admin);
        _grantRole(PAUSER_ROLE, _admin);

        // Initialize parameters
        targetLTV = _targetLTV;
        performanceFeeBps = _performanceFeeBps;
        feeRecipient = _feeRecipient;
        maxTotalAssets = _maxTotalAssets;
        highWaterMark = 1e18; // Start at 1:1

        // Authorize Morpho to pull tokens
        IERC20(Constants.USDT).forceApprove(Constants.MORPHO, type(uint256).max);
        IERC20(Constants.SUSDD).forceApprove(Constants.MORPHO, type(uint256).max);
    }

    // ============ ERC4626 Overrides ============

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
    /// @dev Returns 0 if paused, TVL cap reached, or underwater (NAV=0 with existing shares)
    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;

        uint256 currentAssets = totalAssets();

        // Underwater check: NAV=0 but shares exist → deposits blocked
        if (currentAssets == 0 && totalSupply() > 0) return 0;

        if (currentAssets >= maxTotalAssets) return 0;
        return maxTotalAssets - currentAssets;
    }

    /// @notice Maximum mint amount (returns 0 - mint not supported)
    function maxMint(address) public pure override returns (uint256) {
        return 0; // mint() not supported, use deposit()
    }

    /// @notice Maximum withdraw amount (returns 0 - withdraw not supported)
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0; // withdraw() not supported, use redeem()
    }

    /// @notice Mint is not supported - use deposit() instead
    /// @dev Delta NAV approach makes exact share minting impractical.
    ///      User cannot predict exact shares they'll receive because shares
    ///      depend on actual NAV change after position is built.
    function mint(uint256, address) public pure override returns (uint256) {
        revert("mint() not supported, use deposit()");
    }

    /// @notice Withdraw is not supported - use redeem() instead
    /// @dev With proportional withdrawal, specifying exact assets is impractical.
    ///      User should redeem shares and receive proportional USDT.
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert("withdraw() not supported, use redeem()");
    }

    /// @notice Preview mint returns 0 (mint not supported)
    function previewMint(uint256) public pure override returns (uint256) {
        return 0;
    }

    /// @notice Preview withdraw returns 0 (withdraw not supported)
    function previewWithdraw(uint256) public pure override returns (uint256) {
        return 0;
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

    /// @notice Convert assets to shares (consistent with Delta NAV)
    function convertToShares(uint256 assets) public view override returns (uint256) {
        return previewDeposit(assets);
    }

    /// @notice Estimate the NAV increase from depositing assets
    /// @dev Assumes PSM tin/tout = 0 (see requirements.md "PSM Fee Assumption")
    function _estimateDepositValue(uint256 assets) internal view returns (uint256) {
        if (targetLTV == 0) {
            // No leverage: USDT stays idle, value = assets
            return assets;
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

    /// @notice Deposit USDT and build leveraged position
    /// @dev Uses DELTA NAV approach: shares are calculated based on actual NAV increase,
    ///      not the deposited amount. This protects existing holders from PSM fee dilution.
    function _deposit(address caller, address receiver, uint256 assets, uint256 /* shares */)
        internal
        override
        nonReentrant
        whenNotPaused
    {
        if (assets + totalAssets() > maxTotalAssets) revert MaxTotalAssetsExceeded();

        // 1. Snapshot state BEFORE
        uint256 navBefore = totalAssets();
        uint256 supplyBefore = totalSupply();

        // Block deposits if vault is underwater (NAV=0 but shares exist)
        // This prevents dilution of existing holders
        if (supplyBefore > 0 && navBefore == 0) revert ZeroNAV();

        // 2. Transfer USDT from caller
        SafeERC20.safeTransferFrom(IERC20(Constants.USDT), caller, address(this), assets);

        // 3. Build leveraged position if targetLTV > 0
        if (targetLTV > 0 && assets > 0) {
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
    }

    /// @notice Withdraw USDT by unwinding leveraged position
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override nonReentrant {
        // Check allowance if caller is not owner
        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }

        // Burn shares
        _burn(owner, shares);

        emit Withdraw(caller, receiver, owner, assets, shares);

        // Unwind position to get USDT
        _unwindPosition(assets, receiver);
    }

    // ============ Keeper Functions ============

    /// @notice Rebalance the position to a new target LTV
    /// @param newTargetLTV New LTV target (0 for full delever)
    function rebalance(uint256 newTargetLTV) external onlyRole(KEEPER_ROLE) whenNotPaused nonReentrant {
        if (newTargetLTV > MAX_LTV) revert InvalidLTV();
        if (newTargetLTV >= marketParams.lltv) revert LTVExceedsLLTV();

        uint256 oldTargetLTV = targetLTV;
        targetLTV = newTargetLTV;

        emit TargetLTVUpdated(oldTargetLTV, newTargetLTV);

        // Get current position
        IMorpho morpho = IMorpho(Constants.MORPHO);
        Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

        if (pos.collateral == 0 && newTargetLTV == 0) {
            // No position and no target - nothing to do
            return;
        }

        // Calculate current NAV and position value
        // Note: If nav == 0 (underwater: collateral + idle <= debt), we exit early.
        // Underwater positions cannot be rebalanced - they will be liquidated by Morpho.
        uint256 nav = totalAssets();
        if (nav == 0) return;

        // Calculate target debt for new LTV based on total NAV
        // Any idle USDT will be deployed into the position during lever up
        // targetDebt = nav * targetLTV / (1 - targetLTV)
        uint256 targetDebt;
        if (newTargetLTV > 0) {
            targetDebt = (nav * newTargetLTV) / (Constants.WAD - newTargetLTV);
        }

        // Get current debt (including accrued interest)
        uint256 currentDebt = morpho.expectedBorrowAssets(marketParams, address(this));

        if (targetDebt > currentDebt) {
            // Lever up: borrow more, add collateral
            // _leverUp now automatically deploys any idle USDT into the position
            uint256 additionalDebt = targetDebt - currentDebt;
            _leverUp(additionalDebt);
        } else if (targetDebt < currentDebt) {
            // Delever: repay debt, remove collateral
            uint256 debtToRepay = currentDebt - targetDebt;
            // If targetDebt == 0, this is a full delever - withdraw ALL collateral
            bool isFullDelever = (targetDebt == 0);
            _delever(debtToRepay, isFullDelever);
        } else if (newTargetLTV == 0 && pos.collateral > 0) {
            // Special case: targetDebt == currentDebt == 0, but we have collateral
            // Full delever requested - withdraw all collateral to idle USDT
            IMorpho(Constants.MORPHO).withdrawCollateral(marketParams, pos.collateral, address(this), address(this));
            SwapHelper.swapSUSDDtoUSDT(pos.collateral);
        }

        emit Rebalanced(oldTargetLTV, newTargetLTV, pos.collateral, currentDebt);
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

    /// @notice Harvest performance fees
    /// @dev Mints new shares to feeRecipient based on profit above high water mark
    function harvestFees() external onlyRole(MANAGER_ROLE) nonReentrant {
        if (performanceFeeBps == 0 || totalSupply() == 0) return;

        // Calculate current value per share (in WAD)
        uint256 currentValuePerShare = (totalAssets() * 1e18) / totalSupply();

        if (currentValuePerShare <= highWaterMark) {
            // No profit above HWM
            return;
        }

        // Calculate profit per share
        uint256 profitPerShare = currentValuePerShare - highWaterMark;

        // Calculate fee per share
        uint256 feePerShare = (profitPerShare * performanceFeeBps) / MAX_BPS;

        // Calculate fee shares to mint
        // feeShares = totalSupply * feePerShare / (currentValuePerShare - feePerShare)
        uint256 feeShares = (totalSupply() * feePerShare) / (currentValuePerShare - feePerShare);

        if (feeShares > 0) {
            _mint(feeRecipient, feeShares);
            emit PerformanceFeeHarvested(feeShares, feeRecipient);
        }

        // Update high water mark
        highWaterMark = currentValuePerShare;
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

        // First decode operation type
        uint8 operation = abi.decode(data, (uint8));

        if (operation == OP_DEPOSIT) {
            (, uint256 depositedUsdt) = abi.decode(data, (uint8, uint256));
            _handleDepositCallback(assets, depositedUsdt);
        } else if (operation == OP_WITHDRAW) {
            (, uint256 sharesToRepay, uint256 collateralToWithdraw) = abi.decode(data, (uint8, uint256, uint256));
            _handleWithdrawCallback(sharesToRepay, collateralToWithdraw);
        } else if (operation == OP_REBALANCE) {
            (, uint256 direction, bool withdrawAllCollateral) = abi.decode(data, (uint8, uint256, bool));
            _handleRebalanceCallback(assets, direction, withdrawAllCollateral);
        } else {
            revert FlashLoanCallbackFailed();
        }

        // Flash loan repayment: Morpho calls safeTransferFrom to pull back `assets`
        // Approval was set in constructor (infinite approve to Morpho)
        // IMPORTANT: Do NOT call forceApprove here — it would overwrite infinite approval
    }

    // ============ Internal Functions ============

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

    /// @notice Unwind position to withdraw USDT
    /// @dev Uses PROPORTIONAL withdrawal for fairness: both idle USDT and position
    ///      are withdrawn in the same ratio. This ensures all users pay similar
    ///      gas/fees regardless of withdrawal order.
    function _unwindPosition(uint256 usdtToWithdraw, address receiver) internal {
        uint256 nav = totalAssets();
        if (nav == 0) revert ZeroNAV();

        uint256 idleUsdt = IERC20(Constants.USDT).balanceOf(address(this));
        IMorpho morpho = IMorpho(Constants.MORPHO);
        Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

        // Full withdraw if all shares have been burned (last user exiting)
        bool isFullWithdraw = (totalSupply() == 0);

        // Calculate withdrawal ratio (in WAD for precision)
        // ratio = usdtToWithdraw / nav
        uint256 withdrawRatio = isFullWithdraw
            ? Constants.WAD
            : (usdtToWithdraw * Constants.WAD) / nav;

        // Proportionally withdraw from idle USDT
        uint256 idleToWithdraw = isFullWithdraw
            ? idleUsdt
            : (idleUsdt * withdrawRatio) / Constants.WAD;

        // Proportionally unwind position (if exists)
        uint256 positionToUnwind = usdtToWithdraw > idleToWithdraw
            ? usdtToWithdraw - idleToWithdraw
            : 0;

        if (positionToUnwind > 0) {
            if (pos.collateral == 0) {
                revert InsufficientWithdrawBalance();
            }

            // Calculate proportional shares and collateral to withdraw
            // Both use the same withdrawRatio on raw position values
            uint256 sharesToRepay = (uint256(pos.borrowShares) * withdrawRatio) / Constants.WAD;
            uint256 collateralToWithdraw = (uint256(pos.collateral) * withdrawRatio) / Constants.WAD;

            // Add buffer to collateral for swap rounding (toAssetsUp rounds up flash loan,
            // but swap rounds down, so we need slightly more collateral to cover)
            if (!isFullWithdraw) {
                collateralToWithdraw = (collateralToWithdraw * (Constants.BPS_DENOMINATOR + Constants.DELEVER_BUFFER_BPS)) / Constants.BPS_DENOMINATOR;
            }

            // Cap to actual position (safety check)
            if (sharesToRepay > pos.borrowShares) {
                sharesToRepay = pos.borrowShares;
            }
            if (collateralToWithdraw > pos.collateral) {
                collateralToWithdraw = pos.collateral;
            }

            if (sharesToRepay > 0) {
                // Calculate flash loan amount from shares (with interest accrual)
                (,, uint256 totalBorrowAssets, uint256 totalBorrowShares) = morpho.expectedMarketBalances(marketParams);
                uint256 flashLoanAmount = sharesToRepay.toAssetsUp(totalBorrowAssets, totalBorrowShares);

                // Flash loan to repay debt - pass sharesToRepay and collateralToWithdraw
                bytes memory data = abi.encode(OP_WITHDRAW, sharesToRepay, collateralToWithdraw);
                morpho.flashLoan(Constants.USDT, flashLoanAmount, data);
            } else if (collateralToWithdraw > 0) {
                // No debt, just withdraw collateral
                morpho.withdrawCollateral(marketParams, collateralToWithdraw, address(this), address(this));
                SwapHelper.swapSUSDDtoUSDT(collateralToWithdraw);
            }
        }

        // Transfer USDT to receiver
        uint256 finalBalance = IERC20(Constants.USDT).balanceOf(address(this));
        if (finalBalance < usdtToWithdraw) revert InsufficientWithdrawBalance();
        IERC20(Constants.USDT).safeTransfer(receiver, usdtToWithdraw);
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

    /// @notice Lever up: borrow more and add collateral
    function _leverUp(uint256 additionalDebt) internal {
        if (additionalDebt == 0) return;

        // direction=1 for lever up, third param (withdrawAllCollateral) is false/unused for lever up
        bytes memory data = abi.encode(OP_REBALANCE, uint256(1), false);
        IMorpho(Constants.MORPHO).flashLoan(Constants.USDT, additionalDebt, data);
    }

    /// @notice Delever: repay debt and remove collateral
    /// @param debtToRepay Amount of debt to repay
    /// @param withdrawAllCollateral If true, withdraw ALL remaining collateral (for full delever)
    function _delever(uint256 debtToRepay, bool withdrawAllCollateral) internal {
        if (debtToRepay == 0) return;

        // direction=0 for delever, third param indicates if we should withdraw all collateral
        bytes memory data = abi.encode(OP_REBALANCE, uint256(0), withdrawAllCollateral);
        IMorpho(Constants.MORPHO).flashLoan(Constants.USDT, debtToRepay, data);
    }

    /// @notice Handle rebalance flash loan callback
    /// @param flashLoanAmount Amount of USDT flash loaned
    /// @param direction 1 = lever up, 0 = delever
    /// @param withdrawAllCollateral If true and delever, withdraw ALL collateral (for full delever)
    function _handleRebalanceCallback(uint256 flashLoanAmount, uint256 direction, bool withdrawAllCollateral) internal {
        IMorpho morpho = IMorpho(Constants.MORPHO);

        if (direction == 1) {
            // Lever up: convert all USDT to sUSDD and supply as collateral
            // Note: balanceOf already includes flashLoanAmount (Morpho sent it before callback)
            // So we just convert the entire balance (flash loan + any pre-existing idle)
            uint256 totalUsdt = IERC20(Constants.USDT).balanceOf(address(this));

            uint256 susddAmount = SwapHelper.swapUSDTtoSUSDD(totalUsdt);
            morpho.supplyCollateral(marketParams, susddAmount, address(this), "");
            // Borrow only flashLoanAmount to repay flash loan (pre-existing idle was already ours)
            morpho.borrow(marketParams, flashLoanAmount, 0, address(this), address(this));
        } else {
            // Delever: repay debt, withdraw collateral, convert to USDT
            Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

            uint256 collateralToWithdraw;
            if (withdrawAllCollateral) {
                // Full delever: repay ALL borrow shares to clear debt completely
                // This avoids leaving tiny dust that would make position unhealthy
                if (pos.borrowShares > 0) {
                    morpho.repay(marketParams, 0, pos.borrowShares, address(this), "");
                }
                collateralToWithdraw = pos.collateral;
            } else {
                // Partial delever: repay by assets
                uint256 actualDebt = morpho.expectedBorrowAssets(marketParams, address(this));
                uint256 repayAmount = flashLoanAmount > actualDebt ? actualDebt : flashLoanAmount;
                if (repayAmount > 0) {
                    morpho.repay(marketParams, repayAmount, 0, address(this), "");
                }
                // Re-read position
                pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));
                // Calculate how much collateral to withdraw
                // We need to withdraw enough sUSDD to get `flashLoanAmount` USDT after fees
                collateralToWithdraw = SwapHelper.previewSUSDDNeededForUSDT(flashLoanAmount);
                // Add buffer for sUSDD rate accrual and rounding (10 bps = 0.1%)
                collateralToWithdraw = (collateralToWithdraw * (Constants.BPS_DENOMINATOR + Constants.DELEVER_BUFFER_BPS)) / Constants.BPS_DENOMINATOR;

                if (collateralToWithdraw > pos.collateral) {
                    collateralToWithdraw = pos.collateral;
                }
            }

            if (collateralToWithdraw > 0) {
                morpho.withdrawCollateral(marketParams, collateralToWithdraw, address(this), address(this));
                SwapHelper.swapSUSDDtoUSDT(collateralToWithdraw);
            }
        }
    }

    // ============ ERC20 Overrides for AccessControl ============

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
