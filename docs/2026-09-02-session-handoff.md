# PES session hand-off — 2026-09-02 13:45 (hub ruling #680)

The Owner is quitting and re-opening the sessions: the **hub on Fable 5.1**, every lane on **Opus**.
This file is what a re-opened session reads first. Every prompt below is self-contained; paste the
section for the session you are opening. **The ledger is `docs/pes-claims.md` (hub rulings at the
top, newest first, currently #680; the Owner queue is ruling #361, items 1–40).** Memory is shared
by every session in this project (`~/.claude/projects/-Users-awais-nexus-commerce/memory/MEMORY.md`).

## 0a. CORRECTIONS from the re-open (hub #684, 14:05) — read before §0

- **The claims "table" is the set of `- LANE · nexus-commerce-XX · …` bullet rows around line 17972 of `docs/pes-claims.md` (grep `^- PES\.3 · `). There is NO `## Lane claims` heading and never was — the wording below was the hub's error. The section four lanes created at the file's tail is renamed "Re-open notes" and is not the table.**
- **The ledger reads from BOTH ends: hub rulings are newest-at-TOP (`grep -n -E '^6[89][0-9]\. ' docs/pes-claims.md | head -1`), lane notes append at the bottom. `tail` sees no ruling.** The hub's row is `- PES.0 · **nexus-commerce-8c**`.
- **Before your first edit: confirm via `ListAgents` that your predecessor session is GONE, or has stood down in writing.** The re-open opened successors onto lanes whose old sessions were still alive and mid-item (PES.2 `5f`/`9f`, DS.1 `e2`/`e5`/`48`); an old session still alive stands down explicitly in the ledger. A file in your scope that moved and you did not write: hash the scope twice a minute apart and report CONTENT, not mtimes.
- **Servers:** they belong to the old hub session `50` until the Owner quits it or allows the new hub's SIGTERM (Owner item 41); the new hub restarts them on a port watch and posts STOP/UP timestamps.
- **Status lines below that are stale:** PES.2 — #663 BUILT in code (screen half owed), #674 guard REMOVED from `.ts` and `.d.ts`, #601 DONE and the conformance guard GREEN, one NEW raw-primitives red at `MasterSheet.tsx:1478`; DS.1 — #678's CSS edit LANDED 13:47:59 both forks (verification open); `--nds-popover-max-w` and `--nds-z-drawer` are UNDEFINED in the factory fork (DS.2 mints; a new eighth gate, #684). The idle-set section (§2 last) is held by ONE session as PES.7 + IO.1 custodian.
- Push hygiene: 131 untracked `_*.mts`, 1,682 TRACKED `_*.mts` at HEAD — see §0.

## 0. What is true at hand-off (13:45)

- **HEAD `80f6cfb84`, NOTHING committed or pushed**, ~606 working-tree entries. The Owner pushes,
  once, when they say so (queue items 35 and 36 cover the push).
- **The two dev servers are hub-owned background tasks and DIE with the hub session (in practice at 13:51 they did NOT — the old hub stood down without exiting; see §0a).** The new hub
  starts them first (§1). The local API on :8091 rides the **PRODUCTION database** — every write is
  real.
- **Rehearsal writes only on the XAVIA fixture family** (GALE-JACKET parent
  `cmokmy3a40078pm0p1fvnu523`, 21 rows). A safe column is one with NO push path — `status`,
  `quantity`, `price`, `isPublished`, `brand`, `name` all have one; `manufacturer`, `weave_type`,
  `fabric_type` do not. Restore and verify on **two independent read paths AND after a delay** (#668:
  a surface's own autosave can re-apply a value after your revert).
- **A save to a file in `src/index.ts`'s IMPORT GRAPH restarts the API under tsx watch (a `*.vitest.test.ts` or a `scripts/*.mts` restarts NOTHING — corrected #695; the hand-off's "any `apps/api` write" was wrong and cost three lanes discarded readings)** — a lane says "opening unless you hold
  me" to the hub and waits one round trip before saving (#604).
- **Nothing is approved for the Owner by anyone.** A classifier denial in your session goes to the
  Owner (queue item 40), never to a peer.
- **Design authority is the hub** (#454). Lanes measure, implement, verify; a design question is
  filed with a measurement and a recommendation.
- Every re-opened session **updates its own row in the claims table** (bottom of
  `docs/pes-claims.md`, "## Lane claims") with its NEW session name (`ListAgents`-visible,
  `nexus-commerce-XX`), because the hub routes by those names and every old name is dead.

### Open defects and items (with their ruling numbers)

| # | item | owner | state |
|---|---|---|---|
| #674/#677 | `brand`: sheet reads the attribute twin, PATCH writes the column — sheet now shows the write's layer + a divergence mark | PES.5 | **LANDED** `studio-sheet.service.ts` 13:40:45 (#681) |
| #675 | a same-value write spends a version — bounded equality check (only when `expectedVersion` present); all-no-op request → 200 `{updated:0, unchanged:n}`, never 400 | PES.5 | **LANDED** `products.routes.ts` 13:42:45 (#681) |
| #663 | Reload with unsaved/refused edits confirms, then clears marks + counter with the rows | PES.2 | **LANDED in code** `reloadGuard.ts` (new) + `MasterSheet.tsx` 13:55:05, `sheetWriter.discard()` 13:55:05, `CellSaveTracker.clearAll()` 13:56:06; 11/11 mutations. **Screen acceptance NOT taken** — needs a producible refusal, same blocker as #662 |
| #674 | interim `resolvable` guard | PES.2 | **REMOVED** `sheetWriter.ts` 13:55:05 / `useMasterSheet.ts` 13:48:41. #677 verified first, not taken on report: `PATCH brand` on AIREON then the sheet read returned the new value with `source: masterColumn` in the same second (was stale + `source: master`). Left behind: a test that a column write resolves from the read-back, and its contradicted twin |
| #662 | reason-first tooltip ORDER seen on screen | PES.2 | unverified — the 409 route was CLOSED when I tried it (attr writes did not bump `Product.version`; three left it at 25). **#675 landing 13:42:45 may have opened it**: try a genuinely-different value on a column field with no push path. Everything else in #662 IS on screen: rival `title` gone, two paragraphs after the `pre-line` fix |
| #601 | inline fontSize; the `AddVariationDialog` "native select" | PES.2 | **BOTH CLEAR.** fontSize → DS `Banner` (tokenising the value does NOT move the count — the guard matches the SYNTAX, as its own header says); products fontSize 1→0. The select was a FALSE POSITIVE: the file used the DS `Select` and the guard matched the element name **in a comment** — products select 16→15 on a rewording. I scored it twice: my first rewording quoted the guard's own regex |
| #649 | media provenance `-ai-stale` shares `-ai`'s colour on tiles; PES.7 paints the pair on a real tile after | PES.2 → PES.7 | later |
| #679 | Amazon·IT fits 6/7 required columns at 1440 (master 7/7): measure the channel's leading-band budget, propose | PES.3 | open |
| #678 | `.nds-hovercard-card` nowrap + no max-width — value wraps under the popover cap, key nowrap, measured live | DS.1 | open |
| #679 | px shortfall + side-by-side at 1440 when load < 8; §9.1 fixture carries Amazon·IT permanently | UX.1 | open |
| #664/#673 | `saved`-branch screen run (PES.2) and the channel write round-trip (PES.3) — both blocked by session classifiers | OWNER item 40 | decision |
| #361 | Owner decisions: 31 formula-lab mock · 32 front the Chrome window · 34 chrome A/B (hub recommends A) · 40 above; disclosures 33/36/37/38/39 | OWNER | decisions |

Gates: the seven pre-push gates read untracked files since #591. PES.2's two #601 items have
landed (products: fontSize 0, select 16→15), so re-measure the four ratchets before assuming red. `check-writability.mjs` runs on demand only (`npx tsx`, ~26 s).

**🔴 The push MUST carry four migrations that are APPLIED TO PROD and UNTRACKED** (verified `??` at
13:49): `packages/database/prisma/migrations/20260901c_pes5_listing_aliases`,
`20260901e_pes5_aliaskey_not_null` (its `rollback.sql` is not run by `migrate deploy` and must stay
that way), `20260901f_pes5_listing_snapshots`, `20260902c_pes5_bulkop_progress`. The database has
them; the repo does not; a fresh clone or a deploy is behind prod until they ride along — and a deploy
whose migration table disagrees with the directory is the banked P3009 shape.

**Push hygiene (queue item 35, grown):** `git add -A` would sweep in **131 untracked `_*.mts` probe scripts (was 317 before #682; and 1,682 `_*.mts` are TRACKED at HEAD — delete ONLY by your own explicit `_pes<n>-*.mts` prefix, never a broad glob, #684)**
(`apps/api/scripts/_*.mts`, every lane's `_pes2-*`, `_gx*`, `_adm*`…) and `.env.naf-a2-backup`. Before
the push each lane deletes its own `_*.mts` probes (or the push adds `apps/web`, `apps/api/src`,
`packages`, `scripts/check-*.mjs`, `.githooks`, `docs` explicitly — never `-A`). The fixture parent
GALE-JACKET is written by several lanes' rehearsals (PES.2, PES.5 both at 13:36 — PES.5's #674
control values `BRAND-…`/`MFR-…` were PES.5's own, restored in the same run): anyone reading that row
for evidence reads several sessions' writes — announce a fixture write to the hub first.

---

## 1. HUB (Fable 5.1) — paste this whole section

You are **PES.0, the hub** of the Product Edit Studio rebuild in `/Users/awais/nexus-commerce`.
Read, in this order: `~/.claude/projects/-Users-awais-nexus-commerce/memory/MEMORY.md` (an index —
open a file before acting on its pointer); `docs/2026-09-02-session-handoff.md` (this file);
`docs/pes-claims.md` rulings **#600–#680** and the Owner queue in **#361**;
`docs/2026-09-02-wave4-design.md` (the approved design: §1 formulas, §2 import/export incl. D15.16
the wire envelope, §3 scale, §4 chrome). The Owner's standing directives are #442 (wave 4), #454
(all design/UX decisions in the hub), #461 (dropdowns — closed on every surface at #676/#678).

**Do first, before any lane message:**
1. Start the servers as background tasks with timestamped lines (they died with the old hub):
   `NEXUS_API_HOST=:: PORT=8091 NEXUS_DISABLE_BACKGROUND_JOBS=1 NEXUS_ENABLE_TIMING_ALLOW_ORIGIN=1 npm --prefix apps/api run dev`
   and `NEXT_PUBLIC_API_URL=http://127.0.0.1:8091 npm --prefix apps/web run dev`. Verify:
   `curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:8091/api/products/search?limit=1'` (cold
   boot 30–45 s; a 000 during boot is not DOWN) and `http://localhost:3000/design/chrome`. Check
   `ps eww -o command -p <next dev pid> | tr ' ' '\n' | grep NEXT_PUBLIC_API_URL` — the API target
   lives in the process env, not a file.
2. `git rev-parse --short HEAD` must be `80f6cfb84`; `git diff --cached --stat` must be empty.
3. Re-arm the standing sweep (ScheduleWakeup, 1500 s): ping both servers twice, load, process every
   lane message into the next numbered ruling at the top of the hub list (`grep -n -E '^6[0-9][0-9]\. '
   docs/pes-claims.md | head -1`), reply via SendMessage using ONLY names from the claims table
   (re-read it — every lane will have re-claimed with a new name; where two rows share a name use the
   `[ref]`), keep #361 current, bank lessons in memory by appending to the existing file AND striking
   a stale claim where it sits.

**Rules you enforce (each has a memory file — read it when it bites):** a relayed number carries its
subject and build; a relayed LIST is read from the source, never restated; verify a claim that lets a
lane stop with one command before accepting it; a lane's "done" is checked against mtime AND content
(`cmp`) and gate output, never the message; a rejection names who deletes what by line; a rule about a
framework internal names the framework line; "where does the thing you looked for live?" before
accepting an absence; two independent read paths + a delayed re-read after every rehearsal write;
producer and consumer land together, and a strict consumer must not land before its producer.

**Open at hand-off** (§0 table). PES.5's window CLOSED at 13:42:45 with both items landed and
verified (#681). Route the rest as the table says. The Owner's queue items 31/32/34/40 are theirs — never approve.

---

## 2. LANES (Opus) — common preamble, then your section

**Common preamble (paste with every lane prompt):**
You are lane **{LANE}** of the Product Edit Studio rebuild in `/Users/awais/nexus-commerce`. Read
`~/.claude/projects/-Users-awais-nexus-commerce/memory/MEMORY.md` (index; open a file before acting
on it), `docs/2026-09-02-session-handoff.md` §0 and your section, and your own row in the claims
table at the bottom of `docs/pes-claims.md`; then **update that row with your new session name**
(`ListAgents` shows it; format `nexus-commerce-XX`) and message the hub (the session whose row is
PES.0 — find its new name in the table or via `ListAgents`) with one line: your lane, your new name,
and what you found on disk with mtimes. Rules: **nothing committed or pushed**; the local API on
:8091 is the PRODUCTION database; rehearsal writes only on the XAVIA fixture family on columns with no
push path, restored and verified on two read paths and again after a delay; any `apps/api` write is
announced to the hub as "opening unless you hold me" and waits one round trip; you own only the files
in your row — a change to another lane's file is a request to its owner, or a disclosed one-liner
when the hub has ruled it; the DS is mandatory (`node scripts/ds-conformance-guard.mjs --check`,
`check-raw-primitives-ratchet`, `check-css-hex-ratchet`, `check-css-radius-ratchet`); design
questions go to the hub with a measurement and a recommendation, never decided in-lane; a denial by
your permission classifier goes to the Owner via the hub, never to a peer; every number you report
carries its subject and its build (mtimes of every file on the read path, compared by content); read
the SCREEN, not the diff — a green suite proved the suite; a check that has never failed has not been
shown to be a check; report what you did NOT measure as plainly as what you did.

### PES.2 — master sheet + grid engine (`apps/web/src/design-system/grid/**`, `_studio/sheet/master/**`, `app/products/_sheet/**`)
Open, in this order: (1) **#663** — the sheet's Reload with unsaved or refused edits ASKS (DS
confirm, "1 change not saved — reload and discard it?"); on confirm the tracker entries and the
unsaved counter clear WITH the rows (no stale mark, note or count — measured on screen at #663); on
cancel nothing moves. Tests both branches. (2) **#674 interim guard** — PES.5's #677 LANDED at 13:40:45 (the sheet reads the store the PATCH
writes; `brand` shows the column value + a divergence mark): remove `resolvable` from the writer and
the host with a test that a column write now resolves from the read-back. (2b) Delete your
`apps/api/scripts/_pes2-*.mts` probes before the push. (3) **#601** — `MasterSheet.tsx:1472` inline `fontSize` → DS type
token/utility (`.nds-type-*`, `--nds-font-size-*`; NOT Tailwind `text-*`, #623), and
`AddVariationDialog.tsx:129` native `<select>` → DS `Select`; both ratchets clean. (4) **#662 order on
screen** — produce a real refusal without an outage: a direct PATCH WITH `expectedVersion` on a
COLUMN field with no push path (not `brand`/`name`/`status`) bumps the version, then a sheet edit
sends the stale version → 409 → `refused`; hover: the refusal sentence, a blank line, the cap line;
the `.nds-vh` text equals the first paragraph. (5) Verify no outbound sync item was created by your
`brand` write of 13:2x (item 33's standard) and report. (6) Later: the media `-ai-stale` mark
distinct from `-ai` on tiles (#649), second line. Your `saved`-branch screen run is Owner item 40 —
do not route around the denial.

### PES.5 — API (`apps/api/src/**`; `product-studio.routes.ts`, `studio-sheet.service.ts`, `products.routes.ts`, `import-*.service.ts`)
Both items LANDED before hand-off (`studio-sheet.service.ts` 13:40:45, `products.routes.ts`
13:42:45; #681) — confirm on disk with `stat`, then idle unless the hub routes. For the record: (1) **#677** — the `col.storage === 'column'` branch reads
the COLUMN again (reverting #508(1)'s resolver preference); where the resolver holds a different
non-blank value the cell carries `divergence: { publishesAs, note }` naming both; the write is NOT
redirected (Owner item 29 decides canonicality). Tests: `brand` on GALE-JACKET shows the column value
with the mark; `manufacturer` unchanged at `masterColumn`; a `brand` PATCH reads back through the
sheet as written, same run, restored. (2) **#675 BOUNDED** — a per-cell equality check before the
write, ONLY when `expectedVersion` is present, one batched read per request: a same-value cell is
skipped, counted `unchanged`, spends no version, writes no BulkOperation/AuditLog; equality is
semantic (the KEY's value inside the JSONB bag, scalars after the route's own normalisation). Tests:
same-value PATCH → version unchanged, `updated: 0`, no rows; a real change beside a same-value cell
→ version +1 once; a TOKENLESS PATCH with a same-value cell behaves exactly as today. PES.5's 186 `_pes5-*.mts` probes are DELETED (0 remain; other lanes' 132 untouched; the four
migration directories intact — deleted by the explicit `_pes5-*.mts` pattern, never by prefix).
Also landed: an all-no-op request returns 200 `{ updated: 0, unchanged: n }` (it used to fall into
the "nothing survived validation" 400 + FAILED job — the fix for a silent defect created a loud one
one branch down). The v82 raw-SQL writer stays unknown (#675); `attr_*` not bumping
`Product.version` is by architecture. Delete your `_pes5-*.mts` probe scripts before the push.

### PES.3 — channel scopes (`_studio/sheet/channel/**`, `_studio/channel-ops/**`)
Open: **#679** — Amazon·IT fits 6/7 required columns at 1440 where master fits 7/7, with the same
seven keys and identical declared widths. Measure what the channel scope spends at 1440 that master
does not (the leading/pinned band — alias, cascade, provenance columns — per column in px, both
scopes side by side, GALE-JACKET, `market=IT&locale=it`), and propose; the hub rules the design (D11:
the required set fits at 1440 on every scope). Change no widths before the ruling. Your D18 channel
editor (#673) is accepted; its write round-trip is Owner item 40 (a keystroke was denied in your
session) — do not commit through the grid API. Item 32 (hover/drawer proofs) waits on the Owner
fronting the Chrome window.

### DS.1 — DS gates + components (`scripts/check-*.mjs`, `.githooks/pre-push`, `design-system/components/**` not claimed by others)
Open: **#678** — `.nds-hovercard-card` (`components.css:1103`) has `white-space: nowrap` and no
`max-width`. Trigger a hovercard on a real page with a long value, measure the card; then the VALUE
column wraps (`white-space: normal; overflow-wrap: anywhere`) inside `max-width:
var(--nds-popover-max-w)`, the KEY column stays `nowrap`; re-measure; both forks; screenshot. Leave
`.nds-taginput-menu` (field-width by construction), `.nds-dp-pop` (structural), and the drawer's own
max alone. Then re-run all seven pre-push gates and report reds by file for the hub to route.

### UX.1 — layout spec + `npm run layout:v2` (`docs/2026-09-01-layout-v2-spec.md`, `scripts/check-layout-v2.mjs`, `package.json:21` `layout:v2` — the earlier globs matched nothing, #684)
Open: **#679** — when load < 8: the px shortfall at 1440 on Amazon·IT and the side-by-side with
master; and make §9.1's fixture carry the channel coordinate (Amazon·IT GALE-JACKET) permanently
beside master OUTERWEAR. Keep the 📌 BUILD STAMP on every run and the disturbed-run banner. Re-measure
§5.4 (both paths, `[82]/[112]/[64]` and `[82]/[242]/clear`) only if any file on its read path moves.

### PES.4 — record drawer (`_studio/drawer/**`)
Idle at hand-off. All three `PressableRow` rows adopted with names read from the tree (#670). If
re-opened: nothing assigned; the accessibility-tree names via Chrome's AX node can be re-read when the
Owner fronts the window (item 32).

### DS.2 — tokens + DS components (`design-system/tokens/**`, `styles/**`, `PressableRow`, `ListboxPanel`, `FileDropzone`)
Idle at hand-off; row clear (#676/#678). If re-opened: nothing assigned. Type-scale Phase C (collapse
half-pixel steps) is Owner item 38 — do not start it.

### CH.1 — chrome (`app/design/chrome/**`, `docs/2026-09-02-chrome-proposal.md`)
Standing by for Owner item 34 (A/B pick; hub recommends A). Nothing else.

### IO.1 — import drawer (`_studio/import/**`) · PES.7 — images (`_studio/images/**`) · PES.6 / PES.8 / PES.1 / SC.1 / AG.1 / FX.1
Complete or idle at hand-off; nothing assigned. PES.7 has one later item: paint the media
provenance pair on a real tile after PES.2's `-ai-stale` line.
