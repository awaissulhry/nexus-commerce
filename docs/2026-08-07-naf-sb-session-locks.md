# NAF.SB — parallel-session file ownership

Two or more Claude sessions are building the ten `/fleet` pages at the same
time, on the same `main`, in the same working tree. This file is the protocol
and the live claim register.

**Read this before editing any file in the Shared table. Record a claim before
you edit one. Release it when you commit.**

Background on why this is needed at all:
`~/.claude/projects/-Users-awais-nexus-commerce/memory/project_concurrent_sessions.md`
— `git commit --only`, never `--amend`, and a sibling's `next build` shares
`apps/web/.next`.

---

## 1 · The rule

> **One page, one session, one CSS file, one routes file.**
>
> If two sessions need the same file, the second one waits or asks. If two
> sessions need the same *idea*, they agree on it in this document before either
> writes code.

Anything under a page's own directory is that page's session to change freely.
Everything in §3 is shared and needs a claim.

---

## 2 · Current claims

| Page / stream | Session | Status | Owns exclusively |
|---|---|---|---|
| **Workers** (`SB.W`) | this session | **W.1 + W.2 LANDED, prod-verified** (`e8d209357`, `fdd384bc2`, `fbda95e00`, `f9d6ca853`) — status column + failure taxonomy + DS DataGrid substrate; strip tiles filter the table, halt banner. Next: W.3 (named views, facets, Customize columns, "as of"). Studies in `docs/2026-08-07-naf-sbw-workers-page.md` + `-section-studies.md` | `app/fleet/workers/**`, `app/fleet/_shared/run-health.ts`, `apps/api/scripts/_sbw-*.mts` |
| **Workflows** (`SB.8` / `NAF.WF`) | parallel session | **S1 + S2 LANDED, prod-verified** (`99e46bb74`, `76b3486f0`) — routine list + per-routine story pages at `/fleet/workflows[/key]`. Glossary +`workflow` +`trigger` landed (claim released). Uses `run-health.ts` for failure semantics and splits self-test findings out of headlines per decision 3. Next: S3 (runs section on the detail page). | `app/fleet/workflows/**`, `app/fleet/_shared/use-visibility-poll.ts` (created; shared consumption) |

Update this table when a stream starts, pauses or lands.

---

## 3 · Shared files — claim before editing

| File | Risk if two sessions edit it | Protocol |
|---|---|---|
| `apps/api/src/routes/agent-fleet.routes.ts` | **Boot crash.** A duplicate route path makes Fastify refuse to start; the file is also 771 lines with a `€` binary byte, so `grep` needs `-a`. See `reference_advertising_routes_grep_trap`. | **Do not add routes here.** Each stream creates its own file — `agent-fleet-workers.routes.ts`, `agent-fleet-workflows.routes.ts` — and registers it with one line in `apps/api/src/index.ts` (routes are registered individually there already). One-line conflicts merge; 771-line conflicts do not. |
| `packages/database/prisma/schema.prisma` | Two sessions appending models at the same anchor silently drop one. | Append **at end of file**, inside a marked block: `// ─── NAF.SB.W ───` / `// ─── NAF.SB.8 ───`. Migrations are separate files and do not conflict. Additive migrations are pre-approved; destructive ones are not. |
| `apps/web/src/app/fleet/fleet-pages.css` | 482 lines, shared by all ten pages. Class-name collisions render wrong on someone else's page. | **Frozen to shared primitives.** Page-specific rules go in the page's own file — `workers.css`, `workflows.css` — imported by that page. Adding to `fleet-pages.css` needs a claim and a note here. **Claimed and released by Workers, W.1:** `.fleet-surface` gained the DS light pin (additive declarations only, no new selectors). It is what lets any DS component render on a fleet page without drawing dark cards on a light background — so **the Workflows canvas gets it for free and needs no pin of its own.** Copy `.productsNextLight`, never `.h10-shell`; the comment in the file says why. |
| `apps/web/src/design-system/components/DataGrid.tsx` | Shared by ~50 pages. | **Touched by Workers, W.1:** added `aria-sort` to sortable headers. Purely additive, no prop or behaviour change. Note here before any further edit. |
| `apps/web/src/app/fleet/_shared/*` | Cross-page helpers both streams import. | Additive only; say what you added. Currently `use-visibility-poll.ts` (Workflows) and `run-health.ts` (Workers — failure taxonomy + the six status words; **use it rather than re-deriving "is this broken"**). **W.2 added `WorkerStatus.tag`** — two or three words naming the cause, so a summary can tally the same values the rows carry instead of re-deriving them. **One trap it exists to prevent, hit three separate times in W.1 and W.2:** an `AgentRun` is created `ok: false` and only flips true when it finishes, so `!run.ok` counts the run that is still in flight. `classifyFailure()` guards it; anything counting failures by hand must exclude `status === 'running'` too. |
| `apps/web/src/app/fleet/_shell/*` | `FleetPageShell` and `PlannedPage` are the shape every page wears; a change lands on ten pages at once. | Claim, and say what changed. Additive props only. |
| `.../rules-automation/fleet/glossary.tsx` | Append-only map. Two sessions appending at the same anchor is the exact failure `project_concurrent_sessions` records for `en.json`. | Re-read the file immediately before editing. One term per commit where possible. Never redefine an existing term — the one-definition rule is why the `<Term>` component exists. |
| `apps/web/src/app/_shared/app-nav.ts` | Nav tree; a bad rewrite duplicated a whole block once already. | Should be complete for all ten pages. If it is not, claim it, and never drive edits with `str.index()`. |
| `apps/api/src/services/agent-fleet/charter-registry.ts` | Resolver for every worker. | Claim. Coupled to §4. |
| `apps/api/src/services/agent-fleet/fleet-graph.ts` | The static DAG. | Claim. Coupled to §4. |
| `docs/2026-08-07-naf-sb-fleet-pages.md` | The parent map both streams cite. | Append to your own page's section only. |

---

## 4 · The one real coupling: instances and the stored graph

Workers' **"create a worker"** and Workflows' **stored, versioned graph** are the
same architectural question from two sides — the Part-4 capability/composition
split in `docs/2026-08-07-naf-sb-fleet-pages.md`.

Concretely: if the operator creates *"negative miner, DE only, €0.30/day"* as an
instance of `amazon-negative-miner`, then

- `FLEET_CHARTERS` must resolve it (`resolveCharter` returns `null` for unknown
  keys today), **and**
- `FLEET_GRAPH` must give it edges, or its findings never reach the director —
  and `topoLevels()` throws on an edge naming an unknown node.

**Neither session designs this alone.** Whoever reaches it first writes the
proposal here and the other reviews before any code. Details of the Workers side
are in `docs/2026-08-07-naf-sbw-workers-page.md` Part 6.

Not needed before Workers step **W.8** or the Workflows stored-graph work, so
there is time to do it properly.

### PROPOSAL (Workflows stream, 2026-08-07) — awaiting Workers review

The Workflows stream has reached its stored-model phase first. Two halves, one
contract; the design goal is that **neither half ever names the other's
internals** — they meet only at `resolveCharter`.

**Half A — worker instances (Workers, W.8; sketched here only so Half B cannot
contradict it).** An instance is a new `AgentCharter` row with a fresh `key`
and a new nullable `templateKey` column naming the code charter it
instantiates. `resolveCharter(key)`: when `FLEET_CHARTERS[key]` is absent but
the row's `templateKey` resolves in code, return the code definition of the
template ⊕ the row's narrowing (scope, budget, cadence, prompt overlay).
`outputSchemaKey` / `toolNames` (narrow-only) / `observationKeys` /
`autonomyCap` / `tier` inherit uneditably — laws L2/L3 hold by construction.
Workers may redesign the internals of this half freely; the only thing Half B
relies on is *`resolveCharter` is the single resolver and instances resolve
through it*.

**Half B — stored workflows (Workflows, WF.2).** Two models, appended at end
of schema in a `// ─── NAF.SB.8 ───` block; migration `20260807c_naf_wf_workflows`
(letter checked free):

- `AgentWorkflow` — `key` unique · `name` · `description` · `kind`
  (`builtin | custom`) · `enabled` · timestamps · `createdBy`.
- `AgentWorkflowRevision` — `workflowKey` · `revision` (monotonic) ·
  `definition Json` · `note` (mandatory) · `author` · `createdAt` ·
  `activatedAt` · `supersededAt` · `@@unique([workflowKey, revision])` —
  byte-for-byte the `AgentCharterRevision` contract.
- `AgentRun` gains nullable `workflowKey` + `workflowRevisionId` (additive).
- `definition` Json, contract v1:
  `{ trigger: {type:'schedule',cron} | {type:'manual'},
     steps: [{ charterKey, gate: 'ask'|'act'|'inherit' }],
     edges: [{ from, to, artifact: 'finding'|'plan'|'strategy' }] }`
- **Law (mirrors charters):** code default ⊕ active revision. A built-in with
  no/unreadable active revision runs the CODE path — revert-to-built-in can
  never fail. A custom workflow's floor is *disabled*, never a code fallback.
- **Validation on save/publish (Layer 2 vs Layer 1):** every `charterKey`
  must resolve **via `resolveCharter`** — never `FLEET_CHARTERS` directly —
  so instances become wireable into workflows the day Half A lands, with zero
  change on this side. Edges must be acyclic (the `topoLevels` throw), the
  artifact type accepted by the target's tier, gates tighten-only against
  tool-policy floors (`alwaysAsk` unbreachable).
- **The §4 worry about `FLEET_GRAPH` resolves structurally:** stored
  execution walks the STORED graph, so an instance needs no `FLEET_GRAPH`
  edges to participate in a stored workflow. `FLEET_GRAPH` remains the code
  truth for the built-ins' fallback path only.

**Review asks for the Workers stream:** (1) does Half A as sketched match your
W.8 intent — especially `templateKey` on `AgentCharter` rather than a separate
instance table? (2) any objection to `resolveCharter` as the single meeting
point? (3) any claim on migration letter `20260807c`? Nothing in Half B runs
until this section says REVIEWED.

---

## 5 · Open shared decisions

| # | Decision | Blocks | Status |
|---|---|---|---|
| 1 | **Real-time mechanism** | Workers W.6, Workflows canvas | **SETTLED 2026-08-07 — visibility-gated polling.** One shared hook: refetch ~10s while `document.visibilityState === 'visible'`, pause when hidden, an "as of" stamp, and a *changed since you looked* cue rather than a silent re-sort under the cursor. No SSE, no new infrastructure. **This is the answer for all ten pages** — the Workflows canvas adopts the same hook. Workers extracts it at W.6; whoever needs it sooner may extract it earlier and record that here. **Extracted early by the Workflows stream 2026-08-07** — `apps/web/src/app/fleet/_shared/use-visibility-poll.ts` (10s, visibility-gated, pauses hidden, catches up on return, "as of" = last successful read). Workers re-points at it in W.6. |
| 2 | **The autonomy dial component** | Workers W.4, Controls | **SETTLED 2026-08-07 — one shared component**, two presentation modes: Controls *explain* (card, prose, ladder), Workers *operate* (inline row + bulk). One confirm, one audit write. **Workers extracts it at W.4 and re-points Controls at it**, so `ControlsClient.tsx` will be touched by the Workers session — claimed in advance here. |
| 3 | **Instance / stored-graph model** (§4) | Workers W.8, Workflows | **PROPOSED 2026-08-07 by the Workflows stream — §4, awaiting Workers review.** Workflows holds its migration until the §4 proposal says REVIEWED; the schema-free Versions card ships meanwhile. |
| 4 | **Page-local CSS convention** — `workers.css` / `workflows.css` beside the page, `fleet-pages.css` frozen to shared primitives. | both | **proposed here** — adopt unless objected. |

---

## 6 · Before you commit

1. `git commit --only -- <explicit paths>` — never `git add .`, never `--amend`.
2. `git show --stat HEAD` and confirm **your** files and only yours landed.
3. If a shared file was in the commit, release the claim in §2/§3 here.
4. Pushes can exceed 10 minutes (full `next build` + API `tsc` + security
   tests, contending for the shared `.next`). Retry rather than `--no-verify`;
   confirm with `git ls-remote origin refs/heads/main`.
