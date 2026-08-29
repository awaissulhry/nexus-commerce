# CX.3c — the Advertising page stops showing fossils (exact change)

Programme: `docs/2026-08-29-cx-channel-connections.md` §4 row **CX.3**, the remainder. Owner, 2026-08-29: *"Go ahead. I'll go with your recommendations."*
Depends on CX.3a and CX.3b, both live and prod-verified.

## 0. What I expected to build, and what the measurement changed

I said CX.3c was blocked on "reconciling the metadata shape" so the remaining ~39 read sites could move. Checking what actually writes each field turned that inside out. Three of the columns those sites read are **not per-profile facts at all**, and two of them are **dead**:

| Column on `AmazonAdsConnection` | What writes it | Prod value (9 rows) |
|---|---|---|
| `lastVerifiedAt` | **nothing** | frozen at **2026-05-18** on every row — 3 months old |
| `lastError` / `lastErrorAt` | **nothing** | null on every row |
| `tokenIssuedAt` / `tokenExpiresAt` | the OAuth callback, once, as `issued + 365d` | `tokenIssuedAtIsEstimate = true` on **every** row |
| `accountLabel`, `marketplace`, `region` | the OAuth callback | per-profile channel facts |
| `mode`, `writesEnabledAt`, `lastWriteAt` | the operator's routes | per-profile decisions (CX.3b mirrors these) |

So `/api/advertising/connections` — read by **nine** web call sites and rendered on the Advertising page — shows an operator:

- a **"last verified"** that no code has updated since May;
- a **token expiry** that is a guess the schema itself flags as an estimate;
- a **"last error"** column that is structurally always empty, so a failing profile looks identical to a healthy one.

Meanwhile the connection core, since CX.1, holds the measured versions of all three: `lastHeartbeatAt` (a real `/v2/profiles` call every 15 minutes), `refreshTokenExpiresAt` (from the actual grant), and `lastError` + `authStatus` (from the state machine that has been running all day).

**This unit serves the truth the system already has, without changing the response shape.** That is worth more than converting 39 call sites, and it is the reason the conversion was blocked in the first place.

## 1. The change

`GET /api/advertising/connections` keeps **every field name and type** — nine web call sites depend on the shape, and this unit must not touch them. What changes is where three of the values come from:

| Field | Was | Becomes |
|---|---|---|
| `lastVerifiedAt` | a dead column, May 2026 | the connection's `lastHeartbeatAt` — a real Amazon call, ≤15 min old |
| `lastError` / `lastErrorAt` | always null | the connection's, from the heartbeat state machine |
| `tokenExpiresAt` | `issued + 365d`, flagged as an estimate | the connection's `refreshTokenExpiresAt`, measured at the grant |
| `tokenIssuedAtIsEstimate` | `true` on every row | **false** when the value is the measured one |
| `daysToTokenExpiry` / `tokenExpiryStatus` | derived from the estimate | derived from the measurement |

Per-profile fields (`profileId`, `marketplace`, `region`, `accountLabel`, `mode`, `writesEnabledAt`, `lastWriteAt`, `isActive`) come from the scope when the core can answer, and from the row otherwise — through the CX.3b resolver, so there is one lookup path, not a second one.

When the core cannot answer, every value falls back to today's row exactly as now. `NEXUS_CX_ADS_RESOLVER=0` reverts the whole thing.

## 2. The metadata shape, reconciled

Three writers touch a profile scope's `metadata`, and they wrote overlapping-but-different shapes. Now documented in one place (`ads-profile-resolver.ts`) and merged, never replaced:

| Key | Written by | Meaning |
|---|---|---|
| `marketplace`, `marketplaceStringId`, `currencyCode`, `timezone`, `accountId`, `accountType`, `accountName` | discovery (the heartbeat) | what the CHANNEL says |
| `mode`, `writesEnabledAt`, `lastWriteAt` | the operator's routes, mirrored | what WE decided |
| `legacyRowId` | the CX.3a migration | provenance, until the row goes |

`accountName` is added by discovery so `accountLabel` has a per-profile source that is Amazon's own answer rather than a column last written at connect time.

## 3. What is deliberately NOT done

- **The dead columns are not dropped.** `lastVerifiedAt` and `lastError` stay on the table (`feedback_keep_placeholder_controls`); they simply stop being *displayed* as if current. Dropping columns is a destructive migration and needs its own decision.
- **The ~39 read sites stay as they are.** With the endpoint honest and the resolver in place, converting them is mechanical cleanup with no behaviour change — real work, but not urgent, and each one is a chance to introduce exactly the kind of silent difference this phase keeps finding. They move when something else needs them to.

## 4. Verification on prod

1. `/api/advertising/connections` returns the same field set (compared key-by-key against the shape nine web callers expect).
2. `lastVerifiedAt` is **minutes** old, not months, and moves again after a heartbeat.
3. `tokenIssuedAtIsEstimate` is `false`, and `tokenExpiresAt` matches the connection's `refreshTokenExpiresAt`.
4. The Advertising page renders unchanged in structure, with the new values.
5. `NEXUS_CX_ADS_RESOLVER=0` restores today's values exactly.
