// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IMorpho.sol";
import "./interfaces/IPSM.sol";
import "./libraries/Constants.sol";
import "./libraries/SwapHelper.sol";

/// @title SUSDDVault
/// @notice Leveraged ERC4626 vault: USDT deposits → leveraged sUSDD position in Morpho Blue
/// @dev Users deposit USDT, vault creates leveraged sUSDD/USDT position using flash loans
contract SUSDDVault is ERC4626, AccessControl, Pausable, ReentrancyGuard, IMorphoFlashLoanCallback {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;

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
    event Rebalanced(uint256 oldLTV, uint256 newLTV, uint256 collateralDelta, uint256 debtDelta);
    event PerformanceFeeHarvested(uint256 feeShares, address recipient);
    event EmergencyWithdraw(uint256 collateralWithdrawn, uint256 debtRepaid);

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
    error ZeroPositionValue();

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
    function totalAssets() public view override returns (uint256) {
        // Idle USDT balance
        uint256 idleUsdt = IERC20(Constants.USDT).balanceOf(address(this));

        // Get position from Morpho
        IMorpho morpho = IMorpho(Constants.MORPHO);
        Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

        // Calculate debt in USDT
        uint256 debtUsdt = 0;
        if (pos.borrowShares > 0) {
            Market memory mkt = morpho.market(Id.wrap(Constants.MARKET_ID));
            // debt = borrowShares * totalBorrowAssets / totalBorrowShares
            debtUsdt = (uint256(pos.borrowShares) * uint256(mkt.totalBorrowAssets)) / uint256(mkt.totalBorrowShares);
        }

        // Calculate collateral value in USDT
        uint256 collateralUsdt = SwapHelper.getUSDTValue(pos.collateral);

        // NAV = idle + collateral value - debt
        if (collateralUsdt + idleUsdt > debtUsdt) {
            return idleUsdt + collateralUsdt - debtUsdt;
        }
        return 0; // Underwater (shouldn't happen with proper LTV management)
    }

    /// @notice Maximum deposit amount
    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 currentAssets = totalAssets();
        if (currentAssets >= maxTotalAssets) return 0;
        return maxTotalAssets - currentAssets;
    }

    /// @notice Maximum mint amount
    function maxMint(address owner) public view override returns (uint256) {
        uint256 maxDep = maxDeposit(owner);
        return convertToShares(maxDep);
    }

    /// @notice Deposit USDT and build leveraged position
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
        whenNotPaused
    {
        if (assets + totalAssets() > maxTotalAssets) revert MaxTotalAssetsExceeded();

        // Transfer USDT from caller
        SafeERC20.safeTransferFrom(IERC20(Constants.USDT), caller, address(this), assets);

        // Mint shares to receiver
        _mint(receiver, shares);

        emit Deposit(caller, receiver, assets, shares);

        // Build leveraged position if targetLTV > 0
        if (targetLTV > 0 && assets > 0) {
            _buildPosition(assets);
        }
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
        // Underwater positions cannot be rebalanced - they should be handled via
        // emergencyWithdraw() or allowed to be liquidated by Morpho.
        uint256 nav = totalAssets();
        if (nav == 0) return;

        // Calculate target debt for new LTV based on total NAV
        // Any idle USDT will be deployed into the position during lever up
        // targetDebt = nav * targetLTV / (1 - targetLTV)
        uint256 targetDebt;
        if (newTargetLTV > 0) {
            targetDebt = (nav * newTargetLTV) / (Constants.WAD - newTargetLTV);
        }

        // Get current debt
        uint256 currentDebt = 0;
        if (pos.borrowShares > 0) {
            Market memory mkt = morpho.market(Id.wrap(Constants.MARKET_ID));
            currentDebt = (uint256(pos.borrowShares) * uint256(mkt.totalBorrowAssets)) / uint256(mkt.totalBorrowShares);
        }

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

    // ============ Admin Functions ============

    /// @notice Emergency withdraw: fully unwind position and pause
    function emergencyWithdraw() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();

        // Get current position
        IMorpho morpho = IMorpho(Constants.MORPHO);
        Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

        if (pos.collateral == 0 && pos.borrowShares == 0) {
            emit EmergencyWithdraw(0, 0);
            return;
        }

        // Calculate debt
        uint256 debt = 0;
        if (pos.borrowShares > 0) {
            Market memory mkt = morpho.market(Id.wrap(Constants.MARKET_ID));
            debt = (uint256(pos.borrowShares) * uint256(mkt.totalBorrowAssets)) / uint256(mkt.totalBorrowShares);
        }

        // Full delever - withdraw all collateral in one atomic operation
        if (debt > 0) {
            _delever(debt, true); // true = withdraw all collateral
        } else if (pos.collateral > 0) {
            // No debt but have collateral - just withdraw it
            morpho.withdrawCollateral(marketParams, pos.collateral, address(this), address(this));
            SwapHelper.swapSUSDDtoUSDT(pos.collateral);
        }

        emit EmergencyWithdraw(pos.collateral, debt);
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
            (, uint256 collateralToWithdraw) = abi.decode(data, (uint8, uint256));
            _handleWithdrawCallback(assets, collateralToWithdraw);
        } else if (operation == OP_REBALANCE) {
            (, uint256 direction, bool withdrawAllCollateral) = abi.decode(data, (uint8, uint256, bool));
            _handleRebalanceCallback(assets, direction, withdrawAllCollateral);
        } else {
            revert FlashLoanCallbackFailed();
        }

        // Repay flash loan
        IERC20(Constants.USDT).forceApprove(Constants.MORPHO, assets);
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
    function _unwindPosition(uint256 usdtToWithdraw, address receiver) internal {
        uint256 idleUsdt = IERC20(Constants.USDT).balanceOf(address(this));

        if (idleUsdt >= usdtToWithdraw) {
            // Enough idle USDT, no need to unwind
            IERC20(Constants.USDT).safeTransfer(receiver, usdtToWithdraw);
            return;
        }

        // Get current position
        IMorpho morpho = IMorpho(Constants.MORPHO);
        Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

        if (pos.collateral == 0) {
            // No position - revert if we can't fulfill the withdrawal
            // (Issue #1 fix: don't silently underpay)
            revert InsufficientWithdrawBalance();
        }

        // Calculate NAV and check for zero (Issue #2 fix)
        uint256 nav = totalAssets();
        if (nav == 0) revert ZeroNAV();

        // Calculate how much we need from the position (Issue #4 fix)
        // Only unwind for the amount not covered by idle USDT
        uint256 usdtNeededFromPosition = usdtToWithdraw - idleUsdt;

        // Calculate position value (NAV minus idle USDT)
        // This is the correct denominator for proportional calculations
        // Use safe subtraction to avoid underflow if position is underwater
        uint256 positionValue = nav > idleUsdt ? nav - idleUsdt : 0;
        if (positionValue == 0) revert ZeroPositionValue();

        // Calculate how much collateral to withdraw proportionally to needed amount
        uint256 collateralToWithdraw = (uint256(pos.collateral) * usdtNeededFromPosition) / positionValue;

        // Calculate debt to repay proportionally to needed amount
        uint256 debt = 0;
        if (pos.borrowShares > 0) {
            Market memory mkt = morpho.market(Id.wrap(Constants.MARKET_ID));
            debt = (uint256(pos.borrowShares) * uint256(mkt.totalBorrowAssets)) / uint256(mkt.totalBorrowShares);
        }
        uint256 debtToRepay = (debt * usdtNeededFromPosition) / positionValue;

        if (debtToRepay > 0) {
            // Flash loan to repay debt
            bytes memory data = abi.encode(OP_WITHDRAW, collateralToWithdraw);
            morpho.flashLoan(Constants.USDT, debtToRepay, data);
        } else {
            // No debt, just withdraw collateral
            morpho.withdrawCollateral(marketParams, collateralToWithdraw, address(this), address(this));
            SwapHelper.swapSUSDDtoUSDT(collateralToWithdraw);
        }

        // Transfer USDT to receiver (Issue #1 fix: revert if insufficient)
        uint256 finalBalance = IERC20(Constants.USDT).balanceOf(address(this));
        if (finalBalance < usdtToWithdraw) revert InsufficientWithdrawBalance();
        IERC20(Constants.USDT).safeTransfer(receiver, usdtToWithdraw);
    }

    /// @notice Handle withdraw flash loan callback
    function _handleWithdrawCallback(uint256 flashLoanAmount, uint256 collateralToWithdraw) internal {
        IMorpho morpho = IMorpho(Constants.MORPHO);

        // Repay debt with flash loan
        morpho.repay(marketParams, flashLoanAmount, 0, address(this), "");

        // Withdraw collateral
        morpho.withdrawCollateral(marketParams, collateralToWithdraw, address(this), address(this));

        // Convert sUSDD to USDT
        SwapHelper.swapSUSDDtoUSDT(collateralToWithdraw);

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
            // Lever up: convert borrowed USDT + any idle USDT to sUSDD and supply as collateral
            // This ensures idle USDT doesn't accumulate - it gets deployed into the position
            uint256 idleUsdt = IERC20(Constants.USDT).balanceOf(address(this));
            uint256 totalToConvert = flashLoanAmount + idleUsdt;

            uint256 susddAmount = SwapHelper.swapUSDTtoSUSDD(totalToConvert);
            morpho.supplyCollateral(marketParams, susddAmount, address(this), "");
            // Borrow only flashLoanAmount to repay flash loan (idle was already ours)
            morpho.borrow(marketParams, flashLoanAmount, 0, address(this), address(this));
        } else {
            // Delever: repay debt, withdraw collateral, convert to USDT
            morpho.repay(marketParams, flashLoanAmount, 0, address(this), "");

            Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

            uint256 collateralToWithdraw;
            if (withdrawAllCollateral) {
                // Full delever: withdraw ALL remaining collateral
                collateralToWithdraw = pos.collateral;
            } else {
                // Partial delever: withdraw only enough to repay flash loan
                // Calculate how much collateral to withdraw (use correct preview direction)
                // We need to withdraw enough sUSDD to get `flashLoanAmount` USDT after fees
                collateralToWithdraw = SwapHelper.previewSUSDDNeededForUSDT(flashLoanAmount);
                // Add some buffer for slippage/rounding
                collateralToWithdraw = (collateralToWithdraw * 101) / 100;

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

    // ============ View Helpers ============

    /// @notice Get current position details
    function getPosition() external view returns (uint256 collateral, uint256 debt, uint256 currentLTV) {
        IMorpho morpho = IMorpho(Constants.MORPHO);
        Position memory pos = morpho.position(Id.wrap(Constants.MARKET_ID), address(this));

        collateral = pos.collateral;

        if (pos.borrowShares > 0) {
            Market memory mkt = morpho.market(Id.wrap(Constants.MARKET_ID));
            debt = (uint256(pos.borrowShares) * uint256(mkt.totalBorrowAssets)) / uint256(mkt.totalBorrowShares);
        }

        uint256 collateralValue = SwapHelper.getUSDTValue(collateral);
        if (collateralValue > 0) {
            currentLTV = (debt * Constants.WAD) / collateralValue;
        }
    }

    /// @notice Check if position is healthy (below LLTV)
    function isHealthy() external view returns (bool) {
        (,, uint256 currentLTV) = this.getPosition();
        return currentLTV < marketParams.lltv;
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
