# ADR-006: Rebalance Interface

## Question
How does the keeper interact with the vault for rebalancing?

## Decision
**Simple lever/delever function** with target LTV parameter and safety guardrails.

## Interface

```solidity
function rebalance(uint256 newTargetLTV) external onlyRole(KEEPER_ROLE)
```

- `newTargetLTV > currentLTV` → Lever up (borrow more, buy more sUSDD)
- `newTargetLTV < currentLTV` → Delever (sell sUSDD, repay debt)
- `newTargetLTV == 0` → Full delever (emergency exit to idle USDT)

## LTV Validation

The vault enforces multiple safety checks on target LTV:

| Check | Constraint | Error |
|-------|------------|-------|
| Absolute maximum | `newTargetLTV <= 0.9e18` (90%) | `InvalidLTV` |
| Market LLTV | `newTargetLTV < marketParams.lltv` | `LTVExceedsLLTV` |

**Why both checks?**
- `MAX_LTV` is a conservative hard limit (90%)
- `marketParams.lltv` is the actual liquidation threshold from Morpho market
- Target must be below BOTH to ensure safety margin before liquidation

**Example:**
- Market LLTV: 86%
- MAX_LTV constant: 90%
- Valid targetLTV range: 0% to 85.99%

## State Changes

```solidity
// Updates stored targetLTV
targetLTV = newTargetLTV;

// Emits event
emit TargetLTVUpdated(oldLTV, newLTV);

// Executes rebalance via flash loan
if (targetDebt > currentDebt) _leverUp(additionalDebt);
else if (targetDebt < currentDebt) _delever(debtToRepay, isFullDelever);
```

## Idle USDT Handling

**All idle USDT is automatically deployed during lever up.**

When `rebalance()` increases leverage, any idle USDT in the vault is converted to sUSDD and added to the position. This ensures capital is always working.

**Formula:**
```solidity
targetDebt = NAV * newTargetLTV / (1 - newTargetLTV);
// During lever up, idle USDT is included in the collateral conversion
```

**Example: Re-lever after full delever**
1. Initial state: 4000 sUSDD collateral, 3000 USDT debt (75% LTV)
2. `rebalance(0)` → All converted to ~1000 idle USDT
3. `rebalance(0.6e18)` → All 1000 USDT deployed into new position at 60% LTV

**When idle USDT exists (targetLTV > 0):**
- Partial delever buffer (0.1% / 10 bps) creates small idle amounts
- Next lever up automatically deploys this idle
- No manual intervention needed

## Rationale

1. **Single parameter** - Keeper specifies desired end state, vault figures out the steps.

2. **Atomic execution** - Uses same flash loan pattern as deposits/withdrawals.

3. **Multiple guardrails** - Both absolute and market-relative limits prevent risky positions.

4. **Simplicity** - No complex command arrays or multi-step orchestration needed.

## Keeper Responsibilities

1. Monitor sUSDD yield vs Morpho borrow rate
2. Monitor current LTV vs acceptable range
3. Call `rebalance()` when adjustment needed
4. Delever (`rebalance(0)`) if strategy becomes unprofitable
5. Consider gas costs vs benefit of rebalancing

## Access Control

- Only addresses with `KEEPER_ROLE` can call `rebalance()`
- Multiple keepers can be granted the role via AccessControl
- Admin can grant/revoke keeper role as needed

## Rebalance Blocked When

- Vault is paused (`whenNotPaused` modifier)
- Would exceed MAX_LTV (90%)
- Would exceed market LLTV (liquidation threshold)
