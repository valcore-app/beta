# Valcore

Valcore is an on-chain DeFi strategy execution protocol. Users allocate capital into structured strategy slots, the protocol prices risk and performance over each epoch, and settlement is finalized from verified market data.

**Epoch Flow**
1. Operator runs a new epoch and publishes the asset universe.
2. Users submit strategy allocation and commit capital.
3. Epoch locks and exposure becomes fixed.
4. Oracle finalizes settlement from market prices.
5. Users claim settled balances.

**Risk & Settlement Model**
Valcore applies a capped-downside / amplified-upside settlement model designed for disciplined allocation. Outcomes are deterministic at finalization and reflected both on-chain and in the protocol database.

**Protocol Objective**
Valcore turns strategy execution into a repeatable DeFi primitive: transparent lifecycle, consistent risk rules, and verifiable settlement.

**Closed Testnet Deployment Notes**
1. Deploy `apps/web` publicly.
2. Deploy `apps/oracle` as a private/internal service.
3. Route web-to-oracle traffic only through `/api/oracle/[...path]`.
4. Set both `ORACLE_ADMIN_API_KEY` and `ORACLE_PLAYER_API_KEY` in web and oracle environments.
5. Keep `ORACLE_INTERNAL_URL` private (internal network address), never expose it to clients.
