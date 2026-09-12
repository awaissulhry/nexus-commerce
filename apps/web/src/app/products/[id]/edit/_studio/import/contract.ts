/**
 * IO.1 — the import diff and job wire contract, mirrored from **D15.13** (ruling #495).
 *
 * PES.5 builds the endpoint to that text; this file renders it. The two halves were agreed BEFORE
 * either was written, through the hub, which is the only reason this mirror is a mirror rather than
 * a guess — every field below traces to a numbered clause of D15.13 and says which.
 *
 * ── Why it is hand-written ──────────────────────────────────────────────────────────────────────
 * `apps/web` does not import from `apps/api`. So this is a hand mirror across an app boundary, and
 * the standing rule for those in this programme (`reference_wire_parse_boundary_rules`) applies in
 * full:
 *
 *   - input is `unknown` and is checked, never cast;
 *   - a mirror may be WIDER than its producer and must never be NARROWER — adding a field is safe,
 *     relaxing a constraint is how #397 happened;
 *   - an out-of-vocabulary enum member DEGRADES rather than throwing, because the server will grow
 *     one before this file learns about it;
 *   - and the third state is named: a value that never ARRIVED is not a value that does not EXIST
 *     (`reference_absence_is_not_an_answer`).
 *
 * ── The one rule that shapes everything here ────────────────────────────────────────────────────
 * 🔴 **Nothing in this file lets the client compute something the server already stated.** Labels
 * are the server's (D15.13.2), counts are the server's (D15.13.4), the job's verdict is the
 * server's (D15.13.5). The client composes exactly one thing — a channel row id from components
 * (D15.13.3) — and that is composed here rather than server-side on purpose (#143), because the
 * format is this lane's and has already changed once.
 *
 * PURE. No React, no `fetch`, and — deliberately — no VALUE import from `@/design-system/grid`:
 * that barrel re-exports `NexusGrid.tsx`, and a node test importing anything from it dies at parse
 * before a single test runs (`reference_node_probe_pure_modules`). Types only, which are erased.
 */

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The request
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * D15.5 — the one setting the import has, and the one the research says costs operators the most.
 *
 * `ignore` (the default) leaves a blank cell alone; `clear` writes the blank through as a null.
 * An OMITTED column is always ignored and this setting has no bearing on it — that is Shopify's
 * semantic and the safe one, and it is not configurable.
 */
export type BlankCellMode = 'ignore' | 'clear'

export const BLANK_CELL_MODES: readonly BlankCellMode[] = ['ignore', 'clear']

/** What the drawer asks for. The scope is the coordinate the sheet was on (D15.3). */
export interface ImportDiffRequest {
  productId: string
  scope: { kind: 'master' | 'channel'; channel?: string; marketplace?: string; locale?: string }
  blankCells: BlankCellMode
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The diff
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * D15.13.1 — THREE verdicts, and `would-pin` is not one of them.
 *
 * 🔴 The question that produced this ruling is worth keeping, because the tempting shape is wrong.
 * §2 prints "412 cells change · 7 refused · 3 would pin", which reads as four verdicts. Modelled
 * that way, a cell that both changes and pins has to pick one label, and whichever it picks is a
 * lie about the other half. So a pin is a FLAG on a change (`pins`), and `counts.wouldPin` is a
 * SUBSET of `counts.changed` — the summary says "412 change (3 of them pin)" rather than implying
 * 422 cells are involved.
 */
export type ImportCellVerdict = 'unchanged' | 'changed' | 'refused'

export const IMPORT_CELL_VERDICTS: readonly ImportCellVerdict[] = ['unchanged', 'changed', 'refused']

/**
 * One cell of the diff.
 *
 * D15.13.2 — `before`/`after` are RAW, `beforeLabel`/`afterLabel` are RENDERED by the server with
 * the sheet's own formatter. The grid shows the label and the tooltip carries the raw, and the
 * client NEVER re-derives a label: a second formatter on this side is a second answer to "what does
 * this cell say", and the two would drift the first time a cap or an option list moved.
 */
export interface ImportDiffCell {
  verdict: ImportCellVerdict
  /**
   * D15.13.1 — writing this cell pins it: it follows the layer above today and would stop.
   * Only ever meaningful beside `verdict: 'changed'`; a `pins` on an unchanged cell would be a
   * claim about a write that is not going to happen.
   */
  pins: boolean
  /**
   * 🔴 RAW, both of them — and there are no `beforeLabel`/`afterLabel` beside them.
   *
   * D15.13.2 first said the server would render the labels with "the sheet's own formatter". PES.5
   * then measured that **there is no such thing**: the sheet read returns raw values with
   * `optionLabels` on the COLUMN, and the client renders. So the field that was going to carry a
   * server-rendered label would have had to be produced by a formatter written for this endpoint —
   * a second implementation of the sheet's rendering, which is the drift the original clause was
   * trying to prevent. Corrected in #501 (D15.14).
   *
   * The label is therefore produced HERE, by the grid's own `label()` — injected, never
   * re-implemented (see `labelCell` in `diffModel.ts`).
   */
  before: unknown
  after: unknown
  /**
   * 🔴 REQUIRED in practice on `verdict: 'refused'`, and its absence is itself reportable.
   *
   * A refusal with no reason is the shape this whole programme exists to prevent: the operator is
   * told a value will not be written and not told why, which is indistinguishable from a bug. The
   * type cannot force it (the server owns the payload), so `readCellReason` below answers with a
   * sentence that SAYS the reason was missing rather than rendering an empty tooltip.
   */
  reason?: string | null
  /** Which file column produced this cell — the header as written, for "row 7, column X". */
  header?: string | null
  /**
   * Echoed from the read contract, never derived (§14). PES.5 already decided where this writes;
   * a client re-deriving it from the column key would be guessing at something settled.
   */
  writeField?: string | null
  writeTarget?: 'master' | 'channelListing' | null
  writeVerb?: 'master' | 'channel' | null
}

/**
 * One row of the diff.
 *
 * D15.13.3 — identity arrives as COMPONENTS and is composed on this side. `aliasResolved: false`
 * means the server could not tell which alias this row belongs to; it is rendered as unmatched with
 * that reason and is NOT guessed as `primary`. Guessing is right today (0 alias rows on prod) and
 * silently wrong the moment a second alias exists — and a diff row pointing at the wrong listing is
 * worse than a diff row that says it does not know.
 */
export interface ImportDiffRow {
  productId: string
  aliasKey: string | null
  aliasResolved: boolean
  sku: string
  name?: string | null
  /** The line in the uploaded file, so a refusal can be found in the operator's own spreadsheet. */
  line?: number | null
  cells: Record<string, ImportDiffCell>
  /** Per-row rollup, server-stated for the same reason the top-level counts are. */
  counts?: ImportCounts | null
}

/**
 * D15.13.4 — server-stated and AUTHORITATIVE. Never derived from `rows.length` or by walking cells.
 *
 * 🔴 This is #357's rule, and it was learned expensively: the sync console derived "N causes" from
 * the 200-row page it happened to hold and printed a number that was short by a whole cause, beside
 * a chip that said otherwise. A page must not report itself as a total. `reconcileCounts` in
 * `diffModel.ts` therefore CHECKS these against what arrived and reports a discrepancy as a visible
 * problem rather than silently preferring one.
 */
export interface ImportCounts {
  changed: number
  unchanged: number
  refused: number
  /** A SUBSET of `changed` (D15.13.1) — never added to it. */
  wouldPin: number
}

/** Rows and columns in the file the diff could not attach to anything, each with its reason. */
export interface ImportUnmatchedRow {
  line: number
  sku?: string | null
  reason: string
}

export interface ImportUnmatchedColumn {
  header: string
  /** The row-2 key as written, when there was one. `null` when the header pair was unreadable. */
  key?: string | null
  reason: string
}

/**
 * D15.13.4 — present ONLY if the server ever truncates. It does not today (a family diff is ≤50
 * rows × ~100 columns), so this block is unreachable — and it is here anyway, because the
 * alternative is that the day it starts truncating, the drawer reports a subset as a whole with
 * nothing on screen saying so.
 */
export interface ImportTruncation {
  rowsReturned: number
  rowsTotal: number
  note: string
}

export interface ImportDiff {
  /** What was uploaded, in the server's words — the drawer never describes the file from the File object. */
  file: { name: string; bytes?: number | null; rows?: number | null; columns?: number | null }
  scope: { kind: 'master' | 'channel'; channel?: string | null; marketplace?: string | null; locale?: string | null; label: string }
  /**
   * 🔴 The mode the SERVER applied, echoed back — not the mode the drawer asked for.
   *
   * `reference_api_accepts_a_flag_it_ignores`: an endpoint can accept a flag, log it, return it and
   * never forward it. So the summary is written from this field alone and never OR'd with local
   * intent, and `blankModeDisagreement` in `diffModel.ts` makes a mismatch LOUD — an import that
   * silently cleared cells because the server ignored `ignore` is the worst outcome this drawer has.
   */
  blankCells: BlankCellMode
  counts: ImportCounts
  /**
   * 🔴 What this diff CANNOT see, in the server's own words, rendered always (#357).
   *
   * The sync console's `coverageNote` is the precedent: an empty panel is exactly the shape that
   * reads as reassurance, so the surface states what is outside its reach rather than letting
   * silence imply "nothing else matters".
   */
  coverageNote?: string | null
  rows: ImportDiffRow[]
  unmatchedRows?: ImportUnmatchedRow[]
  unmatchedColumns?: ImportUnmatchedColumn[]
  /**
   * Columns whose KEY cell was empty — the informational columns the sheet's own export writes
   * for humans (the identity band, the readiness verdicts; design V.5). Skipped silently by the
   * server and named here by their label, so the drawer can say "2 informational columns ignored"
   * rather than either reporting them as unknown (noise on every re-import) or saying nothing.
   * Optional: a server that predates it sends none, which reads as "none", never as an error.
   */
  ignoredColumns?: string[]
  truncated?: ImportTruncation | null
  /**
   * 🔴 **The diff token IS the job** (D15.15, ruled #531).
   *
   * I raised this as a gap — with only the file and the blank-cell mode on the apply request, the
   * server must re-parse, and a re-parse is a NEW diff: anything that moved a cell in between lands
   * in it unseen. The ruling is better than the field I proposed. The dry-run PERSISTS the computed
   * diff as the `BulkOperation` itself in `QUEUED` (per cell: coordinate components, raw
   * before/after, verdict), so the job exists from the preview onward and this is its id.
   *
   * What follows from that, and why it closes the hole completely rather than narrowing it:
   *
   *   - apply is `POST …/import/jobs/:id/apply` with **no file and no mode** — the blank-cell mode
   *     is baked into the stored diff, so it cannot be swapped between preview and apply;
   *   - the server applies the STORED diff under per-cell CAS on `before`, so a cell that moved
   *     after the preview is skipped and recorded `refused` with "changed since the preview"
   *     rather than silently overwritten;
   *   - a preview nobody applies goes to `CANCELLED`.
   *
   * Optional in the type only because the endpoint has not shipped; `applyBlockedReason` refuses to
   * apply without it, so the safe direction stays the default.
   */
  jobId?: string | null
  /**
   * D15.14 — the COLUMNS contract, the half that replaced the server-rendered labels.
   *
   * This is a narrowed mirror of the sheet's own `SheetColumn`: only the members the diff needs to
   * render a value the way the sheet renders it. Narrowed, never RELAXED — every member keeps the
   * sheet's own type, so a column handed straight from the sheet read satisfies this unchanged and
   * the two cannot drift into two vocabularies for one idea.
   */
  columns?: ImportDiffColumn[]
}

/**
 * What the diff needs to know about a column to draw it.
 *
 * 🔴 `optionLabels` is the whole reason this exists. `country_of_origin` stores `PK` and shows
 * "Pakistan"; a diff that printed `PK → IT` would be describing a different write from the one the
 * sheet would show for the same cells. The map comes from the server; the rendering is the grid's
 * `label()`; this file supplies neither and only carries them together.
 */
export interface ImportDiffColumn {
  key: string
  /** The English header (D10) — row 1 of the file, and the diff grid's column title. */
  label: string
  options?: string[]
  optionLabels?: Record<string, string>
  kind?: string
  /** Echoed from the sheet contract so a read-only column can say so rather than looking writable. */
  editable?: boolean
  /**
   * 🔴 Where an edit to this column ACTUALLY lands (D15.16.4). REQUIRED in practice.
   *
   * The server has always stated this — `SheetColumn.writeTarget` in `studio-sheet.service.ts`,
   * derived there from the target LAYER rather than from the field name — and the conformed route
   * returns `columns: sheet.columns` unchanged. This lane briefly derived it instead, from a
   * six-entry copy of the API's `CHANNEL_FIELD_MAP`, which is precisely the banked wire-boundary
   * trap: **a local mirror of a server table drifts silently the day the table grows.** A seventh
   * channel field would have rendered as a master write, on the one surface whose job is to say
   * that a cell reaches a live listing.
   *
   * So the mirror is deleted and this is read instead. Optional in the TYPE only because the
   * envelope is hand-mirrored; `verifyImportDiff` refuses a column without it, so a missing value
   * is a contract violation the operator sees, never a guess.
   */
  writeTarget?: 'master' | 'channelListing'
  /** What `PATCH /api/products/bulk` expects in `changes[].field`. Echoed, never re-derived. */
  writeField?: string
  /** What to send as `changes[].target`. `master` even for the six column-backed channel fields. */
  writeVerb?: 'master' | 'channel'
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The job
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * D15.13.5 — and `partial` is the member that matters.
 *
 * 🔴 A job that finished with refusals is NOT `completed`, and the reason is `a cause is not a
 * verdict` one level up: "the run ended" and "the work was done" are different facts, and a console
 * that reports the first as the second sends an operator away believing 7 cells were written that
 * were not. PES.3 shipped that bug once (`throttled` rows reading as "it will retry without you"
 * when all 377 were dead) and it is the same shape.
 *
 * `reverted` is terminal too: the job ran and was then undone. It is not `failed` — nothing went
 * wrong — and it is not `completed` either, because the values it wrote are no longer there.
 */
export type ImportJobState =
  | 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'reverted' | 'cancelled'

/**
 * 🔴 LOWERCASE, and `completed` — the WIRE vocabulary, ruled #600.
 *
 * This set has been wrong twice in opposite directions, which is why it is written down rather than
 * remembered. D15.14 said the job record was `BulkOperation` extended, so I mirrored its UPPERCASE
 * DB enum; the live route then returned `COMPLETED`, which is in neither the ruled list (`SUCCESS`)
 * nor any shape a client had agreed to. #600 settles it: the wire carries D15.13.5's lowercase set,
 * PES.5 maps the DB enum onto it, and this mirrors the WIRE — never the storage. A DB enum is an
 * implementation detail that happened to be visible through a hole in the contract.
 *
 * The case-sensitivity in `isKnownJobState` stays and was deliberately NOT widened when the
 * mismatch appeared: it rendered a successful import as *unexplained* instead of quietly accepting
 * a state nobody had agreed, which is the only reason the divergence was noticed at all.
 */
export const IMPORT_JOB_STATES: readonly ImportJobState[] = [
  'queued', 'running', 'completed', 'partial', 'failed', 'reverted', 'cancelled',
]

/**
 * One cell's outcome. `verdict` is the SERVER's; the client does not re-judge it.
 *
 * 🔴 `changed-since-import` is D15.14's, and it is the most important member here.
 *
 * It is a REVERT outcome: the cell was written by this import, somebody edited it afterwards, and
 * the revert therefore left it alone rather than overwriting that later edit. Without its own
 * member it would be `skipped`, and "skipped" beside a successful revert reads as a formality —
 * an operator would close the drawer believing everything was put back while somebody's newer
 * value survived, or worse, believing their own newer value had just been destroyed. Two opposite
 * misreadings from the same silence, which is what earns a member of its own (ruling #16's test:
 * a state earns a name when it changes what the operator does next).
 */
export interface ImportJobOutcome {
  rowId: string
  fieldKey: string
  /**
   * THREE verdicts (#600): `written`, `unchanged`, and `refused` — the last always with a `reason`.
   *
   * 🔴 `changed-since-import` is GONE, and its removal is a simplification worth understanding.
   * D15.14 minted it so a revert could say it had deliberately left a cell alone. #600 folds that
   * into `refused` carrying the server's own sentence, which is better: this lane stops owning a
   * vocabulary for *why* a write did not happen, and a future reason needs no contract change.
   *
   * What must NOT happen in exchange is recovering the old distinction by matching the reason TEXT.
   * A sentence is prose, it will be reworded, and a client that greps it breaks silently on a
   * copy-edit. So the revert summary counts `written` against `refused` and renders each reason
   * verbatim rather than classifying it.
   */
  verdict: 'written' | 'refused' | 'unchanged'
  reason?: string | null
}

export interface ImportJob {
  jobId: string
  /**
   * 🔴 Typed as the union WIDENED by `string`, deliberately, and this is not laziness.
   *
   * A narrow union would make an unrecognised state a TYPE error at the boundary and a silent
   * `undefined` at runtime — and the runtime half is the one an operator meets. The server will add
   * a state before this file hears about it, and the requirement (D15.13.5) is that an unknown
   * state renders as *unexplained*, never as success. It cannot render as unexplained if the parse
   * has already dropped it. `jobStateNote` is the consumer that makes the widening safe, exactly as
   * `gateNote`'s `default:` branch is what let `PublishMode` be opened.
   */
  state: ImportJobState | (string & {})
  processed: number
  total: number
  /**
   * WHICH phase the state describes — ruled #614/#617, landing as PES.5's item 7.
   *
   * 🔴 It exists because `partial` can now happen TWICE for different reasons: partial on apply
   * (some cells refused by validation), then partial again on revert (some cells refused because
   * they were edited since). The state alone cannot tell those apart, and they call for opposite
   * actions — one says your file was not fully written, the other says your record was not fully
   * put back. So the panel reads the PAIR, never the state alone.
   */
  phase?: 'apply' | 'revert'
  outcomes?: ImportJobOutcome[]
  /**
   * D15.14 — the job record is `BulkOperation` extended, and `expiresAt` is its revertible-until.
   *
   * Named as the server names it rather than as this drawer would like it named. A local rename
   * (`revertibleUntil`, which is what this field was called for an hour) makes the mirror read
   * nicely and makes every future comparison against the server's own record a translation step —
   * and a translation step is where a field quietly stops being read at all.
   *
   * Absent = no stated window, which is NOT the same as an open one. `revertBlockedReason` keeps
   * those apart.
   */
  expiresAt?: string | null
  /** The server's own sentence about this job, when it has one. Rendered verbatim, never paraphrased. */
  note?: string | null
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Reading the wire
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Is this response the shape above?
 *
 * Returns the problems rather than throwing, so the drawer can decide whether to render or shout —
 * the same contract `verifyContract` in the sheet's `types.ts` has, for the same reason: a drift
 * across a hand-mirrored boundary must be a loud message, never a blank grid that reads as "no
 * changes". A blank diff and a broken diff look identical, and one of them means "apply is safe".
 */
export function verifyImportDiff(body: unknown): string[] {
  const problems: string[] = []
  if (!isObject(body)) return ['response is not an object']
  if (!isObject(body.file)) problems.push('file{} missing — the drawer cannot name what was uploaded')
  if (!isObject(body.scope)) problems.push('scope{} missing')
  if (!Array.isArray(body.rows)) problems.push('rows[] missing')
  if (!isObject(body.counts)) {
    // 🔴 The single most important field. Without it every number on screen would have to be
    // derived from the rows in hand, which is precisely what D15.13.4 forbids.
    problems.push('counts{} missing — every number on screen would be the page reporting itself as a total')
  } else {
    for (const k of ['changed', 'unchanged', 'refused', 'wouldPin']) {
      if (typeof body.counts[k] !== 'number') problems.push(`counts.${k} is not a number`)
    }
  }
  /*
   * 🔴 Every column must state where it writes (D15.16.4).
   *
   * Without it the diff cannot tell a master column from one that reaches a LIVE listing, and the
   * only alternative — deriving from the field-name prefix — is the mirror that was deleted for
   * drifting silently. A missing `writeTarget` is therefore a contract violation the operator is
   * shown, and `applyBlockedReason` refuses through it. Never a guess on this question.
   */
  if (Array.isArray(body.columns)) {
    const missing = (body.columns as Array<Record<string, unknown>>)
      .filter((c) => c && c.writeTarget !== 'master' && c.writeTarget !== 'channelListing')
      .map((c) => String(c?.key ?? '?'))
    if (missing.length > 0) {
      problems.push(
        `${missing.length} column(s) do not state where they write (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}) — the diff cannot tell a master column from one that writes a live listing.`,
      )
    }
  }
  if (typeof body.blankCells !== 'string' || !BLANK_CELL_MODES.includes(body.blankCells as BlankCellMode)) {
    // Not a soft failure: the summary sentence is written from this, and a missing echo means the
    // drawer cannot say which blank-cell rule the server actually applied.
    problems.push(`blankCells is not one of ${BLANK_CELL_MODES.join(' | ')} — the server did not echo the mode it applied`)
  }
  return problems
}

/**
 * Read a cell's verdict, degrading an unknown one rather than dropping it.
 *
 * 🔴 An out-of-vocabulary verdict must NOT fall through to `unchanged`. That is the quiet default,
 * and the quiet default is the one that tells an operator "nothing will happen here" about a cell
 * nobody understands — `gateNote`'s lesson, where a shared `default:` branch said an unrecognised
 * publish mode was `live`. It reads as `refused` instead: the safe direction is a cell that will
 * not be written and says so, and `readCellReason` explains that it was the VERDICT that was not
 * understood, not the value.
 */
export function readCellVerdict(cell: Pick<ImportDiffCell, 'verdict'> | null | undefined): ImportCellVerdict {
  const raw = cell?.verdict
  return typeof raw === 'string' && (IMPORT_CELL_VERDICTS as readonly string[]).includes(raw)
    ? (raw as ImportCellVerdict)
    : 'refused'
}

/** True when the server sent a verdict this build does not know — the drawer says so out loud. */
export function isUnknownVerdict(cell: Pick<ImportDiffCell, 'verdict'> | null | undefined): boolean {
  const raw = cell?.verdict
  return typeof raw !== 'string' || !(IMPORT_CELL_VERDICTS as readonly string[]).includes(raw)
}

/**
 * The sentence a cell carries when it will not be written.
 *
 * Three different silences, three different sentences — `reference_absence_is_not_an_answer`. "The
 * server refused it and said why", "the server refused it and said nothing", and "the server sent a
 * verdict this build cannot read" are not the same fact, and collapsing them into one empty tooltip
 * is how a contract drift gets mistaken for a validation rule.
 */
export function readCellReason(cell: ImportDiffCell | null | undefined): string {
  if (!cell) return 'This cell is not in the diff.'
  if (isUnknownVerdict(cell)) {
    return `The server sent a verdict this build does not recognise (${String(cell.verdict)}), so nothing here can say what would happen to this cell. It is shown as refused and will not be applied — that is this build being cautious, not the server refusing the value.`
  }
  const reason = typeof cell.reason === 'string' ? cell.reason.trim() : ''
  if (reason) return reason
  return 'Refused, and the server gave no reason. That is a gap in the response, not a rule you can act on — report it rather than editing the value.'
}
