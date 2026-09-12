/**
 * IO.1 — the import drawer's decisions.
 *
 * The failure these guard is never a crash. It is a drawer that says "5 cells change" over a file
 * that changes 8, an Apply button offered over a response nobody can read, or a job that refused
 * seven rows reported as done. Every one of those looks tidy on screen, which is exactly why they
 * have to be caught here.
 *
 * 🔴 Two of these tests exist because a check that cannot fail is worse than no check
 * (`reference_inference_from_your_own_scaffolding`). `readCellVerdict` degrading to `refused` and
 * `jobStateNote` refusing lower case are both cases where the WRONG behaviour also passes a
 * casually-written test — a lenient reader returns something for every input, and a test that only
 * asserts "it returned a string" agrees with whatever you do. Each asserts the distinction.
 */
import { describe, expect, it } from 'vitest'

import {
  applyBlockedReason,
  applyLabel,
  blankModeDisagreement,
  collapsedRowSentence,
  composeRowId,
  darkNoteFor,
  diffCellTooltip,
  fixtureBlockedReason,
  countsInRows,
  hiddenColumnSentence,
  cellDestination,
  listingWriteWarning,
  isKnownJobState,
  jobIsQuiet,
  jobIsSettled,
  jobStallNote,
  jobStateNote,
  PHASE_REQUIRED,
  labelCell,
  orderedDiffRows,
  outcomeSentence,
  pinSentence,
  reconcileCounts,
  revertBlockedReason,
  revertOutcomeSentence,
  rowUnmatchedReason,
  summariseDiff,
  unknownVerdictCells,
  visibleColumnKeys,
} from './diffModel'
import { readCellReason, readCellVerdict, verifyImportDiff, type ImportDiff, type ImportDiffCell, type ImportDiffRow, type ImportJob } from './contract'
import { FIXTURE_DIFF_CHANNEL, FIXTURE_DIFF_MASTER, FIXTURE_DIFF_UNCHANGED, fixtureJob } from './fixture'

/* ── builders ───────────────────────────────────────────────────────────────────────────────── */



const cell = (over: Partial<ImportDiffCell> = {}): ImportDiffCell => ({
  verdict: 'unchanged', pins: false, before: 'a', after: 'a', ...over,
})

const row = (over: Partial<ImportDiffRow> = {}): ImportDiffRow => ({
  productId: 'p1', aliasKey: null, aliasResolved: true, sku: 'SKU-1', cells: {}, ...over,
})

const diff = (over: Partial<ImportDiff> = {}): ImportDiff => ({
  file: { name: 'f.csv' },
  scope: { kind: 'master', label: 'Master' },
  blankCells: 'ignore',
  counts: { changed: 0, unchanged: 0, refused: 0, wouldPin: 0 },
  rows: [],
  ...over,
})

const job = (over: Partial<ImportJob> = {}): ImportJob => ({
  jobId: 'j1', state: 'completed', processed: 1, total: 1, ...over,
})

/* ── row identity (D15.13.3) ────────────────────────────────────────────────────────────────── */

describe('a diff row must never be aimed at a listing it only probably belongs to', () => {
  it('composes the sheet row id from components', () => {
    expect(composeRowId(row({ aliasKey: 'eu-b2b', productId: 'p9' }))).toBe('eu-b2b:p9')
  })

  it('reads an EMPTY aliasKey as the known primary, which is the server saying "no alias"', () => {
    expect(composeRowId(row({ aliasKey: '', productId: 'p9' }))).toBe('primary:p9')
  })

  it('🔴 returns null — never a guessed "primary" — when the server could not resolve the alias', () => {
    expect(composeRowId(row({ aliasResolved: false, aliasKey: null, productId: 'p9' }))).toBeNull()
    // And the row says why, so the operator is not left with a silently missing line.
    expect(rowUnmatchedReason(row({ aliasResolved: false }))).toMatch(/could not say which listing alias/)
  })

  it('distinguishes "no product matched" from "alias unknown" — different fixes', () => {
    expect(rowUnmatchedReason(row({ productId: '' }))).toMatch(/matched no product/)
    expect(rowUnmatchedReason(row())).toBeNull()
  })
})

/* ── the out-of-vocabulary verdict ──────────────────────────────────────────────────────────── */

describe('an unrecognised verdict must not read as "nothing will happen here"', () => {
  it('🔴 degrades to refused, NOT to the quiet unchanged', () => {
    const unknown = cell({ verdict: 'deferred' as never })
    expect(readCellVerdict(unknown)).toBe('refused')
    // The distinction that matters: were it lenient the other way, this would be 'unchanged' and
    // the cell would render as agreeing with the sheet.
    expect(readCellVerdict(unknown)).not.toBe('unchanged')
  })

  it('says the VERDICT was unreadable, not that the value was rejected', () => {
    const reason = readCellReason(cell({ verdict: 'deferred' as never }))
    expect(reason).toMatch(/does not recognise/)
    expect(reason).toMatch(/that is this build being cautious, not the server refusing the value/i)
  })

  it('names a refusal the server gave no reason for, rather than showing an empty tooltip', () => {
    expect(readCellReason(cell({ verdict: 'refused', reason: null }))).toMatch(/gap in the response/)
    expect(readCellReason(cell({ verdict: 'refused', reason: '   ' }))).toMatch(/gap in the response/)
    expect(readCellReason(cell({ verdict: 'refused', reason: 'Over the cap.' }))).toBe('Over the cap.')
  })
})

/* ── counts (D15.13.4) ──────────────────────────────────────────────────────────────────────── */

describe('the header and the rows must not be able to disagree in silence', () => {
  const changedRow = row({
    cells: { a: cell({ verdict: 'changed', after: 'b' }), b: cell({ verdict: 'refused' }) },
  })

  it('passes when the server counts and the delivered rows agree', () => {
    const d = diff({ rows: [changedRow], counts: { changed: 1, unchanged: 0, refused: 1, wouldPin: 0 } })
    expect(reconcileCounts(d)).toEqual([])
  })

  it('catches a genuine mismatch and refuses to pick a winner', () => {
    const d = diff({ rows: [changedRow], counts: { changed: 412, unchanged: 0, refused: 1, wouldPin: 0 } })
    const problems = reconcileCounts(d)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/header says 412, rows hold 1/)
    expect(problems[0]).toMatch(/neither can be trusted/)
  })

  it('catches wouldPin larger than changed — a pin IS a change (D15.13.1)', () => {
    const d = diff({ rows: [], counts: { changed: 2, unchanged: 0, refused: 0, wouldPin: 5 } })
    expect(reconcileCounts(d)[0]).toMatch(/only 2 that change/)
  })

  it('does NOT cry wolf over a response the server declared truncated', () => {
    const d = diff({
      rows: [changedRow],
      counts: { changed: 999, unchanged: 0, refused: 1, wouldPin: 0 },
      truncated: { rowsReturned: 1, rowsTotal: 999, note: 'first page' },
    })
    expect(reconcileCounts(d)).toEqual([])
  })

  it('🔴 SUSPENDS the arithmetic when an unknown verdict is present, and reports that instead', () => {
    const d = diff({
      rows: [row({ sku: 'SKU-9', cells: { a: cell({ verdict: 'deferred' as never }) } })],
      counts: { changed: 1, unchanged: 0, refused: 0, wouldPin: 0 },
    })
    const problems = reconcileCounts(d)
    // One problem, and it is the unknown verdict — not a fabricated count mismatch caused by this
    // build's own degradation of that cell to `refused`.
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/verdict this build does not recognise/)
    expect(problems[0]).toMatch(/SKU-9/)
    expect(problems.join(' ')).not.toMatch(/header says/)
  })

  it('locates every unknown verdict well enough to report it', () => {
    const found = unknownVerdictCells([row({ sku: 'S1', cells: { name: cell({ verdict: 'x' as never }) } })])
    expect(found).toEqual([{ sku: 'S1', key: 'name', raw: 'x' }])
  })

  it('counts a pin as a change and not as a fourth thing', () => {
    const c = countsInRows([row({ cells: { a: cell({ verdict: 'changed', pins: true }) } })])
    expect(c).toEqual({ changed: 1, unchanged: 0, refused: 0, wouldPin: 1 })
  })
})

/* ── where a cell writes (#577) ─────────────────────────────────────────────────────────────── */

describe('where a cell writes is READ from the column, never derived (D15.16.4)', () => {
  it('reads the column’s stated writeTarget', () => {
    expect(cellDestination({ writeTarget: 'channelListing' }).target).toBe('channelListing')
    expect(cellDestination({ writeTarget: 'master' }).target).toBe('master')
  })

  it('🔴 does NOT infer a listing write from an amazon_/ebay_ name', () => {
    /*
     * The deleted mirror's whole failure mode, asserted so it cannot come back: a prefixed field
     * whose column says master reads as MASTER. A prefix rule would have said listing, and would
     * have been wrong for exactly the cases the server's layer-derived answer gets right.
     */
    expect(cellDestination({ writeTarget: 'master' }).target).toBe('master')
    // …and with no column at all it does not fall back to the name either.
    expect(cellDestination(undefined).target).toBe('master')
  })

  it('lets a per-CELL echo override its column, for an alias or linked row', () => {
    expect(cellDestination({ writeTarget: 'master' }, { writeTarget: 'channelListing' }).target)
      .toBe('channelListing')
  })

  it('names the channel from the scope when there is one', () => {
    const d = cellDestination({ writeTarget: 'channelListing' }, null, { kind: 'channel', channel: 'AMAZON' })
    expect(d.label).toBe('writes the Amazon listing')
  })
})

describe('a column that does not say where it writes is a CONTRACT VIOLATION, not a guess', () => {
  it('🔴 refuses the response rather than assuming master', () => {
    const problems = verifyImportDiff(diff({
      columns: [{ key: 'amazon_title', label: 'Title' }, { key: 'manufacturer', label: 'Manufacturer', writeTarget: 'master' }],
    }) as unknown)
    expect(problems.some((p) => /do not state where they write/.test(p))).toBe(true)
    expect(problems.some((p) => /amazon_title/.test(p))).toBe(true)
  })

  it('accepts columns that all state it', () => {
    const problems = verifyImportDiff(diff({
      columns: [{ key: 'manufacturer', label: 'Manufacturer', writeTarget: 'master' }],
    }) as unknown)
    expect(problems).toEqual([])
  })
})

describe('the master-scope file that would write a live listing', () => {
  const masterDiff = (cells: Record<string, ImportDiffCell>) =>
    diff({
      scope: { kind: 'master', label: 'Master' },
      // The COLUMNS carry the routing now — the warning reads them, not the field names.
      columns: Object.keys(cells).map((key) => ({
        key,
        label: key,
        writeTarget: key.startsWith('amazon_') || key.startsWith('ebay_') ? ('channelListing' as const) : ('master' as const),
      })),
      rows: [row({ cells })],
    })

  it('🔴 warns, names the channel, and counts the cells', () => {
    const w = listingWriteWarning(masterDiff({
      manufacturer: cell({ verdict: 'changed', after: 'x' }),
      amazon_title: cell({ verdict: 'changed', after: 'y' }),
    }))!
    expect(w).toMatch(/1 cell in this file writes to the Amazon listing/)
    expect(w).toMatch(/not to the master record/)
    expect(w).toMatch(/what buyers see/)
  })

  it('names BOTH channels when a file carries both', () => {
    const w = listingWriteWarning(masterDiff({
      amazon_title: cell({ verdict: 'changed', after: 'a' }),
      ebay_title: cell({ verdict: 'changed', after: 'b' }),
    }))!
    expect(w).toMatch(/Amazon and eBay/)
    expect(w).toMatch(/2 cells/)
  })

  it('stays silent on an ordinary master file, so the warning cannot become wallpaper', () => {
    expect(listingWriteWarning(masterDiff({ manufacturer: cell({ verdict: 'changed', after: 'x' }) }))).toBeNull()
  })

  it('🔴 ignores UNCHANGED prefixed cells — a cell that writes nothing endangers nothing', () => {
    expect(listingWriteWarning(masterDiff({ amazon_title: cell({ verdict: 'unchanged' }) }))).toBeNull()
  })

  it('says nothing on a CHANNEL scope, where writing the listing is the whole point', () => {
    const d = diff({
      scope: { kind: 'channel', channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT' },
      columns: [{ key: 'amazon_title', label: 'Title', writeTarget: 'channelListing' as const }],
      rows: [row({ cells: { amazon_title: cell({ verdict: 'changed', after: 'y' }) } })],
    })
    expect(listingWriteWarning(d)).toBeNull()
  })
})

/* ── the summary sentence ───────────────────────────────────────────────────────────────────── */

describe('the summary says the shape, not just the size', () => {
  it('renders the pin count as a SUBSET, so 412 + 3 never reads as 415', () => {
    const s = summariseDiff(diff({ counts: { changed: 412, unchanged: 0, refused: 7, wouldPin: 3 } }))
    expect(s).toBe('412 cells change (3 of them pin) · 7 refused')
  })

  it('omits the pin clause when nothing pins', () => {
    expect(summariseDiff(diff({ counts: { changed: 2, unchanged: 1, refused: 0, wouldPin: 0 } })))
      .toBe('2 cells change · 1 unchanged')
  })

  it('🔴 gives the zero-change round trip its own sentence rather than an empty grid', () => {
    const s = summariseDiff(diff({ counts: { changed: 0, unchanged: 126, refused: 0, wouldPin: 0 } }))
    expect(s).toMatch(/Nothing in this file changes anything/)
    expect(s).toMatch(/126 cells match/)
  })

  it('spells out what a pin costs, above the grid rather than in a tooltip', () => {
    expect(pinSentence(0)).toBeNull()
    expect(pinSentence(1)).toMatch(/pins it to this row/)
    expect(pinSentence(3)).toMatch(/stop tracking the master until reset/)
  })

  it('labels Apply with the number the operator is agreeing to', () => {
    expect(applyLabel({ changed: 412, unchanged: 0, refused: 7, wouldPin: 3 })).toBe('Apply 412 changes')
    expect(applyLabel({ changed: 1, unchanged: 0, refused: 0, wouldPin: 0 })).toBe('Apply 1 change')
  })
})

/* ── the blank-cell flag ────────────────────────────────────────────────────────────────────── */

describe('the blank-cell mode is read from the server ECHO, never from local intent', () => {
  it('is silent when the server applied what was asked', () => {
    expect(blankModeDisagreement('ignore', 'ignore')).toBeNull()
    expect(blankModeDisagreement('clear', 'clear')).toBeNull()
  })

  it('🔴 shouts loudest in the dangerous direction — asked ignore, server cleared', () => {
    const note = blankModeDisagreement('ignore', 'clear')!
    expect(note).toMatch(/about to empty the value it sits on/)
    expect(note).toMatch(/Do not apply this diff/)
  })

  it('still reports the safe direction, because a flag ignored one way is ignored both ways', () => {
    expect(blankModeDisagreement('clear', 'ignore')).toMatch(/not reaching the parser/)
  })
})

/* ── whether Apply may be offered at all ────────────────────────────────────────────────────── */

describe('Apply is offered, or it explains itself — never greyed out in silence', () => {
  const applicable = diff({
    jobId: 'job-1',
    rows: [row({ cells: { a: cell({ verdict: 'changed', after: 'b' }) } })],
    counts: { changed: 1, unchanged: 0, refused: 0, wouldPin: 0 },
  })

  it('offers Apply when the response is coherent and something changes', () => {
    expect(applyBlockedReason(applicable, 'ignore', [])).toBeNull()
  })

  it('blocks on a contract problem, because nothing on screen can be trusted', () => {
    expect(applyBlockedReason(applicable, 'ignore', ['counts{} missing'])).toMatch(/does not match the agreed contract/)
  })

  it('blocks when the server applied a different blank-cell mode', () => {
    expect(applyBlockedReason({ ...applicable, blankCells: 'clear' }, 'ignore', [])).toMatch(/about to empty/)
  })

  it('blocks when there is nothing to apply, and says so as a fact rather than a failure', () => {
    const clean = diff({ counts: { changed: 0, unchanged: 9, refused: 0, wouldPin: 0 } })
    expect(applyBlockedReason(clean, 'ignore', [])).toMatch(/nothing to apply/)
  })

  it('🔴 does NOT block on refusals — a partial file still applies (D15.6)', () => {
    const withRefusals = diff({
      jobId: 'job-1',
      rows: [row({ cells: { a: cell({ verdict: 'changed', after: 'b' }), b: cell({ verdict: 'refused' }) } })],
      counts: { changed: 1, unchanged: 0, refused: 1, wouldPin: 0 },
    })
    expect(applyBlockedReason(withRefusals, 'ignore', [])).toBeNull()
  })

  it('🔴 refuses to apply a preview the server did not store — a re-parse is a DIFFERENT diff (D15.15)', () => {
    const { jobId: _none, ...unstored } = applicable
    const reason = applyBlockedReason(unstored, 'ignore', [])!
    expect(reason).toMatch(/not stored by the server/)
    expect(reason).toMatch(/without you having seen it/)
  })

  it('🔴 refuses over FIXTURE data whatever else is true — the dark build cannot write', () => {
    const asFixture = { ...applicable, isFixture: true }
    expect(applyBlockedReason(asFixture, 'ignore', [])).toMatch(/built-in fixture data/)
    // And it wins over every other reason, so no combination of states can talk it into applying.
    expect(fixtureBlockedReason(asFixture)).not.toBeNull()
    expect(fixtureBlockedReason(applicable)).toBeNull()
  })
})

/* ── the dark announcement (#535) ───────────────────────────────────────────────────────────── */

describe('a drawer that cannot write says so before anyone spends effort on it', () => {
  it('🔴 announces from the TRANSPORT, with no diff in hand — i.e. at rest, on open', () => {
    // The failure this replaces: the banner keyed off the diff payload, so it could not appear
    // until after a file had been chosen and parsed.
    expect(darkNoteFor('Preview only — nothing here can write.', null)).toMatch(/nothing here can write/)
  })

  it('says nothing on a live transport with no diff', () => {
    expect(darkNoteFor(null, null)).toBeNull()
  })

  it('still shouts when a LIVE transport hands back fixture-flagged data', () => {
    // Nobody designed this state; it must not render as real.
    expect(darkNoteFor(null, { isFixture: true })).toMatch(/built-in fixture data/)
  })

  it('prefers the transport’s wording, so the banner does not change meaning when the step does', () => {
    expect(darkNoteFor('Transport is dark.', { isFixture: true })).toBe('Transport is dark.')
  })

  it('stays silent on a live transport with a real diff', () => {
    expect(darkNoteFor(null, { isFixture: false })).toBeNull()
    expect(darkNoteFor(undefined, {})).toBeNull()
  })
})

/* ── what the diff grid shows ───────────────────────────────────────────────────────────────── */

describe('the diff grid shows the work, and says what it left out', () => {
  const rows = [
    row({ sku: 'A', line: 2, cells: { name: cell({ verdict: 'changed' }), style: cell() } }),
    row({ sku: 'B', line: 3, cells: { name: cell({ verdict: 'refused' }), style: cell() } }),
    row({ sku: 'C', line: 4, cells: { name: cell(), style: cell() } }),
  ]

  it('drops rows with nothing to look at', () => {
    expect(orderedDiffRows(rows).map((r) => r.sku)).toEqual(['B', 'A'])
  })

  it('🔴 puts refusals first — they are the only rows that need a decision before applying', () => {
    expect(orderedDiffRows(rows)[0].sku).toBe('B')
  })

  it('hides a column that matched everywhere, and counts it', () => {
    const { keys, hidden } = visibleColumnKeys(rows)
    expect(keys).toEqual(['name'])
    expect(hidden).toBe(1)
    expect(hiddenColumnSentence(hidden)).toMatch(/1 column matched the sheet in every row/)
    expect(hiddenColumnSentence(0)).toBeNull()
  })

  it('keeps the FILE’s column order rather than sorting it', () => {
    const wide = [row({ cells: { zeta: cell({ verdict: 'changed' }), alpha: cell({ verdict: 'changed' }) } })]
    expect(visibleColumnKeys(wide).keys).toEqual(['zeta', 'alpha'])
  })

  it('says how many rows are held back, and nothing when none are', () => {
    expect(collapsedRowSentence(20, 34)).toBe('Showing the first 20 of 34 rows with changes.')
    expect(collapsedRowSentence(20, 20)).toBeNull()
  })
})

/* ── labels (D15.14) ────────────────────────────────────────────────────────────────────────── */

describe('a diff renders values the way the sheet does, through the sheet’s own function', () => {
  const column = { key: 'country_of_origin', label: 'Country of origin', optionLabels: { PK: 'Pakistan', IT: 'Italy' } }

  it('labels BOTH ends, so a diff is comparable on its face', () => {
    expect(labelCell({ before: 'PK', after: 'IT' }, column)).toEqual({ before: 'Pakistan', after: 'Italy' })
  })

  it('🔴 falls back to the CODE for an unmapped value — a blank would read as a removal', () => {
    expect(labelCell({ before: 'PK', after: 'PAK' }, column).after).toBe('PAK')
  })

  it('renders a genuinely empty value as empty, and does not look it up', () => {
    expect(labelCell({ before: '', after: 'PK' }, column).before).toBe('')
  })

  it('passes a column with no option list straight through', () => {
    expect(labelCell({ before: 'Aireon', after: 'Aireon Pro' }, undefined))
      .toEqual({ before: 'Aireon', after: 'Aireon Pro' })
  })
})

/* ── the tooltip, now the only home for the full text (#562) ────────────────────────────────── */

describe('the tooltip carries what the fixed-height cell cannot show', () => {
  const column = { key: 'country_of_origin', label: 'Country of origin', optionLabels: { PK: 'Pakistan', IT: 'Italy' } }

  it('labels both ends, matching what the cell renders', () => {
    expect(diffCellTooltip(cell({ verdict: 'changed', before: 'PK', after: 'IT' }), column))
      .toBe('Pakistan → Italy')
  })

  it('shows an unchanged cell as its plain value, not as an arrow to itself', () => {
    expect(diffCellTooltip(cell({ verdict: 'unchanged', before: 'PK', after: 'PK' }), column)).toBe('Pakistan')
  })

  it('names an empty end rather than rendering a bare arrow', () => {
    expect(diffCellTooltip(cell({ verdict: 'changed', before: 'PK', after: '' }), column))
      .toBe('Pakistan → (empty)')
  })

  it('🔴 carries the refusal REASON — the fixed-height cell has nowhere else to put it', () => {
    const t = diffCellTooltip(cell({ verdict: 'refused', before: 'PK', after: 'PAK', reason: 'Not an accepted value.' }), column)
    expect(t).toMatch(/REFUSED/)
    expect(t).toMatch(/Not an accepted value\./)
  })

  it('spells out the consequence on a pin', () => {
    const t = diffCellTooltip(cell({ verdict: 'changed', pins: true, before: 'a', after: 'b' }), undefined)
    expect(t).toMatch(/stop tracking the master until reset/)
  })

  it('explains an unknown verdict rather than showing a bare pair', () => {
    expect(diffCellTooltip(cell({ verdict: 'nope' as never, before: 'a', after: 'b' }), undefined))
      .toMatch(/does not recognise/)
  })
})

/* ── the job (D15.13.5 / D15.14) ────────────────────────────────────────────────────────────── */

describe('a job that did not finish the work must not report that it did', () => {
  it('🔴 reports what was WRITTEN, in CELLS — the live acceptance run caught both halves', () => {
    /*
     * A one-row file changing one column returns `processed: 1, total: 2` — the SKU cell is a cell
     * too, and it matched. The old wording read "Done. All 2 rows were written": wrong UNIT and
     * wrong COUNT, compounding into one confident false number on the commonest success path.
     *
     * 🔴 It passed 95 tests. Every fixture happened to have `processed === total`, so no test could
     * tell the two numbers apart — a suite can only distinguish values its data varies.
     */
    const note = jobStateNote({ state: 'completed', processed: 1, total: 2 })
    expect(note).toMatch(/1 cell was written/)
    expect(note).toMatch(/the other 1 already matched the sheet/)
    expect(note).not.toMatch(/rows/)
    expect(note).not.toMatch(/All 2/)
  })

  it('still says "all" when every cell really was written', () => {
    expect(jobStateNote({ state: 'completed', processed: 3, total: 3 })).toMatch(/All 3 cells were written/)
  })

  it('🔴 gives an APPLY-partial its own sentence, which cannot be mistaken for completed', () => {
    const note = jobStateNote({ state: 'partial', processed: 5, total: 7, phase: 'apply' })
    expect(note).toMatch(/^Apply partial — 5 of 7 cells were written/)
    expect(note).toMatch(/This is not a completed import/)
    expect(note).not.toMatch(/^Done\./)
  })

  it('🔴 "partial" alone cannot say partial AT WHAT — the pair disambiguates (#614)', () => {
    /*
     * 🔴 THE test that matters here, by the rule tonight's `processed === total` fixtures taught:
     * it varies `phase` while holding `state` CONSTANT. A suite that only ever sends one phase
     * cannot tell whether the renderer reads it at all — the same blindness that let
     * "All 2 rows were written" survive 95 tests.
     */
    const same = { state: 'partial' as const, processed: 3, total: 5 }
    const apply = jobStateNote({ ...same, phase: 'apply' })
    const revert = jobStateNote({ ...same, phase: 'revert' })
    expect(apply).not.toBe(revert)
    expect(apply).toMatch(/^Apply partial — 3 of 5 cells were written/)
    expect(revert).toMatch(/^Revert partial — 3 of 5 cells were restored/)
    // The revert wording must not claim anything was WRITTEN — it is putting values back.
    expect(revert).not.toMatch(/were written/)
    // Neither may be mistakable for a clean completion.
    expect(apply).toMatch(/not a completed import/)
    expect(revert).toMatch(/still hold what the import wrote/)
  })

  it('🔴 with the producer landed, a partial with NO phase is unexplained — not guessed as apply', () => {
    /*
     * The post-landing world (PES.5 item 7, 08:39:01 / 08:40:34). `partial` can now mean either
     * phase, so absence is genuinely ambiguous — and the two possibilities demand OPPOSITE
     * responses: "your file was only partly written" versus "your record was only partly put back".
     * Guessing `apply` because it used to be the only option is exactly the stale-default failure
     * that made `CANCELLED` read as unexplained after it became real.
     */
    expect(PHASE_REQUIRED).toBe(true)
    const note = jobStateNote({ state: 'partial', processed: 3, total: 5 })
    expect(note).toMatch(/does not say partial at WHAT/)
    expect(note).toMatch(/opposite responses/)
    expect(note).not.toMatch(/Finished with refusals/)
  })

  it('🔴 renders an unrecognised state as unexplained, never as success', () => {
    /*
     * 🔴 This test used `CANCELLED` until D15.15 made it a REAL state, at which point the test
     * would have passed for the wrong reason had the state list not been updated with it — it
     * asserted "unexplained" about a state the server now sends deliberately. A test naming a
     * plausible-but-fictional value goes stale the moment the value becomes real, silently. The
     * sentinel below is chosen to be one no contract would ever mint.
     */
    const note = jobStateNote({ state: 'HALF_PAST_TUESDAY', processed: 0, total: 7 })
    expect(note).toMatch(/state this build does not recognise/)
    expect(note).toMatch(/treat this import as unexplained/)
  })

  it('D15.15 — a stored preview says it is waiting for YOU, not that it will run on its own', () => {
    const note = jobStateNote({ state: 'queued', processed: 0, total: 7 })
    expect(note).toMatch(/waiting for you/)
    expect(note).toMatch(/nothing will be until you apply it/)
  })

  it('D15.15 — CANCELLED is a known state, and is NOT drawn as a success', () => {
    expect(isKnownJobState('cancelled')).toBe(true)
    expect(jobStateNote({ state: 'cancelled', processed: 0, total: 7 })).toMatch(/never applied/)
    expect(jobStateNote({ state: 'cancelled', processed: 0, total: 7 })).not.toMatch(/does not recognise/)
    // Nothing went wrong and nobody is needed — but the operator's changes did not happen, so the
    // reassuring palette would be a lie.
    expect(jobIsQuiet(job({ state: 'cancelled' }))).toBe(false)
    expect(jobIsSettled('cancelled')).toBe(true)
  })

  it('🔴 is case-SENSITIVE: an UPPER-case "COMPLETED" is a drift, not a synonym', () => {
    expect(isKnownJobState('completed')).toBe(true)
    // 🔴 The exact string the LIVE route returned against a mirror expecting the other case.
    // Strictness turned a silent mismatch into a visible one and got the wire fixed (#600).
    expect(isKnownJobState('COMPLETED')).toBe(false)
    expect(jobStateNote({ state: 'COMPLETED', processed: 1, total: 1 })).toMatch(/does not recognise/)
  })

  it('does not promise a revert restored everything, because one case does not', () => {
    expect(jobStateNote({ state: 'reverted', processed: 5, total: 5 }))
      .toMatch(/except any that were edited after the import ran/)
  })

  it('treats only queued and running as unsettled', () => {
    expect(jobIsSettled('running')).toBe(false)
    expect(jobIsSettled('partial')).toBe(true)
    // An unknown state is not settled either — this build cannot say that it is.
    expect(jobIsSettled('HALF_PAST_TUESDAY')).toBe(false)
  })

  it('🔴 refuses the quiet tone for a success carrying refusals or skipped-because-edited cells', () => {
    expect(jobIsQuiet(job({ state: 'completed', outcomes: [{ rowId: 'r', fieldKey: 'f', verdict: 'written' }] }))).toBe(true)
    expect(jobIsQuiet(job({ state: 'completed', outcomes: [{ rowId: 'r', fieldKey: 'f', verdict: 'refused' }] }))).toBe(false)
    expect(jobIsQuiet(job({ state: 'reverted', outcomes: [{ rowId: 'r', fieldKey: 'f', verdict: 'refused' }] }))).toBe(false)
    expect(jobIsQuiet(job({ state: 'reverted', outcomes: [{ rowId: 'r', fieldKey: 'f', verdict: 'unchanged' }] }))).toBe(true)
    expect(jobIsQuiet(job({ state: 'partial' }))).toBe(false)
  })
})

describe('a job that stopped moving must not keep saying it is writing', () => {
  it('says nothing while the job is young', () => {
    expect(jobStallNote({ state: 'running', processed: 0, total: 2 }, 5_000)).toBeNull()
  })

  it('🔴 names the stranded case — running, nothing written, unrecoverable', () => {
    const n = jobStallNote({ state: 'running', processed: 0, total: 2 }, 45_000)!
    expect(n).toMatch(/without writing anything/)
    expect(n).toMatch(/cannot be cancelled and it cannot be applied again/)
    expect(n).toMatch(/take a fresh preview/)
  })

  it('says something DIFFERENT when it stalled part-way — those writes are live', () => {
    const n = jobStallNote({ state: 'running', processed: 3, total: 9 }, 45_000)!
    expect(n).toMatch(/without advancing past 3 of 9/)
    expect(n).toMatch(/already written are live/)
  })

  it('never fires on a settled job, however long it has sat', () => {
    for (const state of ['completed', 'partial', 'failed', 'reverted', 'cancelled', 'queued']) {
      expect(jobStallNote({ state, processed: 0, total: 2 }, 10 * 60_000)).toBeNull()
    }
  })
})

describe('a revert says what it actually put back', () => {
  const now = Date.parse('2026-09-02T12:00:00.000Z')

  it('offers a revert on a settled job inside its window', () => {
    expect(revertBlockedReason(job({ state: 'partial', expiresAt: '2026-09-03T00:00:00.000Z' }), now)).toBeNull()
  })

  it('refuses while the job is still running, and says when it will be available', () => {
    expect(revertBlockedReason(job({ state: 'running' }), now)).toMatch(/still running/)
  })

  it('refuses on a state it cannot read rather than offering a write it may not perform', () => {
    expect(revertBlockedReason(job({ state: 'HALF_PAST_TUESDAY' }), now)).toMatch(/does not recognise/)
  })

  it('D15.15 — refuses on a cancelled preview, which wrote nothing to put back', () => {
    expect(revertBlockedReason(job({ state: 'cancelled' }), now)).toMatch(/never applied, so there is nothing to revert/)
  })

  it('refuses when the job wrote nothing', () => {
    const wroteNothing = job({ state: 'failed', outcomes: [{ rowId: 'r', fieldKey: 'f', verdict: 'refused' }] })
    expect(revertBlockedReason(wroteNothing, now)).toMatch(/wrote nothing/)
  })

  it('reports an expired window with the instant it closed', () => {
    expect(revertBlockedReason(job({ expiresAt: '2026-09-01T00:00:00.000Z' }), now)).toMatch(/revert window .* closed/)
  })

  it('🔴 an UNPARSEABLE deadline is neither open nor expired, and says which it is', () => {
    const note = revertBlockedReason(job({ expiresAt: 'whenever' }), now)!
    expect(note).toMatch(/cannot read/)
    expect(note).not.toMatch(/closed on/)
  })

  it('🔴 names the cells a revert deliberately left alone', () => {
    const sentence = revertOutcomeSentence({
      outcomes: [
        { rowId: 'r1', fieldKey: 'name', verdict: 'written' },
        { rowId: 'r2', fieldKey: 'brand', verdict: 'refused', reason: 'Edited after the import ran.' },
      ],
    })!
    expect(sentence).toMatch(/1 cell was restored/)
    expect(sentence).toMatch(/1 was not/)
    // 🔴 Counted by VERDICT. The sentence must not be produced by matching the reason text (#600):
    // a reason is prose and a client that greps it breaks silently on a re-wording.
    expect(sentence).toMatch(/left as it is rather than overwritten/)
  })

  it('says nothing rather than a confident zero when the server listed no outcomes', () => {
    expect(revertOutcomeSentence({ outcomes: undefined })).toBeNull()
    expect(revertOutcomeSentence({ outcomes: [] })).toBeNull()
  })

  it('prefers the server’s own reason over the built-in wording', () => {
    expect(outcomeSentence({ rowId: 'r', fieldKey: 'f', verdict: 'refused', reason: 'Over the cap.' })).toBe('Over the cap.')
    expect(outcomeSentence({ rowId: 'r', fieldKey: 'f', verdict: 'unchanged' })).toMatch(/Already held this value/)
    expect(outcomeSentence({ rowId: 'r', fieldKey: 'f', verdict: 'refused', reason: 'Edited after the import ran.' }))
      .toBe('Edited after the import ran.')
  })
})

/* ── the contract check ─────────────────────────────────────────────────────────────────────── */

describe('a drifted response must be a loud message, never a blank grid reading as "no changes"', () => {
  it('accepts the agreed shape', () => {
    expect(verifyImportDiff(diff())).toEqual([])
  })

  it('🔴 names a missing counts{} as the thing that would make every number self-reported', () => {
    const { counts: _drop, ...withoutCounts } = diff()
    expect(verifyImportDiff(withoutCounts)[0]).toMatch(/page reporting itself as a total/)
  })

  it('names a missing blank-cell echo, because the summary is written from it', () => {
    expect(verifyImportDiff({ ...diff(), blankCells: 'maybe' })[0]).toMatch(/did not echo the mode it applied/)
  })

  it('rejects a non-object outright', () => {
    expect(verifyImportDiff(null)).toEqual(['response is not an object'])
    expect(verifyImportDiff('{}')).toEqual(['response is not an object'])
  })
})

/* ── the fixture itself ─────────────────────────────────────────────────────────────────────── */

describe('the fixture must be self-consistent, or the drawer shouts at its own test data', () => {
  /*
   * 🔴 This suite exists because the fixture's `counts` are hand-written to stand in for a
   * SERVER-stated count, and `reconcileCounts` compares them against the cells. Hand arithmetic
   * over 36 cells rots the first time a cell is edited, and the symptom would be the drawer
   * permanently displaying a contract violation — a bug in the test data presented as a finding
   * about PES.5's endpoint.
   */
  it('the master fixture holds exactly the cells its counts claim, from the SERVER’s side', () => {
    const client = countsInRows(FIXTURE_DIFF_MASTER.rows)
    // The client reads the one `deferred` cell as refused; the server counted it as a change.
    // So the two tallies differ by exactly that one cell, in exactly that direction.
    expect(client).toEqual({ changed: 7, unchanged: 25, refused: 4, wouldPin: 1 })
    expect(FIXTURE_DIFF_MASTER.counts).toEqual({ changed: 8, unchanged: 25, refused: 3, wouldPin: 1 })
    expect(client.changed + client.refused).toBe(FIXTURE_DIFF_MASTER.counts.changed + FIXTURE_DIFF_MASTER.counts.refused)
    expect(unknownVerdictCells(FIXTURE_DIFF_MASTER.rows)).toHaveLength(1)
  })

  it('the master fixture therefore reconciles to exactly one problem: the unknown verdict', () => {
    const problems = reconcileCounts(FIXTURE_DIFF_MASTER)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/verdict this build does not recognise/)
  })

  it('the channel fixture is clean — every count agrees with its cells', () => {
    expect(countsInRows(FIXTURE_DIFF_CHANNEL.rows)).toEqual(FIXTURE_DIFF_CHANNEL.counts)
    expect(reconcileCounts(FIXTURE_DIFF_CHANNEL)).toEqual([])
  })

  it('the zero-change fixture is genuinely zero-change, which is D15.1’s acceptance test', () => {
    expect(countsInRows(FIXTURE_DIFF_UNCHANGED.rows)).toEqual(FIXTURE_DIFF_UNCHANGED.counts)
    expect(reconcileCounts(FIXTURE_DIFF_UNCHANGED)).toEqual([])
    expect(orderedDiffRows(FIXTURE_DIFF_UNCHANGED.rows)).toEqual([])
    expect(summariseDiff(FIXTURE_DIFF_UNCHANGED)).toMatch(/Nothing in this file changes anything/)
  })

  it('every fixture passes the contract check it will be parsed by', () => {
    expect(verifyImportDiff(FIXTURE_DIFF_MASTER)).toEqual([])
    expect(verifyImportDiff(FIXTURE_DIFF_CHANNEL)).toEqual([])
    expect(verifyImportDiff(FIXTURE_DIFF_UNCHANGED)).toEqual([])
  })

  it('exercises the states it claims to: a pin, a reasoned refusal, a reasonless one, an unresolved alias', () => {
    const cells = FIXTURE_DIFF_MASTER.rows.flatMap((r) => Object.values(r.cells))
    expect(cells.some((c) => c.verdict === 'changed' && c.pins)).toBe(true)
    expect(cells.some((c) => c.verdict === 'refused' && typeof c.reason === 'string' && c.reason.length > 0)).toBe(true)
    expect(cells.some((c) => c.verdict === 'refused' && !c.reason)).toBe(true)
    expect(FIXTURE_DIFF_MASTER.rows.some((r) => !r.aliasResolved)).toBe(true)
    expect(FIXTURE_DIFF_MASTER.unmatchedRows?.length).toBeGreaterThan(0)
    expect(FIXTURE_DIFF_MASTER.unmatchedColumns?.length).toBeGreaterThan(0)
  })

  it('the job fixture defaults to PARTIAL — the state most likely to be rendered carelessly', () => {
    expect(fixtureJob().state).toBe('partial')
    expect(jobIsQuiet(fixtureJob())).toBe(false)
    expect(revertBlockedReason(fixtureJob(), Date.now())).toBeNull()
  })

  it('D15.15 — every fixture preview carries a jobId, so only the fixture flag blocks Apply', () => {
    for (const f of [FIXTURE_DIFF_MASTER, FIXTURE_DIFF_CHANNEL, FIXTURE_DIFF_UNCHANGED]) {
      expect(f.jobId).toBeTruthy()
    }
    // The master fixture is blocked because it IS a fixture — not incidentally, because it lacks a
    // job id. If the fixture flag were removed the block must come from somewhere real.
    expect(applyBlockedReason(FIXTURE_DIFF_MASTER, 'ignore', [])).toMatch(/built-in fixture data/)
  })

  it('every fixture is flagged as one, so the drawer cannot render it without saying so', () => {
    expect(FIXTURE_DIFF_MASTER.isFixture).toBe(true)
    expect(FIXTURE_DIFF_MASTER.fixtureNote).toMatch(/not your file/)
    expect(fixtureJob().isFixture).toBe(true)
  })
})
