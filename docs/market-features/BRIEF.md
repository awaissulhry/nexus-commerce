# BRIEF — market-specific feature research for the Product Edit Studio (PES)

You are ONE of 34 read-only research agents. Each agent owns ONE market-specific feature that exists
in the OLD product edit page (or beside it) and must answer, for that feature only:

> "We are rebuilding the product edit page as a grid-first studio. Where does THIS feature live in the
>  new page, what shape does it take, what backend already exists, and what is wrong with it today?"

The Owner's own framing of the question: *"we have not yet built any toolbar, I would say. Do we
integrate it directly in the description cell of eBay, or do we have it with the images section, etc.,
or how does it actually work?"* — so your report must land on a concrete PLACEMENT with a reason.

## 0. Hard rules (read twice)

1. **READ-ONLY.** You may read files, grep, `git log`/`git diff`/`git blame`, and read docs. You may
   NOT edit or create any file except your own report file (path given in your prompt). No `npm`, no
   `vitest`, no `tsc`, no builds, no dev servers, no browser, no database, no curl, no Railway tools,
   no Agent/sub-agent spawning. 34 agents share one machine and a shared working tree that other
   sessions are editing live; anything beyond reading collides.
2. **Local dev hits the PRODUCTION database and every eBay listing in the fixture family is LIVE**
   — that is why you do not run anything. Cite code and docs; mark anything not measured as
   "hypothesis".
3. **The old tree is SPECIFICATION, never source** (Owner rule, layout doc §2.10): the studio is
   rebuilt from scratch on the Nexus design system (DS) + AG Grid Enterprise. Capabilities survive,
   code does not. Do not propose "wrap the old component".
4. **Nothing is committed** in this programme; do not suggest git operations.
5. **Design authority is the Owner.** You RECOMMEND with evidence; you do not rule. Open questions
   for the Owner go in a dedicated section (max 3).
6. **No live AI generation** (Owner ruling #13): AI surfaces are built and honest but DARK; never
   propose enabling generation.
7. Untouchable areas (never propose edits inside them): the flat-file editors
   (`apps/web/src/app/products/amazon-flat-file/**`, `ebay-flat-file/**` — except the Description
   Studio, which is being REBUILT into the studio), FBA quantity logic, the existing import flows.

## 1. Where things are

- Old edit page: `apps/web/src/app/products/[id]/edit/` — `ProductEditClient.tsx`, `tabs/**`
  (`amazon-cockpit/`, `ebay-cockpit/`, `images/`, `ChannelListingTab.tsx`, `MatrixTab.tsx`, …),
  `_shared/**` (cockpit-shell, market-switch, draft-bus …). Old channel field editor:
  `apps/web/src/app/products/_shared/ChannelFieldEditor.tsx`.
- NEW studio (what exists today): `apps/web/src/app/products/[id]/edit/_studio/**` — frame
  (`StudioClient/StudioFrame/StudioBar/StudioHeader/PublishMenu/StudioTabHost`), `sheet/master/**`,
  `sheet/channel/**` (ChannelSheet, AliasBandCell, AliasPublishControl, CascadeCell,
  channelActions.ts), `sheet/SheetToolbar.tsx`, `drawer/**` (RecordDrawer + panes Record / History /
  Compare / Listings, RecordActions, RestoreMode), `images/**` (master gallery, amazon matrix, ebay
  grid, dam, editor, viewer, publish, plan, local), `channel-ops/**` (Errors & Sync console),
  `ancillary/**` (Activity, Analytics·Ads), `ai/**` (draft review), `import/**`, `contracts.tsx`
  (useStudioScope, useRegisterViewChip, useSaveReporter, useScopeReadiness …).
- Grid substrate (DS-owned): `apps/web/src/design-system/grid/**` — `editors/` (sheetWriter,
  writeGate, SelectPanelEditor, FormulaCellEditor, openGesture), `renderers/` (cells, provenance,
  IdentityBand, MediaCellView, readiness), `actions/` (registry.ts, menuAdapters, ActionConfirm,
  useActionPress), `toolbars/`, `views/`, `hosts/GridSheet`.
- DS components/patterns/primitives: `apps/web/src/design-system/{components,patterns,primitives}/`.
  Exports include: Drawer, Modal, Menu, Tabs, HoverCard, Combobox, Listbox/ListboxPanel, MultiSelect,
  OptionList, Banner, EmptyState, Stepper, FileDropzone, ImageUpload, Thumbnail, PressableRow,
  KeyValue, Card, MetricStrip, DataGrid; patterns GridToolbar, FilterBar, BulkActionBar, EditModeBar,
  Builder, PreferencesModal, DetailHeader; primitives Button, FilterChip, Pill, Badge, Tag, Input,
  Textarea, Select, Toggle, Checkbox, SegmentedControl, Tooltip, Kbd, TagInput, NumberStepper.
  Name DS components in your design; if none fits, say so and propose ONE new DS component.
- API: `apps/api/src/routes/**`, `apps/api/src/services/**`; schema
  `packages/database/prisma/schema.prisma`. Permission manifest:
  `apps/api/src/lib/auth/permissions-manifest.ts`.
- Docs (authoritative, read the parts you need):
  - `docs/2026-09-01-product-edit-studio-layout.md` — approved layout + decision log (200 lines, read all).
  - `docs/pes-parity-audit.md` — every old capability with a parity status; your prompt names your rows.
  - `docs/2026-09-01-channel-ops-research.md` — industry research on where per-listing channel
    operations live beside a grid (three legs: drawer = depth; verbs in ONE action registry mirrored
    on row menu / ⋯ / selection bar / drawer; queues in an Errors & Sync console; publish
    snapshot/restore follows the CMS doctrine). The Owner has NOT yet decided D1; your report feeds it.
  - `docs/2026-09-04-channel-attribute-model-design.md` — APPROVED 2026-09-05: every channel field is a
    column from a per-channel adapter (`ChannelFieldSpec`), four cell shapes (scalar / list / measure
    / compound), one store per shape, no exclusions. eBay aspects become columns keyed by English name.
  - `docs/2026-09-01-layout-v2-spec.md` §5 (non-modal slide-over drawer, 520px, sheet stays live),
    §5.5 (gesture map: double-click EDITS, a record opens only from the identity cell / `open-record`
    verb / Enter on identity).
  - `docs/2026-09-01-pes7-images-inventory.md` — the images lane's full inventory + build record.
  - `docs/2026-09-04-studio-layout-and-controls-review.md` — the studio's band-by-band geometry today.
  - `docs/pes-claims.md` — 34k-line ledger; hub rulings are numbered NEWEST-AT-TOP (`grep -nE '^NNN\. '`).
    Only grep it for your feature's keywords; do not read it whole.

## 2. The approved studio, in one screen

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ ‹ Products  GALE Pro Racing Suit · GALE-KAN-PRO · ● Active      autosave ✓  [Publish ▾]│  48px header (collapses on grid scroll)
├───────────────────────────────────────────────────────────────────────────────────────┤
│ SCOPE [Master 96%][Amazon ●92%][eBay ⚠71%][Shopify ○—]  Tabs: Sheet·Images·Analytics·Activity·Errors&Sync   Market [IT ▾] Locale [it ▾] │ 40px
├───────────────────────────────────────────────────────────────────────────────────────┤
│ 21 rows · 2 selected  [View ▾][Missing required (7)][Warnings (42)]  Find…  [Customise][Export ▾][Import][Reload] │ 40px SheetToolbar (leading/trailing slots for scope verbs)
├───────────────────────────────────────────────────────────────────────────────────────┤
│  THE SHEET — NexusGrid (AG Enterprise) in GridSheet host, ~75% of viewport                 │
│  master scope: parent + child SKU rows × every master attribute (101 cols on GALE)          │
│  channel scope (eBay·IT): one collapsible ALIAS BAND per listing ①②③ + the same child SKUs  │
│    × every channel field (AM.1). Per-cell provenance 🔗 inherited · ✎ pinned · ⚠ · ✦ AI draft │
│  cell edit = autosave via ONE SheetWriter (PATCH /api/products/bulk, expectedVersion)        │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ footer: 21 rows · autosave ✓ · Type or Enter to edit · ↓↑ · Tab · drag corner to fill · ⌘Z  │ 36px
└───────────────────────────────────────────────────────────────────────────────────────┘
Record drawer: NON-MODAL slide-over from the right (520px), panes Record · History · Compare ·
Listings; opened only from the identity cell / `open-record` verb / Enter on identity. Sheet stays live.
Verbs: ONE action registry (design-system/grid/actions/registry.ts) with scopes ROW · SELECTION ·
CONTEXT(product-family | alias-group); each verb declared once by its lane and rendered on the row
context menu, the ⋯ column, the selection bar and the drawer. Order: COLLECT → PREFLIGHT → CONFIRM → RUN;
the confirm level comes from the preflight (`ActionImpact`), never a fixed flag.
Publish: explicit, per channel, preflight-first, dry-run default; mode from the SERVER
(getAmazonPublishMode / getEbayPublishMode); eBay currently preview-only. `AliasPublishControl`
calls POST /api/products/sheet/publish-preview. Header `Publish ▾` lists channels, sends nothing yet.
Tabs are for NON-tabular surfaces only. Mapping/formulas are GLOBAL at /channels/mapping.
Readiness: ONE server definition (services/pim/readiness.service.ts) feeds chips, bands, rows.
```

## 3. Placement vocabulary — choose a PRIMARY home and any MIRRORS, and argue for them

| code | home | use it for |
|---|---|---|
| H1 | **The cell itself** — a renderer + editor for the value's own column | a value the operator edits per row (a template ASSIGNMENT, a rich-text body, a policy id, a category) |
| H2 | **A status column** — read-only derived column with a mark + tooltip, filterable | facts the channel reports (buy-box, A+ state, suppression, sync state, drift) |
| H3 | **ROW verb** in the action registry (row menu · ⋯ · drawer actions) | one-shot operation on one listing/variant (pull, restore, dismiss, promote) |
| H4 | **SELECTION verb** (selection bar) | the same operation on N selected rows |
| H5 | **CONTEXT verb** on the alias band / family bar (`CONTEXT(alias-group)` / `(product-family)`) | operations on a whole listing alias or family (publish this alias, apply to siblings, replicate) |
| H6 | **SheetToolbar `leading`/`trailing` addition** (scope-level verb) | scope-wide operations (translate this coordinate, pull from channel, preview live listing) |
| H7 | **Record-drawer pane or section** (depth, non-modal, sheet stays live) | structured sub-editors (category tree, policies, fitment table), per-listing status detail, snapshot/version history, previews |
| H8 | **Images tab** surface | every media capability |
| H9 | **Errors & Sync console tab** (queue-shaped, grouped by cause, rows jump to the sheet/drawer) | suppressions, sync failures, drift, schema alerts across many rows |
| H10 | **Header `Publish ▾` / header ⋯ menu** | product-level publish entry and link-outs |
| H11 | **A page OUTSIDE the studio** (e.g. a theme MANAGER at /channels/…) with the studio holding only the per-listing ASSIGNMENT | account-level/config-level things (theme library, business policies, mapping) |
| H12 | **Drop** (needs the Owner's sign-off at swap) | dead or superseded capability |

Most features need TWO codes: e.g. "H1 assignment cell + H11 theme manager + H7 preview pane".
A verb must NEVER live only in the drawer (channel-ops research §3.2). A queue must NEVER be inline-only.
Everything you place must say what the sheet shows AT REST (a mark? a column? nothing?) and how it
interacts with per-cell provenance, autosave and readiness.

## 4. Your report — write it to the path in your prompt, exactly these sections

```
# NN — <feature name>
## 1. What it is (one paragraph, in operator terms; who uses it and when)
## 2. Old UI — inventory (entry points; components with file:line; interactions; what round-trips to
      the server vs what is browser-local/localStorage; what is DEAD (no importer))
## 3. Backend that exists (routes method+path with file:line; services; Prisma models/fields;
      external channel calls and their safety gates — dry-run flags, real-API env gates, publish modes;
      jobs/crons; permissions from the manifest)
## 4. Studio today (what `_studio/**` already covers, file:line; parity audit rows + status; hub rulings
      that bind this feature — cite ruling numbers)
## 5. Defects and slowness — evidence from reading (giant components, waterfalls, N+1, polling,
      localStorage-only state, duplicated logic, stale caches, mirrored types that drift, missing tests);
      cite file:line; label each item MEASURED-IN-DOC / CODE-READ / HYPOTHESIS
## 6. Proposed home in the studio
   6.1 Primary home (H-code) + mirrors, and WHY (one paragraph each)
   6.2 What the sheet shows at rest, per scope (master / channel×market): column? mark? tooltip? chip?
   6.3 The interaction, step by step (open → collect → preflight → confirm → run → what repaints);
       DS components used; keyboard; how it behaves with the drawer open
   6.4 Per-scope rules: what differs on master vs a channel scope vs an alias band; single-store
       channels (Shopify) vs market channels
   6.5 Provenance / autosave / readiness / publish integration
   6.6 A small ASCII mockup of the primary surface (≤ 25 lines)
## 7. Contracts and data (API shape reused vs new; server changes; additive schema changes only;
      which lane owns each piece: PES.2 grid substrate · PES.3 channel sheet · PES.4 drawer ·
      PES.5 backend · PES.6 mapping · PES.7 images · PES.8 AI · PES.1 frame)
## 8. Risks and traps (live listings, prod writes from local dev, publish gates, untouchables, AI dark,
      per-channel oversell, Amazon EU shared quantity, images global per ASIN …)
## 9. Open questions for the Owner (max 3, each with your recommended answer)
## 10. Effort (S / M / L per piece) and dependencies on other features/lanes
```

Be concrete: file:line for every claim about code; ruling numbers for every claim about decisions.
Prefer fewer, verified facts over many inferred ones. Aim for 150–300 lines.

## 5. What you return to the coordinator (your final message)

At most 150 words: feature · primary home (H-code) + mirrors · one-sentence rationale · the single
biggest risk · effort · the ONE open question that most needs the Owner. Nothing else — the full
report is in your file.
