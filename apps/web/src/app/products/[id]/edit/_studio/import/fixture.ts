/**
 * IO.1 — the fixture the drawer is built against until PES.5's endpoint answers.
 *
 * 🔴 **This is not test data pretending to be live data, and the drawer says so on screen.**
 *
 * The hub ordered this lane built dark (#492). Dark is a real risk: a surface wired to a fixture
 * looks exactly like a surface wired to a server, and the programme's standing preference is to
 * ship live rather than dark precisely because that resemblance has fooled people before. So the
 * mitigation is structural, not a promise — `isFixture` rides on the payload, `ImportDrawer`
 * renders a banner naming it whenever it is set, and **nothing can reach the diff grid without
 * passing through the same parse the live response will**. When the endpoint lands, deleting this
 * file and its one import site is the whole migration.
 *
 * ── Why the identity in here is REAL ────────────────────────────────────────────────────────────
 * The SKUs and cuids below were measured against prod (read-only counts, 2026-09-02) and are the
 * actual GALE-JACKET family. A fixture with invented ids exercises the rendering and nothing else;
 * one with real ids also exercises `composeRowId`, the sheet's row-id format, and the day the two
 * surfaces are wired together the ids already match. The VALUES are invented — no cell below claims
 * to be the current content of anything.
 *
 * ── What the fixture is chosen to exercise ──────────────────────────────────────────────────────
 * Every state the drawer can render, because a fixture that only shows the happy path is a fixture
 * that certifies the happy path:
 *
 *   - a plain change (`name` on two rows)
 *   - a change that PINS (`brand` on a child that follows the master today)
 *   - a refusal WITH a reason (`country_of_origin` off its closed list)
 *   - a refusal with NO reason — the server gap `readCellReason` has a sentence for
 *   - an unrecognised verdict — the out-of-vocabulary case that must read refused, not unchanged
 *   - an unresolved alias — `aliasResolved: false`, which must render unmatched and never `primary`
 *   - unchanged cells inside a column that changes elsewhere
 *   - a column that matches everywhere, so `hiddenColumnSentence` has something to say
 *   - unmatched file rows and unmatched file columns
 *
 * PURE data. No React, no fetch.
 */
import type { BlankCellMode, ImportDiff, ImportDiffCell, ImportJob } from './contract'

/** Set on every fixture payload; the drawer refuses to render one without a banner naming it. */
export interface FixtureFlag {
  isFixture: true
  fixtureNote: string
}

export type FixtureDiff = ImportDiff & FixtureFlag
export type FixtureJob = ImportJob & FixtureFlag

const FIXTURE_NOTE =
  'This diff is a built-in fixture, not your file. PES.5’s import endpoint has not shipped, so nothing here has been read from the server and Apply is disabled.'

/* Real GALE-JACKET identity, measured read-only against prod on 2026-09-02. */
const PARENT = 'cmokmy3a40078pm0p1fvnu523'
const BLACK_3XL = 'cmokmy0jf0003pm0ppnu1b2yy'
const BLACK_4XL = 'cmokmy0jt0004pm0p0gaufo1b'
const BLACK_XXL = 'cmokmy0m9000apm0pm52rd77m'
const YELLOW_M = 'cmokmy0ot000gpm0p4z5vwnoo'
const YELLOW_XXL = 'cmokmy0qb000kpm0p06pmx2vt'

/** An unchanged cell — the common case, and the one that must not be mistaken for a change. */
const same = (value: string, header: string): ImportDiffCell => ({
  verdict: 'unchanged',
  pins: false,
  before: value,
  after: value,
  header,
})

const changed = (before: string, after: string, header: string, pins = false): ImportDiffCell => ({
  verdict: 'changed',
  pins,
  before,
  after,
  header,
})

const refused = (before: string, after: string, header: string, reason: string | null): ImportDiffCell => ({
  verdict: 'refused',
  pins: false,
  before,
  after,
  header,
  reason,
})

/**
 * The master-scope fixture.
 *
 * `counts` is written by hand to match the cells below, because it stands in for a SERVER-stated
 * count — and `reconcileCounts` compares the two. A fixture whose header disagreed with its own
 * rows would make the drawer permanently shout, which would be a bug in the fixture presented as a
 * finding about the contract.
 *
 * Counted from the cells below: 6 rows x 6 columns = 36 cells. The SERVER's view (what `counts`
 * stands in for) is changed 8 (1 of them pinning) · refused 3 · unchanged 25. This build READS one
 * of those 8 as refused instead, because it is the deliberately-unrecognised `deferred` verdict on
 * `GALE-JACKET-BLACK-MEN-4XL` — so the client tallies changed 7 · refused 4 · unchanged 25.
 *
 * 🔴 That divergence is the point, not an error in the fixture. It is exactly the case that made
 * `reconcileCounts` suspend its arithmetic when an unknown verdict is present: the two tallies
 * disagree BY CONSTRUCTION, and a reconciler that reported it would be blaming the server for this
 * client's own safety degradation. Both numbers above are correct from where they are standing.
 */
export const FIXTURE_DIFF_MASTER: FixtureDiff = {
  isFixture: true,
  fixtureNote: FIXTURE_NOTE,
  jobId: 'fixture-preview-master',
  file: { name: 'GALE-JACKET-master-2026-09-02.csv', bytes: 18_432, rows: 8, columns: 8 },
  scope: { kind: 'master', locale: 'en', label: 'Master' },
  blankCells: 'ignore',
  counts: { changed: 8, unchanged: 25, refused: 3, wouldPin: 1 },
  coverageNote:
    'This diff covers the 21 rows of the GALE-JACKET family only. A row in the file whose SKU belongs to another family is listed as unmatched below and is never written — an import addresses one family sheet (D15 §2.3).',
  /*
   * D15.14's columns contract. `country_of_origin` carries `optionLabels` on purpose: it is the
   * column the export comment cites for label-vs-code ("exports Pakistan, not PK"), so it is the
   * one that proves the injected `label()` is actually being applied to BOTH ends of a diff.
   */
  columns: [
    { key: 'name', label: 'Name', kind: 'text', editable: true, writeTarget: 'master', writeVerb: 'master' },
    { key: 'brand', label: 'Brand', kind: 'text', editable: true, writeTarget: 'master', writeVerb: 'master' },
    {
      key: 'country_of_origin',
      label: 'Country of origin',
      kind: 'select',
      editable: true,
      options: ['PK', 'IT', 'CN'],
      optionLabels: { PK: 'Pakistan', IT: 'Italy', CN: 'China' },
      writeTarget: 'master',
      writeVerb: 'master',
    },
    { key: 'fabric_type', label: 'Fabric type', kind: 'text', editable: true, writeTarget: 'master', writeVerb: 'master' },
    { key: 'product_description', label: 'Description', kind: 'longtext', editable: true, writeTarget: 'master', writeVerb: 'master' },
    { key: 'style', label: 'Style', kind: 'text', editable: true, writeTarget: 'master', writeVerb: 'master' },
  ],
  rows: [
    {
      productId: PARENT,
      aliasKey: null,
      aliasResolved: true,
      sku: 'GALE-JACKET',
      name: 'Gale Jacket',
      line: 2,
      cells: {
        name: changed('Gale Jacket', 'Gale Jacket — Waterproof Shell', 'Name'),
        brand: same('Aireon', 'Brand'),
        country_of_origin: same('PK', 'Country of origin'),
        fabric_type: changed('Polyester', 'Ripstop polyester', 'Fabric type'),
        // 20,000 BYTES, not characters — the cap this field actually binds on
        // (`reference_amazon_two_independent_length_caps`). The reason names the unit, because
        // "too long" over a field an operator can see 4,000 visible characters in is not actionable.
        product_description: refused(
          'A waterproof shell built for the Italian winter.',
          '(21,884 bytes of HTML pasted from the supplier’s site)',
          'Description',
          'Over the 20,000-byte limit for this field (21,884 bytes). The limit is on UTF-8 bytes, not characters — accented characters cost two.',
        ),
        style: same('Shell', 'Style'),
      },
    },
    {
      productId: YELLOW_M,
      aliasKey: null,
      aliasResolved: true,
      sku: 'GALE-JACKET-YELLOW-MEN-M',
      name: 'Gale Jacket · Yellow · M',
      line: 3,
      cells: {
        name: changed('Gale Jacket Yellow M', 'Gale Jacket — Waterproof Shell · Yellow · M', 'Name'),
        // The pin. This child follows the master's brand today; writing it stops that.
        brand: changed('Aireon', 'Aireon Pro', 'Brand', true),
        country_of_origin: same('PK', 'Country of origin'),
        fabric_type: same('Polyester', 'Fabric type'),
        product_description: same('A waterproof shell built for the Italian winter.', 'Description'),
        style: same('Shell', 'Style'),
      },
    },
    {
      productId: BLACK_XXL,
      aliasKey: null,
      aliasResolved: true,
      sku: 'GALE-JACKET-BLACK-MEN-XXL',
      name: 'Gale Jacket · Black · XXL',
      line: 4,
      cells: {
        name: changed('Gale Jacket Black XXL', 'Gale Jacket — Waterproof Shell · Black · XXL', 'Name'),
        brand: same('Aireon', 'Brand'),
        // Off the closed list. The reason names what IS accepted, because a refusal that does not
        // say what would work sends the operator back to the file to guess.
        country_of_origin: refused(
          'PK',
          'PAK',
          'Country of origin',
          'Not one of this field’s accepted values. It takes a country name (“Pakistan”) or its ISO-2 code (“PK”); “PAK” is ISO-3 and is not accepted.',
        ),
        fabric_type: same('Polyester', 'Fabric type'),
        product_description: same('A waterproof shell built for the Italian winter.', 'Description'),
        style: same('Shell', 'Style'),
      },
    },
    {
      productId: BLACK_3XL,
      aliasKey: null,
      aliasResolved: true,
      sku: 'GALE-JACKET-BLACK-MEN-3XL',
      name: 'Gale Jacket · Black · 3XL',
      line: 5,
      cells: {
        name: changed('Gale Jacket Black 3XL', 'Gale Jacket — Waterproof Shell · Black · 3XL', 'Name'),
        brand: same('Aireon', 'Brand'),
        // A refusal the server gave NO reason for. Not an oversight in the fixture — this is the
        // gap `readCellReason` exists to name, and it has to be reachable to be seen.
        country_of_origin: refused('PK', '', 'Country of origin', null),
        fabric_type: same('Polyester', 'Fabric type'),
        product_description: same('A waterproof shell built for the Italian winter.', 'Description'),
        style: same('Shell', 'Style'),
      },
    },
    {
      productId: BLACK_4XL,
      aliasKey: null,
      aliasResolved: true,
      sku: 'GALE-JACKET-BLACK-MEN-4XL',
      name: 'Gale Jacket · Black · 4XL',
      line: 6,
      cells: {
        /*
         * An out-of-vocabulary verdict. The server has not sent one of these yet — that is the
         * point. `readCellVerdict` must degrade it to `refused` rather than to the quiet
         * `unchanged`, and the drawer must say the VERDICT was unreadable rather than implying the
         * value was rejected. Cast, because the type is the contract and this is deliberately not
         * in it.
         */
        name: { ...changed('Gale Jacket Black 4XL', 'Gale Jacket — Waterproof Shell · Black · 4XL', 'Name'), verdict: 'deferred' as never },
        brand: same('Aireon', 'Brand'),
        country_of_origin: same('PK', 'Country of origin'),
        fabric_type: same('Polyester', 'Fabric type'),
        product_description: same('A waterproof shell built for the Italian winter.', 'Description'),
        style: same('Shell', 'Style'),
      },
    },
    {
      /*
       * The unresolved alias. `composeRowId` must return null here and the drawer must render it
       * unmatched — never guessing `primary`. Prod holds 0 alias rows today, which is exactly why
       * this case needs a fixture: it is unreachable on real data and will not be unreachable
       * forever.
       */
      productId: YELLOW_XXL,
      aliasKey: null,
      aliasResolved: false,
      sku: 'GALE-JACKET-YELLOW-MEN-XXL',
      name: 'Gale Jacket · Yellow · XXL',
      line: 7,
      cells: {
        name: changed('Gale Jacket Yellow XXL', 'Gale Jacket — Waterproof Shell · Yellow · XXL', 'Name'),
        brand: same('Aireon', 'Brand'),
        country_of_origin: same('PK', 'Country of origin'),
        fabric_type: same('Polyester', 'Fabric type'),
        product_description: same('A waterproof shell built for the Italian winter.', 'Description'),
        style: same('Shell', 'Style'),
      },
    },
  ],
  unmatchedRows: [
    { line: 8, sku: 'XAVIA-GLOVE-BLACK-L', reason: 'This SKU is not in the GALE-JACKET family. An import addresses one family sheet.' },
    { line: 9, sku: '', reason: 'No SKU in this line — the key column was blank, so there is nothing to match it to.' },
  ],
  unmatchedColumns: [
    { header: 'Amazon ASIN', key: 'asin', reason: 'Read-only on this scope — the channel assigns it, so a value here cannot be written.' },
    { header: 'Image 1', key: null, reason: 'Images are not imported from a file (D15 §2.3) — the images surface has its own per-listing rules.' },
  ],
}

/**
 * The channel-scope fixture. Same shape, different coordinate — and it is here because D15.3's
 * claim ("a channel export writes to the listing, not master") is the one an operator cannot verify
 * by looking, and the drawer's job is to make the coordinate visible before they apply.
 *
 * Counted from the cells below: changed 2 (of which 2 pin) · refused 0 · unchanged 4.
 */
export const FIXTURE_DIFF_CHANNEL: FixtureDiff = {
  isFixture: true,
  fixtureNote: FIXTURE_NOTE,
  jobId: 'fixture-preview-channel',
  file: { name: 'GALE-JACKET-AMAZON-IT-2026-09-02.csv', bytes: 6_140, rows: 3, columns: 3 },
  scope: { kind: 'channel', channel: 'AMAZON', marketplace: 'IT', locale: 'it', label: 'Amazon · IT' },
  blankCells: 'ignore',
  counts: { changed: 2, unchanged: 4, refused: 0, wouldPin: 2 },
  coverageNote:
    'Every column in this file is keyed @amazon:IT:it, so every write lands on the Amazon·IT listing. Nothing here writes to the master record.',
  /*
   * On a CHANNEL scope every one of these writes the listing — and `writeVerb` is the detail the
   * sheet contract warns about: the six column-backed fields carry `writeTarget: 'channelListing'`
   * but `writeVerb: 'master'`, because they route by their prefixed NAME and must not also send
   * `target: 'channel'`. Copied faithfully so the fixture cannot teach the drawer a shape the
   * server never sends.
   */
  columns: [
    { key: 'amazon_title', label: 'Title', kind: 'text', editable: true, writeTarget: 'channelListing', writeVerb: 'master' },
    { key: 'amazon_description', label: 'Description', kind: 'longtext', editable: true, writeTarget: 'channelListing', writeVerb: 'master' },
    { key: 'attr_material', label: 'Material', kind: 'text', editable: true, writeTarget: 'channelListing', writeVerb: 'channel' },
  ],
  rows: [
    {
      productId: PARENT,
      aliasKey: '',
      aliasResolved: true,
      sku: 'GALE-JACKET',
      name: 'Gale Jacket',
      line: 2,
      cells: {
        // Both pin: these follow the master today (the six flagged fields), and writing a channel
        // value clears `followMaster*`. This is the single most consequential thing an import can
        // do quietly, which is why the pin count leads the summary.
        amazon_title: changed('Gale Jacket', 'Gale Jacket — Giacca impermeabile', 'Title', true),
        amazon_description: changed(
          'A waterproof shell built for the Italian winter.',
          'Una giacca impermeabile pensata per l’inverno italiano.',
          'Description',
          true,
        ),
        attr_material: same('Poliestere', 'Material'),
      },
    },
    {
      productId: YELLOW_M,
      aliasKey: '',
      aliasResolved: true,
      sku: 'GALE-JACKET-YELLOW-MEN-M',
      name: 'Gale Jacket · Yellow · M',
      line: 3,
      cells: {
        amazon_title: same('Gale Jacket Yellow M', 'Title'),
        amazon_description: same('A waterproof shell built for the Italian winter.', 'Description'),
        attr_material: same('Poliestere', 'Material'),
      },
    },
  ],
}

/**
 * The zero-change fixture — D15.1's acceptance test as a renderable state.
 *
 * "Export a view, re-import it unmodified, zero changes" is the round trip's one invariant, and the
 * day it holds this is what the operator sees. It has its own fixture because a blank grid cannot
 * tell "the round trip is clean" from "the parse produced nothing", and only one of those means the
 * feature works.
 */
export const FIXTURE_DIFF_UNCHANGED: FixtureDiff = {
  isFixture: true,
  fixtureNote: FIXTURE_NOTE,
  jobId: 'fixture-preview-unchanged',
  file: { name: 'GALE-JACKET-master-2026-09-02.csv', bytes: 18_432, rows: 7, columns: 6 },
  scope: { kind: 'master', locale: 'en', label: 'Master' },
  blankCells: 'ignore',
  counts: { changed: 0, unchanged: 36, refused: 0, wouldPin: 0 },
  coverageNote: 'Every cell in this file matches the sheet. This is what a clean export → import round trip looks like.',
  columns: FIXTURE_DIFF_MASTER.columns,
  rows: FIXTURE_DIFF_MASTER.rows.map((row) => ({
    ...row,
    aliasResolved: true,
    cells: Object.fromEntries(
      Object.entries(row.cells).map(([key, cell]) => [key, same(String(cell.before ?? ''), cell.header ?? key)]),
    ),
  })),
}

export function fixtureDiffFor(scope: 'master' | 'channel'): FixtureDiff {
  return scope === 'channel' ? FIXTURE_DIFF_CHANNEL : FIXTURE_DIFF_MASTER
}

/**
 * A job fixture, in whichever state the caller wants to look at.
 *
 * `partial` is the default because it is the state D15.13.5 was ruled for and the one most likely to
 * be rendered carelessly — a fixture that defaults to `completed` would let the careless rendering
 * ship and look right.
 */
export function fixtureJob(state: ImportJob['state'] = 'partial', blankCells: BlankCellMode = 'ignore'): FixtureJob {
  const outcomes: ImportJob['outcomes'] = [
    { rowId: `primary:${PARENT}`, fieldKey: 'name', verdict: 'written' },
    { rowId: `primary:${PARENT}`, fieldKey: 'fabric_type', verdict: 'written' },
    { rowId: `primary:${YELLOW_M}`, fieldKey: 'name', verdict: 'written' },
    { rowId: `primary:${YELLOW_M}`, fieldKey: 'brand', verdict: 'written' },
    { rowId: `primary:${BLACK_XXL}`, fieldKey: 'name', verdict: 'written' },
    {
      rowId: `primary:${PARENT}`,
      fieldKey: 'product_description',
      verdict: 'refused',
      reason: 'Over the 20,000-byte limit for this field (21,884 bytes).',
    },
    {
      rowId: `primary:${BLACK_XXL}`,
      fieldKey: 'country_of_origin',
      verdict: 'refused',
      reason: 'Not one of this field’s accepted values.',
    },
  ]
  return {
    isFixture: true,
    fixtureNote: `This job is a built-in fixture in state “${state}”, not a real import. Nothing has been written.`,
    jobId: 'fixture-job',
    state,
    processed: state === 'queued' ? 0 : state === 'running' ? 3 : 5,
    total: 7,
    outcomes: state === 'queued' ? [] : outcomes,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    note: blankCells === 'clear' ? 'Blank cells in this file cleared the values they sat on.' : null,
  }
}
