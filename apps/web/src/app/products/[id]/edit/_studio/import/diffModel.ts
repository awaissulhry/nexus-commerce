/**
 * IO.1 — everything the import drawer DECIDES, with no React and no DOM.
 *
 * The drawer's honesty lives here rather than in the components, for the reason PES.3's
 * `syncQueue.ts` gives: the failure this guards is not a crash, it is a surface that says "412 cells
 * will change" when the truth is 415, or "completed" about a job that refused seven rows. Both look
 * tidy and both send the operator the wrong way — so both are decided in a file a test can reach.
 *
 * PURE: type-only imports, nothing from `@/design-system/grid` at runtime, no `.tsx` anywhere on the
 * import path (`reference_node_probe_pure_modules`). Tested beside this file.
 */
import {
  isUnknownVerdict,
  readCellReason,
  readCellVerdict,
  type BlankCellMode,
  type ImportCounts,
  type ImportDiff,
  type ImportDiffCell,
  type ImportDiffColumn,
  type ImportDiffRow,
  type ImportJob,
  type ImportJobOutcome,
  type ImportJobState,
} from './contract'
import { optionLabel } from '../sheet/optionLabel'

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Rendering a value (D15.14)
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The pair of strings a diff cell shows.
 *
 * 🔴 **`optionLabel` is IMPORTED from the sheet, never re-derived here** (#501/#506).
 *
 * D15.13.2 originally had the server render the labels; PES.5 measured that no server-side sheet
 * formatter exists — the sheet returns raw values plus `optionLabels` on the column and the client
 * renders — so the labels are the grid's own. PES.2 hoisted that function out of the closure at
 * `columns.tsx:237` into `_studio/sheet/optionLabel.ts` for exactly this consumer.
 *
 * A copy would have typechecked, passed every test, and looked identical for `country_of_origin`
 * today — and been a second answer to "what does this cell say" the first time an option list moved.
 * `reference_ds_option_list_two_copies` is that defect one floor down; the import is the fix.
 *
 * Both ends go through it, deliberately: labelling only the `after` renders `PK → Italy`, which
 * describes a change from a code to a name rather than the change that is actually happening. A
 * diff has to be comparable on its face.
 */
export function labelCell(
  cell: Pick<ImportDiffCell, 'before' | 'after'>,
  column: ImportDiffColumn | undefined,
): { before: string; after: string } {
  return {
    before: optionLabel(cell.before, column?.optionLabels),
    after: optionLabel(cell.after, column?.optionLabels),
  }
}

/**
 * A blank rendered so it cannot be mistaken for a value.
 *
 * An empty string in a diff cell is ambiguous between "this field is empty" and "the label came
 * back empty", and under `blankCells: 'clear'` the difference is a value about to be destroyed.
 * The sheet's own `EmptyValue` renders the em-dash for exactly this; the diff grid uses that
 * renderer, and this is the text form for a tooltip.
 */
export function blankOr(text: string): string {
  return text === '' ? '(empty)' : text
}

/**
 * The full sentence a diff cell carries, for the tooltip (#562).
 *
 * 🔴 Pure and shared, because the cell is now FIXED-HEIGHT and the tooltip is the only place the
 * untruncated before/after exists. `autoHeight` on the column was inert — `RowAutoHeightModule` is
 * not registered, and an unregistered module fails SILENTLY, so the column had been asking for a
 * behaviour it never got and the long values were simply clipped with nothing to reveal them.
 * Ruled (#562): the diff is a review surface with fixed rows like the sheet, and the tooltip carries
 * the full text.
 *
 * It lives here rather than in the renderer so the RENDERER and the COLUMN's `tooltipValueGetter`
 * cannot describe the same cell two ways — the drift that `optionLabel` had to be hoisted to
 * prevent one floor down.
 */
export function diffCellTooltip(cell: ImportDiffCell, column: ImportDiffColumn | undefined): string {
  const verdict = readCellVerdict(cell)
  const { before, after } = labelCell(cell, column)
  if (verdict === 'unchanged') return blankOr(before)
  const pair = `${blankOr(before)} → ${blankOr(after)}`
  if (verdict === 'refused') return `${pair}\n\nREFUSED. ${readCellReason(cell)}`
  if (cell.pins) {
    return `${pair}\n\nThis cell follows the layer above today. Writing it pins it to this row, and it will stop tracking the master until reset.`
  }
  return pair
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Row identity (D15.13.3)
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The sheet row id for a diff row, or **null** when it cannot be known.
 *
 * The composition lives HERE, on the client, which is the whole reason PES.5 returns components
 * (#143): the format `${aliasKey || 'primary'}:${productId}` is this lane's and has already changed
 * once. A server that composed it would emit ids resolving to nothing the next time it changes, and
 * the symptom — a diff row that highlights nothing in the sheet — reads as a UI bug forever.
 *
 * 🔴 `aliasResolved: false` returns null rather than guessing `primary`. Copied deliberately from
 * `jumpTargetOf` in `syncQueue.ts`, including its reasoning: guessing is right today (prod holds
 * **0** `ProductListingAlias` rows) and silently wrong the moment a second alias exists — and a
 * diff row aimed at the wrong listing is worse than one that says it does not know, because the
 * operator believes it.
 */
export function composeRowId(row: Pick<ImportDiffRow, 'productId' | 'aliasKey' | 'aliasResolved'>): string | null {
  if (!row.aliasResolved || !row.productId) return null
  return `${row.aliasKey ? row.aliasKey : 'primary'}:${row.productId}`
}

/** A row the drawer cannot place, and the sentence saying why. `null` when the row is fine. */
export function rowUnmatchedReason(row: ImportDiffRow): string | null {
  if (!row.productId) return 'The server matched no product to this line.'
  if (!row.aliasResolved) {
    return 'The server could not say which listing alias this line belongs to. It is not applied — a write aimed at the wrong alias cannot be undone by looking at it.'
  }
  return null
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Where a cell WRITES (#577)
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Where one cell's write actually lands — **read from the COLUMN, never derived** (D15.16.4).
 *
 * 🔴 This function used to fall back to a six-entry copy of the API's `CHANNEL_FIELD_MAP` and mark
 * the answer `stated: false`. That mirror is DELETED, and the deletion is the point: a local copy
 * of a server table drifts silently the day the table grows, and a seventh channel field would have
 * rendered as a master write on the one surface whose whole job is to say a cell reaches a LIVE
 * listing. Being honest that an answer was derived does not make a silently-stale answer safe.
 *
 * The server has always stated this on `SheetColumn.writeTarget`, where it is derived from the
 * target LAYER rather than the field name — so it is right for cases a prefix rule cannot see, such
 * as a channel cell that inherits from master but writes to the channel. `verifyImportDiff` refuses
 * a column that omits it, so there is no third branch here to guess with.
 */
export interface CellDestination {
  target: 'master' | 'channelListing'
  /** `AMAZON` / `EBAY` when the write lands on a listing; null when it lands on the master. */
  channel: string | null
  /** What the diff renders — "writes the master record", "writes the Amazon listing". */
  label: string
}

const channelLabel = (channel: string | null): string =>
  channel === 'AMAZON' ? 'Amazon' : channel === 'EBAY' ? 'eBay' : 'channel'

/**
 * The column says where it writes; a per-cell echo wins only when the server sent one, since a
 * single cell may legitimately differ from its column (an alias row, a linked field).
 */
export function cellDestination(
  column: Pick<ImportDiffColumn, 'writeTarget'> | null | undefined,
  cell?: Pick<ImportDiffCell, 'writeTarget'> | null,
  cellScope?: { kind?: string; channel?: string | null } | null,
): CellDestination {
  const target = cell?.writeTarget ?? column?.writeTarget ?? 'master'
  if (target === 'channelListing') {
    const channel = cellScope?.channel ?? null
    return { target, channel, label: `writes the ${channelLabel(channel)} listing` }
  }
  return { target: 'master', channel: null, label: 'writes the master record' }
}

/**
 * 🔴 The warning above a MASTER-scope diff that would nevertheless write a channel listing (#577).
 *
 * Not a per-cell mark alone: a mark can be scrolled past, and this is the difference between
 * editing a spreadsheet and editing a live marketplace listing. Returns null when there is nothing
 * to say, so the warning cannot become wallpaper.
 */
export function listingWriteWarning(diff: ImportDiff): string | null {
  if (diff.scope?.kind !== 'master') return null
  const byKey = new Map((diff.columns ?? []).map((c) => [c.key, c]))
  const channels = new Set<string>()
  let cells = 0
  for (const row of diff.rows ?? []) {
    for (const [key, cell] of Object.entries(row.cells ?? {})) {
      if (readCellVerdict(cell) !== 'changed') continue
      const dest = cellDestination(byKey.get(key), cell, undefined)
      if (dest.target === 'channelListing') {
        cells++
        // The scope has no channel (it is master), so name the channel from the column key only for
        // the WARNING's wording. The routing decision itself never touches the key.
        channels.add(key.startsWith('ebay_') ? 'eBay' : key.startsWith('amazon_') ? 'Amazon' : 'channel')
      }
    }
  }
  if (cells === 0) return null
  const where = [...channels].sort().join(' and ')
  return `${cells} ${cells === 1 ? 'cell in this file writes' : 'cells in this file write'} to the ${where} ${channels.size === 1 ? 'listing' : 'listings'}, not to the master record — these columns route by their name whatever scope you exported from. If those listings are live, applying this changes what buyers see.`
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Counts (D15.13.4)
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The counts the ROWS in hand actually contain.
 *
 * 🔴 Not for display. This exists ONLY to be compared against the server's, by `reconcileCounts`.
 * Rendering it would be the exact defect #357 names — a page reporting itself as a total — and the
 * name says so, so a future caller reaching for it has to read this sentence first.
 */
export function countsInRows(rows: readonly ImportDiffRow[]): ImportCounts {
  const c: ImportCounts = { changed: 0, unchanged: 0, refused: 0, wouldPin: 0 }
  for (const row of rows) {
    for (const cell of Object.values(row.cells ?? {})) {
      const verdict = readCellVerdict(cell)
      if (verdict === 'changed') {
        c.changed++
        if (cell.pins) c.wouldPin++
      } else if (verdict === 'refused') c.refused++
      else c.unchanged++
    }
  }
  return c
}

/**
 * Every cell carrying a verdict this build does not know, located well enough to be reported.
 *
 * Its own function because it is needed twice: once to tell the operator (an unknown verdict is a
 * contract drift and they must not apply through one), and once to SUSPEND the count comparison
 * below — see `reconcileCounts`.
 */
export function unknownVerdictCells(rows: readonly ImportDiffRow[]): Array<{ sku: string; key: string; raw: string }> {
  const found: Array<{ sku: string; key: string; raw: string }> = []
  for (const row of rows) {
    for (const [key, cell] of Object.entries(row.cells ?? {})) {
      if (isUnknownVerdict(cell)) found.push({ sku: row.sku, key, raw: String(cell.verdict) })
    }
  }
  return found
}

/**
 * Do the server's numbers and the delivered rows agree, and is the server's own arithmetic coherent?
 *
 * Returns a list of problems, empty when everything lines up. The drawer renders them; it does NOT
 * silently prefer one source. The server's counts stay authoritative for what is DISPLAYED
 * (D15.13.4) — but "authoritative" is not "unquestionable", and a diff whose header says 412 while
 * its rows hold 8 is a response nobody should apply.
 *
 * 🔴 TWO cases where a mismatch is EXPECTED, and both are checked before the arithmetic, because a
 * false positive here is worse than a false negative (`reference_scanner_false_positive_worse`):
 * this block only works if it fires rarely, and one cry-wolf teaches an operator to scroll past it.
 *
 *   1. **A truncated response.** The server said it sent a subset; of course the subset does not
 *      add up to the whole.
 *   2. **An unknown verdict.** This one is subtler and it is the reason this function was rewritten.
 *      `readCellVerdict` degrades an unrecognised verdict to `refused` — deliberately, it is the
 *      safe direction — so the client's tally counts that cell as refused while the server counted
 *      it as whatever it actually meant. The two then disagree BY CONSTRUCTION, and reporting that
 *      as "the response is incoherent" would be this build blaming the server for the client's own
 *      degradation. The unknown verdict is reported instead, which is the true finding and the more
 *      actionable one.
 */
export function reconcileCounts(diff: ImportDiff): string[] {
  const problems: string[] = []
  const stated = diff.counts

  if (stated.wouldPin > stated.changed) {
    // D15.13.1 makes wouldPin a SUBSET of changed. If it is not, one of the two numbers is wrong
    // and the summary sentence built from them would be nonsense in a way that reads as precise.
    problems.push(
      `The server reports ${stated.wouldPin} cells that would pin but only ${stated.changed} that change, and a pin is a kind of change (D15.13.1). One of the two numbers is wrong.`,
    )
  }

  const unknown = unknownVerdictCells(diff.rows ?? [])
  if (unknown.length > 0) {
    const first = unknown[0]
    problems.push(
      `${unknown.length === 1 ? 'One cell carries' : `${n(unknown.length)} cells carry`} a verdict this build does not recognise (${first.sku} · ${first.key} · “${first.raw}”). ${unknown.length === 1 ? 'It is' : 'They are'} shown as refused and will not be applied, and the counts above cannot be checked against the rows while ${unknown.length === 1 ? 'it is' : 'they are'} present.`,
    )
  }

  if (diff.truncated || unknown.length > 0) return problems

  const actual = countsInRows(diff.rows ?? [])
  const disagree: string[] = []
  if (actual.changed !== stated.changed) disagree.push(`changed: header says ${stated.changed}, rows hold ${actual.changed}`)
  if (actual.refused !== stated.refused) disagree.push(`refused: header says ${stated.refused}, rows hold ${actual.refused}`)
  if (actual.wouldPin !== stated.wouldPin) disagree.push(`would pin: header says ${stated.wouldPin}, rows hold ${actual.wouldPin}`)
  if (disagree.length > 0) {
    problems.push(
      `The summary and the rows below disagree (${disagree.join('; ')}). The response did not declare itself truncated, so one of the two is wrong and neither can be trusted for an apply.`,
    )
  }
  return problems
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The summary sentence (D15.13.1, D15.5)
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

const n = (v: number) => v.toLocaleString('en-GB')

/** What the blank-cell mode means, in words, for the summary line (D15.5). */
export function blankModeSentence(mode: BlankCellMode): string {
  return mode === 'clear'
    ? 'Blank cells in the file CLEAR the value.'
    : 'Blank cells in the file are ignored.'
}

/**
 * The one-line verdict above the diff.
 *
 * Reads "412 change (3 of them pin) · 7 refused" — D15.13.1's wording, so the pin count is visibly
 * a subset rather than a third addend. `summarise` in `syncQueue.ts` is the model: say the SHAPE,
 * not just the size.
 *
 * 🔴 The zero-change case gets its own sentence rather than an empty grid. D15.1's acceptance test
 * IS this state ("export a view, re-import it unmodified, zero changes"), and a blank surface
 * cannot tell "the round trip is clean" from "the parse produced nothing" — one of which means the
 * feature works and the other that it is broken.
 */
export function summariseDiff(diff: ImportDiff): string {
  const c = diff.counts
  if (c.changed === 0 && c.refused === 0) {
    return `Nothing in this file changes anything. ${n(c.unchanged)} ${c.unchanged === 1 ? 'cell matches' : 'cells match'} the sheet's current values.`
  }
  const parts: string[] = []
  if (c.changed > 0) {
    parts.push(
      c.wouldPin > 0
        ? `${n(c.changed)} ${c.changed === 1 ? 'cell changes' : 'cells change'} (${n(c.wouldPin)} of them ${c.wouldPin === 1 ? 'pins' : 'pin'})`
        : `${n(c.changed)} ${c.changed === 1 ? 'cell changes' : 'cells change'}`,
    )
  }
  if (c.refused > 0) parts.push(`${n(c.refused)} refused`)
  if (c.unchanged > 0) parts.push(`${n(c.unchanged)} unchanged`)
  return parts.join(' · ')
}

/**
 * What "would pin" actually costs the operator, said once, above the grid.
 *
 * Not a tooltip: a pin is the change with the longest tail — the cell stops following its layer and
 * stays stopped until someone resets it — and it is the one an operator is least likely to have
 * intended when they edited a spreadsheet.
 */
export function pinSentence(count: number): string | null {
  if (count <= 0) return null
  return `${n(count)} ${count === 1 ? 'cell follows' : 'cells follow'} the layer above today. Writing ${count === 1 ? 'it' : 'them'} pins ${count === 1 ? 'it' : 'them'} to this row, and ${count === 1 ? 'it' : 'they'} will stop tracking the master until reset.`
}

/**
 * 🔴 The mode the SERVER applied against the mode the drawer asked for.
 *
 * `reference_api_accepts_a_flag_it_ignores`: an endpoint can accept a flag, log it, return it in an
 * envelope and never forward it to the code that acts. So this compares the request to the ECHO and
 * shouts when they differ, rather than the drawer printing its own intent as if it were the outcome.
 *
 * The asymmetry is deliberate. `asked: ignore, applied: clear` is the dangerous direction — cells
 * the operator expected to be left alone are about to be emptied — and it says so in those words.
 * The reverse is safe but still wrong, and is still reported, because an endpoint that ignores this
 * flag in one direction ignores it in both and the next operator may not be so lucky.
 */
export function blankModeDisagreement(asked: BlankCellMode, applied: BlankCellMode): string | null {
  if (asked === applied) return null
  if (asked === 'ignore' && applied === 'clear') {
    return `You chose "ignore blank cells" and the server applied "clear". Every blank cell in this file is about to empty the value it sits on. Do not apply this diff — the setting did not reach the code that acts on it.`
  }
  return `You chose "${asked}" for blank cells and the server applied "${applied}". The diff below describes what the SERVER would do, not what you asked for. The setting is not reaching the parser.`
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Which rows and columns the diff grid shows (D15.4)
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/** D15.4 — "the first 20 changed rows expanded, the rest on demand". */
export const EXPANDED_ROW_LIMIT = 20

/** Does this row have anything the operator needs to look at? */
export function rowHasVerdict(row: ImportDiffRow): boolean {
  return Object.values(row.cells ?? {}).some((c) => readCellVerdict(c) !== 'unchanged')
}

/**
 * The rows worth rendering, most urgent first.
 *
 * Refusals lead. A refused cell is the only kind the operator MUST act on before applying — a
 * change they can accept by reading the count, a refusal they cannot — so sorting by "most refused"
 * puts the work at the top instead of wherever the file happened to put it. Ties fall back to the
 * file's own line order, so the diff can still be read alongside the spreadsheet it came from.
 */
export function orderedDiffRows(rows: readonly ImportDiffRow[]): ImportDiffRow[] {
  return rows
    .filter(rowHasVerdict)
    .map((row) => {
      let refused = 0
      let changed = 0
      for (const cell of Object.values(row.cells ?? {})) {
        const v = readCellVerdict(cell)
        if (v === 'refused') refused++
        else if (v === 'changed') changed++
      }
      return { row, refused, changed }
    })
    .sort((a, b) => b.refused - a.refused || b.changed - a.changed || (a.row.line ?? 0) - (b.row.line ?? 0))
    .map((e) => e.row)
}

/**
 * The columns the diff grid shows, and how many it hid.
 *
 * A file carries ~100 columns and typically three of them change. Rendering all 100 spends the
 * width §9.1 fights for on columns of identical values — so a column with nothing but `unchanged`
 * cells is dropped, and the COUNT of dropped columns is returned so the drawer can say so. Hiding
 * something silently is the habit this programme keeps paying for; hiding it and saying "and 94
 * columns matched throughout" is information.
 *
 * Cells inside a kept column stay visible whatever their verdict, including unchanged ones: within
 * a column that changes somewhere, "this row did not change" is a fact the operator needs.
 */
export function visibleColumnKeys(rows: readonly ImportDiffRow[]): { keys: string[]; hidden: number } {
  const all = new Set<string>()
  const interesting = new Set<string>()
  for (const row of rows) {
    for (const [key, cell] of Object.entries(row.cells ?? {})) {
      all.add(key)
      if (readCellVerdict(cell) !== 'unchanged') interesting.add(key)
    }
  }
  // First-seen order, not alphabetical: the file's column order is the operator's own, and
  // re-sorting it means the diff no longer reads left-to-right like the spreadsheet it came from.
  const keys: string[] = []
  for (const row of rows) for (const key of Object.keys(row.cells ?? {})) if (interesting.has(key) && !keys.includes(key)) keys.push(key)
  return { keys, hidden: all.size - interesting.size }
}

/** The sentence for the columns that were dropped. `null` when none were. */
export function hiddenColumnSentence(hidden: number): string | null {
  if (hidden <= 0) return null
  return `${n(hidden)} ${hidden === 1 ? 'column matched' : 'columns matched'} the sheet in every row and ${hidden === 1 ? 'is' : 'are'} not shown.`
}

/** The sentence for the rows held back by `EXPANDED_ROW_LIMIT`. `null` when all are shown. */
export function collapsedRowSentence(shown: number, total: number): string | null {
  if (total <= shown) return null
  return `Showing the first ${n(shown)} of ${n(total)} rows with changes.`
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * Can this diff be applied at all?
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Why Apply is not offered, or `null` when it is.
 *
 * 🔴 This returns a REASON, never a boolean. A disabled control cannot explain itself
 * (`reference_disabled_control_cannot_explain`), and "Apply" greyed out with no sentence is the
 * single most frustrating state this drawer could have — the operator has a file, a diff, and no
 * way to learn what is wrong with it.
 *
 * Note what is NOT here: refusals do not block an apply. D15.6 is explicit that a partial file is
 * applied and the refused rows are listed with reasons — refusing the whole file because one cell
 * is over a cap would make the feature useless on real data. The refusals are counted in the
 * button's own label instead, so the operator applies a number they have seen.
 */
export function applyBlockedReason(
  diff: ImportDiff,
  askedBlankMode: BlankCellMode,
  contractProblems: readonly string[],
): string | null {
  const fixture = fixtureBlockedReason(diff)
  if (fixture) return fixture
  if (contractProblems.length > 0) {
    return 'This response does not match the agreed contract, so nothing on screen can be trusted to describe what an apply would do.'
  }
  const disagreement = blankModeDisagreement(askedBlankMode, diff.blankCells)
  if (disagreement) return disagreement
  const reconciliation = reconcileCounts(diff)
  if (reconciliation.length > 0) return reconciliation[0]
  if (diff.counts.changed === 0) {
    return 'Nothing in this file changes anything, so there is nothing to apply.'
  }
  if (!diff.jobId) {
    /*
     * 🔴 No job, no apply (D15.15).
     *
     * The dry-run persists the diff as the job, so a preview WITHOUT a job id is a preview the
     * server did not store — and applying it could only ask the server to read the file again. A
     * re-parse is a different diff: anything that moved a cell in between (another lane's write, a
     * sync job, a formula) lands in it unseen. D15.4's promise is not that the operator saw A diff,
     * it is that nothing writes but the one they saw, and that promise cannot survive a re-parse.
     */
    return 'This preview was not stored by the server, so there is no saved diff to apply — applying would mean reading the file again, and anything that changed in between would be written without you having seen it. Upload the file again.'
  }
  return null
}

/**
 * The drawer is showing built-in fixture data, so Apply is not offered.
 *
 * 🔴 Structural, not a promise. The hub ordered this lane built dark (#492), and a surface wired to
 * a fixture looks exactly like one wired to a server — that resemblance is the risk, and "we will
 * remember to turn it off" is not a control. The flag rides on the payload, this reads it, and
 * `applyBlockedReason` refuses through it, so the dark build cannot write even if every other guard
 * were removed. Deleting `fixture.ts` and its one import site is the whole migration.
 *
 * Takes `unknown` because `isFixture` is deliberately NOT on `ImportDiff` — it is not part of the
 * contract PES.5 builds to, and putting it there would invite a server to send it.
 */
export function fixtureBlockedReason(diff: unknown): string | null {
  const flagged = (diff as { isFixture?: unknown } | null)?.isFixture === true
  if (!flagged) return null
  return 'This is built-in fixture data, not your file. PES.5’s import endpoint has not shipped, so there is nothing here to apply.'
}

/**
 * The one sentence a drawer that cannot write shows, from the moment it opens (#535).
 *
 * TWO independent sources, and both are kept on purpose:
 *
 *   - the TRANSPORT says it at rest, before any file is chosen — that is the ruling, and it is what
 *     stops an operator uploading a real file only to learn afterwards that nothing could apply;
 *   - the PAYLOAD says it too, because a live transport that somehow returned fixture-flagged data
 *     is a state nobody has designed for, and it must still shout rather than render as real.
 *
 * The transport's note wins when both are present: it is the more general fact ("this drawer cannot
 * write at all") and it is already on screen, so replacing it with the payload's narrower wording
 * mid-session would make the banner appear to change meaning when only the step changed.
 */
export function darkNoteFor(transportNote: string | null | undefined, diff: unknown): string | null {
  if (transportNote) return transportNote
  return fixtureBlockedReason(diff)
}

/** The Apply button's own label — the number the operator is agreeing to, not a bare verb. */
export function applyLabel(counts: ImportCounts): string {
  return `Apply ${n(counts.changed)} ${counts.changed === 1 ? 'change' : 'changes'}`
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The job (D15.13.5)
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * 🔴 FLIPPED with PES.5's item 7 (`import-jobs.service.ts` 08:39:01, `product-studio.routes.ts`
 * 08:40:34) — producer and consumer together, as ruled.
 *
 * Before that landing, `partial` unambiguously meant apply-partial (the service set it only on the
 * apply path, revert always returned `reverted`) and rendering an absent `phase` as *unexplained*
 * would have replaced an honest sentence with a shrug — a regression dressed as strictness. After
 * it, `partial` can mean either phase, so absence is genuinely ambiguous and unexplained is the
 * only honest answer.
 *
 * Both worlds were verified against the LIVE route before this flip, with a real partial of each
 * phase rather than a fixture: an apply-partial (`status` off its closed list, refused; the
 * `manufacturer` beside it written) returned `state: 'partial', phase: 'apply'`, and a
 * revert-partial (one cell edited by another writer between apply and revert) returned
 * `state: 'partial', phase: 'revert'` with one `written` and one `refused — changed since import`.
 * The POLL carries `phase` on both, which matters because a panel that polls rather than holding
 * the apply response would otherwise show "partial" with nothing to say partial at.
 */
export const PHASE_REQUIRED = true

const KNOWN_JOB_STATES = new Set<string>(['queued', 'running', 'completed', 'partial', 'failed', 'reverted', 'cancelled'])

/**
 * 🔴 Case-SENSITIVE, deliberately, and this is not pedantry.
 *
 * The wire set is lower case (#600). Accepting `'COMPLETED'` too would mean this build cannot tell
 * a contract it understands from one it has half-guessed — and the cost is asymmetric: an
 * unrecognised state renders *unexplained* (safe, someone investigates) while a leniently-matched
 * one renders as success (unsafe, nobody does).
 *
 * 🔴 This was tested in production rather than argued. The live route returned `COMPLETED` against a
 * mirror expecting `SUCCESS`; strictness turned a silent mismatch into a visible one and got the
 * vocabulary fixed at the source. Had it matched case-insensitively, the drawer would have shown a
 * confident success and the two contracts would still disagree.
 */
export function isKnownJobState(state: string): state is ImportJobState {
  return KNOWN_JOB_STATES.has(state)
}

/** A job that will not change again on its own. `queued`/`running` are the only live ones. */
export function jobIsSettled(state: string): boolean {
  return isKnownJobState(state) && state !== 'queued' && state !== 'running'
}

/**
 * What a job's state MEANS, in a sentence, for the operator.
 *
 * 🔴 The `default:` branch is the point of this function, exactly as it is in `gateNote`.
 *
 * An unrecognised state is where the operator most needs telling, and staying quiet — or worse,
 * falling through to the success wording — reads as "the import worked". PES.3 shipped that shape
 * once: a shared `default` that reported an unknown publish mode as `live`. The server will add a
 * state before this build hears about it, and on that day this must say so rather than smile.
 *
 * `partial` is the state D15.13.5 exists for: finished, and NOT done.
 */
export function jobStateNote(job: Pick<ImportJob, 'state' | 'processed' | 'total' | 'phase'>): string {
  const state = String(job.state)
  switch (state) {
    case 'queued':
      /*
       * D15.15: a `QUEUED` job is the STORED PREVIEW — the diff exists on the server and has not
       * been applied. So "queued" here does not mean "about to run on its own"; it means "waiting
       * for you". Saying "queued" alone would let an operator close the drawer believing the import
       * would proceed without them.
       */
      return 'This preview is saved and waiting for you. Nothing has been written, and nothing will be until you apply it.'
    case 'cancelled':
      return 'This preview was never applied and has been cancelled. Nothing was written. The file is unchanged on your side — upload it again if you still want these changes.'
    case 'running':
      return `Writing — ${n(job.processed)} of ${n(job.total)} cells so far. Values already written are live; closing this drawer does not stop the job.`
    case 'completed':
      /*
       * 🔴 `processed`, not `total`, and CELLS, not rows — both halves were wrong and the live
       * acceptance run caught it.
       *
       * A one-row file changing one column reported `processed: 1, total: 2` (the SKU column is a
       * cell too, and it matched), and this sentence read "Done. All 2 rows were written." Two
       * errors compounding into one confident, wrong number: the unit was cells, and one of those
       * cells was not written because it did not need to be. Exactly the shape this lane exists to
       * prevent — a count that reads precise and is false — and it survived 95 tests because every
       * fixture had `processed === total`.
       *
       * `completed` means no refusals, so the remainder is the unchanged cells, and saying so is
       * more useful than hiding it: it tells an operator their file largely matched.
       */
      if (job.processed === job.total) {
        return `Done. All ${n(job.total)} ${job.total === 1 ? 'cell was' : 'cells were'} written.`
      }
      return `Done. ${n(job.processed)} ${job.processed === 1 ? 'cell was' : 'cells were'} written; the other ${n(job.total - job.processed)} already matched the sheet.`
    case 'partial':
      /*
       * The sentence D15.13.5 was ruled for — it must never be mistaken for `completed` — and since
       * #614 it must also say partial AT WHAT. `partial` on apply and `partial` on revert are
       * different facts demanding different actions.
       */
      if (job.phase === 'apply') {
        return `Apply partial — ${n(job.processed)} of ${n(job.total)} cells were written and the rest were not. The refused cells are listed below with the reason each was refused. This is not a completed import.`
      }
      if (job.phase === 'revert') {
        return `Revert partial — ${n(job.processed)} of ${n(job.total)} cells were restored and the rest were not. Those cells still hold what the import wrote, or what someone changed them to since. The reasons are listed below.`
      }
      return PHASE_REQUIRED
        ? `The server reports a partial import but does not say partial at WHAT — whether your file was only partly written, or a revert only partly put it back. Those need opposite responses, so nothing here can tell you which happened. Check the import record.`
        : `Finished with refusals — ${n(job.processed)} of ${n(job.total)} cells were written and the rest were not. The refused cells are listed below with the reason each was refused. This is not a completed import.`
    case 'failed':
      return 'The job failed. Any rows written before it stopped are still written — check the outcomes below before re-running the file.'
    case 'reverted':
      /*
       * 🔴 "restored" is a claim, and D15.14 gave it an exception: a cell edited after the import
       * is skipped by the revert (`changed-since-import`) rather than overwritten. So this sentence
       * cannot promise everything went back. It states the rule and defers the count to
       * `revertOutcomeSentence`, which can see the outcomes this function cannot.
       */
      return 'This import was reverted. Cells it wrote have been restored — except any that were edited after the import ran, which were left as they are rather than overwritten.'
    default:
      return `The server reports a state this build does not recognise (${state}). Nothing here can say whether your file was written, partly written, or refused — treat this import as unexplained and check the record before re-running it.`
  }
}

/** A RUNNING job that has not advanced for this long is reported as stalled, not as working. */
export const JOB_STALL_MS = 30_000

/**
 * 🔴 A job that stopped moving must not keep saying it is writing.
 *
 * Observed in production during the #588 rehearsal, not imagined: an apply that threw *after*
 * marking the job `RUNNING` left it stranded there permanently — `processed: 0`, cancel refused
 * (`cancelled: false`), a re-apply answering 409 "a preview applies once". Nothing was written and
 * nothing ever would be, yet the poll keeps returning `RUNNING` forever.
 *
 * Against that, `jobStateNote`'s honest-sounding "Writing — 0 of 2 rows so far" becomes a lie that
 * renews itself every 1.5 seconds. **Starvation looks exactly like idle**, and the only way to tell
 * them apart is to clock it — so the panel times how long the job has sat unchanged and says so.
 *
 * It reports; it does not re-classify. The state is still the server's `RUNNING`, and this sentence
 * sits beside it rather than replacing it — the client is not entitled to declare a job dead.
 */
export function jobStallNote(
  job: Pick<ImportJob, 'state' | 'processed' | 'total'>,
  unchangedForMs: number,
): string | null {
  if (String(job.state) !== 'running' || unchangedForMs < JOB_STALL_MS) return null
  const secs = Math.round(unchangedForMs / 1000)
  return job.processed === 0
    ? `This import has been marked as running for ${secs}s without writing anything. A job that fails after it starts can be left in this state — it cannot be cancelled and it cannot be applied again. Nothing has been written; take a fresh preview rather than waiting.`
    : `This import has been marked as running for ${secs}s without advancing past ${job.processed} of ${job.total} cells. The ${job.processed} already written are live. Check the record before re-running the file.`
}

/**
 * Is this job safe to render quietly?
 *
 * 🔴 NOT `state === 'completed'`. `groupIsQuiet`'s lesson from the sync console: tone follows the
 * VERDICT, and an unknown state is not a quiet one however calm its name looks. Only two states
 * earn silence — a clean completion, and a revert that did what it said.
 */
export function jobIsQuiet(job: Pick<ImportJob, 'state' | 'outcomes'>): boolean {
  const state = String(job.state)
  /*
   * 🔴 `CANCELLED` is deliberately NOT quiet, though nothing went wrong and nobody is needed.
   *
   * Quiet is the SUCCESS palette, and a cancelled preview is the opposite of a success: the
   * operator's changes did not happen. Colouring it green would be the reassuring-silence failure
   * in its purest form — an import that did nothing, drawn like an import that worked.
   */
  if (state !== 'completed' && state !== 'reverted') return false
  // A refusal is not a failure of the run, but it is not nothing either: a revert that left three
  // cells alone has something the operator must be told, so it disqualifies the quiet tone too.
  return !(job.outcomes ?? []).some((o) => o.verdict === 'refused')
}

/**
 * What a REVERT actually did, counted from the server's own per-cell record.
 *
 * 🔴 The sentence exists because of D15.14's `changed-since-import`. A revert that put back 5 of 7
 * cells and silently called itself done is the drawer's worst outcome after a bad apply: the
 * operator believes the record is back where it was, and two cells hold values nobody chose on
 * purpose. Naming the skipped cells is not a nicety — it is the difference between a revert an
 * operator can trust and one they cannot check.
 *
 * Returns null when the server listed no outcomes, so the drawer can say "the server did not list
 * them" rather than printing a confident zero (`reference_absence_is_not_an_answer`).
 */
export function revertOutcomeSentence(job: Pick<ImportJob, 'outcomes'>): string | null {
  const outcomes = job.outcomes
  if (!outcomes || outcomes.length === 0) return null
  const restored = outcomes.filter((o) => o.verdict === 'written').length
  const refused = outcomes.filter((o) => o.verdict === 'refused').length
  if (refused === 0) return `${n(restored)} ${restored === 1 ? 'cell was' : 'cells were'} restored.`
  /*
   * 🔴 COUNTED by verdict, never classified by reading the reason (#600).
   *
   * `changed-since-import` used to be its own verdict; it is now a `refused` carrying the server's
   * sentence. The tempting move is to recover the old wording by matching that text — and it would
   * work today and break silently the first time someone re-words it. So this says how many were
   * not restored and lets each row render its own reason verbatim underneath.
   */
  return `${n(restored)} ${restored === 1 ? 'cell was' : 'cells were'} restored. ${n(refused)} ${refused === 1 ? 'was' : 'were'} not — each with its reason below. A cell edited after the import ran is left as it is rather than overwritten.`
}

/** The sentence one outcome carries. The server's `reason` wins; this is the fallback per verdict. */
export function outcomeSentence(outcome: ImportJobOutcome): string {
  const reason = typeof outcome.reason === 'string' ? outcome.reason.trim() : ''
  if (reason) return reason
  switch (outcome.verdict) {
    case 'written':
      return 'Written.'
    case 'refused':
      return 'Refused, and the server gave no reason. That is a gap in the response, not a rule you can act on.'
    case 'unchanged':
      return 'Already held this value — nothing to write.'
    default:
      return `The server sent an outcome this build does not recognise (${String((outcome as { verdict: unknown }).verdict)}), so nothing here can say what happened to this cell.`
  }
}

/**
 * Why "Revert this import" is not offered, or `null` when it is.
 *
 * Again a reason and not a boolean. The three noes are genuinely different: a job still running has
 * nothing settled to revert, a job that wrote nothing has nothing to undo, and an expired window is
 * the server's rule rather than the drawer's.
 *
 * `now` is injected so this is testable without freezing a clock — the same shape `matchesFilter`
 * uses in `syncQueue.ts`.
 */
export function revertBlockedReason(job: ImportJob, now: number): string | null {
  const state = String(job.state)
  if (!jobIsSettled(state)) {
    return isKnownJobState(state)
      ? 'This import is still running. Revert becomes available when it finishes.'
      : 'This import is in a state this build does not recognise, so it cannot offer a revert it may not be able to perform.'
  }
  if (state === 'reverted') return 'This import has already been reverted.'
  if (state === 'cancelled') return 'This preview was never applied, so there is nothing to revert.'
  const written = (job.outcomes ?? []).filter((o) => o.verdict === 'written').length
  if ((job.outcomes ?? []).length > 0 && written === 0) {
    return 'This import wrote nothing, so there is nothing to revert.'
  }
  if (job.expiresAt) {
    const until = Date.parse(job.expiresAt)
    // 🔴 An UNPARSEABLE instant is not an expired one, and it is not an open window either. Reading
    // NaN as "still revertible" would offer a write the server will refuse; reading it as expired
    // would hide one it would accept. Say which it is and let a person decide.
    if (Number.isNaN(until)) {
      return `The server sent a revert deadline this build cannot read (${job.expiresAt}), so it cannot say whether the window is still open.`
    }
    if (now > until) return `The revert window for this import closed on ${new Date(until).toLocaleString('en-GB')}.`
  }
  return null
}

/**
 * How many cells a revert would actually put back.
 *
 * Derived from the outcomes because that IS the server's statement of what it wrote — this is not
 * the page reporting itself as a total, it is the page counting the server's own per-cell record.
 * Returns null when no outcomes were sent, so the drawer says "the server did not list them"
 * instead of printing a confident 0.
 */
export function revertScope(job: ImportJob): number | null {
  if (!job.outcomes) return null
  return job.outcomes.filter((o) => o.verdict === 'written').length
}
