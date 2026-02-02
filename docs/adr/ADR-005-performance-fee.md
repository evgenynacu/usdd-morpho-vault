# ADR-005: Performance Fee

## Question
How do we accrue and calculate performance fees?

## Decision
**High-water mark with virtual shares** - mint fee shares when NAV exceeds previous high.

## Mechanism

1. Track `highWaterMark` (highest NAV per share achieved)
2. On profit realization (any user action or explicit harvest):
   - If current NAV/share > highWaterMark:
     - Calculate profit = (currentNAV/share - highWaterMark) * totalSupply
     - Fee = profit * performanceFeeBps / 10000
     - Mint new shares to feeRecipient worth `fee` amount
     - Update highWaterMark = currentNAV/share

## Rationale

1. **Fair to users** - Only charge fees on actual gains above previous peak.

2. **No double-charging** - High-water mark prevents charging fees on recovery from losses.

3. **Standard pattern** - Used by most sophisticated vaults (Yearn v3, etc.).

4. **Share dilution** - Minting shares is cleaner than transferring assets; doesn't require liquidity.

## Example

- High-water mark: 1.00 USDT/share
- Current NAV/share: 1.10 USDT/share
- Total supply: 1000 shares
- Performance fee: 10%

Profit = (1.10 - 1.00) * 1000 = 100 USDT
Fee = 100 * 10% = 10 USDT
Shares minted = 10 USDT / 1.10 = ~9.09 shares to manager

New high-water mark: 1.10 USDT/share
