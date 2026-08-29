# CX.2 — Channels UI on the design system (exact change)

Programme: `docs/2026-08-29-cx-channel-connections.md` §4 row **CX.2**. Owner, 2026-08-29: *"We should go ahead with CX to rebuild and make sure it all aligns properly with the nexus design system."*
Depends on CX.1 (`61774d222`, the fields this page renders). No migration. One web commit; rollback is `git revert` of it.

Rules applied throughout: DS-first (`feedback_design_system`, `DESIGN.md` mapping table — a control the DS lacks is **added to the DS**, not hand-rolled), extend-not-add (`/settings/channels` stays the one route; new capability = a **tab**), 100 % honest (every value traces to a real column or a real live call; nothing derived from `isActive` or `managedBy` is labelled "Connected"), visibility over minimalism (inline buttons, no "More ⋯"), keep-placeholder (the eBay category probe and the Ads engine controls stay, labelled for what they are), no `cursor: help`, no `disabled` attribute on a control that has a reason to give (`check-silent-disabled`), ship live.

## 0. What is wrong today (measured — audit A6, screenshots 02/03/06/09)
1. Two surfaces say "connected" from two different facts: the DS `AccountsPanel` (health = `lastSyncStatus`) and a lower Tailwind card grid ("Connected" = `isActive`, "Env-managed" = `managedBy`). Neither reads `authStatus`, scopes, drift or the CX.1 timestamps — all of which `/api/accounts` now returns and **no client renders**.
2. Three "Coming soon / Connector deferred" cards (Shopify, Woo, Etsy) — Woo is out of scope, the other two are catalogue entries with a real reason.
3. Test is rendered for any connected channel but always calls the eBay endpoint; Diagnose is not connection-scoped; the purpose-built `POST /api/cx/connections/:id/heartbeat` has no caller.
4. Amazon Ads lives on a separate page as a **manual paste form** whose fields browser autofill fills with a saved password; the LWA OAuth route (`GET /api/amazon-ads/auth/connect`) has zero web callers.
5. `[type]` detail page: zero DS imports, its own `Card`/`Stat`/`Pill`, a raw `<table>`, a marketplace allowlist duplicated from the API, and a "Reconnect / advanced" card promised in its header comment and never built.
6. `ChannelsClient.tsx` (632 lines) mixes DS `AccountsPanel`, `@/components/ui` Tailwind adapters and hand-rolled skeleton/banner markup.

## 1. Page structure — `/settings/channels`
`page.tsx` → `PageHeader` (title "Channels", subtitle "Marketplace and store accounts — sign-in, permissions, health.") + DS `Tabs` (`size="md"`) with URL sync `?tab=accounts|connect|diagnostics` (default `accounts`, param deleted for the default — the `OrderDetailClient.tsx:51-69` pattern). Each tab is its own client component; the popup bridge (postMessage + `BroadcastChannel('nexus-oauth')` + ACK) moves into one hook `useConnectPopup()` shared by Accounts (Reconnect) and Connect.

| Tab | Content | Data |
|---|---|---|
| **Accounts** | DS `AccountsPanel` (extended, §2) | `GET /api/accounts` |
| **Connect** | one DS `Card` per catalogue entry (§3) + Amazon Ads card + the corrected "About" card | `GET /api/cx/channels`, `GET /api/accounts`, `GET /api/advertising/connections` |
| **Diagnostics** | per-account live checks + ledger + inbound events (§4) | `POST /api/cx/connections/:id/heartbeat`, `POST …/refresh`, `GET …/events`, `GET /api/settings/channels/:type/detail`, `GET /api/ebay/diagnostics` |

The lower card grid, the hand-rolled skeleton and banner, and `CHANNELS` constant are deleted. Loading = DS `Skeleton`; notices = DS `Banner`; confirms = the existing `useConfirm` injected into the DS components (no `window.confirm`).

## 2. Accounts tab — the honest row (DS change: `AccountsPanel.tsx`, `AccountSwitcher.tsx` type, `components.css`)
`AccountRow` gains the CX.1 block (all optional so an older API still types): `authStatus`, `region`, `grantedScopes`, `scopeDrift`, `scopes[{kind,externalId,label}]`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, `lastRefreshAt`, `lastHeartbeatAt`, `lastInboundAt`, `lastOutboundAt`, `lastErrorAt`, `lastError`, `consecutiveFailures`, `identity`.

Row, left → right, top → bottom:
- **Status `Pill` (dot)** from `authStatus`: connected → success "Connected" · degraded → warning "Degraded — N failures" · needs_reauth → danger "Sign-in needed" · revoked → danger "Access revoked" · disconnected → neutral "Disconnected" · unknown → info "Not yet checked". The old `health` dot is removed from the row (it encoded `lastSyncStatus`); `lastSyncStatus` stays as text in the timestamps line so nothing is lost.
- Name (editable, as today) · Primary badge · env-managed tag · region `Tag` (e.g. `EU`, `GLOBAL`).
- **Scope chips** (`Tag`, one per `scopes` row, label ?? externalId; Amazon shows 11 participating marketplaces, eBay "All eBay sites" until markets are configured) — measured facts from `ConnectionScope`, never the allowlist.
- **Permissions line**: "22 permissions granted" or, when `scopeDrift.length > 0`, a warning `Pill` "N permissions not granted" and the Reconnect button relabelled **"Reconnect to grant N permissions"**.
- **Timestamps line** (relative, absolute in `title`): `Refreshed · Heartbeat · Inbound · Outbound · Last sync`. A `null` renders as **"never"**; `lastInboundAt`/`lastOutboundAt` render **"not tracked yet"** because no receiver/sender writes them until CX.4 (saying "never" would be a lie about a column nothing feeds).
- **Error line** when `lastError` and status ∈ {degraded, needs_reauth}: the stored `lastError` verbatim (it is already redacted server-side).
- Buttons (inline, no menu): Rename · Make primary · **Test** → `POST /api/cx/connections/:id/heartbeat`, result inline on the row ("OK · 412 ms" / "Failed · auth_expired · …") — a real call, and `lastHeartbeatAt` advances · Reconnect (label as above) · Disconnect (the one path: `POST /api/accounts/:id/disconnect`, which revokes at the channel via the token service since CX.0/CX.1). Env-managed rows: Test works (Amazon participations call); Disconnect stays the "Set by environment" text.

## 3. Connect tab — catalogue-driven
For each `GET /api/cx/channels` entry, ordered AMAZON_SP, AMAZON_ADS, EBAY, SHOPIFY, ETSY, a DS `Card` (`header` = displayName, `description` = one honest sentence), body:
- "Signs in with {authMode}" · "{requiredScopes.length} permissions requested{, M need channel review}" · refresh lifetime line ("Sign-in lasts ~18 months, then reconnect" for eBay; "rotates on every refresh" for Etsy) · region `Select` when `regions.length > 1` (Amazon: EU default).
- Primary action:
  - `available: true` → `Button variant="primary"` **Connect {name}** → popup opened synchronously → `POST /api/cx/connect/{key}/start` `{intent:'connect', region}`; already-connected channels also get **Connect another account** (eBay today — `xaviaracing`, `motovento`).
  - `available: false` → the same button **held** (`aria-disabled`, focusable); activating it shows the reason inline under the button, from a per-key table: AMAZON_SP "Amazon sign-in arrives with CX.3 (public-app registration is the Owner's step); the environment-managed account is connected under Accounts." · SHOPIFY "Arrives with CX.4 — needs the custom-distribution app." · ETSY "Arrives with CX.5 — needs the Seller App registration." No "Coming soon" badge; the reason is the badge.
  - `connectException` (none in Tier 1) → the key-paste form per §2.3 of the programme; not built here.
- **Amazon Ads card** (same page, replacing the separate manual form): profiles from `GET /api/advertising/connections` rendered as scope chips (`{accountLabel} · {marketplace} · sandbox|live`), and **Connect with Amazon Ads** → popup on `GET /api/amazon-ads/auth/connect` (the existing PKCE LWA flow; the callback upserts `AmazonAdsConnection`). The card says plainly that Ads accounts do not yet share Accounts' health (CX.3 merges them). `/settings/advertising` keeps its engine controls (mode, writes, allowlist) untouched; its **manual paste form is removed** and replaced by a DS `Banner` pointing at Channels → Connect. Nav description for Channels becomes "Marketplace & store accounts — sign-in, permissions, health" (today's says "Amazon, eBay, Shopify OAuth" — only eBay is).
- **About** card: four true sentences (popup sign-in; permissions recorded at consent + drift; heartbeat every 15 min; Disconnect revokes at the channel and archives the grant).

## 4. Diagnostics tab
Account picker (`Listbox` over active accounts, primary preselected), then DS `Card`s:
1. **Live checks** — `Button` **Run heartbeat** (result: status pill, latency, error class + message) · **Refresh token now** (`POST …/refresh` → new expiry, 409 "another worker holds the lease" shown as-is) · both write real rows.
2. **Ledger** — `GET /api/cx/connections/:id/events` in DS `DataGrid` (time, type, actor, summary of `detail`), 100 rows, newest first. This is the archive-never-delete trail; nothing on the page can delete from it.
3. **Recent inbound events** — the detail endpoint's `recentEvents` in `DataGrid` (time, type, external id, processed, error) + the ok/failed/pending `MetricStrip`.
4. **eBay category probe** (eBay accounts only) — the existing `GET /api/ebay/diagnostics?marketplaceId=EBAY_IT`, labelled "Probes the IT site with the primary account's token — not scoped to the selected account" (placeholder kept, described honestly).

## 5. `/settings/channels/[type]` detail — rebuilt on the DS
Same route, same endpoints. Local `Card`/`Stat`/`Pill`/`TONE_PILL` deleted → DS `Card`, new DS **`KeyValue`** (§6), DS `Pill`; header actions gain **Test / Reconnect / Disconnect** (the promised card, as buttons); marketplaces → `CheckboxCard` grid driven by the API's allowlist (the local duplicate deleted); events → `DataGrid`; scopes card renders granted + drift as in §2. `useSettingsForm` save bar unchanged.

## 6. Design-system additions (files under `apps/web/src/design-system/`)
- `components/KeyValue.tsx` — `<dl>` term/value grid (`items: {label, value, hint?}[]`, `columns 1|2|3`), token-styled `.nds-kv`. Gap filed in `.claude/DS-GAPS.md` (no description-list primitive; the detail page's `Stat` was the fourth local spelling).
- `AccountsPanel.tsx` / `AccountSwitcher.tsx` — §2. New classes `.nds-acctp-status`, `.nds-acctp-scopes`, `.nds-acctp-times`, `.nds-acctp-err`, `.nds-acctp-test` in `styles/components.css` (frozen-differing in the fork baseline; free to edit).
- `components/index.ts` gains `KeyValue` — **mirrored byte-for-byte into `apps/factory/src/design-system/components/index.ts`** (identical today; the fork-drift ratchet would otherwise fail the push). `Tabs.tsx`/`Card.tsx` untouched.
- Tokens only (`--nds-*` / platform aliases); no hex, no Tailwind palette, no `cursor: help`; raw-primitive ratchet: every new file at zero raw controls.

## 7. Files
New: `settings/channels/{AccountsTab,ConnectTab,DiagnosticsTab}.tsx`, `settings/channels/useConnectPopup.ts`, `design-system/components/KeyValue.tsx`, tests `settings/channels/__tests__/*.test.tsx`.
Rewritten: `settings/channels/page.tsx`, `ChannelsClient.tsx`, `[type]/ChannelDetailClient.tsx`, `ebay-callback/page.tsx` (DS `Spinner`, the forwarder stays).
Touched: `settings/advertising/page.tsx` (form → Banner), `settings/_shell/settings-nav.ts:226`, `design-system/components/{AccountsPanel,AccountSwitcher,index}.tsx`, `design-system/styles/components.css`, `apps/factory/…/components/index.ts` (mirror), `.claude/DS-GAPS.md` (+1 line).
Deleted: nothing outside those files; `@/components/ui/{Button,Badge}` lose their last channels callers but stay (other pages).

## 8. Verification (prod, `nexus-commerce-three.vercel.app`)
1. Screenshots of every tab and state present on prod: Accounts (Amazon env row + two eBay rows with status pills, scope chips, permissions line, timestamps), Connect (eBay available, Amazon/Shopify/Etsy held with visible reasons, Ads card with the nine profiles), Diagnostics (heartbeat run, ledger rows, inbound events), detail page — light and dark.
2. States that cannot be produced on prod without breaking a grant (`degraded`, `needs_reauth`, `revoked`, drift > 0) are covered by component tests asserting pill tone/text and the Reconnect label for each `authStatus`; not screenshot-faked.
3. Geometry: the tab panel's content width ≈ viewport − rail − paddings (`getBoundingClientRect`), no right-side dead zone; icon/affordance symmetry on the rows measured.
4. Honesty round-trips: **Test** on `xaviaracing` → `lastHeartbeatAt` advances in the DB and a `heartbeat_ok` ledger row appears; **Refresh token now** → `lastRefreshAt` advances; the row's "Refreshed …" matches the column.
5. The held Connect buttons are reachable by Tab and produce their reason on Enter (the `check-silent-disabled` measurement).
6. All pre-push guards green (token-guard, raw-primitives ratchet, fork drift, silent-disabled, help-cursor, link targets, hex ratchet, button vocabulary).

## 9. Risks · rollback
Low: read paths only, plus three POSTs the API already exposes. The Ads manual form removal is the one capability change — the OAuth route it is replaced by is live on prod and has been since the Ads integration shipped; if it fails for a profile, the Owner tells me and the form comes back under a flag. Rollback = revert one web commit.

## 10. Tests
`AccountsPanel` row rendering per `authStatus` × drift (six statuses, drift 0/N, env vs oauth); `ConnectTab` catalogue rendering (available vs held + reason on Enter, region select only when >1); `useConnectPopup` bridge (own-origin and API-origin messages accepted, others ignored, ACK sent, BroadcastChannel path); `DiagnosticsTab` heartbeat result rendering; `KeyValue`.

## 11. Build record + prod defects found and fixed (2026-08-29)

Shipped `9fadf5130` (+ `c86393577`, the two event lists onto `NexusGrid` because the pre-push grid-kit ratchet refuses new DS-`DataGrid` importers). Then verified **on prod, in the browser**, which found seven defects the local checks could not — every one of them a thing the screen said that was not true, or said twice:

| # | Defect, measured on prod | Fix |
|---|---|---|
| 1 | The page rendered its title **twice** — the settings shell already draws "Channels" + the nav description, and my `PageHeader` repeated both lines | `PageHeader` removed; the shell owns the header (no other settings page uses one) |
| 2 | Amazon Ads rendered **twice** on Connect: the catalogue entry ("Not yet") beside the profiles card ("9 active") — two cards disagreeing about one channel | the catalogue's `AMAZON_ADS` entry is filtered out and its facts (auth mode, scopes, renewal, API version) are folded into the one Ads card |
| 3 | Amazon Seller said "**0 requested**" permissions — SP-API grants roles at app registration, not OAuth scopes | "Set by the app's roles at the channel, not by scopes" when `requiredScopes` is empty |
| 4 | The env-managed Amazon row said "**0 permissions granted**" | "No OAuth permissions — credentials come from the environment" |
| 5 | "**Last sync never (SUCCESS)**" — a verdict with no timestamp behind it (the boot-stamped status CX.1 stopped writing) | no time ⇒ no verdict: "Last sync never" |
| 6 | `xaviaracing` showed "**eBay tokens not configured for this connection**" as a floating line under a **Connected** pill — the last *sync's* error, read as current state | the sync error is appended to the "Last sync … (FAILED): …" fact; `healthReason` is no longer repeated on a CX.1 row |
| 7 | **Run heartbeat's result vanished ~200 ms after it appeared** — the reset effect depended on the account *object*, and the refetch the check itself triggers hands back a new object for the same account | every diagnostics effect keys on `account.id` / `account.channel`; the reset runs only when the operator picks a different account |

Also: the ledger's Actor column printed a raw cuid; it now prints the actor *kind* (operator / cron / system) with the user id in the title, and `actorKind` is dropped from the Detail summary it duplicated.

**Verified live on prod** (`nexus-commerce-three.vercel.app`, API `ddc4ddba9`): three tabs render with URL sync; Accounts shows the status pill from `authStatus`, region and 12 Amazon marketplace chips / "All eBay sites", "22 permissions not granted" with Reconnect relabelled to match, and the four timestamps; Connect renders five catalogue cards + Ads; Diagnostics loads the ledger on `NexusGrid` — real `heartbeat_ok` rows every 15 minutes — and **Run heartbeat wrote a new ledger row `heartbeat_ok · actorKind: operator · 3087 ms`** attributed to the operator's user id. That is the round trip the honesty rule asks for: the button made a real call, the channel answered, the row landed.

**A note on the poll that said this was not deployed for an hour:** `useSearchParams` inside the `Suspense` boundary makes the page client-rendered, so its text never appears in the server HTML. A `curl | grep` for the new copy therefore reported "not deployed" while the page had been live the whole time. Measure a client-rendered page in a browser, never in `curl`.
