# ADR-004: Atomic Leverage

## Question
How do we achieve leverage atomically in a single transaction?

## Decision
**Flash loan from Morpho Blue** (0% fee) to build/unwind leverage in one transaction.

## Flash Loan Operation Types

The vault uses three operation types in flash loan callbacks:

| Op Code | Name | Purpose |
|---------|------|---------|
| 1 | `OP_DEPOSIT` | Build leveraged position from user deposit |
| 2 | `OP_WITHDRAW` | Unwind position for user withdrawal |
| 3 | `OP_REBALANCE` | Adjust leverage (lever up or delever) |

## Flow: Deposit (Build Leverage)

```
User deposits USDT
    │
    ▼
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_DEPOSIT)    │
│   │                                         │
│   ▼                                         │
│ Total USDT = deposit + flash loan           │
│   │                                         │
│   ▼                                         │
│ Swap all USDT → sUSDD (via PSM + stake)     │
│   │                                         │
│   ▼                                         │
│ Supply sUSDD as collateral to Morpho        │
│   │                                         │
│   ▼                                         │
│ Borrow USDT against collateral              │
│   │                                         │
│   ▼                                         │
│ Repay flash loan with borrowed USDT         │
└─────────────────────────────────────────────┘
    │
    ▼
Result: Leveraged sUSDD position
```

## Flow: Withdraw (Unwind Leverage)

```
User requests withdrawal
    │
    ▼
Check idle USDT balance
    │
    ├── Sufficient idle USDT? → Transfer directly, done
    │
    └── Need to unwind position:
        │
        ▼
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_WITHDRAW)   │
│   │                                         │
│   ▼                                         │
│ Repay proportional USDT debt                │
│   │                                         │
│   ▼                                         │
│ Withdraw proportional sUSDD collateral      │
│   │                                         │
│   ▼                                         │
│ Swap sUSDD → USDT (via unstake + PSM)       │
│   │                                         │
│   ▼                                         │
│ Repay flash loan from swap proceeds         │
└─────────────────────────────────────────────┘
    │
    ▼
Transfer USDT to user
```

**Idle USDT Optimization:** If the vault holds idle USDT (e.g., from previous operations), withdrawals first use idle balance before unwinding the Morpho position. This saves gas and preserves the leveraged position when possible.

## Flow: Rebalance (Lever Up)

```
Keeper calls rebalance(higherLTV)
    │
    ▼
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_REBALANCE)  │
│   │                                         │
│   ▼                                         │
│ Swap USDT → sUSDD                           │
│   │                                         │
│   ▼                                         │
│ Supply sUSDD as additional collateral       │
│   │                                         │
│   ▼                                         │
│ Borrow USDT to repay flash loan             │
└─────────────────────────────────────────────┘
```

## Flow: Rebalance (Delever)

```
Keeper calls rebalance(lowerLTV)
    │
    ▼
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_REBALANCE)  │
│   │                                         │
│   ▼                                         │
│ Repay portion of USDT debt                  │
│   │                                         │
│   ▼                                         │
│ Calculate sUSDD needed for flash loan repay │
│ (using previewSUSDDNeededForUSDT + buffer)  │
│   │                                         │
│   ▼                                         │
│ Withdraw sUSDD collateral                   │
│   │                                         │
│   ▼                                         │
│ Swap sUSDD → USDT                           │
│   │                                         │
│   ▼                                         │
│ Repay flash loan                            │
└─────────────────────────────────────────────┘
```

## Rationale

1. **No intermediate state** - Position never exists in partial/risky state.

2. **Gas efficient** - Single transaction vs multiple.

3. **Zero flash loan fee** - Morpho Blue provides free flash loans.

4. **Standard pattern** - Flash loans for atomic leverage is well-established.

5. **Idle balance optimization** - Minimizes unnecessary position changes.

## Key Calculations

**Deposit leverage:**
```
borrowAmount = depositedUsdt * targetLTV / (1 - targetLTV)
```

**Example (75% LTV = 4x leverage):**
- 1000 USDT deposit needs 3000 USDT flash loan
- Total 4000 USDT converts to ~4000 sUSDD collateral
- Borrow 3000 USDT to repay flash loan
- Net equity: 1000 USDT, Collateral: ~4000, Debt: 3000

**Withdrawal proportional amounts:**
```
usdtNeededFromPosition = usdtToWithdraw - idleUsdt
positionValue = NAV - idleUsdt  // Value locked in Morpho position
collateralToWithdraw = totalCollateral * usdtNeededFromPosition / positionValue
debtToRepay = totalDebt * usdtNeededFromPosition / positionValue
```

Note: We use `positionValue` (not NAV) as the denominator because we're calculating proportions relative to the Morpho position only, not including idle USDT.

## Delever Algorithm Details

### Partial Delever (rebalance to lower LTV)

When reducing leverage but not fully exiting:

1. Flash loan the amount of debt to repay
2. Repay that debt to Morpho
3. Calculate collateral needed: `previewSUSDDNeededForUSDT(flashLoanAmount)`
4. Add 1% buffer for slippage/rounding: `collateral *= 101 / 100`
5. Withdraw and convert collateral to repay flash loan

This may leave small amounts of excess USDT as idle balance.

### Full Delever (rebalance(0))

When fully exiting the leveraged position:

1. Flash loan the ENTIRE debt amount
2. Repay all debt to Morpho
3. Withdraw ALL remaining collateral (not just enough for flash loan)
4. Convert all collateral to USDT
5. Repay flash loan, remainder becomes idle USDT

The key difference: partial delever withdraws only what's needed for the flash loan, while full delever withdraws everything.
