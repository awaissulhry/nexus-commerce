# BP.S — Shared channel accounts and account-level access

Date: 2026-09-16. Status: **BP.S1, BP.S2, BP.S3 and loose ends L1/L2 COMPLETE** and
**committed** on the Owner's word (§23 — the "Nothing committed" lines below record each
section's state when it was written). **Not end-to-end AAA yet** — §18 and §22.4 list what is
still open.

Owner's ask, 2026-09-16: *"the ability to connect a single account to multiple profiles and limit
the profiles by access or something like that."*
Owner's scope decision, same day: **read-only sharing first, publish after**; and **both** access
limits — per profile (read vs publish) **and** per person (account restriction).

Builds on [business profiles](2026-09-08-business-profiles-architecture.md) (BP, dark until
2026-09-16) and [MAP](2026-08-19-map-multi-account-profiles.md).

---

## 1. What was measured first

Every claim below was read out of the tree or run on 2026-09-16, not recalled.

| Fact | Evidence | Why it decides something |
| --- | --- | --- |
| One seller account maps to exactly ONE profile, by primary key. | `packages/database/prisma/schema.prisma:19034` — `ChannelAccountOwnership.@@id([channelType, environment, externalAccountId])` | Sharing cannot be expressed as a second owner. It has to be a *grant*. |
| 409 row-level-security policies all read `workspaceId = current_setting('nexus.workspace_id')`. | `packages/database/prisma/migrations/20260908b_workspace_data_isolation/migration.sql`, 409 × `CREATE POLICY` | A row belongs to one profile at the database layer. Sharing is a policy change, not a column change. |
| The policy's `USING` (read) and `WITH CHECK` (write) clauses are **separate**. | same file, `:7172` | Read-only sharing can be enforced *by PostgreSQL*, not by application discipline. Extend `USING`; leave `WITH CHECK` untouched and the guest physically cannot write the row. |
| An inbound notification resolves its profile by seller id and **refuses if it finds more than one**. | `apps/api/src/lib/workspace-ingress.ts:6` — `take: 2`, then `if (candidates.length !== 1) throw WorkspaceError('ingress_account_ambiguous', …, 503)` | 🔴 **The landmine.** Naïvely giving one account two profiles stops every incoming order for that account immediately. Inbound MUST stay with one owner. |
| Every connection lookup already names its account. | `apps/api/scripts/map0-connection-resolution-audit.mts --ratchet`, run 2026-09-16: **0 ambient**, 46 NAMED / 8 SCOPED / 31 WRITE / 14 OTHER, baseline 0, enforced in `.githooks/pre-push:223` | Both features get exactly one home. Nothing picks an account by accident, so nothing can silently pick a *shared* one either. |
| One module decrypts credentials. | `apps/api/src/services/cx/token.service.ts:2` — *"the ONLY module that decrypts a connection's credentials"*; `getAccessToken` at `:247` | The credential guard for a guest profile is **one function**, not a sweep. |
| `UserRole.channelScope` is still inert: stored, passed, displayed, never enforced. | `auth.routes.ts:321,343,425,471`; `team.routes.ts:71,79,124,132`; `team-access.service.ts:100,110,113` — every hit is a read/write/display, zero call sites gate on it | Per-person account limits are unbuilt, exactly as MAP.8 recorded. Not a lie to the operator: the web UI never offers it. |
| Route permissions resolve from `(method, pattern)` in a pre-handler. | `apps/api/src/lib/auth/rbac-hook.ts:42` — `permissionForRoute(method, pattern)` | 🔴 The RBAC hook **cannot** see which account a request will touch. This is why MAP.8 was parked in August. The 0-ambient result is what unparks it — see §5. |

---

## 2. The model

**One owner, many guests.** A channel account keeps exactly one owning profile. Other profiles
receive a *grant*. Ownership, credentials, reconnect, disconnect and inbound routing never move.

```
Xavia Racing  (owner)  ──owns──▶  eBay: xaviaracing
      │                                  │
      │                                  └──grant(mode=read)──▶  Second Business  (guest)
      └──owns──▶  Amazon: A1VRHK…
```

Deliberately NOT chosen, and why:

- **A second `ChannelAccountOwnership` row.** Refused by the primary key, and it would make the
  ingress guard at `workspace-ingress.ts:6` throw 503 on every order.
- **Copying the connection into the guest profile.** Two encrypted credential copies, two refresh
  leases, two competing owners of the same listings and stock. The BP architecture doc rules this
  out in as many words; it is also what `nexus_assign_channel_account()` was written to prevent.
- **A `workspaceIds String[]` on `ChannelConnection`.** Would need all 409 policies re-reasoned and
  breaks the `nexus_workspace_reference_guard` trigger contract.

---

## 3. BP.S1 — the grant, read-only

### 3.1 Schema (additive)

```prisma
model ChannelAccountGrant {
  connectionId     String
  connection       ChannelConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  /// The GUEST profile. Never defaulted from request context: this row is WRITTEN
  /// by the owner and READ by the guest, so a context default would be wrong on
  /// one of the two paths.
  workspaceId      String
  workspace        Workspace @relation("GrantGuest", fields: [workspaceId], references: [id], onDelete: Restrict)
  /// The owner at grant time. Denormalised so the owner can list and revoke its
  /// own grants, and so an audit names both sides without a join to a row the
  /// reader may no longer see.
  ownerWorkspaceId String
  ownerWorkspace   Workspace @relation("GrantOwner", fields: [ownerWorkspaceId], references: [id], onDelete: Restrict)
  /// 'read' | 'publish'. BP.S1 honours ONLY 'read'; 'publish' is refused at the
  /// write path until BP.S3 lands its claim index. The column exists now so the
  /// UI and the API contract do not change shape later.
  mode             String   @default("read")
  /// Empty = every marketplace the account carries. Non-empty = that subset only.
  marketplaces     String[] @default([])
  grantedByUserId  String
  grantedAt        DateTime @default(now())
  revokedAt        DateTime?
  revokedByUserId  String?

  @@id([connectionId, workspaceId])
  @@index([workspaceId])
  @@index([ownerWorkspaceId])
}
```

Its own RLS — **two** policies, for the reason given in §3.2 (a single `FOR ALL` policy whose
`USING` named both sides would have let the guest `DELETE` its own grant row):

```sql
-- nexus_workspace_isolation      FOR ALL    — owner only, both USING and WITH CHECK
-- nexus_workspace_grant_guest_read FOR SELECT — the guest may read its own grant, nothing else
```

Revocation is a `revokedAt` write, never a `DELETE`, so the history survives.

### 3.2 The one policy change — a SEPARATE `FOR SELECT` policy, not a wider `USING`

`ChannelConnection` and `ConnectionScope` only. The existing `nexus_workspace_isolation` policy is
**not modified**. A second, permissive, read-only policy is added beside it:

```sql
CREATE POLICY nexus_workspace_grant_read ON "ChannelConnection"
  FOR SELECT TO nexus_workspace_runtime
  USING (EXISTS (
    SELECT 1 FROM "ChannelAccountGrant" g
    JOIN "Workspace" w ON w.id = g."workspaceId"
    WHERE g."connectionId" = "ChannelConnection".id
      AND g."workspaceId"  = NULLIF(current_setting('nexus.workspace_id', true), '')
      AND g."revokedAt" IS NULL
      AND w.status = 'active'
  ));
```

🔴 **Why a separate `FOR SELECT` policy and not a second arm on the existing `USING`.** The existing
policy is `FOR ALL`. Its `USING` governs which rows `SELECT`, `UPDATE` **and `DELETE`** may target;
only `WITH CHECK` governs the resulting row on `INSERT`/`UPDATE`. So widening that `USING` would
have let a guest `DELETE` the owner's connection outright — `DELETE` consults `USING` alone and
never reaches `WITH CHECK`. PostgreSQL OR-combines permissive policies per command, so a separate
`FOR SELECT` policy adds read access and adds nothing else:

| command | policies consulted | guest result |
| --- | --- | --- |
| `SELECT` | isolation `USING` **OR** grant `USING` | ✅ reads the row |
| `UPDATE` | isolation `USING` only (grant policy is `FOR SELECT`) | ❌ no row to target |
| `DELETE` | isolation `USING` only | ❌ no row to target |
| `INSERT` | isolation `WITH CHECK` only | ❌ refused |

Verification arm §7.2 exercises `UPDATE` **and** `DELETE` as the guest, not just `UPDATE`.

Because the resolver ratchet is at 0, **no call site changes.** `listActiveConnections`,
`resolveConnection`, `primaryConnectionIds` and the 46 named lookups all pick up granted accounts
through the policy.

Because the resolver ratchet is at 0, **no call site changes.** `listActiveConnections`,
`resolveConnection`, `primaryConnectionIds` and the 46 named lookups all pick up granted accounts
through the policy.

### 3.3 The credential guard — the security-critical piece

RLS grants ROW access, and `ChannelConnection.credentialsEnc` is a column on that row. Read access
alone must never yield a usable token.

One guard, in the one module that decrypts (`services/cx/token.service.ts`):

- `getAccessToken(connectionId)` and `refreshNow(connectionId)` resolve the connection's
  `workspaceId` and throw `WorkspaceError('account_not_owned', …, 403)` when it differs from the
  current context.
- A dedicated test asserts a guest context gets 403 from `getAccessToken` while the owner context
  gets a token — the positive control in the same run, per
  `reference_could_not_measure_vs_measured_empty`.

Outbound queue jobs already carry their originating workspace (`lib/workspace-jobs.ts`), so a job
queued by the owner keeps working; a guest cannot queue one because it cannot write.

### 3.4 Inbound is untouched

`workspace-ingress.ts` still finds exactly one `ChannelAccountRoute` per account, because a grant
creates no route row. Orders, notifications and webhooks continue to land in the owner. **This is
the whole reason the design is a grant and not a second owner.** A test asserts
`verifiedChannelWorkspace` still returns one candidate with a grant present.

### 3.5 What the guest actually gets

Read access to the account row and its marketplace scopes. That is what makes the account visible
in the guest's Channels page and nameable in reporting.

🔴 **It does NOT by itself make the owner's listings, orders or stock visible in the guest
profile.** Those rows carry their own `workspaceId` and their own policies. Extending them is a
separate decision with a separate blast radius, and it is **out of scope here** — see §6.

### 3.6 UI (Nexus DS, existing surfaces, no new pages)

- `settings/channels` → Accounts tab: each account row gains **Share with a profile** beside the
  existing Assign profile, opening a dialog on the same `BusinessProfilePicker` the assignment
  dialog already uses. Owner-only.
- An account row in a **guest** profile renders a `Shared from <owner>` chip, no Rename / Test /
  Reconnect / Disconnect / Make primary / Assign profile, and the reason in words — not a disabled
  control, per MAP.4's finding that a `title` on a disabled button is unreachable and measured
  2.04:1.
- A **Shared accounts** section listing grants the owner has given, each with Revoke.

---

## 4. BP.S2 — per-person account restriction (MAP.8, unparked)

August's blocker was structural: `rbac-hook.ts:42` resolves a permission from `(method, pattern)`
before the handler runs, so it cannot know which account the request will touch. Half-built
authorization is worse than none, so it was given its own engagement.

**The ratchet closing is what changes that.** With 0 ambient lookups, every site that reaches an
account names it, and the connection resolver is the single door. So:

- `WorkspaceMemberRole` gains an optional restriction: the set of `connectionId`s a membership may
  use. Empty = unrestricted (today's behaviour, so existing members are unchanged).
- `connection-resolver.service.ts` refuses a connection outside the actor's set, fail-closed, the
  same way it already refuses an ambiguous scope. `nexus.actor_id` is already in the database
  context (it is in all 409 policies), so this can be belt-and-braces in RLS too.
- The existing inert `UserRole.channelScope` is **migrated or removed, not left beside a second
  mechanism** — two access fields where one is enforced is exactly the lie
  `feedback_100_percent_honest_ui` forbids. The BP migration preflight already stops on non-empty
  `channelScope`, so the set is known and small.
- Team settings gets the control. Until it does, the field stays absent from the UI rather than
  present and ignored.

---

## 5. BP.S3 — publish grants (named, NOT built)

Deferred by the Owner. Recorded so the shape is not re-invented:

A shared account with two publishing profiles needs, before it is safe:

1. **A listing claim index** on `(connectionId, marketplace, externalListingId)` → owning profile,
   so two profiles cannot both own one live listing. Two isolated catalogs can legitimately hold
   the same SKU — SKU uniqueness is per profile since `20260908b` — so the claim must key on the
   *channel's* identifier, not ours.
2. **A stock ownership rule.** One physical eBay quantity, two independent stock pools, is an
   oversell. `reference_oversell_is_per_channel_not_summed` and the shared Amazon EU quantity are
   the precedents.
3. **A publish preflight** that names the destination account and refuses on an unclaimed or
   foreign-claimed listing, before anything is queued.

Only then does `mode='publish'` stop being refused.

---

## 6. Explicitly out of scope

- Sharing the owner's **listings, orders, stock or catalog** into a guest profile. BP.S1 shares the
  *account*, not its business records.
- Publishing from a guest profile (BP.S3).
- Cross-profile consolidated reporting.
- Moving an account **with** business history — still refused by `nexus_assign_channel_account()`.
- Any production migration or flag change. BP itself is local-only as of 2026-09-16.

---

## 7. How this gets verified

Not "tests pass" — the specific arms that would fail if the design is wrong:

1. **Inbound survives.** With a grant present, `verifiedChannelWorkspace` returns one candidate.
   Positive control: insert a second `ChannelAccountRoute` by hand and watch it 503, proving the
   test can fail.
2. **The guest cannot write.** As `nexus_workspace_runtime` (the non-bypass role) in a guest
   context: `UPDATE` affects 0 rows, **`DELETE` affects 0 rows**, `INSERT` is refused — all by RLS,
   not by application code. The `DELETE` arm is the one that would have passed silently under a
   widened `FOR ALL` `USING`; it is the reason §3.2 uses a separate `FOR SELECT` policy. Positive
   control in the same run: the owner context updates the same row successfully, so a zero here
   means "refused", never "the statement never ran".
3. **The guest cannot get a token.** `getAccessToken` under a guest context → 403; under the owner
   context in the same run → a token.
4. **Revocation is immediate.** Set `revokedAt`, re-read in the guest context, row gone.
5. **An archived guest loses access.** The policy's `status = 'active'` arm.
6. **BP.S2:** a restricted member resolving a connection outside their set fails closed; an
   unrestricted member is unaffected.
7. Migration rehearsed on a disposable copy before it touches the local database, and applied
   directly — never `prisma migrate deploy`, which would drag the ~7 unrelated parked 0913–0915
   migrations (`reference_migrate_deploy_drags_parked_migrations`).

---

## 8. Order of work

| Unit | Contents | Gate |
| --- | --- | --- |
| BP.S1a ✅ | `ChannelAccountGrant` + its policy + the two `FOR SELECT` policies. Migration only. | Done — see §9 |
| BP.S1b ✅ | The `token.service` credential guard + tests. | Done — see §10 |
| BP.S1c ✅ | API: grant / revoke / list endpoints, owner-only. | Done — see §12 |
| BP.S1d ✅ | UI on `settings/channels`. | Done — see §13 |
| BP.S2 ✅ | Per-person account restriction. | Done — see §14 |
| BP.S3 ✅ | Publish grants. | Done — see §16 |

Nothing is committed without the Owner's approval of this document.

---

## 9. BP.S1a — build record (2026-09-16)

Migration `20260916a_bps1a_channel_account_grant`, applied to the **local** database only.
Applied directly, never `prisma migrate deploy` — the local tree is behind on ~7 unrelated
0913–0915 migrations that must not be dragged in
(`reference_migrate_deploy_drags_parked_migrations`).

Order was edit → verify → migrate → generate, as four steps, per PES.5's finding that combining
them left the database carrying a column the schema did not have.

### 9.1 Design change made during the build

§3.2 originally widened the existing `FOR ALL` policy's `USING` clause. **That was a hole.** In
PostgreSQL, `DELETE` consults `USING` alone and never reaches `WITH CHECK`, so a guest could have
deleted the owner's connection outright. Replaced with a separate `FOR SELECT` policy, which
PostgreSQL OR-combines per command, adding read and nothing else. The rehearsal now exercises
`DELETE` as well as `UPDATE`; the `DELETE` arm is the one that would have passed silently.

### 9.2 Rehearsal — 19 arms, all passed, then rolled back

Applied the migration inside one transaction, asserted, `ROLLBACK`. `ChannelAccountGrant` confirmed
absent afterwards. Script: `scratchpad/bps1a-rehearse.cjs`. Every context used
`SET LOCAL ROLE nexus_workspace_runtime` + `set_config('nexus.workspace_id'/'nexus.actor_id')` —
**the same statements `packages/database/workspace-adapter.ts:20-22` issues at runtime**, so the
rehearsal exercised the real enforcement path and not a superuser that bypasses RLS.

| Arm | Result |
| --- | --- |
| Guest sees nothing *before* a grant (the baseline that gives every later "1 row" meaning) | 0 rows |
| Owner creates a grant through RLS | 1 row |
| Guest **cannot** grant itself access | refused |
| Guest `SELECT`s the shared account / its scopes | 1 row / 1 of 1 |
| Guest `UPDATE` | 0 rows |
| 🔴 Guest `DELETE` | 0 rows |
| Guest cannot `DELETE` its own grant | 0 rows |
| **CONTROL** — owner `UPDATE`, same transaction | 1 row |
| Revoke → guest re-reads | 0 rows |
| Archived guest | 0 rows |
| Revoked member of the guest | 0 rows |
| **CONTROL** — membership restored | 1 row |
| 🔴 Inbound still resolves exactly ONE profile | 1 candidate |
| Guest profile has no ingress route at all | 0 routes |
| `mode` outside read\|publish | refused |
| Self-grant | refused |

### 9.3 End-to-end, against the running app

A real grant was inserted as the owner, through RLS. The guest profile's Channels page then showed
the shared eBay account — **with no application code changed at all**, exactly as §3.2 predicted
from the 0-ambient ratchet. The grant was removed again afterwards; see §9.4.

Boundary confirmed in the guest's context, with a positive control in the same run:

| Guest context reads | Rows |
| --- | --- |
| the shared account | **1** |
| `Product` | 0 |
| `ChannelListing` on that account | 0 |
| `Order` on that account | 0 |
| `ConnectionEvent` on that account | 0 |
| *(superuser, same account)* | *274 listings — so each 0 above is a refusal, not an empty table* |

### 9.4 🔴 What this exposed, and why the grant was removed again

With a grant live, the guest's account row rendered the **owner's** control set — Rename, Test,
Reconnect, **Disconnect**, Assign profile — plus a `Primary` badge that means nothing outside the
owning business. RLS would refuse every one of those writes, so they are safe but **dishonest**: a
control that cannot work must not be offered, and a disabled control is not the answer either
(MAP.4 measured a disabled button at 2.04:1 with an unreachable `title`).

The test grant was therefore deleted. `ChannelAccountGrant` is empty. **Do not create a grant
through the database until BP.S1d ships the guest control set** — the mechanism works, the UI does
not yet tell the truth about it.

`ConnectionEvent` is deliberately *not* in the read policy, so a guest's Diagnostics tab will show
no history for a shared account. BP.S1d decides whether that reads as honest or as broken.

### 9.5 Gates

| Check | Result |
| --- | --- |
| `prisma validate` | valid |
| `apps/api` typecheck | 0 errors |
| `apps/web` typecheck | 0 errors |
| `check-schema-drift.mjs` (table-level) | pass — 434 models |
| `check-column-drift.mjs` (column-level) | pass — 434 tables |
| `map0-connection-resolution-audit --ratchet` | 0 ambient (unchanged; no call sites touched) |

Nothing committed.

---

## 10. BP.S1b — build record (2026-09-16)

The guard that makes a READ grant genuinely read-only.

### 10.1 The guard

`assertCredentialOwner(row)` in `apps/api/src/services/cx/token.service.ts`. A no-op while
`NEXUS_WORKSPACES_ENABLED !== '1'`; otherwise it throws
`WorkspaceError('account_not_owned', …, 403)` when the row's `workspaceId` is not the caller's.

Called in **two** places, not one:

1. `readCredentials(row)` — the private function every decrypt goes through, so it covers
   `getAccessToken`, `readRefreshToken`, `refreshNow`, `revoke`, `encryptLegacyRow` and
   `restorePlaintextRow` from a single line.
2. 🔴 `getAccessToken`, right after the row is fetched — because the branch below it,
   `managedBy === 'env' && channelType === 'AMAZON'`, **returns a token minted from the
   environment and never reaches `readCredentials` at all.** Guarding only the decrypt path would
   have left the env-managed Amazon account shareable-and-usable. Its own test arm covers it.

Fail-closed by construction: with profiles on and no business context,
`workspaceIdForQuery()` throws rather than defaulting. That branch is unreachable today —
`packages/database/workspace-adapter.ts:18` sets `nexus.workspace_id` to `''`, so RLS returns no
rows — but it refuses a future unscoped caller instead of trusting it.

### 10.2 🔴 The engine, found late: policies are GENERATED, and the migration had bypassed it

`packages/database/scripts/workspace-policies.mjs` builds every policy from
`packages/database/workspaces/model-ownership.json`, and `formulaDatabase()` applies **that**, not
the migrations. So BP.S1a's hand-written policies existed in the deployed database and **not** in
the disposable database every test runs against — two builders, drifting from birth
(`reference_two_column_builders_drift`). Worse, `ChannelAccountGrant` was in neither
`globalModels` nor `workspaceModels`, so the generator emitted no `GRANT` for it and the runtime
role could not have read it at all.

Corrected to the pattern already in the tree — `account-assignment.sql` is byte-for-byte identical
to migration `20260908e`:

- `packages/database/workspaces/account-grant.sql` now holds the RLS + GRANT + four policies.
- The generator reads it, next to `account-assignment.sql`.
- Migration `20260916a` = table DDL + that file's exact bytes. Asserted: the migration **ends with**
  the shared file, byte for byte.
- `ChannelAccountGrant` classified in **`globalModels`**, beside `ChannelAccountOwnership` and
  `ChannelAccountRoute`. Global is correct: it spans two businesses by design, so the generated
  one-workspace `nexus_workspace_isolation` policy would be wrong for it. It brings its own.

🔴 **There is no gate keeping that map complete.** Nothing derives it from `schema.prisma`; a new
model can be added and silently left unclassified, which is what happened here and was caught only
because a test could not read its own table. Checked by hand after the fix: 434 models in the
schema, 434 classified, none unclassified, none stale. A derived gate is the obvious follow-up and
is **not** built — see §11.

### 10.3 Test — real PostgreSQL, not a fake

`apps/api/src/services/cx/token-grant-ownership.vitest.test.ts`, 9 arms, all passing. It runs
against a disposable PostgreSQL carrying the **real generated policies**, with `db.js` mocked to a
Proxy that forwards to that client — because the point is the *interaction* between the policy that
grants the read and the guard that refuses the use. A mocked prisma could have let the guard pass
while the policy was wrong, or the reverse, and neither would have been visible.

| Arm | Result |
| --- | --- |
| **CONTROL** — owner reads the row *and* gets its token | token returned |
| Guest **can** see the shared account (else the refusals prove nothing) | row, `workspaceId` = owner |
| Guest `getAccessToken` | `account_not_owned` / 403 |
| Guest `readRefreshToken` | `account_not_owned` |
| Guest `refreshNow` | `account_not_owned` |
| 🔴 Guest `getAccessToken` on the **env-managed Amazon** account | `account_not_owned` |
| A business with no grant | row is `null` |
| Revoke → guest re-reads → restore | `null`, then the row again |
| **CONTROL** — guard inert with profiles off, same context, same row | token returned |

Two arms initially failed on `No ChannelSpec registered for EBAY`: `getAccessToken` resolves the
channel spec *before* returning a cached token, and specs register as an import side effect. Both
failures were the **success controls**. Fixed by importing the real connector rather than
weakening the assertions — a control that cannot run makes every refusal beside it meaningless.

The file restores `NEXUS_WORKSPACES_ENABLED` in `afterAll`: vitest may run several files per
worker, and the sibling `token.service.vitest.test.ts` asserts the profiles-off behaviour.

### 10.4 Gates

| Check | Result |
| --- | --- |
| `apps/api` typecheck | 0 errors |
| `src/services/cx/` — 15 files | 301 passed |
| workspace / connection-resolver / workspace-jobs / product-workspace-scope | 67 passed |
| `check-schema-drift.mjs` | pass — 434 models |
| `check-column-drift.mjs` | pass — 434 tables |
| migration tail == `account-grant.sql` | byte-identical |
| ownership map completeness (by hand) | 434 / 434, none unclassified |

Nothing committed.

---

## 11. Follow-ups this work exposed (NOT built, need their own yes)

1. **A gate deriving `model-ownership.json` from `schema.prisma`.** §10.2 — a new model can be left
   unclassified silently. Cheap; the one-line check already written by hand would become the gate.
2. **A parity gate for the shared policy files.** `account-grant.sql` and `account-assignment.sql`
   are byte-for-byte copies inside their migrations by convention only; nothing asserts it.
3. **`ConnectionEvent` for a guest.** Deliberately not shared, so a guest's Diagnostics tab shows no
   history for a shared account. BP.S1d decides whether that reads as honest or as broken.

---

## 12. BP.S1c — build record (2026-09-16)

`apps/api/src/services/channel-account-grant.service.ts` + four routes on
`accounts.routes.ts`. Three layers, each covering what the others cannot:
RLS is the backstop, the service states WHY in words and enforces the OWNER role
(which RLS cannot express), and BP.S1b keeps credentials out of it.

### 12.1 Routes

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /api/accounts/:id/grants` | `settings.integrations.manage` | Owner view of who it is shared with |
| `POST /api/accounts/:id/grants` | `settings.integrations.manage` | Share; body `{destinationWorkspaceId, mode?, marketplaces?}` |
| `POST /api/accounts/:id/grants/:workspaceId/revoke` | `settings.integrations.manage` | **POST, not DELETE** — it writes `revokedAt` and keeps the row |
| `GET /api/accounts/shared-with-me` | `settings.integrations.manage` | Guest view: which rows belong to someone else |

Manifest entries sit **before** the broad `/api/accounts` one (first match wins),
because that entry reads at `PG.dashboard` and these lists **name other
businesses**. Resolution verified for all four plus the four existing routes,
which are unchanged.

### 12.2 The rules, and why each exists

- **Owner of BOTH sides**, re-read from live membership via `workspaces.requireOwner`.
  An owner here gets no authority in the destination.
- 🔴 **The account must be OWNED here, not merely visible here.** Before `20260916a`
  a successful `findUnique` implied ownership; `nexus_workspace_grant_read` broke
  that. Without this a guest could pass on an account it only borrows, and the owner
  would never know about the second guest. Same lesson as BP.S1b's env-Amazon branch.
- **An API key can never share.** Its context carries `actorUserId: null` and
  `roleKeys: []` (`workspace-hook.ts:58`), so sharing stays a deliberate human act.
- **`mode: 'publish'` is refused by NAME** (`grant_mode_unavailable`, 400), not as a
  generic validation error — it is a real future value and the operator deserves to
  know it is not built yet, not that they typed something invalid.
- **Re-sharing UPDATES the same row** and clears `revokedAt`, so a share's history
  stays in one place instead of accumulating duplicates.
- **Both businesses get a `WorkspaceAudit` row.** A guest must be able to see how it
  got access.
- **A malformed `marketplaces` list is refused**, never coerced — a narrowing list
  that silently becomes empty widens the share.

### 12.3 🔴 A test that passed for the wrong reason

`the guest CANNOT share on further an account it only borrows` was pointed at a
destination the actor did not own. It was refused — with
`workspace_owner_required`, because the destination check ran first. A true
refusal that said something untrue, and it would have gone on passing if the
account-ownership check were deleted.

Two fixes, both needed:
1. The service now answers **"can you share this account at all"** before
   **"may you share it there"** — the conceptual order, and the one that gives the
   accurate message.
2. The test gained a fourth business the actor genuinely owns, so the only thing
   left to refuse is the account. Plus a **control** proving that same actor CAN
   share that same destination an account it does own.

### 12.4 Tests — 17 arms, real PostgreSQL

`apps/api/src/services/channel-account-grant.vitest.test.ts`. Controls first; both
refusal directions; the API-key arm; malformed marketplaces; revoke, double-revoke,
and re-share reusing one row.

### 12.5 End-to-end through the running stack

Browser → Next proxy → API → RLS, on the real local database with a real session:

| Step | Result |
| --- | --- |
| Owner shares the eBay account with the second business | `200`, grant named `Second Business (test)` |
| Owner lists grants | the share |
| `mode: 'publish'` | `400 grant_mode_unavailable`, honest sentence |
| **Guest** `shared-with-me` | names the account AND its owner |
| **Guest** tries to re-share it | `403 account_not_owned` |
| **Guest** tries to list its grants | `403 account_not_owned` |
| Owner revokes | `200 revoked:true` |
| Owner revokes again | `404` "already been revoked" |
| Owner lists after revoke | the row survives, `revokedAt` set |

⚠ **A trap for BP.S1d:** the revoke POST has no body. Sending
`Content-Type: application/json` with an empty body makes Fastify reject it with
`FST_ERR_CTP_EMPTY_JSON_BODY` before the handler runs. `AccountsPanel` already
calls its no-body POSTs as bare `{ method: 'POST' }` with no headers
(`AccountsPanel.tsx:232,272`); match that. This bit the probe, not the code.

The error message for a borrowed account was reworded: it also answers a **list**
request, where "Only its owner can share it further" was not what had been asked.

All probe data was removed afterwards — `ChannelAccountGrant` is empty and the four
probe audit rows are deleted. **Still do not create a grant by hand until BP.S1d**
(§9.4).

### 12.6 Gates

| Check | Result |
| --- | --- |
| `apps/api` typecheck | 0 errors |
| cx + workspace + grant + auth suites, 27 files | 481 passed |
| `check-schema-drift.mjs` / `check-column-drift.mjs` | pass — 434 / 434 |
| MAP.3 connection-resolver ratchet | 0 ambient (baseline 0) |
| Route permission resolution, 8 routes | all as intended, existing 4 unchanged |

Nothing committed.

---

## 13. BP.S1d — build record (2026-09-16). BP.S1 is complete.

The screen now tells the truth about a borrowed account, which is what §9.4 said had
to happen before a grant could exist.

### 13.1 The rule went in the ENGINE

`rowActions()` in `design-system/lib/accounts-panel.ts` — the pure function that already
decided every control on a row. It gains `sharedFromName` in, and `rename` + `sharedNote`
out. A borrowed account returns every action `false` and the reason in words.

Keeping it there rather than in the component is what makes **one** test cover every
control at once: a button added to `AccountsPanel` later cannot quietly appear on a
borrowed row without also appearing in that object.

Rendered as a **reason**, never as disabled buttons — the same measured cause as the
existing `envNote`: a `title` on a disabled control is unreachable (a disabled element
fires no pointer events) and its colours are dim enough to fail contrast besides
(MAP.4 measured 2.04:1). The `silent-disabled` ratchet passes.

`isPrimary` is deliberately ignored for a borrowed row: primary is a fact about the
**owner's** channel and would read as a claim about ours.

### 13.2 🔴 The accessibility tree found what the screenshot did not

After the first pass the row looked right — no Rename, Test, Reconnect, Disconnect,
Assign profile or Share. `read_page` with `filter: interactive` showed it was not:
**eight colour swatches were still live**, because they are `<button>`s rendered in
their own block *above* `nds-acctp-actions`, which is all I had gated. Each is a
`PATCH /api/accounts/:id` that RLS refuses — safe, and exactly the lie this unit
exists to remove.

Gated too. The row now reports **0 interactive elements**. A screenshot shows what is
drawn; the accessibility tree shows what can be pressed, and only the second one
answers "can a guest act here".

### 13.3 What shipped

- **Owner row:** a new `Share with a profile` button beside `Assign profile`. Both are
  offered so neither is mistaken for the other — Assign **moves** ownership and refuses
  any account with history; Share **lends** it read-only and changes nothing.
- **`ShareAccountDialog`** (`app/settings/channels/`), on the DS `Modal` + the existing
  `BusinessProfilePicker` with `permission="owner"`. It states the limits plainly before
  the act, lists who the account is already shared with, and each has `Stop sharing`.
  Its no-body POST sends no `Content-Type`, per §12.5.
- **Guest row:** a `Shared by <owner>` chip in place of `Primary`, zero controls, and
  `Shared by <owner> — only they can change or disconnect it`.
- **`AccountsTab`** reads `GET /api/accounts/shared-with-me` and passes the map down. A
  failed read leaves it empty, so rows render as owned — the wrong way round for
  honesty, but the server refuses those actions anyway and inventing a "shared" state we
  could not read would be worse. The reason is written at the call site.
- Mirrored to **Factory**: `accounts-panel.ts`, `accounts-panel.d.ts`,
  `AccountsPanel.tsx` and the spec. Parity back to its pre-existing 14 drifts, none of
  them mine.

### 13.4 Measured on the running app

Owner shared the live eBay account with the second profile through the dialog; the
guest page was then read in both themes.

| Check | Result |
| --- | --- |
| Owner row offers `Share with a profile` | on every owned account |
| Dialog states the limits before the act | 4 bullets, plus the destination rule |
| Share, then `Shared with … Stop sharing` | listed in the dialog |
| Guest row — interactive elements | **0** |
| Guest row — chip | `Shared by Existing business` |
| Guest row — `Primary` badge | absent |
| Guest row — reason | `Shared by Existing business — only they can change or disconnect it` |
| Contrast, note (11.5px) | **7.38** dark · **5.91** light — both pass AA 4.5:1 |
| Contrast, chip (11px) | **13.23** dark · **8.71** light |
| Light theme render | correct |
| Horizontal overflow at 1512px | none |

⚠ **The 390px check did NOT run.** `resize_window` is clamped by the OS: asking for
390 left `innerWidth` at 1728, and asking for 420 gave 1440. So this is *not* a mobile
pass. What can be said instead: the note uses the **same** `nds-acctp-note` class, in
the same `display:flex; flex-wrap:wrap` parent, as the env-managed note that MAP.4 did
measure at 390px. That is an inference from a shared class, not a measurement.

### 13.5 Gates

| Check | Result |
| --- | --- |
| web / factory / api typecheck | 0 errors each |
| `src/design-system` + `src/app/settings`, 118 files | 1480 passed |
| `accounts-panel` engine tests | 68 passed (6 new arms + a control) |
| DS parity (factory) | 272 identical · 14 drifted — all pre-existing, none mine |
| silent-disabled ratchet (U13) | pass |
| button-vocabulary ratchet | pass, 53 / 243 |
| raw-primitives ratchet | pass |
| `tokens:check` | in sync |

### 13.6 State left behind

One **live grant** in the local database: the eBay account `xaviaracing`, owned by
*Existing business*, shared read-only with *Second Business (test)*. It is left in place
deliberately — the screen is now honest about it — and `Stop sharing` in the dialog
removes it in one click. `Second Business (test)` is also test data and can be archived
from `/profiles`.

Nothing committed.

---

## 14. BP.S2 — build record (2026-09-16). Per-person account access.

Migration `20260916b_bps2_member_account_access`, service, routes, UI and 21 tests.

### 14.1 It went in the database, not in 46 call sites

MAP.8 parked this in August for a structural reason that is still true:
`rbac-hook.ts:42` resolves a permission from `(method, pattern)` in a preHandler and
cannot know which account a request will touch. This does not solve it there — it
moves the question to the layer that always knows, the row.

`nexus_account_restriction` on `ChannelConnection` is **RESTRICTIVE**, so PostgreSQL
**ANDs** it with every permissive policy instead of OR-ing it in. One statement
therefore covers owned accounts *and* accounts shared in under BP.S1a, reads *and*
writes, all 46 named lookups, with no call site changed.

Probed before designing on it (PostgreSQL 17.11): a permissive `USING (true)` plus a
restrictive `USING (id = 1)` returned 1 row of 2. It ANDs.

Three arms, cheapest first: **no actor** (a job, a webhook — a restriction is about a
person and scheduled work has none), **not restricted** (the default and fast path),
**this account is on their list**.

🔴 `WITH CHECK` repeats `USING`, so a restricted member cannot INSERT a
ChannelConnection — a brand-new row cannot already be on their list. That is the
honest reading of "restricted to these accounts", and it fails at the database rather
than halfway through an OAuth callback.

### 14.2 🔴 The rehearsal killed the first design

v1 put a boolean `accountsRestricted` on `WorkspaceMembership`. Measured:

```
relname               relrowsecurity  relforcerowsecurity
WorkspaceMembership   false           false      ← policies on it: 0
```

and a non-owner context ran `UPDATE "WorkspaceMembership" … → UPDATED 1 row(s)`.

**That table has no row-level security at all.** A flag there would have been guarded
only by the service layer while the allow-list beside it was guarded by the database —
and the person restricted could have lifted their own restriction with one write.

v2: the flag is a **row** in `WorkspaceMemberAccountLimit`, protected by the same
owner-only policy as the list. Presence = restricted, absence = unrestricted. A row
rather than "empty list means unrestricted" because removing the last allowed account
must not silently promote someone back to seeing everything.

### 14.3 🔴 Two rehearsal arms passed for the wrong reason

In §E the first RLS violation **aborted the transaction**, and every later statement
failed with `current transaction is aborted` — which a `.catch()` reported as the
refusal being hoped for. Fixed with a per-probe `SAVEPOINT`, plus a live control
inside the same context. The arms now report distinct real outcomes:

| Probe | Outcome |
| --- | --- |
| member adds themselves an account | `raised: new row violates row-level security policy` |
| member deletes an entry from their own list | `0 row(s) affected` |
| 🔴 member deletes their own LIMIT row to free themselves | `0 row(s) affected` |
| **CONTROL** — they still read their own list | 1 row |

### 14.4 Rehearsal — 20 arms, all passed, then rolled back

Applied inside one transaction, asserted, `ROLLBACK`; the table was confirmed absent
afterwards. Highlights: a restricted member saw **1 of 17** accounts, could not read
or write the other 16, **could** still write the one they were given (the control that
makes each zero a refusal), while the owner and a no-actor job both still saw 17. An
empty list meant **no** accounts, not all of them. A revoked member saw nothing.

🔴 The restricted member **must** be able to read their own allow-list: the policy
asks that table whether they may see an account, so hiding it would lock them out of
everything — a total lock-out that looks exactly like a correctly narrow restriction.
That arm is tested.

### 14.5 The dead field is closed, not left beside a working one

`UserRole.channelScope` was stored, passed and displayed, and enforced nowhere. That
was harmless while nothing limited account access. It stops being harmless now, because
an administrator could set it, be told it saved, and believe someone was limited.

Both writers now **refuse** it with `channel_scope_retired` rather than storing it:
`team.routes.ts` (role assignment) and `auth.routes.ts` (invitations). The column is
**not dropped** — that is destructive, and production's contents are unknown; the BP
migration preflight already stops on a non-empty one.

### 14.6 The routes had to move

They were written on `/api/team/users/...` and returned **410** in the browser:
`team.routes.ts:38` retires that whole surface the moment business profiles are on.
A route added there is unreachable in exactly the configuration it exists for.

They now sit on `/api/workspaces/:id/account-access` and
`/api/workspaces/:id/members/:memberId/account-access`, beside the other member writes.
🔴 That surface is a **control path** — `workspace-hook.ts:51` returns before it
establishes a workspace context — so the routes open the context themselves from live
membership (`inWorkspace`), never from the caller's word.

### 14.7 Measured on the running app

Settings → Team & Access → Manage access now carries an **Account access** section:
a choice of *Every seller account in this business* / *Only the accounts I choose*, the
account list as checkboxes, and, when nothing is ticked, the sentence *"With nothing
selected, this person reaches no seller account."* — because an empty list is a real
instruction here, not an unfinished form. An **owner** gets a sentence instead of a
control, since owners reach everything by role.

Limiting a real member to one eBay account, through the real UI:

| Context | Accounts visible |
| --- | --- |
| the limited member | **1** (EBAY) |
| **CONTROL** — the owner | 17 |
| **CONTROL** — a background job | 17 |

with the limit row, the allow row and the audit row all written. The test data was
removed afterwards — it sat on another session's gate user.

### 14.8 🔴 Turning the flag on breaks 20 test files that are not flag-ready

Measured on `src/services src/routes src/lib/auth`:

| Configuration | Result |
| --- | --- |
| `NEXUS_WORKSPACES_ENABLED=0` | 691 files pass, **1 fails** |
| `NEXUS_WORKSPACES_ENABLED=1` | 671 pass, **21 fail** (69 tests) |

The failures are `workspace_required — Select a business profile` and pre-existing 410
shims: tests that run with no workspace context, which the scoped client now refuses.
**None are caused by BP.S1 or BP.S2** — the same file passes with the flag flipped and
nothing else changed. The one baseline failure is
`amazon-classifications.vitest.test.ts` (AWS env vars, zero references to anything
touched here).

This is a real release prerequisite, and it is now quantified rather than guessed.

### 14.9 Gates

| Check | Result |
| --- | --- |
| api / web / factory typecheck | 0 errors each |
| BP.S2 service tests | 21 passed |
| full api suite, flag off | 708 files, **8856 passed, 1 pre-existing failure** |
| web `src/app/settings` + `src/design-system` | 1480 passed |
| schema / column drift | pass — 436 / 436 |
| ownership map completeness | 436 / 436, none unclassified |
| DS parity (factory) | 272 identical · 14 drifted, all pre-existing |
| silent-disabled / raw-primitives / button-vocabulary | pass |

Nothing committed.

---

## 15. Two things this work could not settle

1. 🔴 **`WorkspaceMembership`, `Workspace` and `WorkspaceMemberRole` have no
   row-level security.** Measured, not inferred (§14.2). It is why BP.S2's flag is a
   row in a protected table. Whether those tables *should* be protected is a separate
   question with a wide blast radius, and is **not** answered here.
2. ⚠ **A POST without the `x-nexus-csrf` header was not refused** on
   `/api/accounts/:id/grants` in local dev. `verifyCsrf` (`csrf.ts:45`) requires both
   the cookie and the header, and `workspace-hook.ts:83` calls it for every non-GET
   outside the `/api/workspaces` control paths, so it should have been a `csrf_failed`.
   Three probes — no header, wrong header name, correct header — all reached the
   handler and were refused for an unrelated reason. **Not investigated further and
   not caused by this work**; the UI sends the documented header regardless. Worth its
   own look before production.

---

## 16. BP.S3 — build record (2026-09-16). A guest may publish.

Migration `20260916c_bps3_listing_claim`, `listing-claim.service.ts`, the preflight in
`outbound-enqueue.ts`, the credential guard extended, `mode: 'publish'` enabled, and the
UI. 14 claim tests, a 14-arm rehearsal, all API suites back to baseline.

### 16.1 The model: one seller coordinate, one owning business

A seller account names a listing by the seller's own SKU inside that account and
marketplace. Two businesses sharing one account therefore share **one** SKU namespace.
`ChannelListingClaim`'s **primary key** `(connectionId, marketplace, sellerSku)` is the
exclusivity: the second business to reach a coordinate collides at the database
(`23505`) instead of overwriting a live listing or pushing a second quantity at it.

That also answers stock. Because a coordinate is exclusive, exactly **one** business ever
pushes quantity for it, so there are never two counters for one listing.

A claim is a **lock, not history**: it is deleted on release, because a released lock
still occupying its own primary key would block the next holder forever.
`WorkspaceAudit` carries who held it.

The seller identity comes from `sellerSkuForClaim`, deliberately the **same** rule as
`sellerSkuForDelist` — the coordinate a publish reserves must be the one a delist
releases. 🔴 When that rule returns `null` (a listing with two live seller identities) the
publish is **refused on a shared account**, never guessed: without one identity there is
no coordinate to be exclusive about.

### 16.2 Zero blast radius for everyone who has not shared

The preflight is a **no-op** unless the account is shared. `sharedConnectionIds` is one
indexed read; an account with a single business behind it takes the early return. No
existing publish changes. The claim service is also imported **lazily**, past the flag
check, so the hot outbound path never loads it on a single-business install.

### 16.3 A publish grant now mints a token — and a read grant still cannot

`assertCredentialOwner` (BP.S1b) admits an active `mode: 'publish'` grant, exactly where
its comment said BP.S3 would. The grant is **re-read on every call**, not cached, so a
revoked share stops working on the next push and not at the next restart — tested.

### 16.4 🔴 A total refusal is loud; a partial one is reported

If **every** row of a publish is refused, `enqueueOutboundRowsInstant` **throws**
`listing_coordinate_claimed` (409). Returning `[]` would have made "nothing will be
published" indistinguishable from "there was nothing to do" — a Publish button that
succeeds and changes nothing. A partial refusal proceeds with the rest, calls
`onBlocked`, and is always logged.

### 16.5 Rehearsal — 14 arms, distinct real error codes

| Arm | Outcome |
| --- | --- |
| Owner claims `(eBay, IT, SKU-SHARED)` | 1 row |
| 🔴 **Guest claims the same coordinate** | `23505` unique violation |
| **CONTROL** — guest claims a different SKU, same account | 1 row |
| Guest reads both claims (so a refusal can explain itself) | 2 rows |
| Guest deletes / re-points the owner's claim | 0 rows / 0 rows |
| Guest forges a claim in the owner's name | `42501` |
| **CONTROL** — guest releases its own claim | 1 row |
| Owner releases → guest takes the freed coordinate | 1 row / 1 row |
| Empty / whitespace SKU | `23514` / `23514` |
| Revoked share → ex-guest reads claims | 0 rows |

### 16.6 What broke while building it, and why

- 🔴 **A top-level import turned a sibling suite into a load failure.**
  `channel-delist.vitest.test.ts` mocks `@nexus/database` with no default export; the claim
  service's import pulled that default into its graph. Fixed with the lazy import above —
  which is also the leaner design — not by editing another lane's mock.
- **My own BP.S1c test** asserted `publish` was refused. It now asserts `publish` is
  accepted and an undefined mode is refused.
- **A revoke test asserted the wrong refusal.** With the share gone the guest cannot even
  *see* the row, so `getAccessToken` fails with "not found" before the ownership question
  is asked — stronger than `account_not_owned`. The test now asserts what actually happens.

### 16.7 UI — measured on the running app

- **Share dialog:** a *What they can do* choice — *See the account only* / *See it and
  publish with it*. **Every line of copy follows the mode**: the subtitle, the bold publish
  bullet explaining SKU exclusivity, and the hint *"Publishing reaches the real
  marketplace with your seller account."* The first build left the subtitle reading
  *"cannot … publish with it"* directly above a control offering exactly that. Fixed.
- **Upgrading an existing share** from read to publish works through the same dialog; the
  list then reads *"Second Business (test) — can publish"*.
- **Guest row:** one fact per element. The chip says who and which mode —
  `Shared by Existing business · can publish` (or `· read-only`; both modes are named so
  neither has to be inferred). The note says only the limit —
  `Only Existing business can change or disconnect it`. The first build put all of that in
  the note: **5 lines in a 145 px column**. Now **3**.
- The note's last line was a single orphaned word (*"…disconnect / it"*). `text-wrap:
  balance` on `.nds-acctp-note` evens the lines without widening the column. Browsers
  without it fall back to the wrapping that shipped before.
- Guest row interactive elements: **0**.

### 16.8 Left in a safe state

The live share on the real eBay account `xaviaracing` was upgraded to `publish` to test
the UI, then **reverted to `read`** — a publish grant on a live seller account lent to a
*test* profile is not something to leave behind. `ChannelListingClaim` is empty.

---

## 17. The two loose ends

### 17.1 L1 — membership and role writes are now protected ✅

Migration `20260916d_l1_membership_write_guard`. `WorkspaceMembership` and
`WorkspaceMemberRole` had **no row-level security**; a non-owner could update their own
membership.

🔴 **Reads stay open, deliberately.** `workspace-hook.ts:97` resolves membership *before*
it opens a workspace context — the membership is what decides the context. A read policy
keyed on `nexus.workspace_id` would evaluate against `''` and **every sign-in would fail**.
Only writes are gated, which is where elevation actually lives.

Write rule: no actor (jobs, migrations) · an active OWNER of that row's business · or the
creation moment. 🔴 **The rehearsal caught that creating a business would have broken.**
Creation inserts the workspace, then the membership, then its OWNER role — and by the
third statement a membership exists, so the membership guard's "no members yet" arm had
closed, while no OWNER role existed yet for the owner arm to find: `42501`. Roles now
have their own bootstrap arm: the actor's **own** membership, with **no roles yet**, in a
business with **exactly one** membership. All three together are unreachable from an
established business.

| Arm | Outcome |
| --- | --- |
| 🔴 **Sign-in** — resolve memberships with no context | 2 memberships, roles OWNER |
| 🔴 **Create a business** — first membership, then OWNER role | 1 row, 1 row |
| Non-owner writes their own membership | 0 rows |
| Non-owner grants themselves OWNER | `42501` |
| Non-owner joins a business that has an owner | `42501` |
| **CONTROL** — owner writes a member / reads unchanged / job unaffected | 1 row / 3 / 3 rows |
| A stranger writes another business's memberships | 0 rows |

Then, through the real generated policies: `workspace.vitest.test.ts` (creation,
invitations, last-owner races, revocation) plus every BP suite — **98 passed**. Live:
signed in, and `/api/auth/me`, `/api/workspaces`, the profile, accounts and the access
list all return 200.

`Workspace` itself is still unprotected. Its writes are name and status, not access, and
it was left out to keep this change's blast radius on the login path as small as possible.

### 17.2 L2 — CSRF: **not a vulnerability.** The alarm was the probe. ✅

§15.2 reported that a POST without `x-nexus-csrf` was accepted. Re-measured with a request
that would otherwise succeed:

| Request | Result |
| --- | --- |
| `fetch`, no header written | **200** |
| `fetch`, forged header | 403 `csrf_failed` |
| `fetch`, correct header | 200 |

A missing header accepted, a wrong one refused — that pattern is what gave it away.
`lib/auth/install-fetch.ts` patches `window.fetch` and **adds** `x-nexus-csrf` to every
mutating API request that lacks one. The "no header" probe was never header-less.

`XMLHttpRequest` is not patched, so it can send a genuinely header-less request:

| Request | Result |
| --- | --- |
| 🔴 **XHR, truly no header** | **403 `csrf_failed`** |
| **CONTROL** — XHR with the header | 400 `workspace_required` |

The control got **past** the CSRF gate and stopped at a later check (XHR also skips the
wrapper's workspace header). That is the discriminator. **CSRF is enforced.**

---

## 18. 🔴 What is still NOT done — so "AAA end to end" is not claimed

1. ~~A claim refusal is enforced but not surfaced in background publish paths.~~
   **Closed — §19.**
2. **Turning the flag on breaks 42 API test files** (218 tests + 7 that do not load).
   ⚠ The earlier "20 files / 69 tests" was measured on a narrower scope, and it was wrong
   to say none were from this work: `token.service` had 54 failures from the BP.S3 guard.
   **Guarded — §22** (a ratchet: it can only shrink). The 42 files themselves are NOT fixed.
3. **No narrow-width check.** `resize_window` is clamped by the OS (390 → 1728, 420 →
   1440). Not measured.
4. ~~No derived gate for `model-ownership.json` or policy-file ⇄ migration parity.~~
   **Closed — §21.**
5. `Workspace` has no write protection (§17.1).
6. ~~The ads notifier fans out to every user.~~ **Closed — §20** (and it was not a leak; see §20.1).

Nothing committed. Production untouched.

---

## 19. §18.1 closed — a refused publish now reaches a person. And BP.S3 was not working.

### 19.1 🔴 Correction: BP.S3 did not let a guest publish

§16 stated a guest profile could publish. **It could not.** Proving the notice end to end
meant creating a real listing on a shared account, and the very first attempt failed:

```
Invalid `prisma.channelListing.create()` invocation: Foreign key constraint violated
```

`nexus_workspace_reference_guard` — the trigger that refuses a row pointing at another
business's record — read the account's owning business, found it differed from the
guest's, and raised `23503` (which Prisma reports as a foreign-key violation). The claim,
the publish preflight and the credential guard were all correct, and all sat behind
this. §16's tests never reached it: they exercised `claimCoordinate` on a coordinate and
**never created a real listing on a shared account**. A fixture that holds a dimension
constant cannot fail on it.

**Fix — migration `20260916e_bps3_publish_reference_guard`.** The guard moved into
`packages/database/workspaces/reference-guard.sql`, shared by the generator and the
migration like every other policy file. Its original body is unchanged — **proven
byte-for-byte** by removing the new block and comparing (995 = 995 characters,
identical). One exception is added. A link to `ChannelConnection` is allowed only when
**all** hold:

1. the row is `ChannelListing`, `VariantChannelListing` or `ProductListingAlias` — the
   three a publisher must write. **Not** `Order` (inbound stays with the owner), **not**
   `ConnectionScope`/`ConnectionEvent`, `EbayCampaign`, `SyncChannelPolicy` or
   `SharedListingMembership`;
2. this business holds an **active** grant on that account;
3. the grant is `publish`. A `read` grant still attaches nothing.

This guard fires on **every insert and update of every business table**, so the
rehearsal proved ordinary writes first:

| Arm | Result |
| --- | --- |
| 🔴 owner links a listing to its own account | 1 row |
| 🔴 ordinary update of an ordinary row | 1 row |
| 🔴 listing with no account link | 1 row |
| **publish guest attaches a listing to the shared account** | **1 row** |
| read guest | `23503` |
| revoked publish grant | `23503` |
| 🔴 publish guest attaches an **Order** to the owner's account | `23503` |
| guest sees accounts it has no grant on | 0 |
| ownership still cannot be reassigned | `23514` |

⚠ Revoking or downgrading a publish grant freezes the guest's existing listings on that
account: the guard fires on UPDATE, so they can no longer be edited. Intended — the same
moment the guest loses the right to push them.

### 19.2 🔴 The bell had never shown a single notification

To surface a refusal "in the bell" it first had to be established that the bell worked.
It did not.

`notifications.routes.ts` read `userIdFor(_req) → 'default-user'` for every request,
with a note that it would use the session "when real auth lands". Real auth landed; this
never followed. Measured on the local database:

| | |
| --- | --- |
| notifications | **391,197** |
| addressed to a real user | **391,197** |
| addressed to `'default-user'` | **0** |
| unread, for the Owner alone | **195,806** |
| of which `ads-automation-rule` warnings | 195,565 (99.9%) |
| newest | 2026-09-06 — nothing in the last 7 days |
| buried inside | **1 `danger` automation-halt alarm**, 7 ads write refusals |

Everything this application had ever written to a person was written where no person
could see it. Anything BP.S3 surfaced would have joined it.

**Fixed:** every bell route now scopes to `request.authUser.id` and returns 401 without
one — never a shared default id, which would also let one person read another's.
The route also required `admin.view`, while the bell renders for **every** signed-in
person, so a non-admin got a 403 and an empty bell. Reading and dismissing your own
notifications is now `PG.dashboard`, safe because every query is scoped to the session's
user and, through the `Notification` isolation policy, to the business in context.

**The backlog**, per the Owner's decision: everything older than 7 days marked read
**except** `severity = 'danger'`. Nothing deleted. The write was committed only after it
matched a prediction taken beforehand:

| | predicted | actual |
| --- | --- | --- |
| marked read | 391,195 | 391,195 |
| total rows (none deleted) | 391,197 | 391,197 |
| still unread | 2 | 2 — both `ads-automation-halt` `danger` |

### 19.3 The notifier

`apps/api/src/services/publish-refusal-notify.service.ts`, called once from
`enqueueOutboundRowsInstant`, so all six publish callers are covered. Two lessons from
the only other notifier in the codebase:

- 🔴 **Recipients are this business's people.** `ads-automation-notify.service.ts` fans out
  to `userProfile.findMany()` — every login on the system, across every business. A
  refusal **names another business**, so that would leak it. Recipients here: the actor if
  a person caused it, plus the active owners of the refused business.
- 🔴 **Deduped.** That notifier measured 41,466 notifications a day before its caps. One
  unread notice per listing per person; once read, a recurrence notifies again.

Copy, written for the person who has to act:

> **E2E refusal probe jacket was not published**
> Existing business already publishes E2E-REFUSAL-… on the shared eBay IT account. Use a
> different seller SKU, or ask Existing business to stop publishing it there.

Channel names come from `@nexus/shared/channel-label`, the one operator-facing channel
name — the first measured notice read *"EBAY IT"*. A draft fallback produced *"the shared
the shared account"*; `accountPhrase()` builds the phrase once and is tested for every
missing part.

### 19.4 The bell, rebuilt on the design system

Measured the first day it returned real rows, then fixed:

| Defect | Measured | Now |
| --- | --- | --- |
| Panel in dark mode | `rgb(255, 255, 255)` — hand-written Tailwind | `rgb(24, 38, 59)` — DS tokens only |
| "All read" / "Refresh" | dark controls on the white panel | DS `Button`s |
| 🔴 **The one unread alarm** | below read digests; badge said "1 unread" | **first** |
| Unread vs read | identical | accent bar + weight + spoken "Unread." |
| 🔴 **Keyboard** | rows were `<div role="button">`, no tab stop, no key handler | real buttons |
| Inbox link | raw `<a href="/inbox">`, dropped the business | workspace `Link` |
| Trigger | no `aria-expanded`, no `aria-haspopup` | DS `ToolbarButton`, both set |

🔴 **The ordering fix first failed in the browser while its unit test passed.** Client-side
ordering (`notifications-order.ts`) was correct and tested, but the API returned the 30
**newest** rows and the alarm was older than all of them: `unreadCount: 1`,
`unreadRowsReturned: 0`. No client sort can surface a row it was never sent — and the
test passed because the test handed it the alarm. **Fixed at the source:** the API now
fetches every unread row first and fills the remainder with read ones.

Measured on the running app:

| Check | Result |
| --- | --- |
| Text contrast, dark — 95 elements | worst **7.27** (every element ≥ AAA 7:1) |
| Text contrast, light — 95 elements | worst **5.91**, **0** below AA 4.5:1 |
| First notification row is a focusable control | yes |
| Escape closes the panel | yes |
| Focus returns to the bell | yes |
| `aria-expanded` after close | `false` |
| A click **inside** the portalled panel keeps it open | yes |
| A click outside closes it | yes |

That inside-click arm matters: the panel is portalled to `<body>`, so it is outside the
trigger's wrapper in the DOM, and a naive click-outside handler closes it on every click
within.

### 19.5 End to end — a real refusal, through the real code, into the real bell

`apps/api/scripts/bps3-refusal-e2e.mts`. Refuses to run unless `DATABASE_URL` is local and
business profiles are on; the queue is pointed at a dead port; every fixture is removed
and the share restored in `finally`.

| Arm | Result |
| --- | --- |
| Owner business holds the coordinate first | acquired |
| Guest business has its own product + listing on the shared account | created — **only after §19.1** |
| 🔴 The publish is refused | `listing_coordinate_claimed` |
| As a 409 | yes |
| 🔴 **Nothing was queued for the channel** | 0 rows |
| 🔴 **A notice reached the guest business's owner** | 1 |
| It names the business holding the SKU | yes |
| It links to the product | `/products/<id>/edit` |
| The bell's unread count | 0 → 1 |
| 🔴 The owner business sees none of it | 0 |
| Five more refusals of the same listing | still 1 notice |

**11 passed, 0 failed**, then confirmed on screen in the guest business's bell.

The first two runs of this probe failed on the probe, not the product: one edited the
share with no business in context (the owner-only policy correctly found nothing), and a
`--keep` run left a claim, a product and **the share set to `publish` on the live
account** — found by checking before the next run, and cleaned by value.

### 19.6 Gates

| Check | Result |
| --- | --- |
| api / web / factory typecheck | 0 errors each |
| API suite (flag off) | **8,881 passed**, 1 pre-existing unrelated failure |
| web `components` + `design-system` + `settings` | 130 files, **1,596 passed** |
| notifier tests / ordering tests | 11 / 6 |
| schema / column drift | 437 / 437 |
| policy files ⇄ migrations | **5 of 5** byte-identical |
| raw-primitives · silent-disabled · token guard · DS conformance · token resolution · CSS parse · help-cursor | all pass |
| MAP.3 connection ratchet | 0 ambient |

State left: `ChannelListingClaim` empty, the live share on `read`, no test products.
Nothing committed.

---

## 20. §18 follow-up — the ads notifier's recipients

### 20.1 🔴 Correction to the risk as first reported

§18 / the report called this "a live privacy leak once profiles are on". **Measured, it is
not.** Rows addressed to someone outside a business are stored in that business, and the
`Notification` isolation policy only lets that business's members read them — so no screen
shows one business's alert to another. It was still wrong in three concrete ways.

### 20.2 What was measured

`ads-automation-notify.service.ts` sent to `userProfile.findMany({ take: 100 })`:

| Login | Status | Businesses | Ads notices |
| --- | --- | --- | --- |
| the Owner | active | 2 | 195,785 |
| `fulfillment-test@nexus.local` | **deactivated** | **0** | **195,370** |

1. **Deactivated people were notified** — and could never read it.
2. **People outside the business were addressed**, their rows written into a business they
   do not belong to.
3. **`take: 100` silently dropped real members** once a system passed a hundred users.

And a fourth, in the dedupe: it asked whether an identical unread notice existed **for
anyone**, so one person's unread copy suppressed the notice for everyone — and a
deactivated account never reads anything.

### 20.3 Fix

- Profiles **on**: the **active** members of the business the automation ran in.
- Profiles **off** (one business): every **active** user. **No cap.**
- Profiles on with **no business in context**: nobody, logged — never a guessed fan-out.
- Dedupe is **per person**: each gets at most one unread copy of their own.

Both documented invariants are kept and still tested: **`danger` is never deduped** (and
never even queried), and **`deduped` never reads as "reached nobody"**.

🔴 The "no context → nobody" rule could have switched ads alerts **off**, so the callers were
traced before relying on it: `lib/cron/clustered.ts` runs every schedule **once per active
business inside `withWorkspace`**, and `WorkspaceWorker` restores each job's business before
its processor runs. Both ads paths therefore carry a business.

### 20.4 Tests

`ads-automation-notify.vitest.test.ts` — the 8 existing assertions moved to the new query
shape, plus 5 new (per-person dedupe; the dedupe only considers the people being notified;
active-only with no cap; business members only; no context → nobody). **13 passed.**

`ads-automation-notify.business.vitest.test.ts` — real PostgreSQL. **9 passed:**

| Arm | Result |
| --- | --- |
| Automation in business A reaches A's two active members | 2 |
| Member of only B | 0 |
| Member of both: sees it in A, not in B | 1 / 0 |
| 🔴 Deactivated member of A | 0 |
| Revoked member of A | 0 |
| 🔴 Active login in no business | 0 |
| Rows stored only in the producing business | A only |
| Same notice again | deduped, wouldHaveReached 2 |
| 🔴 One reads theirs → only they get the recurrence | created 1 |

### 20.5 Gates

API typecheck 0 errors · API suite incl. `jobs` and `workers`: 731 files, **9,119 passed**, 1
pre-existing unrelated failure · MAP.3 ratchet 0.

---

## 21. §18.4 closed — the two mistakes that repeated are now push-blocking checks

Both went wrong twice on 2026-09-16 and were caught only by counting by hand.

### 21.1 `packages/database/scripts/check-model-ownership.mjs`

Every Prisma model must be in `workspaceModels` or `globalModels`. A model in neither gets
no GRANT to `nexus_workspace_runtime` and no policy — and `prisma validate`, tsc, both
schema-drift checks and every existing test still pass. Fails on: **unclassified**, stale
(listed but no longer a model), listed in **both**, listed twice, and **zero models parsed**
(an empty result is not a pass). Today: **437 models, 415 workspace · 22 global.**

### 21.2 `packages/database/scripts/check-policy-migration-parity.mjs`

Row-level security has two builders — the generator the test database applies and the
migrations every deployed database applies. New manifest
`packages/database/workspaces/policy-migrations.json` names the migration carrying each
shared file's current body. Fails on: a `workspaces/*.sql` the generator never reads; a file
the generator reads that is missing; a file with no manifest entry; an entry naming a
migration that does not exist; 🔴 **a migration that does not end with the file's exact
bytes** — reporting the first differing line; and zero files. Today: **6 of 6 match.**

The failure message tells the author what to do and what not to: write a **new** migration
ending with the new bytes and repoint the entry — never edit an applied migration.

### 21.3 Wired into `.githooks/pre-push`

Directly after the column-level drift check. 15 lines added, nothing else changed (`git
diff` confirmed). Executed as written, from the repo root:

| Tree | Result |
| --- | --- |
| the real tree | both ✓, **exit 0** |
| a copy with one unclassified model | ❌ names `ForgottenTable`, says how to classify it, **exit 1 — push stopped** |

The first wiring attempt matched nothing — the file uses `—` where the anchor had `-`. The
edit script asserted its anchor count **before** writing, so nothing was written.

### 21.4 Mutation-tested — 14 arms, on a scratch copy, never the shared tree

| Arm | Result |
| --- | --- |
| **CONTROL** — untouched copy passes model-ownership | pass |
| **CONTROL** — untouched copy passes parity | pass |
| 🔴 new model nobody classified | red, names it |
| listed name that is no longer a model | red |
| model listed as both | red |
| empty schema | red |
| 🔴 one changed byte in a shared policy **file** | red, names the file |
| 🔴 one changed byte in the **migration** | red |
| reports where they differ | red, "first difference near line" |
| policy file the generator never reads | red |
| policy file with no manifest entry | red |
| entry naming a missing migration | red |
| generator reads a file that is not there | red |
| no policy files at all | red |

🔴 **The first run went 13/14 — and the 14th was the harness, not the gate.** The arm
changed `revokedAt` in `listing-claim.sql`, which does not contain that word; `sed`
changed nothing, and the gate correctly passed. The harness now hashes the file before and
after every mutation and **refuses to run an arm whose mutation changed nothing**.

⚠ The harness lives outside the repo. Nothing yet re-runs it, so a later edit that made
either script pass everything would not be caught. Moving it into a test is a follow-up,
not done here.

---

## 22. §18.2 guarded — tests with profiles ON can only get better

The user chose "Guard now, fix over time". Three parts.

### 22.1 The local test run stopped changing its own switch

`apps/api/.env` holds `NEXUS_WORKSPACES_ENABLED=1` for the local API. Vitest loads that file,
so **every** local test run — for every session sharing this tree — ran with profiles ON,
and 43 files / 272 tests went red for people who had changed nothing.

`apps/api/vitest.setup.ts` now sets the flag to `0` **only when the shell did not set it**,
and prints which mode the run is in. An exported `NEXUS_WORKSPACES_ENABLED=1` is kept.

| Run | Result |
| --- | --- |
| default suite (profiles OFF) | 9,119 passed · 1 failed (the known AWS credential test, not related) |
| `token.service.vitest.test.ts`, OFF and ON | green both ways — it now sets the flag itself and restores it in `afterAll` |

The OAuth callback 302s seen in the ON run are intended: the callback relays to the web app.

### 22.2 The ratchet — `apps/api/scripts/profiles-on-ratchet.mjs`

Runs `src/services src/routes src/lib src/jobs src/workers` with profiles ON and a dead Redis
port, and compares each failing file with `apps/api/scripts/profiles-on-baseline.json`
(42 files, 218 tests, 7 marked `suite` = fails to load).

| Case | Result |
| --- | --- |
| file not in the baseline fails | ❌ NEW |
| baselined file has more failures | ❌ WORSE |
| a counted file now fails to load | ❌ WORSE |
| baselined file now fully passes but is still listed | ❌ remove it (`--write`) — the list can only shrink |
| fewer failures, not zero | ✓ with a note to lower the count |
| zero files measured / no report / no baseline | ❌ "could not measure" is not "clean" |

### 22.3 Proven — 8 of 8 branches, then twice for real, then through the hook

Every branch was run on **copies** of a saved report and baseline (`--report=`, `--baseline=`),
never on the real baseline: CONTROL pass · NEW · WORSE · FIXED-still-listed · IMPROVED note ·
count → load failure · zero files · missing baseline. **8/8.**

Real run, twice: `738 files measured, 42 known-failing (218 tests) — none new, none worse.`
Same both times, so the baseline is stable.

Wired into `.githooks/pre-push` directly after the security tests. Executed as written:

| Hook lines | Result |
| --- | --- |
| as in the file | ✓ **exit 0** |
| same lines, pointed at a baseline with `bus.vitest.test.ts` lowered 14 → 13 | ❌ `WORSE … 13 → 14 failing`, **exit 1 — push stopped** |

Cost: about 30 seconds per push.

### 22.4 Still open

- The **42 files are not fixed.** Most call code that correctly refuses to run without a
  business. The fix is to give each test a business (`withWorkspace`), area by area.
  Not yet read in depth: the catalogue live-DB `variation-*` suites, the clustered/relay
  mocks, `studio-matrix`, `reference-labels`, `amazon-variation-preflight`, `database-target`.
- The ratchet's branch proof and the §21.4 gate harness live in the scratchpad, not the repo.
  Nothing re-runs them.
- Runs where the local catalogue database exists (the hook). Not in CI: CI has no local
  database, so its numbers would differ.

Nothing committed. Production untouched.

---

## 23. Committed (2026-09-16, on the Owner's word: "commit and push it all")

| Commit | What |
| --- | --- |
| `86a2a4777` | database: 5 migrations, shared policy files, generator, model classification |
| `80a6f4dc4` | api: sharing, credential guard, per-person access, claims, refusal notices |
| `b1e47aa34` | notifications: the bell reads the signed-in user, unread first |
| `b0390cb39` | ads notifier: active people only, deduped per person |
| `4b868085d` | web: Share with a profile, borrowed-account rows, Account access |
| `46a70bad3` | studio: keeps `/w/<id>` on the first cursor write |
| `2c84f7e5e` | checks: test-mode pin, model-ownership, policy parity, profiles-ON ratchet |

### 23.1 Checked before committing

- Full diff re-read. Fixed first: a BP.S3 comment block inserted between
  `enqueueOutboundRowsInstant` and its own doc comment; "read-only" wording left over from
  before publish sharing (routes, grant service, both AccountsPanel copies); a typo; a
  duplicate import; a stray blank line. Web and factory design-system changes confirmed
  identical.
- Type checks: api, web, factory — all exit 0. Policy parity, model ownership, table and
  column drift, `prisma validate`, MAP.3 resolver ratchet — all pass.
- Web tests for the touched files: 76/76. The factory copy of the accounts-panel test is not
  run by the factory config (it only includes `__tests__/*.test.ts`); its change is identical
  to the web copy.
- Full API suite: 15 failures in 11 files under heavy machine load (load average ~5.9; 9 were
  "Test timed out", 3 "failed to start worker"). Re-run alone: **all pass except two files**:
  - `amazon-classifications` — the known AWS-keys test, failing before this work.
  - `amazon-validation-preview` (5) — the test mocks the token but not the region lookup,
    which reads the live local Amazon connection. That row is `authStatus = 'disconnected'`,
    changed at 08:49 UTC with no ConnectionEvent, while this session ran nothing (last action
    08:26). **Not this work, and not reverted** — it is local data someone else changed.
- No secrets, emails or debug output in any committed file. Not committed (not this work):
  `.githooks/pre-push.backup`, `.graphifyignore`, `graphify-out/`.

### 23.2 What pushing does to production

`railway.toml` runs `prisma migrate deploy` before the API starts. The last production deploy
(`ed6bf877`, 05:40 UTC) reported 446 migrations and "No pending migrations", so the push applies
exactly these five. All their policies target `nexus_workspace_runtime`, the same as the 409 from
`20260908b`, which production has run since 09-08 with profiles off. With profiles off in
production, the new API checks return early and the new UI is hidden.

Two things DO change for production users:

1. **The bell starts working.** Production has its own unread backlog; the local mark-read
   (older than 7 days, except `danger`) was not applied there.
2. **Ads notices go to active users only**, one unread copy each.
