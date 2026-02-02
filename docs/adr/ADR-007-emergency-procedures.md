# ADR-007: Emergency Procedures

## Question
How does emergency withdrawal work?

## Decision
**Two-tier system**: keeper delever + admin emergency withdraw.

## Tier 1: Keeper Delever (Automated)

- **Who**: Keeper role
- **How**: `rebalance(0)` - sets target LTV to zero
- **Effect**: Full delever, vault holds only idle USDT
- **Use case**: Risk detected (depeg risk, high borrow rate, low liquidity)

This is **not a loss** - just stops earning yield until conditions improve. Keeper can later call `rebalance(targetLTV)` to re-lever.

## Tier 2: Admin Emergency Withdraw

- **Who**: Admin role only
- **When**: Keeper cannot act (compromised, paused, bug in rebalance logic)
- **Effect**: Force unwind bypassing normal checks
- **Use case**: Critical vulnerability, complete system failure

## Pause States

| State | Deposits | Withdrawals | Rebalance |
|-------|----------|-------------|-----------|
| Normal | yes | yes | yes |
| Paused | no | yes | no |
| Paused + Deleveraged | no | yes (idle USDT) | no |

## Flow: Keeper Delever

1. Keeper detects risk condition
2. Keeper calls `rebalance(0)`
3. Vault uses flash loan to fully unwind position
4. Vault now holds idle USDT
5. Users can still deposit/withdraw normally
6. When safe, keeper calls `rebalance(targetLTV)` to resume

## Rationale

1. **Automated response** - Keeper can react to risks without human intervention.

2. **No loss of funds** - Delever only stops yield, doesn't lose principal.

3. **Reversible** - Keeper can re-lever when conditions improve.

4. **Defense in depth** - Admin emergency withdraw as last resort if keeper path fails.
