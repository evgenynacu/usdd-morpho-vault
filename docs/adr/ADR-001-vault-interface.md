# ADR-001: Vault Interface

## Question
Should we use standard ERC4626 or a custom vault interface?

## Decision
**Standard ERC4626** with USDT as the base asset.

> **Note:** The interface is limited to `deposit()` and `redeem()` only. See [ADR-005](ADR-005-limited-erc4626.md) for rationale.

## Rationale

1. **Simpler architecture** - Single strategy with atomic operations, no need for complex parent/child or queued epochs.

2. **No epoch batching needed** - Our sUSDD swap has no slippage, so deposits/withdrawals can execute atomically in single transactions.

3. **Ecosystem compatibility** - ERC4626 enables integration with aggregators, yield dashboards, and other DeFi protocols.

4. **Sufficient flexibility** - We can override `_deposit`/`_withdraw` to handle leverage operations while maintaining standard interface.
