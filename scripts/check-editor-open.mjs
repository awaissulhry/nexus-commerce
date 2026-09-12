/**
 * THE OPEN-GESTURE GATE — every gesture that asks a cell to become editable must open an editor,
 * measured in a real browser. Owner's ruling 3 of the 2026-09-03 P0.
 *
 *   node scripts/check-editor-open.mjs [--strict] [EDITOR_ONLY=first|early|settled]
 *
 * ## What it exists to stop coming back
 *
 * The Owner: *"I double-click a cell and sometimes no editor opens."* Measured 2026-09-03: AG
 * parents a 6×6px `.ag-fill-handle` INSIDE the selected cell's bottom-right corner and binds its
 * own `dblclick` beginning `_stopPropagationForAgGrid(e)` — so the cell never sees the gesture. The
 * rest of that handler fills the value down to the LAST ROW OF THE GRID, unconfirmed. Before the
 * fix, one corner double-click on `basePrice` armed **20** `PATCH /api/products/bulk` calls
 * carrying `"0"` onto twenty other rows of the family. Local dev writes PRODUCTION.
 *
 * So this gate asserts two things a green build otherwise says nothing about:
 *   1. an editor's DOM exists within 250 ms of every open gesture, at every hit-point;
 *   2. an open gesture arms NO write. A double-click is not a data change.
 *
 * ## The controls, and why each is here rather than trusted
 *
 *  · **POSITIVE CONTROL, per gesture.** Before every click, `elementFromPoint` must resolve to the
 *    target cell (or to its own fill handle). The first version of this probe had no such control
 *    and reported 0/16 on four columns — the cells were simply SCROLLED OFF SCREEN at x=1622 in a
 *    1600px viewport and the pointer hit nothing. That is "could not measure" wearing the costume
 *    of "measured a failure". An unverified point ABSTAINS, and **abstentions fail the run**: this
 *    gate never reports a pass it did not take.
 *  · **NEGATIVE CONTROL, once per run.** A double-click on a HEADER cell must open nothing. If the
 *    detector reports an editor there, the detector is broken and every green above it is vacuous —
 *    so that inverts the whole run. A check that cannot fail is not passing.
 *  · **WRITE CONTROL.** Every non-GET to the API is aborted at the network layer (the two formula
 *    READ endpoints excepted) and counted. The gate therefore cannot damage the database it is
 *    pointed at, and a re-appearance of the fill-down is a hard failure rather than 20 silent rows.
 *  · **WIRE CONTROL.** `backend-url.ts` falls back to the DEPLOYED Railway API when
 *    `NEXT_PUBLIC_API_URL` is unset, and a dev browser spent ~10 minutes talking to production that
 *    way on 2026-09-03. A run whose page dials anything but the expected host is NOT MEASURED.
 *  · **FOCUS-BROKEN.** `EDITOR_ONLY` narrows the run; anything that runs anyway records itself and
 *    prints a red banner, because a narrowed run that reads like a full one is how a suite quietly
 *    stops asserting things. Skipped blocks are UNRUN, never green.
 *
 * ## The three timings, and why they are these three
 *
 *  · `first`   — the FIRST gesture after rows render, one gesture per page load. This is the arm
 *                that catches most: on a first interaction no fill handle pre-exists, so the first
 *                click of the double-click CREATES the obstacle the second click then lands on, and
 *                before the fix all four column kinds failed here.
 *  · `early`   — a burst starting the moment rows render, spanning the window in which the formula
 *                batch lands and the persisted column state is re-applied.
 *  · `settled` — ≥15 s after load, the state an operator is in for most of a session.
 *
 * ## What a green run does NOT cover, stated plainly
 *
 *  · `kind: 'boolean'` — nothing produces it (the sheet stringifies wire booleans into two-option
 *    selects; the live contract carries 0). It cannot be exercised and is not claimed.
 *  · Columns that arrive `editable: false` (11 of 96 on the fixture) are NOT in the landing view,
 *    so the "a refusal must say why" half of ruling 1 is not measured here.
 *  · The open-gesture timings (`first`/`early`/`settled`) and `geometry` run on master·DE only;
 *    PES.3's `ChannelSheet` shares `NexusGrid` and therefore the fix, but sharing a component is
 *    not a measurement. `contract`, `refused` and `parity` run on all THREE scopes (master·DE,
 *    AMAZON·IT, EBAY·IT) — `parity` because on 2026-09-04 the three sheets differed in header
 *    height, footer, number alignment, required-cell wording and identity header, none by decision.
 */
import { authenticatedStudioPage } from './studio-browser-auth.mjs'
import { chromium } from '@playwright/test'
import { execSync } from 'node:child_process'
import { statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { loadavg } from 'node:os'

const BASE = process.env.EDITOR_BASE ?? 'http://localhost:3000'
const API = process.env.EDITOR_API ?? 'http://127.0.0.1:8091'
const PRODUCT = process.env.EDITOR_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
const MARKET = process.env.EDITOR_MARKET ?? 'DE'
const LOCALE = process.env.EDITOR_LOCALE ?? 'de'
const STUDIO = `${BASE}/products/${PRODUCT}/edit/studio?market=${MARKET}&locale=${LOCALE}`
const STRICT = process.argv.includes('--strict')
const REPS = Number(process.env.EDITOR_REPS ?? 20)
const ROWS_MS = Number(process.env.EDITOR_ROWS_MS ?? 60000)

/**
 * 🔴 The kinds, and the editor mode each MUST open in — mirroring
 * `design-system/grid/editors/openGesture.ts`'s `EDITOR_MODE_BY_KIND`, which carries the reasoning
 * and the one flagged divergence from the ruling's enumeration (select stays a popup: 268 options
 * cannot fit a 110px cell, and inline is the design #461/#484 already rejected).
 *
 * Column ids are the fixture's. A kind whose column is not on screen ABSTAINS loudly rather than
 * passing at 0/0 — the vacuous-green shape this programme has removed three times.
 */
const KINDS = [
  { kind: 'text', colId: 'name', mode: 'inline' },
  { kind: 'longtext', colId: 'item_name', mode: 'popup' },
  { kind: 'number', colId: 'basePrice', mode: 'inline' },
  { kind: 'select', colId: 'status', mode: 'popup' },
]
/** Every gesture the ruling names. `=` is the one that must open the FORMULA popup on every kind. */
const GESTURES = ['dblclick', 'enter', 'f2', 'type', 'equals']
/** Both hit-points. `corner` is the fill handle — the whole defect — and is never optional. */
const SPOTS = ['centre', 'corner']

const TIMINGS = ['first', 'early', 'settled', 'geometry', 'contract', 'refused', 'parity']
const ONLY = (process.env.EDITOR_ONLY ?? '').trim()
if (ONLY && !TIMINGS.includes(ONLY)) {
  console.error(`❌ EDITOR_ONLY="${ONLY}" is not a block. Use ${TIMINGS.join(' | ')}, or unset it for all of them. Refusing rather than silently running everything.`)
  process.exit(2)
}
const RUN = ONLY ? [ONLY] : TIMINGS
/** The open-gesture timings. `geometry` is a separate block with its own loop, below. */
const GESTURE_TIMINGS = RUN.filter((t) => !['geometry', 'contract', 'refused', 'parity'].includes(t))
const focusRan = []
process.on('exit', () => {
  if (ONLY && focusRan.length) {
    console.error(`\n🔴 FOCUS BROKEN — these timings ran despite EDITOR_ONLY=${ONLY}: ${[...new Set(focusRan)].join(', ')}. The banner above is FALSE for this run.`)
  }
})

/**
 * 🔴 THE CAPS ARE READ FROM THE SOURCE, never restated here. A hardcoded copy of a table that lives
 * in the app is a set claim that goes stale in hours — this repo has paid for that more than once —
 * and a gate asserting yesterday's caps passes for the wrong reason. If the parse cannot find them
 * the run FAILS: "the gate could not read what it is asserting" is not a pass.
 */
const CAPS_SOURCE = 'apps/web/src/design-system/grid/editors/editorBox.ts'
/**
 * 🔴 THE CONTRACT TABLE IS THE GATE'S INPUT, not a description of it. Parsed from the document, so
 * there is no second copy to drift from: edit a cell in the doc and the next run asserts the new
 * value. A row the parser cannot understand FAILS rather than being skipped — a contract line the
 * gate quietly ignores is a line nothing enforces.
 */
const CONTRACT_DOC = 'docs/2026-09-03-cell-editing-contract.md'
/** The fixture announcement is found by TOKEN, never by section number — see the note at its use. */
const LEDGER_DOC = 'docs/pes-claims.md'
const FIXTURE_TOKEN = 'FIXTURE-REGISTER-B0-FLUSH'
function readContract() {
  let text
  try { text = readFileSync(CONTRACT_DOC, 'utf8') } catch { return { rows: null, error: `${CONTRACT_DOC} could not be read` } }
  const seg = text.split('<!-- CONTRACT-TABLE-START -->')[1]?.split('<!-- CONTRACT-TABLE-END -->')[0]
  if (!seg) return { rows: null, error: `no CONTRACT-TABLE markers in ${CONTRACT_DOC}` }
  const lines = seg.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'))
  if (lines.length < 3) return { rows: null, error: `the contract table has ${lines.length} lines; expected a header, a rule and at least one row` }
  const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim())
  const header = cells(lines[0])
  const gestures = header.slice(3)
  if (header[0] !== 'kind' || header[1] !== 'state' || header[2] !== 'col' || gestures.length === 0) {
    return { rows: null, error: `unexpected header: ${header.join(' | ')}` }
  }
  const rows = []
  for (const line of lines.slice(2)) {
    const c = cells(line)
    if (c.length !== header.length) return { rows: null, error: `row has ${c.length} cells, header has ${header.length}: ${line}` }
    const expect = {}
    for (let i = 0; i < gestures.length; i++) {
      /* Strip the provenance mark; it is for the reader, not the assertion. An unknown token FAILS. */
      const token = c[3 + i].replace(/[✓·]/g, '').trim()
      if (!/^(inline|pop:text|pop:list|pop:multi|pop:measure|pop:fx|none|none\+say)$/.test(token)) {
        return { rows: null, error: `unknown expectation "${c[3 + i]}" for ${c[0]}/${c[1]}/${gestures[i]}` }
      }
      expect[gestures[i]] = token
    }
    rows.push({ kind: c[0], state: c[1], col: c[2], expect })
  }
  return { rows, gestures }
}
function readCaps() {
  let text
  try { text = readFileSync(CAPS_SOURCE, 'utf8') } catch { return null }
  const block = text.match(/export const EDITOR_CAPS = \{([\s\S]*?)\n\} as const/)
  if (!block) return null
  const caps = {}
  for (const m of block[1].matchAll(/(\w+):\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)/g)) {
    caps[m[1]] = { width: Number(m[2]), height: Number(m[3]) }
  }
  return Object.keys(caps).length ? caps : null
}

const STAMP_FILES = [
  CONTRACT_DOC,
  'apps/web/src/design-system/grid/NexusGrid.tsx',
  'apps/web/src/design-system/grid/editors/openGesture.ts',
  'apps/web/src/design-system/grid/editors/editorBox.ts',
  'apps/web/src/design-system/grid/theme/grid.css',
  'apps/web/src/design-system/grid/hosts/GridSheet.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/master/columns.tsx',
  'scripts/check-editor-open.mjs',
]
/** `HH:MM:SS` — prefixed to every assertion line so a finding can be placed in a time window. */
const at = () => new Date().toTimeString().slice(0, 8)

/**
 * 🔴 WHAT ELSE COULD BE DRIVING THIS PAGE, recorded at the top of every run.
 *
 * On 2026-09-04 three Playwright gates ran against one API inside seven minutes — two sessions each
 * believing the machine was quiet, and a third (this lane) that had not been asked. Two greens would
 * have mutually confirmed a clean gate nobody measured quietly; two reds would have confirmed a
 * regression that was only contention. **No run's log recorded what else was running**, so the whole
 * thing had to be reconstructed from a process table someone happened to capture.
 *
 * 🔴 AND IT IS A STATE, NOT A WINDOW — ce's own correction to their evidence, worth repeating here
 * because this header has the identical limit: a snapshot at start cannot see a run that already
 * exited, nor one that starts a minute later. It narrows the question; it does not answer it. Read
 * it as "at least these, at this instant", never as "these and no others".
 */
const processHeader = () => {
  /* 🔴 PARSE THE FIELDS; NEVER REGEX THE COMPOSED LINE. Three sessions made the same mistake in one
     afternoon: this header counted the `zsh -c` WRAPPER whose command line carries the script name
     (so "another gate is running" fired on every solo run, by construction); ce's proposed fix and
     the hub's both anchored `^node` against a line that begins with the pid, and both returned 0.
     A string that CONTAINS an identity is not an identity — the same lesson as the loopback-form
     alarm. So: split pid / ppid / args and test the FIELDS. */
  let rows = []
  try {
    rows = execSync('ps -Ao pid=,ppid=,args=', { encoding: 'utf8' }).split('\n').map((l) => {
      const m = l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] } : null
    }).filter(Boolean)
  } catch { /* a header that cannot read the table says so below rather than claiming a quiet machine */ }
  const gates = rows.filter((r) => r.args.startsWith('node ') && r.args.includes('check-editor-open.mjs'))
  const gatePids = new Set(gates.map((g) => g.pid))
  /* Browsers by PARENT CHAIN to a live gate, never by the string "chrome": the Owner had 26 helper
     processes of their own browser open, which this header once reported as contention. */
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const descendsFromGate = (r) => {
    for (let cur = r, hops = 0; cur && hops < 12; hops++) {
      if (gatePids.has(cur.ppid)) return true
      cur = byPid.get(cur.ppid)
    }
    return false
  }
  const browsers = rows.filter((r) => descendsFromGate(r) && /Chromium|chrome|firefox|webkit/i.test(r.args))
  console.log(`\n🕐 ${at()} · WHAT ELSE COULD BE SHARING THIS API — a snapshot, not a window`)
  if (rows.length === 0) console.log(`   ⚠ the process table could not be read — this says NOTHING about what else is running`)
  console.log(`   gate processes (node, this script), incl. this one: ${gates.length}`)
  for (const g of gates) console.log(`     pid ${g.pid} ppid ${g.ppid}  ${g.args.slice(0, 110)}`)
  if (gates.length > 1) console.log(`   🔴 ANOTHER GATE IS RUNNING. Two gates against one API are each other's load; a red here may be contention and a green is not a quiet measurement.`)
  console.log(`   browser processes owned by a gate: ${browsers.length}`)
  const orphans = gates.filter((g) => g.ppid === 1)
  if (orphans.length) console.log(`   🔴 ${orphans.length} ORPHANED gate process(es) (ppid 1) — a previous run that did not exit is still holding the page.`)
  /* 🔴 ce's correction, kept verbatim because it is the truest sentence in this header: a `ps`
     records a STATE, not a WINDOW. It cannot see a run that already exited, nor one that starts a
     minute later. Read this as "at least these, at this instant" — never "these and no others". */
  console.log(`   (a snapshot cannot see a run that already exited or one that starts later — read as "at least these, at this instant")`)
}

const buildStamp = () => {
  console.log('\n📌 BUILD STAMP — every file whose change can invalidate a reading below (sha1, first 8):')
  for (const f of STAMP_FILES) {
    try {
      const t = statSync(f).mtime
      const sha = createHash('sha1').update(readFileSync(f)).digest('hex').slice(0, 8)
      console.log(`   ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}  sha1:${sha}  ${f}`)
    } catch { console.log(`   ????????  ${f}  — MISSING: the stamp is incomplete`) }
  }
}

/* ── liveness. Report the OBSERVATION, never a conclusion the check cannot support. ───────────── */
const t0 = Date.now()
const live = await fetch(STUDIO, { signal: AbortSignal.timeout(ROWS_MS) })
  .then((r) => ({ ok: r.ok, how: r.ok ? 'ok' : `answered HTTP ${r.status}` }))
  .catch((e) => ({ ok: false, how: e?.name === 'TimeoutError' || /timeout/i.test(String(e?.message))
    ? 'timed out'
    : /ECONNREFUSED|fetch failed/i.test(`${e?.cause?.code ?? ''} ${e?.message ?? ''}`)
      ? 'CONNECTION REFUSED — nothing is listening'
      : `failed: ${String(e?.message ?? e).slice(0, 80)}` }))
if (!live.ok) {
  const waited = ((Date.now() - t0) / 1000).toFixed(1)
  const msg = `open-gesture gate: ${BASE} ${live.how} after ${waited}s — NOT MEASURED (load ${loadavg()[0].toFixed(2)}). ` +
    `Check \`lsof -iTCP:3000 -sTCP:LISTEN\`. A busy box has served this route in minutes; raise EDITOR_ROWS_MS.`
  if (STRICT) { console.error(`❌ ${msg}`); process.exit(1) }
  console.warn(`⚠️  SKIPPED — ${msg}`)
  process.exit(2)
}

buildStamp()
processHeader()
if (ONLY) {
  console.log(`\n🔎 FOCUSED RUN — EDITOR_ONLY=${ONLY}. The other timings are NOT RUN and therefore NOT PASSING:`)
  for (const t of TIMINGS.filter((t) => t !== ONLY)) console.log(`     · ${t}`)
  console.log(`   Do not quote this run as a gate pass.`)
}

const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1600, height: 1000 } }).catch(async error => { await browser.close(); console.error(error.message); process.exit(2) })

const LOOPBACK = new Set(['localhost','127.0.0.1','::1','[::1]','0.0.0.0'])
const hostKey = (u) => { try { const x = new URL(u); return `${LOOPBACK.has(x.hostname) ? 'loopback' : x.hostname}:${x.port}` } catch { return null } }
const expectedApi = hostKey(API)
const apiHosts = new Set()
let inFlight = 'load'
const armedWrites = []
/**
 * 🔴 A WRITE IS CLASSIFIED BY PATH, NOT BY "NOT A GET".
 *
 * The first version counted every non-GET outside the two formula reads as a write, aborted it, and
 * tallied it. That swept up Next's own dev tooling — `POST /__nextjs_original-stack-frames`, the
 * dev-overlay's source-map request — which is not a write, is not on the API, and being aborted can
 * break the overlay the gate is running inside. A gate that damages the page it is measuring is
 * measuring a page nobody else has.
 *
 * So: a WRITE is a non-GET to the API host under `/api/`. Everything else — dev tooling, telemetry,
 * anything on the web origin — passes through untouched and uncounted.
 */
const isApiWrite = (method, url) => {
  if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') return false
  if (hostKey(url) !== expectedApi) return false
  let path
  try { path = new URL(url).pathname } catch { return false }
  if (!path.startsWith('/api/')) return false
  /* The two formula endpoints are POST-shaped READS the sheet needs to paint its ƒ marks. */
  if (/^\/api\/pim\/formulas\/(batch|preview)$/.test(path)) return false
  return true
}
await page.route('**/*', async (r) => {
  const req = r.request(), m = req.method(), u = req.url()
  const h = hostKey(u)
  if (h && h !== hostKey(BASE) && !/cloudinary|media-amazon|fonts\./.test(u)) apiHosts.add(h)
  /* 🔴 THE STUB IS TESTED FIRST, and the order is the bug it fixes. The formula batch is
     deliberately classified as a READ, so `!isApiWrite` returns early — a stub placed below that
     line is DEAD CODE. Mine was, and it served 0× while the arm reported the sheet had rendered
     nothing: a check that never runs, the same family as a CSS rule bound to no element and a
     warning that always fires. */
  if (stubRefused && /\/api\/pim\/formulas\/batch$/.test(u)) {
    const { productId, fieldKey, expr, lastError } = stubRefused
    stubServed++
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ formulas: { [productId]: { [fieldKey]: { productId, fieldKey, expr, lastError } } } }) })
  }
  if (!isApiWrite(m, u)) return r.continue()
  const record = { during: inFlight, req: `${m} ${u.replace(/^https?:\/\/[^/]+/, '')}`, body: (req.postData() ?? '').slice(0, 200) }
  /* 🔴 EXACTLY ONE expected write per flush row, and only while this gate is holding the window
     open. The first API write inside that window is the save this gate deliberately caused; it is
     held forever, so the client believes it is saving and the request never completes. A SECOND
     write in the same window is not expected and is recorded as a failure like any other — "one
     expected" is asserted, not assumed. */
  if (heldFlush && expectingHeldWrite) {
    expectingHeldWrite = false
    expectedHeld.push(record)
    return new Promise(() => {})
  }
  armedWrites.push(record)
  return r.abort()
})

const EDITOR_SEL = '.ag-cell-inline-editing, .ag-popup-editor'
/**
 * 🔴 EVERY SHAPE IS MATCHED ON ITS OWN MARKER, and an unmatched popup is `popup:UNCLASSIFIED`,
 * never quietly attributed to whichever branch happens to be last. The first draft of this fell
 * through to `popup:formula` and reported four clean `agLargeTextCellEditor` opens as the formula
 * editor — a default that made one shape unfalsifiable, which is the same class of error as a
 * gate that cannot go red. Markers read from the components: `.nds-formula-editor`
 * (`FormulaCellEditor`), `ListboxPanel` (`SelectPanelEditor`), AG's own `.ag-large-text-input`.
 */
const shapeOf = () => {
  const p = document.querySelector('.ag-popup-editor')
  if (!p) return document.querySelector('.ag-cell-inline-editing') ? 'inline' : 'NONE'
  if (p.querySelector('.nds-formula-editor')) return 'popup:formula'
  if (p.querySelector('.ag-large-text-input')) return 'popup:largetext'
  /* AM.1 shapes BEFORE the listbox test: the list editor contains an option list and would read as
     the single select. Markers read from the components (`ListPanelEditor`, `MeasureEditor`). */
  if (p.querySelector('.nds-list-editor')) return 'popup:multi'
  if (p.querySelector('.nds-measure-editor')) return 'popup:measure'
  if (p.querySelector('[role="listbox"], [class*="listbox"], [class*="Listbox"]')) return 'popup:listbox'
  return 'popup:UNCLASSIFIED:' + (p.firstElementChild?.className || '?').toString().split(' ')[0].slice(0, 24)
}
const idle = () => ({ n: document.querySelectorAll('.ag-cell-inline-editing, .ag-popup-editor').length })
const escape_ = async () => {
  for (let i = 0; i < 4; i++) {
    if ((await page.evaluate(idle)).n === 0) return true
    await page.keyboard.press('Escape')
    await page.waitForTimeout(70)
  }
  return (await page.evaluate(idle)).n === 0
}
/**
 * 🔴 EVERY column of the row, not the ones that happen to be in the DOM right now.
 *
 * AG VIRTUALISES COLUMNS: only the columns intersecting the viewport exist as elements. A single
 * un-scrolled `querySelectorAll` therefore answers "is column X on this sheet?" with "is it under
 * the viewport at this instant?", which is a different question. Asking the wrong one made this gate
 * report `could not bring a column on screen` five times on columns that were present, and — worse —
 * made this lane report a RESTORED column as lost and file a regression against the Owner's item 44
 * that did not exist. It is #771's own trap ("the scan never reached maxScroll, where the last
 * column lives").
 *
 * So: scroll to the right edge, snapshot, scroll back to the left edge, snapshot, and union. The
 * scroll is restored afterwards so the caller's geometry is untouched.
 */
const renderedCols = async (rowId) => {
  const snap = () => page.evaluate((rid) =>
    [...document.querySelectorAll(`.ag-row[row-id="${rid}"] .ag-cell[col-id]`)].map((c) => c.getAttribute('col-id')), rowId)
  const setScroll = (to) => page.evaluate((t) => {
    const v = document.querySelector('.ag-grid-viewport, .ag-body-horizontal-scroll-viewport')
    if (v) v.scrollLeft = t === 'max' ? v.scrollWidth : 0
  }, to)
  /* 🔴 The WHOLE width, not the two ends. Two snapshots (0 and max) were enough for a 96-column sheet;
     AM.1's 192 columns are ~25,000px wide and everything between the ends read as "not rendered", which
     sent every middle column down the Customise-reveal path and failed it (2026-09-05 02:18). Each step
     reads the position BACK — a write the scroller ignores must not count as a step taken. */
  const seen = new Set(await snap())
  const dims = await page.evaluate(() => {
    const v = document.querySelector('.ag-grid-viewport, .ag-body-horizontal-scroll-viewport')
    return v ? { w: v.clientWidth, max: v.scrollWidth } : null
  })
  if (dims) {
    const step = Math.max(200, Math.round(dims.w * 0.7))
    for (let x = step; x <= dims.max + step; x += step) {
      const at = await page.evaluate((left) => {
        const v = document.querySelector('.ag-grid-viewport, .ag-body-horizontal-scroll-viewport')
        if (!v) return -1
        v.scrollLeft = left
        return v.scrollLeft
      }, Math.min(x, dims.max))
      if (at < 0) break
      await page.waitForTimeout(320)
      for (const c of await snap()) seen.add(c)
      if (at >= dims.max - 1) break
    }
  }
  await setScroll(0); await page.waitForTimeout(350)
  for (const c of await snap()) seen.add(c)
  return [...seen]
}

/**
 * Scroll until the cell for `colId` actually EXISTS, and leave it there.
 *
 * 🔴 Detecting a column and being able to act on it are different problems, and fixing only the
 * first broke the second: `renderedCols` ends at scrollLeft 0, so a far-right target that it had
 * just proven present was gone from the DOM by the time the gesture ran ("vanished after
 * resolution", 10 rows). Virtualisation means a locator cannot scroll to something that does not
 * exist — the GRID has to be moved first. Steps by ~80% of the viewport so no column is skipped.
 */
const bringOnScreen = async (rowId, colId) => {
  /* 🔴 PRESENT IS NOT VISIBLE. This asked only whether the cell EXISTS, and AG renders a buffer of
     columns beyond the viewport — so it returned true for a cell sitting off the right edge, callers
     clicked at a coordinate outside the window, and the failure surfaced as "the fixture cell did
     not open" when the cell had never been clicked at all. Third instance today of existence being
     mistaken for the thing itself (a column present but unscrolled; a rule declared but unbound; a
     cell rendered but off screen). The predicate is now VISIBILITY: in the DOM *and* inside the
     viewport with room for a click. */
  /* 🔴 THE PREDICATE IS `elementFromPoint` AT THE POINT THE CALLER WILL CLICK — not existence, and
     not geometry either. Geometry was my second wrong answer in five minutes: requiring the whole
     rect inside the viewport is both too strict (a wide cell never qualifies) and still wrong, since
     the sheet's PINNED IDENTITY BAND overlays the left ~445px and a cell can sit at left ≥ 0 and
     still be underneath it — which the run then reported as "the point is over ag-Grid-AutoColumn".
     Asking the browser what is actually at the click point answers existence, viewport clipping and
     overlay in one question, and it is the same question `fire()` asks, so the two cannot disagree. */
  const here = async () => page.evaluate(([rid, cid]) => {
    const el = document.querySelector(`.ag-row[row-id="${rid}"] .ag-cell[col-id="${cid}"]`)
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 4) return false
    const x = r.left + Math.min(r.width * 0.4, 30)
    const y = r.top + r.height * 0.5
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false
    const hit = document.elementFromPoint(x, y)
    return !!hit && hit.closest('.ag-cell[col-id]')?.getAttribute('col-id') === cid
  }, [rowId, colId])
  if (await here()) return true
  const width = await page.evaluate(() => {
    const v = document.querySelector('.ag-grid-viewport, .ag-body-horizontal-scroll-viewport')
    return v ? { w: v.clientWidth, max: v.scrollWidth } : null
  })
  if (!width) return false
  const step = Math.max(200, Math.round(width.w * 0.7))
  for (let x = 0; x <= width.max; x += step) {
    await page.evaluate((left) => {
      const v = document.querySelector('.ag-grid-viewport, .ag-body-horizontal-scroll-viewport')
      if (v) v.scrollLeft = left
    }, x)
    /* 320ms, not 180: with 192 columns AG needs longer to place the virtualised cells after a scroll
       (basePrice at ~20,000px read "could not be scrolled" at 180ms on 2026-09-05). */
    await page.waitForTimeout(320)
    if (await here()) return true
  }
  return false
}

/**
 * Put ONE save in flight, on the announced XAVIA fixture cell, and leave it hanging.
 *
 * The value is distinct per call because `writeGate.sameValue` drops a re-typed identical value —
 * that rule is correct and it is also what made this lane read "Tab silently discards edits" from
 * four contaminated trials. A flush row that armed nothing would be a `settled` row wearing a
 * different label.
 */
const FLUSH_FIXTURE_COL = 'name'
let flushSeq = 0
const armHeldSave = async (rowId) => {
  if (!(await bringOnScreen(rowId, FLUSH_FIXTURE_COL))) return { ok: false, why: `${FLUSH_FIXTURE_COL} could not be brought on screen` }
  const cell = page.locator(`.ag-row[row-id="${rowId}"] .ag-cell[col-id="${FLUSH_FIXTURE_COL}"]`).first()
  let b = await cell.boundingBox({ timeout: 2500 }).catch(() => null)
  if (!b) return { ok: false, why: `${FLUSH_FIXTURE_COL} has no box` }
  /* 🔴 THE SAME POSITIVE CONTROL `fire()` HAS, AND ITS ABSENCE HERE IS WHY THIS FAILED.
     I wrote this helper to click a cell and never checked what was under the pointer — the exact
     artefact that already cost this programme two false readings (a 0/16 sweep on cells that were
     off screen, and a row of ABSTAINs where the pinned identity band covered the target). ce's run
     showed the failures arriving as a PREFIX — text ✗, longtext ✗, number ✓, select ✓, same cell,
     in execution order — which is first-interaction shaped, not exhaustion: the earlier rows had not
     yet scrolled the sheet to a position where `name` clears the pinned band. A helper that clicks
     without aiming is a helper that reports "the cell did not open" when it never hit the cell. */
  const aim = async () => page.evaluate(([x, y, col]) => {
    const e = document.elementFromPoint(x, y)
    if (!e) return { ok: false, over: 'nothing (off screen?)' }
    const cellEl = e.closest('.ag-cell[col-id]')
    return { ok: !!cellEl && cellEl.getAttribute('col-id') === col, over: cellEl?.getAttribute('col-id') ?? (e.className || e.tagName).toString().split(' ')[0] }
  }, [b.x + Math.min(b.width * 0.4, 30), b.y + b.height * 0.5, FLUSH_FIXTURE_COL])
  let ctl = await aim()
  if (!ctl.ok) {
    await page.mouse.wheel(-320, 0)
    await page.waitForTimeout(250)
    const nb = await cell.boundingBox({ timeout: 2500 }).catch(() => null)
    if (nb) { b = nb; ctl = await aim() }
  }
  if (!ctl.ok) return { ok: false, why: `the point is over ${ctl.over}, not ${FLUSH_FIXTURE_COL} — the fixture cell was never clicked` }
  await page.mouse.dblclick(b.x + Math.min(b.width * 0.4, 30), b.y + b.height * 0.5)
  const opened = await page.waitForFunction((s2) => document.querySelector(s2), EDITOR_SEL, { timeout: 600, polling: 'raf' }).then(() => true).catch(() => false)
  if (!opened) return { ok: false, why: `the fixture cell did not open (pointer was over ${ctl.over})` }
  const before = expectedHeld.length
  expectingHeldWrite = true
  await page.keyboard.type(`ZZGATE-FLUSH-${++flushSeq}`, { delay: 10 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  if (expectedHeld.length === before) {
    expectingHeldWrite = false
    return { ok: false, why: 'no save was armed — the flush state was NOT produced' }
  }
  return { ok: true }
}

const load = async () => {
  inFlight = 'load'
  await page.goto(STUDIO, { waitUntil: 'domcontentloaded' })
  const ok = await page.waitForFunction(() => document.querySelectorAll('.ag-row[row-id]').length > 0, null, { timeout: ROWS_MS }).then(() => true).catch(() => false)
  if (!ok) return null
  return page.evaluate(() => document.querySelector('.ag-grid-scrolling-container .ag-row[row-id]')?.getAttribute('row-id') ?? null)
}

/** One gesture, with its positive control. Returns `{opened, shape}` or `{abstain}`. */
async function fire(rowId, colId, gesture, spot) {
  const loc = page.locator(`.ag-row[row-id="${rowId}"] .ag-cell[col-id="${colId}"]`).first()
  if (!(await loc.count())) return { abstain: `column ${colId} is not on the sheet` }
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  const b = await loc.boundingBox()
  if (!b) return { abstain: `column ${colId} has no box` }
  let x = spot === 'corner' ? b.x + b.width - 3 : b.x + Math.min(b.width * 0.4, 40)
  let y = spot === 'corner' ? b.y + b.height - 3 : b.y + b.height * 0.5
  const aim = async (x, y) => page.evaluate(([x, y, colId]) => {
    const e = document.elementFromPoint(x, y)
    if (!e) return { ok: false, why: 'the point is over nothing — off screen?' }
    if ((e.className || '').toString().includes('ag-fill-handle')) return { ok: true, on: 'fill-handle' }
    const cell = e.closest('.ag-cell[col-id]')
    if (!cell) return { ok: false, why: `the point is over ${(e.className || e.tagName).toString().split(' ')[0]}, not a cell` }
    const got = cell.getAttribute('col-id')
    return got === colId ? { ok: true, on: 'cell' } : { ok: false, why: `the point is over cell ${got}, not ${colId}` }
  }, [x, y, colId])
  let ctl = await aim(x, y)
  /* 🔴 ONE re-aim, then abstain. `scrollIntoViewIfNeeded` parks a column at the viewport's left
     edge, where the sheet's PINNED IDENTITY BAND covers it — UX.1 measured that the trailing panel
     width of this sheet is permanently coverable, and the same is true of the leading pinned block.
     A covered cell is "could not measure", not "does not open", and the two must never share an
     appearance: so the grid is nudged clear and the control is asked AGAIN. It is the control that
     decides, never the retry — a second failure still abstains, and an abstention still fails the
     run. */
  if (!ctl.ok) {
    await page.mouse.wheel(-320, 0)
    await page.waitForTimeout(180)
    const nb = await loc.boundingBox()
    if (!nb) return { abstain: `${ctl.why}; after a nudge the cell had no box` }
    x = spot === 'corner' ? nb.x + nb.width - 3 : nb.x + Math.min(nb.width * 0.4, 40)
    y = spot === 'corner' ? nb.y + nb.height - 3 : nb.y + nb.height * 0.5
    ctl = await aim(x, y)
  }
  if (!ctl.ok) return { abstain: ctl.why }
  if (gesture === 'dblclick') await page.mouse.dblclick(x, y)
  else {
    await page.mouse.click(x, y)
    await page.waitForTimeout(40)
    await page.keyboard.press(gesture === 'enter' ? 'Enter' : gesture === 'f2' ? 'F2' : gesture === 'type' ? 'a' : '=')
  }
  const opened = await page.waitForFunction((s) => document.querySelector(s), EDITOR_SEL, { timeout: 250, polling: 'raf' })
    .then(() => true).catch(() => false)
  if (opened) await page.waitForTimeout(120)
  return { opened, shape: opened ? await page.evaluate(shapeOf) : 'NONE', on: ctl.on }
}

const failures = []
let geometryMeasured = 0
let parityChecked = 0
let contractChecked = 0
let refusedChecked = 0
/** Set while a contract `flush` row is being driven: the writer's PATCH is HELD open, never sent. */
let heldFlush = false
/**
 * 🔴 #780's REFUSED state, produced ON THE WIRE instead of in the database.
 *
 * A refusal only renders at rest if a stored formula carries a `lastError`, and that state is
 * TEMPORARY by its own restore plan — so a gate arm depending on a real one either writes to
 * production on every push or passes vacuously the rest of the time. Both were on the table and
 * both are the trap this suite keeps removing. The gate already owns the network layer, and the
 * state only has to exist ON THE WIRE: `POST /pim/formulas/batch` is fulfilled with a synthetic row
 * carrying an `expr` and a `lastError` in the server's own sentence shape, and the sheet is then
 * held to what it renders. No write, no fixture, no vacuity, every run.
 *
 * What this proves and what it does NOT: it proves THIS CLIENT renders a refusal correctly. It does
 * not prove the server ever emits that shape — that is ce's suite, and the one-off real reading in
 * the ledger. Two claims, and the stub only makes one of them.
 */
let stubRefused = null
let stubServed = 0
/**
 * 🔴 THE `flush` STATE HAS TO BE PRODUCED, NOT DECLARED (hub #785).
 *
 * The doc says a `flush` row runs "while a save is in flight". It did not: the tally showed 0 armed
 * writes for the whole run, so `heldFlush` never had a request to hold and those six rows were
 * exercising exactly what `settled` exercises — passing for the wrong reason since they were
 * written. Producing the state honestly means ARMING one write per flush row, which collides with
 * "any armed API write fails the run", so the two tallies are kept apart: an EXPECTED held write is
 * the one this gate deliberately caused and is holding open forever; anything else is a failure.
 *
 * The write never completes, so nothing reaches the database either way — the same guarantee the
 * abort gives, by a different mechanism.
 */
const expectedHeld = []
/** True only inside the window where this gate has deliberately caused one save. */
let expectingHeldWrite = false
const abstentions = []
const results = []

/**
 * 🔴 THE PLAN IS THE COVERAGE CLAIM, so it is built rather than derived from a modulus.
 *
 * The first version rotated `GESTURES[i % 5]` against `SPOTS[floor(i/5) % 2]`, which at
 * `EDITOR_REPS=5` produced five CENTRE gestures and never once touched the corner — i.e. a green
 * run that could not have caught the very defect this gate exists for. The arm that would have
 * failed was the one never run.
 *
 * `CYCLE` is the full matrix: every gesture × every hit-point, 10 pairs. `EDITOR_REPS` must be a
 * positive multiple of 10 so each pair is exercised the same number of times; anything else
 * REFUSES rather than under-covering quietly. The default 20 gives the ruling's "20× on each
 * column kind" as two passes over the complete matrix.
 */
const CYCLE = GESTURES.flatMap((gesture) => SPOTS.map((spot) => ({ gesture, spot })))
if (!Number.isInteger(REPS) || REPS < CYCLE.length || REPS % CYCLE.length !== 0) {
  console.error(`❌ EDITOR_REPS=${process.env.EDITOR_REPS ?? REPS} cannot cover the matrix. It must be a positive multiple of ${CYCLE.length} (${GESTURES.length} gestures × ${SPOTS.length} hit-points) so no gesture/hit-point pair is silently skipped. Refusing rather than reporting a partial run as a pass.`)
  process.exit(2)
}
const plan = (i) => CYCLE[i % CYCLE.length]

for (const timing of GESTURE_TIMINGS) {
  if (ONLY && timing !== ONLY) focusRan.push(timing)
  console.log(`\n── ${timing}${timing === 'first' ? ' (one gesture per page load — the arm the defect lived in)' : ''}`)
  let rowId = null
  if (timing !== 'first') {
    rowId = await load()
    if (!rowId) { failures.push(`${timing}: NOT MEASURED — no rows rendered within ${ROWS_MS}ms`); continue }
    if (timing === 'settled') await page.waitForTimeout(15000)
  }
  for (const k of KINDS) {
    let opened = 0, n = 0, abst = 0, wrote = 0
    const shapes = new Map()
    for (let i = 0; i < REPS; i++) {
      const { gesture, spot } = plan(i)
      if (timing === 'first') {
        rowId = await load()
        if (!rowId) { abst++; abstentions.push(`${timing}/${k.kind}: no rows rendered`); continue }
      } else if (!(await escape_())) {
        abst++; abstentions.push(`${timing}/${k.kind}/${gesture}: an editor from the previous gesture would not close`); continue
      }
      const before = armedWrites.length
      inFlight = `${timing}/${k.kind}/${gesture}/${spot}/${i}`
      const res = await fire(rowId, k.colId, gesture, spot)
      if (res.abstain) { abst++; abstentions.push(`${timing}/${k.kind}/${gesture}/${spot}: ${res.abstain}`); continue }
      n++
      if (res.opened) opened++
      else failures.push(`${timing} · ${k.kind} (${k.colId}) · ${gesture} · ${spot}${res.on === 'fill-handle' ? ' (ON THE FILL HANDLE — the 2026-09-03 P0)' : ''}: NO EDITOR within 250ms`)
      shapes.set(res.shape, (shapes.get(res.shape) ?? 0) + 1)
      /* Ruling 2: the same column always opens the same way. `=` is always the formula popup. */
      const want = gesture === 'equals' ? 'popup:formula' : k.mode === 'inline' ? 'inline' : k.kind === 'longtext' ? 'popup:largetext' : 'popup:listbox'
      if (res.opened && res.shape !== want) failures.push(`${timing} · ${k.kind} · ${gesture} · ${spot}: opened ${res.shape}, expected ${want} (one editor mode per kind — ruling 2)`)
      await escape_()
      await page.waitForTimeout(300) // let a debounced writer flush before we attribute
      if (armedWrites.length > before) {
        wrote += armedWrites.length - before
        failures.push(`${timing} · ${k.kind} (${k.colId}) · ${gesture} · ${spot}: the gesture ARMED ${armedWrites.length - before} write(s). An open gesture is not a data change.`)
      }
    }
    results.push({ timing, kind: k.kind, colId: k.colId, opened, n, abst, wrote, shapes })
    const bar = n > 0 && opened === n && wrote === 0 && abst === 0 ? '✅' : '❌'
    console.log(`   ${at()} ${bar} ${k.kind.padEnd(9)} ${k.colId.padEnd(12)} opened ${String(opened).padStart(2)}/${String(n).padStart(2)}   ` +
      `${[...shapes].map(([s, c]) => `${s}×${c}`).join(' ').padEnd(30)} writes-armed ${wrote}${abst ? `   ABSTAINED ${abst}` : ''}`)
  }
}

/* ── GEOMETRY: the Owner's Phase 1 rule, at three widths, on the rightmost visible column. ─────
 *
 * The rule (`docs/2026-09-03-cell-editor-approach.md`):
 *   width = clamp(cellWidth, contentWidth, min(cap, roomToRight)) · the top-left is PINNED to the
 *   cell and never slides · the origin cell stays visible and outlined as "editing".
 *
 * 🔴 EACH KIND IS PARKED AGAINST THE RIGHT EDGE ON PURPOSE. A popup only detaches when it is wider
 * than the room to its right, so a reading taken mid-sheet passes on every build, broken or not.
 * The first version of this block walked the rightmost cells and took whatever kinds it happened to
 * meet — it measured `select` and `formula` three times and **never once reached `longtext`, the
 * editor the −202px defect actually lived in**, and still printed PASSED. A gate that can miss the
 * defect it was written for is worse than none, so every kind is now driven to the hard position by
 * name, and a kind that cannot be measured FAILS the run rather than being noted.
 *
 * 1728 / 1440 / 1280 because the room is a function of the viewport, and the original readings were
 * taken at one of them.
 */
if (RUN.includes('geometry')) {
  console.log(`\n── geometry (the sizing rule, each kind parked against the right edge)`)
  const caps = readCaps()
  /** kind → a column that opens that editor, and the gesture that opens it. */
  const GEOMETRY_TARGETS = [
    { kind: 'longtext', colId: 'product_description', gesture: 'dblclick' },
    { kind: 'select', colId: 'status', gesture: 'dblclick' },
    { kind: 'formula', colId: 'name', gesture: 'equals' },
  ]
  if (!caps) {
    failures.push(`geometry: NOT MEASURED — could not read EDITOR_CAPS from ${CAPS_SOURCE}. The gate cannot assert a cap it could not read.`)
    console.log(`   ❌ could not read the caps from ${CAPS_SOURCE}`)
  } else {
    console.log(`   caps read from source: ${Object.entries(caps).map(([k, c]) => `${k} ${c.width}×${c.height}`).join(' · ')}`)
    for (const vw of [1728, 1440, 1280]) {
      await page.setViewportSize({ width: vw, height: 1000 })
      const rowId = await load()
      if (!rowId) { failures.push(`geometry@${vw}: NOT MEASURED — no rows rendered`); continue }
      await page.waitForTimeout(1200)
      for (const t of GEOMETRY_TARGETS) {
        await escape_()
        const sel = `.ag-row[row-id="${rowId}"] .ag-cell[col-id="${t.colId}"]`
        const loc = page.locator(sel).first()
        if (!(await loc.count())) { failures.push(`geometry@${vw} · ${t.kind}: NOT MEASURED — column ${t.colId} is not on the sheet`); continue }
        /* 🔴 PARK IT AGAINST THE RIGHT EDGE BY COMPUTING THE OFFSET, not by stepping blindly.
           AG VIRTUALISES COLUMNS: scrolling fully right removes `product_description` from the DOM
           altogether, and the first version of this then hung 30s on a `boundingBox()` for a cell
           that no longer existed — while reporting "not parked at the edge" for the two kinds it did
           reach, i.e. measuring the easy position and calling it the hard one.
           `page.mouse.wheel(+dx)` moves content LEFT (x decreases), so reaching a target x needs a
           wheel of -(target - current). Two passes because one wheel can be clamped by the end of
           the scroll range. */
        const box2 = async () => loc.boundingBox({ timeout: 2500 }).catch(() => null)
        await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(200)
        const targetX = vw - 300
        let parked = false
        for (let pass = 0; pass < 3; pass++) {
          const b0 = await box2()
          if (!b0) { await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(200); continue }
          if (Math.abs(b0.x - targetX) <= 40) { parked = true; break }
          await page.mouse.move(Math.round(vw / 2), 500)
          await page.mouse.wheel(-Math.round(targetX - b0.x), 0)
          await page.waitForTimeout(350)
        }
        const b = await box2()
        if (!b) { failures.push(`geometry@${vw} · ${t.kind}: NOT MEASURED — ${t.colId} left the DOM (AG virtualises columns) and could not be brought back`); continue }
        /* 🔴 THE ACCEPTANCE CRITERION IS "DOES THE ROOM TERM BIND", NOT A PIXEL TARGET.
           A reading only tests this fix where `roomToRight < cap` — that is precisely the condition
           under which the old code widened past the window and AG slid the popup sideways. Anywhere
           else the editor fits at its cap and every build passes, broken or not.
           My first criterion was "x within 40px of `vw - 300`", and it rejected a perfectly valid
           1728 reading (room 414 < the 560 cap, so the term bound) purely because the sheet ran out
           of columns before that pixel. The pixel was a proxy; this is the thing itself. */
        const roomHere = vw - b.x
        const capHere = caps[t.kind]?.width ?? 0
        const binds = roomHere < capHere
        if (!binds) failures.push(`geometry@${vw} · ${t.kind}: NOT MEASURED AT THE EDGE — ${t.colId} parked at x=${Math.round(b.x)} leaves ${Math.round(roomHere)}px, which is not below the ${capHere}px cap, so the room term does not bind and this reading cannot fail.`)
        const x = b.x + Math.min(b.width * 0.4, 30), y = b.y + b.height * 0.5
        const aimed = await page.evaluate(([x, y, col]) =>
          document.elementFromPoint(x, y)?.closest('.ag-cell[col-id]')?.getAttribute('col-id') === col, [x, y, t.colId])
        if (!aimed) { failures.push(`geometry@${vw} · ${t.kind}: NOT MEASURED — the point is not over ${t.colId}`); continue }
        if (t.gesture === 'dblclick') await page.mouse.dblclick(x, y)
        else { await page.mouse.click(x, y); await page.waitForTimeout(40); await page.keyboard.press('=') }
        const opened = await page.waitForFunction((s2) => document.querySelector(s2), EDITOR_SEL, { timeout: 500, polling: 'raf' }).then(() => true).catch(() => false)
        if (!opened) { failures.push(`geometry@${vw} · ${t.kind}: no editor opened on ${t.colId}`); await escape_(); continue }
        await page.waitForTimeout(200)
        const m = await page.evaluate(() => {
          const p2 = document.querySelector('.ag-popup-editor')
          if (!p2) return { inline: true }
          const cell = document.querySelector('.ag-cell.ag-cell-popup-editing')
          const pr = p2.getBoundingClientRect(), cr = cell?.getBoundingClientRect()
          const val = cell?.querySelector('.nds-cell-value')
          const kind = p2.querySelector('.nds-formula-editor') ? 'formula'
            : p2.querySelector('.ag-large-text-input') ? 'longtext'
            : p2.querySelector('[role="listbox"], [class*="istbox"]') ? 'select' : 'UNCLASSIFIED'
          return { inline: false, kind,
            px: Math.round(pr.x), pw: Math.round(pr.width), pright: Math.round(pr.right),
            cx: cr ? Math.round(cr.x) : null, cw: cr ? Math.round(cr.width) : null,
            under: cr ? pr.y >= cr.y + cr.height - 2 : false,
            valueVisibility: val ? getComputedStyle(val).visibility : null,
            outlineWidth: cell ? parseFloat(getComputedStyle(cell).outlineWidth) || 0 : 0,
            cellText: (cell?.innerText || '').trim(),
            /* 🔴 Read HERE, inside the same evaluate, because the editor is still open. My first
               version queried the textarea after `escape_()` had closed the popup and reported "the
               selector has moved" three times — an assertion that cannot see its subject. It failed
               loudly rather than passing vacuously, which is the only reason it was caught. */
            ta: (() => {
              const el = p2.querySelector('.ag-text-area-input')
              if (!el) return { found: false }
              const outer = p2.querySelector('.ag-large-text')
              const rr = el.getBoundingClientRect(), oo = outer?.getBoundingClientRect()
              return { found: true, resize: getComputedStyle(el).resize,
                taH: Math.round(rr.height), outerH: oo ? Math.round(oo.height) : null }
            })() }
        })
        await escape_()
        const tag = `geometry@${vw} · ${t.kind} (${t.colId})`
        if (m.inline) { failures.push(`${tag}: opened INLINE where a popup was expected`); continue }
        if (m.kind !== t.kind) { failures.push(`${tag}: opened ${m.kind}, expected ${t.kind}`); continue }
        const cap = caps[m.kind]
        const problems = []
        /* 1. FLUSH: the top-left is pinned to the cell. 1px of rounding allowed, no more. */
        if (m.cx == null || Math.abs(m.px - m.cx) > 1) problems.push(`NOT FLUSH: popup.x=${m.px} vs cell.x=${m.cx} (Δ${m.cx == null ? '?' : m.px - m.cx}) — the 2026-09-03 displacement`)
        /* 2. Inside the window: nothing may be edited off screen. */
        if (m.pright > vw + 1) problems.push(`right edge ${m.pright} beyond the viewport ${vw}`)
        /* 3. No editor wider than its cap — read from source, never restated here. */
        if (!cap) problems.push(`no cap declared for kind "${m.kind}"`)
        else if (m.pw > cap.width + 1) problems.push(`width ${m.pw} exceeds the ${m.kind} cap ${cap.width}`)
        /* 🔴 4. Owner item 52(a): the long-text editor is ONE BOX with no manual resize handle.
              The Owner found this by DRAGGING a corner — an instrument no geometry probe has, which
              is why a suite measuring boxes reported Δ0 on a torn editor. Asserted on the real
              textarea (`.ag-text-area-input`, verified from the live DOM), because the rule that
              was supposed to prevent this was written against `.ag-large-text-input` — AG's wrapper
              — and bound to nothing for a whole day. */
        if (m.kind === 'longtext') {
          const ta = m.ta ?? { found: false }
          if (!ta.found) problems.push('no .ag-text-area-input in the long-text popup — the selector this rule depends on has moved')
          else {
            if (ta.resize !== 'none') problems.push(`the long-text textarea offers a resize handle (resize: ${ta.resize}) — dragging it tears the editor from its background`)
            /* One box: the container follows the textarea. A container that cannot grow with its
               content is exactly the 52(a) tear, so the gap between them must stay small. */
            if (ta.outerH != null && ta.outerH - ta.taH > 60) problems.push(`the long-text container (${ta.outerH}px) has drifted from its textarea (${ta.taH}px) — they are no longer one box`)
          }
        }
        /* 5. Never narrower than the cell unless the ROOM forced it — the regression that opened
              every editor at 110px while the geometry read a perfect Δ0. */
        if (m.cw != null && m.pw < m.cw && m.px + m.cw <= vw) problems.push(`width ${m.pw} is narrower than its ${m.cw}px cell with room to spare`)
        /* 6. The origin cell is outlined as editing, always. */
        if (!(m.outlineWidth > 0)) problems.push(`origin cell has no editing outline (outline-width ${m.outlineWidth})`)
        /* 7. …and readable under an `under` popup, the only place its value still shows. */
        if (m.under && m.valueVisibility !== 'visible') problems.push(`origin cell BLANKED under an 'under' popup (visibility ${m.valueVisibility}) — the operator cannot see the value they are changing`)
        for (const pr2 of problems) failures.push(`${tag}: ${pr2}`)
        if (binds) geometryMeasured++
        console.log(`   ${problems.length ? '❌' : '✅'} ${String(vw).padEnd(4)} ${m.kind.padEnd(9)} ${t.colId.padEnd(21)} cell ${m.cw}px@${String(m.cx).padStart(4)}  popup ${String(m.pw).padStart(3)}px@${String(m.px).padStart(4)} (Δ${m.cx == null ? '?' : m.px - m.cx}) right=${m.pright}/${vw} outline=${m.outlineWidth} ${m.under ? `under·value ${m.valueVisibility}` : 'over'}${binds ? ` room=${Math.round(roomHere)}<cap` : '  🔴 ROOM DOES NOT BIND'}`)
      }
    }
    await page.setViewportSize({ width: 1600, height: 1000 })
    const wanted = 3 * 3
    if (geometryMeasured < wanted) failures.push(`geometry: only ${geometryMeasured} of ${wanted} kind×width readings were taken — an unmeasured kind is NOT a passing kind`)
  }
}

/* ── CONTRACT: the table in docs/2026-09-03-cell-editing-contract.md, asserted line by line. ───
 *
 * On BOTH scopes (master·DE and Amazon·IT), because "the same column always opens the same way" is
 * a claim about the product, not about one sheet, and PES.3's channel scope shares every editor
 * through the engine — sharing a component is not a measurement.
 *
 * 🔴 A row that cannot be DRIVEN fails. An unmeasured contract line is not a passing one, and the
 * failure mode this whole suite exists to refuse is the green that came from having nothing to look
 * at (see the `first`/`geometry` blocks, both of which shipped that bug and had it caught).
 */
if (RUN.includes('contract')) {
  const { rows: contractRows, gestures: contractGestures, error: contractError } = readContract()
  console.log(`\n── contract (${CONTRACT_DOC}, asserted line by line on both scopes)`)
  if (!contractRows) {
    failures.push(`contract: NOT MEASURED — ${contractError}. The gate cannot assert a table it could not parse.`)
    console.log(`   ❌ ${contractError}`)
  } else {
    console.log(`   ${contractRows.length} rows × ${contractGestures.length} gestures parsed from the document`)
    const SCOPES_TO_RUN = [
      { key: 'master', url: STUDIO, apiQ: `scope=master&market=${MARKET}&locale=${LOCALE}` },
      { key: 'AMAZON·IT', url: `${BASE}/products/${PRODUCT}/edit/studio?scope=AMAZON&market=IT&locale=it`, apiQ: 'scope=channel&channel=AMAZON&market=IT&locale=it' },
      { key: 'EBAY·IT', url: `${BASE}/products/${PRODUCT}/edit/studio?scope=EBAY&market=IT&locale=it`, apiQ: 'scope=channel&channel=EBAY&market=IT&locale=it' },
    ]
    /**
     * 🔴 THE TABLE NAMES A COLUMN, THE SCOPE DECIDES WHICH ONE. `col` is the master column and is
     * the preferred target; a different scope carries different keys (`basePrice` does not exist on
     * Amazon·IT at all) and asserting a kind against a column that scope has never heard of measures
     * nothing. So the gate reads that scope's OWN contract and, when the named column is not
     * rendered, drives the first rendered column of the same kind — printing which one, because a
     * reading against a substituted column is only honest if it says so.
     */
    const contractsByScope = new Map()
    for (const sc of SCOPES_TO_RUN) {
      const cols = await fetch(`${API}/api/products/${PRODUCT}/studio/sheet?${sc.apiQ}`)
        .then((r) => (r.ok ? r.json() : null)).then((j) => j?.columns ?? null).catch(() => null)
      contractsByScope.set(sc.key, cols)
      if (!cols) failures.push(`contract ${sc.key}: NOT MEASURED — could not read the column contract from the API, so no column can be resolved by kind`)
    }
    for (const scope of SCOPES_TO_RUN) {
      console.log(`\n   ── scope ${scope.key}`)
      /* `locked` / `fxblocked` need a column that is not in the landing view. Reveal it ONCE per
         scope through the one Customise dialog, exactly as an operator would. */
      let revealed = false
      for (const row of contractRows) {
        const needsReveal = row.state === 'locked' || row.state === 'fxblocked'
        inFlight = `contract/${scope.key}/${row.kind}/${row.state}`
        await page.goto(scope.url, { waitUntil: 'domcontentloaded' })
        const ready = await page.waitForFunction(() => document.querySelectorAll('.ag-row[row-id]').length > 0, null, { timeout: ROWS_MS }).then(() => true).catch(() => false)
        if (!ready) { failures.push(`contract ${scope.key} · ${row.kind}/${row.state}: NOT MEASURED — no rows rendered`); continue }
        const rowId = await page.evaluate(() => document.querySelector('.ag-grid-scrolling-container .ag-row[row-id]')?.getAttribute('row-id') ?? document.querySelector('.ag-row[row-id]')?.getAttribute('row-id'))
        /* The three timing states, produced rather than waited for. */
        /* 🔴 `batch` is a 400ms sample of the FORMULA BATCH window, but the column model needs
           longer to restore — deciding "not rendered" at 400ms made two channel rows report
           "could not bring a number column on screen" on a sheet that had one. Resolve the column
           on a settled grid, then take the timing sample. */
        if (row.state === 'batch') await page.waitForTimeout(2500)
        else if (row.state === 'flush') { await page.waitForTimeout(2500); heldFlush = true }  // the save is armed once the target is resolved, below
        else await page.waitForTimeout(2500)
        if (needsReveal && !revealed) {
          const btn = page.getByRole('button', { name: /Customise/i })
          if (await btn.count()) {
            await btn.click(); await page.waitForTimeout(900)
            const tick = await page.evaluate((col) => {
              const want = { condition_type: /Item Condition/i }[col]
              const r = [...document.querySelectorAll('.nds-prefs-pick')].find((n) => want && want.test(n.textContent || ''))
              const box = r?.querySelector('input[type="checkbox"]')
              if (!box) return false
              if (!box.checked) box.click()
              return box.checked
            }, row.col)
            if (tick) { const save = page.getByRole('button', { name: /^Save$/ }); if (await save.count()) { await save.click(); await page.waitForTimeout(1800) } }
            revealed = tick
            /* 🔴 A reveal that finds no row to tick must CLOSE the dialog it opened. It did not, and on
               the first scope without `condition_type` (EBAY·IT, 2026-09-04) the open backdrop swallowed
               the next Customise click for 30s and the run died with an uncaught TimeoutError — losing
               `refused` and `parity` with it. A crash is not a finding. */
            if (!tick) { await page.keyboard.press('Escape'); await page.waitForTimeout(400) }
          }
        }
        const scopeCols = contractsByScope.get(scope.key)
        const wantLocked = row.state === 'locked' || row.state === 'fxblocked'
        /* Which columns of this kind does this scope declare, and which are RENDERED right now? */
        /* A row's `kind` is a SHAPE for list/measure (AM.1) and a scalar kind otherwise — and a scalar
           row must never resolve to a shaped column of the same wire kind (`supplier_declared_dg_hz_regulation`
           is `kind: select, shape: list`; opening it for the `select` row would measure the wrong editor). */
        /* `shape: 'scalar'` is set EXPLICITLY on ordinary columns — a truthiness test excluded every one of them (run 2026-09-05 02:16). */
        const kindMatches = (c) => (row.kind === 'list' || row.kind === 'measure' ? c.shape === row.kind : c.kind === row.kind && (!c.shape || c.shape === 'scalar'))
        const declared = (scopeCols ?? []).filter((c) => kindMatches(c)
          && (row.state === 'locked' ? c.editable === false
            : row.state === 'fxblocked' ? c.formulaWritable === false
            : c.editable !== false))
        const rendered = await renderedCols(rowId)
        /* 🔴 The NAMED column drives the row only while it still SATISFIES the row on this scope. AM.1
           made `condition_type` editable (the channel accepts it) and turned eBay's `brand` into the
           394-option "Marca" aspect; driving them by name measured a listbox against `none+say` and a
           select against `inline` — the sheet was right both times (2026-09-05 02:33). */
        const namedOk = rendered.includes(row.col) && declared.some((c) => c.key === row.col)
        let target = namedOk ? row.col : declared.map((c) => c.key).find((k) => rendered.includes(k)) ?? null
        const revealDiag = { ticked: 'not attempted' }
        if (!target && declared.length) {
          /* Declared but not rendered — reveal one through the ONE Customise dialog. */
          const label = declared[0].label ?? declared[0].key
          const btn = page.getByRole('button', { name: /Customise/i })
          if (await btn.count()) {
            /* A dialog left open by anything before us blocks the click; clear it, and if the click still
               cannot land, record NOT MEASURED for THIS row rather than aborting every later block. */
            if (await page.locator('.nds-backdrop').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(400) }
            const clicked = await btn.click({ timeout: 8000 }).then(() => true).catch(() => false)
            if (!clicked) {
              failures.push(`contract ${scope.key} · ${row.kind}/${row.state}: NOT MEASURED — the Customise button could not be clicked (something intercepts the pointer), so ${declared[0].key} could not be revealed`)
              console.log(`   ${at()} ❌ ${row.kind.padEnd(9)} ${row.state.padEnd(10)} Customise could not be clicked — reveal of ${declared[0].key} not attempted`)
              continue
            }
            await page.waitForTimeout(1000)
            /* 🔴 If the box is ALREADY ticked and the column still is not on screen, ticking it is a
               no-op and Save changes nothing — so the reveal silently does nothing from the second
               row onward. Measured exactly that: the first reveal of a column worked and every later
               one reported "could not bring it on screen". Toggle it OFF and back ON so the dialog
               has a change to save. (That the preference can say "visible" while the grid does not
               show it is reported to the hub as a suspected channel persistence defect — this is the
               gate working around it, not a fix for it.) */
            const ticked = await page.evaluate((lbl) => {
              const r = [...document.querySelectorAll('.nds-prefs-pick')].find((n) => (n.textContent || '').trim() === lbl)
              const box = r?.querySelector('input[type="checkbox"]')
              if (!box) return false
              if (box.checked) { box.click(); box.click() } else { box.click() }
              return box.checked
            }, label)
            revealDiag.ticked = String(ticked)
            if (ticked) {
              const save = page.getByRole('button', { name: /^Save$/ })
              if (await save.count()) {
                await save.click()
                /* Wait for the COLUMN, not for a duration: the grid re-runs its column model after a
                   Customise save and a fixed sleep decided "not rendered" on a sheet that was still
                   applying it — reported as "could not bring a number column on screen" twice. */
                await page.waitForFunction(([rid, keys]) => {
                  const on = [...document.querySelectorAll(`.ag-row[row-id="${rid}"] .ag-cell[col-id]`)].map((c) => c.getAttribute('col-id'))
                  return keys.some((k) => on.includes(k))
                }, [rowId, declared.map((c) => c.key)], { timeout: 8000, polling: 'raf' }).catch(() => {})
              }
            }
            else { await page.keyboard.press('Escape'); await page.waitForTimeout(400) }
            const now = await renderedCols(rowId)
            target = declared.map((c) => c.key).find((k) => now.includes(k)) ?? null
          }
        }
        if (!target) {
          heldFlush = false
          if (!declared.length) {
            /* A legitimate n/a: this scope declares NO column of this kind and state. Recorded, not
               failed — the same honesty the yes/no row gets. */
            console.log(`   ·  ${row.kind.padEnd(9)} ${row.state.padEnd(10)} n/a — ${scope.key} declares no ${row.state} ${row.kind} column`)
            continue
          }
          /* 🔴 A failure that cannot be diagnosed from its own log costs a day. This one said only
             "could not be brought on screen" and three sessions could not tell whether the reveal
             never ran, the tick never landed, or the column was revealed and then hidden. Print the
             evidence that separates them. */
          const diag = await page.evaluate((rid) => ({
            customiseButton: !!([...document.querySelectorAll('button')].find((b) => /Customise/i.test(b.textContent || ''))),
            modalOpen: !!document.querySelector('.nds-modal'),
            /* 🔴 The SET, not the count. "24 headers against 18" is a number that names nothing;
               the six-column difference names which state the grid is in and where it came from. */
            headerSet: [...document.querySelectorAll('.ag-header-cell[col-id]')].map((h) => h.getAttribute('col-id')).sort(),
            headers: [...document.querySelectorAll('.ag-header-cell[col-id]')].map((h) => h.getAttribute('col-id')).length,
            bodyCells: [...document.querySelectorAll(`.ag-row[row-id="${rid}"] .ag-cell[col-id]`)].map((c) => c.getAttribute('col-id')).length,
            wantedHeader: [...document.querySelectorAll('.ag-header-cell[col-id]')].some((h) => h.getAttribute('col-id') === 'condition_type'),
          }), rowId)
          failures.push(`contract ${scope.key} · ${row.kind}/${row.state}: NOT MEASURED — ${scope.key} declares ${declared.length} ${row.kind} column(s) for this state (e.g. ${declared[0].key}) but none could be brought on screen. reveal: label="${declared[0].label ?? declared[0].key}" tickResult=${revealDiag.ticked} customiseButton=${diag.customiseButton} modalStillOpen=${diag.modalOpen} headersNow=${diag.headers} bodyCellsNow=${diag.bodyCells} headerHasWanted=${diag.wantedHeader}`)
          console.log(`   ${at()} ❌ ${row.kind.padEnd(9)} ${row.state.padEnd(10)} could not bring a ${row.kind} column on screen — tick=${revealDiag.ticked} headers=${diag.headers} bodyCells=${diag.bodyCells} headerHasWanted=${diag.wantedHeader} modalOpen=${diag.modalOpen}`)
          console.log(`        HEADER SET (${diag.headerSet.length}): ${diag.headerSet.join(' ')}`)
          continue
        }
        if (!(await bringOnScreen(rowId, target))) {
          failures.push(`contract ${scope.key} · ${row.kind}/${row.state}: NOT MEASURED — ${target} could not be scrolled into the DOM`)
          continue
        }
        const cell = page.locator(`.ag-row[row-id="${rowId}"] .ag-cell[col-id="${target}"]`).first()
        /* Produce the `flush` state now that the sheet is loaded and a cell can be reached. If it
           cannot be produced the row FAILS: a state nobody produced is not a state anybody tested. */
        /* 🔴 The row's MARK reflects the STATE as well as the assertions. ce's run caught this on the
           first outing: two AMAZON·IT flush rows failed to produce their state, were recorded in the
           findings list — and still printed ✅, because every gesture assertion passed. Anyone
           scanning the block sees fourteen greens and stops; the findings list at the bottom is the
           only thing standing between that and being missed. A vacuous pass that PRINTS as a pass is
           how vacuous passes survive review, which is the whole class this gate exists to refuse. */
        let stateProduced = true
        if (row.state === 'flush') {
          const armed = await armHeldSave(rowId)
          if (!armed.ok) {
            stateProduced = false
            failures.push(`contract ${scope.key} · ${row.kind}/${row.state}: the flush state was NOT PRODUCED — ${armed.why}. This row would have asserted the same thing as \`settled\`.`)
          }
        }
        const got = {}
        let bad = 0
        for (const g of contractGestures) {
          await escape_()
          /* A previous gesture (or an editor closing) can scroll the grid, and virtualisation then
             removes the target again — so this is re-asserted per gesture, not once per row. */
          if (!(await bringOnScreen(rowId, target))) { got[g] = 'GONE'; failures.push(`contract ${scope.key} · ${row.kind}/${row.state}/${g}: NOT MEASURED — ${target} left the DOM`); bad++; continue }
          await cell.scrollIntoViewIfNeeded().catch(() => {})
          const b = await cell.boundingBox({ timeout: 2500 }).catch(() => null)
          if (!b) { got[g] = 'NOBOX'; failures.push(`contract ${scope.key} · ${row.kind}/${row.state}/${g}: NOT MEASURED — no box`); bad++; continue }
          let x = b.x + Math.min(b.width * 0.4, 30), y = b.y + b.height * 0.5
          let aimed = await page.evaluate(([x, y, c]) => document.elementFromPoint(x, y)?.closest('.ag-cell[col-id]')?.getAttribute('col-id') === c, [x, y, target])
          if (!aimed) {
            await page.mouse.wheel(-320, 0); await page.waitForTimeout(220)
            const nb = await cell.boundingBox({ timeout: 2500 }).catch(() => null)
            if (nb) { x = nb.x + Math.min(nb.width * 0.4, 30); y = nb.y + nb.height * 0.5
              aimed = await page.evaluate(([x, y, c]) => document.elementFromPoint(x, y)?.closest('.ag-cell[col-id]')?.getAttribute('col-id') === c, [x, y, target]) }
          }
          if (!aimed) { got[g] = 'ABSTAIN'; failures.push(`contract ${scope.key} · ${row.kind}/${row.state}/${g}: NOT MEASURED — the point is not over ${target}`); bad++; continue }
          /* 🔴 "Is the sheet SAYING why", not "did a NEW message appear". The refusal is deduped for
             2.5s so an operator typing five characters into a locked cell gets one explanation
             rather than five stacked — correct product behaviour that a new-text detector reads as
             four silences. The proposition the contract makes is that the operator is not left
             without an explanation, and a message still on screen satisfies it. */
          if (g === 'dblclick') await page.mouse.dblclick(x, y)
          else { await page.mouse.click(x, y); await page.waitForTimeout(40)
            await page.keyboard.press(g === 'enter' ? 'Enter' : g === 'f2' ? 'F2' : g === 'type' ? 'a' : '=') }
          const opened = await page.waitForFunction((s2) => document.querySelector(s2), EDITOR_SEL, { timeout: 400, polling: 'raf' }).then(() => true).catch(() => false)
          /* 🔴 POLL for the refusal, never sleep for it. A fixed 350ms wait raced the channel's
             toast — which renders perfectly, just later, right after a Customise save has the page
             busy — and the gate reported five silences on a sheet that was explaining itself. A
             race dressed as a reading is the same class as the unwitnessed zero this suite refuses
             everywhere else. Bounded, so a genuine silence still fails rather than hanging. */
          if (opened) await page.waitForTimeout(160)
          else await page.waitForFunction(() =>
            /read-only|cannot be edited|does not apply|per variation|not writable/i.test(
              [...document.querySelectorAll('.nds-toasts')].map((n) => n.textContent ?? '').join(' ')),
            null, { timeout: 1500, polling: 'raf' }).catch(() => {})
          const shape = opened ? await page.evaluate(shapeOf) : 'NONE'
          /* 🔴 ALL the toast hosts, not the first. The studio route renders TWO `.nds-toasts`
             viewports (measured: 2 here, 1 on /products/next; neither is the DS fallback and no
             `[nds]` console error fires, so both are real providers). `querySelector` returns the
             EMPTY one, which read as five silences on a cell that was explaining itself perfectly —
             a false red this gate reported before the hosts were counted. Reported to the hub as a
             separate pre-existing defect; asserted here against every host so this check measures
             the sheet rather than the DOM order of two portals. */
          const said = opened ? false : await page.evaluate(() =>
            /read-only|cannot be edited|does not apply|per variation|not writable/i.test(
              [...document.querySelectorAll('.nds-toasts')].map((n) => n.textContent ?? '').join(' ')))
          const actual = opened
            ? { inline: 'inline', 'popup:largetext': 'pop:text', 'popup:listbox': 'pop:list', 'popup:multi': 'pop:multi', 'popup:measure': 'pop:measure', 'popup:formula': 'pop:fx' }[shape] ?? shape
            : (said ? 'none+say' : 'none')
          got[g] = actual
          if (actual !== row.expect[g]) {
            bad++
            failures.push(`contract ${scope.key} · ${row.kind}/${row.state}/${g} on ${target}: expected ${row.expect[g]}, got ${actual}`)
          }
          await escape_()
        }
        /* 🔴 RELEASE THE HELD FLUSH. `heldFlush` makes every write hang so the client believes a save
           is in flight; leaving it set turned that into a property of the whole rest of the run —
           every later row's writes hung too. A state the gate INDUCES must be scoped to the row that
           asked for it, or the gate stops measuring what its own labels claim. */
        heldFlush = false
        contractChecked += contractGestures.length
        console.log(`   ${at()} ${bad ? '❌' : stateProduced ? '✅' : '⚠'} ${row.kind.padEnd(9)} ${(stateProduced ? row.state : `${row.state}(→settled)`).padEnd(10)} ${String(target === row.col ? target : `${target} (for ${row.col})`).padEnd(24)} ${contractGestures.map((g) => `${g}=${got[g]}`).join(' ')}`)
      }
    }
    await page.setViewportSize({ width: 1600, height: 1000 })
  }
}

/* ── REFUSED: #780, asserted at rest on both scopes, from a stubbed wire. ─────────────────────── */
if (RUN.includes('refused')) {
  console.log(`\n── refused (a stored formula whose result the server refused, stubbed on the wire)`)
  const REASON = '"maybe" is not an allowed value for Are batteries included? — choose one of: No, Sì'
  for (const sc of [
    { key: 'master', url: STUDIO },
    { key: 'AMAZON·IT', url: `${BASE}/products/${PRODUCT}/edit/studio?scope=AMAZON&market=IT&locale=it` },
    { key: 'EBAY·IT', url: `${BASE}/products/${PRODUCT}/edit/studio?scope=EBAY&market=IT&locale=it` },
  ]) {
    inFlight = `refused/${sc.key}`
    /* Loaded once WITHOUT the stub to learn the row id, then again with it — the stub is keyed on a
       real product id so the sheet matches it to a real row rather than dropping it silently. */
    await page.goto(sc.url, { waitUntil: 'domcontentloaded' })
    const ok = await page.waitForFunction(() => document.querySelectorAll('.ag-row[row-id]').length > 0, null, { timeout: ROWS_MS }).then(() => true).catch(() => false)
    if (!ok) { failures.push(`refused ${sc.key}: NOT MEASURED — no rows rendered`); continue }
    const rowId = await page.evaluate(() => document.querySelector('.ag-grid-scrolling-container .ag-row[row-id]')?.getAttribute('row-id') ?? document.querySelector('.ag-row[row-id]')?.getAttribute('row-id'))
    /* The channel prefixes its row ids (`primary:<productId>`); the formula batch is keyed on the
       bare product id, so the stub uses the id the SERVER would use, not the grid's row key. */
    const productId = String(rowId).includes(':') ? String(rowId).split(':').pop() : rowId
    stubRefused = { productId, fieldKey: 'name', expr: 'upper($brand)', lastError: REASON }
    await page.goto(sc.url, { waitUntil: 'domcontentloaded' })
    const ok2 = await page.waitForFunction(() => document.querySelectorAll('.ag-row[row-id]').length > 0, null, { timeout: ROWS_MS }).then(() => true).catch(() => false)
    if (!ok2) { stubRefused = null; failures.push(`refused ${sc.key}: NOT MEASURED — no rows rendered with the stub`); continue }
    await page.waitForTimeout(3000)
    if (!(await bringOnScreen(rowId, 'name'))) { stubRefused = null; failures.push(`refused ${sc.key}: NOT MEASURED — name could not be brought on screen`); continue }
    console.log(`      stub served ${stubServed}× · productId=${productId} · rowId=${rowId}`)
    const m = await page.evaluate((rid) => {
      const cell = document.querySelector(`.ag-row[row-id="${rid}"] .ag-cell[col-id="name"]`)
      if (!cell) return { found: false }
      const mark = cell.querySelector('.nds-cell-prov-refused')
      return { found: true,
        refusedClass: cell.classList.contains('nds-cell-is-formula-refused'),
        formulaClass: cell.classList.contains('nds-cell-is-formula'),
        markPresent: !!mark, markTitle: mark?.getAttribute('title') ?? null,
        markText: (mark?.textContent ?? '').trim(),
        classes: cell.className,
        formulaMark: !!cell.querySelector('.nds-cell-prov-formula') }
    }, rowId)
    /* 🔴 DOES THE RULE COMPUTE, OR DID AG NOT APPLY IT? Scrolling the column out of view and back
       makes AG DESTROY and RECREATE the cell, which re-runs `cellClassRules` from scratch. If the
       class appears only after that, the inputs were right and the refresh never re-evaluated them;
       if it is still absent, the rule itself saw no reason. One instrument, two hypotheses, no grid
       api needed. */
    const afterRecreate = await (async () => {
      await page.evaluate(() => { const v = document.querySelector('.ag-grid-viewport, .ag-body-horizontal-scroll-viewport'); if (v) v.scrollLeft = v.scrollWidth })
      await page.waitForTimeout(400)
      await page.evaluate(() => { const v = document.querySelector('.ag-grid-viewport, .ag-body-horizontal-scroll-viewport'); if (v) v.scrollLeft = 0 })
      await page.waitForTimeout(400)
      await bringOnScreen(rowId, 'name')
      return page.evaluate((rid) => {
        const cell = document.querySelector(`.ag-row[row-id="${rid}"] .ag-cell[col-id="name"]`)
        return cell ? cell.classList.contains('nds-cell-is-formula-refused') : null
      }, rowId)
    })()
    console.log(`        after cell recreate: refusedClass=${afterRecreate}`)
    stubRefused = null
    const problems = []
    if (!m.found) problems.push('the name cell vanished')
    else {
      if (!m.refusedClass) problems.push('the cell does not carry .nds-cell-is-formula-refused')
      /* 🔴 The ƒ must be GONE, not accompanied. A refused cell wearing both marks says "calculated,
         and also refused" — the same false claim in two glyphs, which is the defect #780 names. */
      if (m.formulaMark) problems.push('the ƒ mark is still present beside the warning — a refused cell must not also claim it was calculated')
      if (m.formulaClass) problems.push('the cell still carries .nds-cell-is-formula')
      if (!m.markPresent) problems.push('no .nds-cell-prov-refused mark rendered')
      /* The tooltip is the SERVER'S sentence verbatim — no prefix, no field name, no client wording.
         Compared against the exact string the wire carried, so a client that "helpfully" wraps it
         fails here rather than in front of an operator. */
      if (m.markTitle !== REASON) problems.push(`the mark's tooltip is not the server's sentence verbatim — got ${JSON.stringify(m.markTitle)}`)
    }
    for (const pr of problems) failures.push(`refused ${sc.key} · name: ${pr}`)
    refusedChecked++
    console.log(`        classes: ${m.classes}`)
    console.log(`   ${at()} ${problems.length ? '❌' : '✅'} ${sc.key.padEnd(10)} refusedClass=${m.refusedClass} ƒ-gone=${!m.formulaMark} mark=${JSON.stringify(m.markText)} tooltip=${m.markTitle === REASON ? 'server sentence verbatim' : 'DIFFERS'}`)
  }
}

/* ── NEGATIVE CONTROL: the detector must be able to say NO. ──────────────────────────────────── */
console.log('\n── negative control (the run above is worthless if this opens an editor)')
{
  if (!(await page.evaluate(() => document.querySelectorAll('.ag-row[row-id]').length))) await load()
  await escape_()
  /* The contract block leaves the grid scrolled far right (the full-width sweep); at that position the
     `name` header is virtualised away and the control reported NOT RUN (2026-09-05 02:41). Scroll home first. */
  await page.evaluate(() => { const v = document.querySelector('.ag-grid-viewport, .ag-body-horizontal-scroll-viewport'); if (v) v.scrollLeft = 0 })
  await page.waitForTimeout(400)
  const head = page.locator('.ag-header-cell[col-id="name"], .ag-header-cell[col-id="brand"]').first()
  const hb = (await head.count()) ? await head.boundingBox() : null
  if (!hb) {
    failures.push('negative control: NOT RUN — no header cell to aim at, so nothing here proves the detector can report a miss')
    console.log('   ❌ NOT RUN — no header cell found')
  } else {
    inFlight = 'negative-control'
    await page.mouse.dblclick(hb.x + hb.width / 2, hb.y + hb.height / 2)
    const opened = await page.waitForFunction((s) => document.querySelector(s), EDITOR_SEL, { timeout: 250, polling: 'raf' }).then(() => true).catch(() => false)
    if (opened) {
      failures.push('negative control FAILED: a double-click on a HEADER opened an editor. The detector cannot tell open from shut, so every green above it is vacuous.')
      console.log('   ❌ a header double-click opened an editor — the detector is broken')
    } else console.log('   ✅ a header double-click opens nothing — the detector can report a miss')
    await escape_()
  }
}

/* ── WIRE CONTROL ─────────────────────────────────────────────────────────────────────────────── */
console.log('\n── wire')
const foreign = [...apiHosts].filter((h) => h !== expectedApi)
console.log(`   API hosts the page dialled: ${[...apiHosts].join(', ') || '(none)'} · expected ${expectedApi}`)
if (foreign.length) failures.push(`the page dialled ${foreign.join(', ')} — expected ${expectedApi}. NOT MEASURED: a run against another backend describes another database.`)
else if (apiHosts.size === 0) failures.push('the page dialled NO API host — the readings cannot be attributed to a backend')

/**
 * 🔴 THE TALLY IS PRINTED AND ASSERTED, not narrated. The PASSED banner used to print the literal
 * "0 writes armed" whatever this number was — the #744 banner shape, a line asserting a property
 * nothing checked. Any API write armed anywhere in the run now FAILS it, not only one inside a
 * gesture window: an open gesture is not a data change, and neither is loading a page.
 */
console.log(`\n── API writes armed across the whole run: ${armedWrites.length} (aborted at the network layer; none reached a database)`)
/* 🔴 THE CROSS-REFERENCE IS CHECKED, NOT PRINTED. This line used to cite "docs/pes-claims.md §16" —
   a reference by POSITION into an append-only file three sessions write to, which survived a real
   §16 collision today only because the other session happened to renumber theirs. A comment saying
   "keep these in sync" would be an instruction, and this repo has already paid for
   instructions-as-mechanism. So the ledger heading carries a token, the gate finds the heading by
   that token, and a token that has gone missing FAILS the run instead of printing a wrong pointer. */
const fixtureRef = (() => {
  try {
    const line = readFileSync(LEDGER_DOC, 'utf8').split('\n').find((l) => l.includes(FIXTURE_TOKEN))
    return line ? line.replace(/^#+\s*/, '').trim() : null
  } catch { return null }
})()
if (!fixtureRef) failures.push(`the fixture announcement token ${FIXTURE_TOKEN} is not in ${LEDGER_DOC} — this run held saves against a fixture whose announcement cannot be found`)
console.log(`── expected saves HELD open to produce the \`flush\` state: ${expectedHeld.length} (on ${FLUSH_FIXTURE_COL}, XAVIA fixture, never completed)`)
console.log(`   announced at: ${fixtureRef ?? `🔴 ${FIXTURE_TOKEN} NOT FOUND in ${LEDGER_DOC}`}`)
if (armedWrites.length > 0) {
  failures.push(`${armedWrites.length} API write(s) were armed during this run — an open gesture is not a data change. First: ${armedWrites[0].req} during ${armedWrites[0].during}`)
}
for (const w of armedWrites.slice(0, 8)) console.log(`   [${w.during}] ${w.req}  ${w.body.slice(0, 120)}`)

/* ── PARITY: the three scopes are ONE sheet. ──────────────────────────────────────────────────
 * Owner, 2026-09-04: "no inconsistencies or any differences in the UI at all". Measured that day
 * BEFORE the fix: master's header 57px against the channels' 29px (no filter row), a keyboard hint
 * on master's footer and none on the channels', numbers left-aligned on the channels, `⚠ required`
 * on master against `—` on the channels for the same empty cell, `Product` against `SKU` over the
 * same identity band. None was a decision. Every reading below is taken on all three scopes and
 * compared to master's; a difference fails, and a null on master fails as NOT MEASURED rather than
 * comparing equal to another null. */
if (RUN.includes('parity')) {
  console.log(`\n── parity (master·DE, AMAZON·IT, EBAY·IT — one chrome, one footer, one cell)`)
  const PARITY_SCOPES = [
    { key: 'master', url: STUDIO },
    { key: 'AMAZON·IT', url: `${BASE}/products/${PRODUCT}/edit/studio?scope=AMAZON&market=IT&locale=it` },
    { key: 'EBAY·IT', url: `${BASE}/products/${PRODUCT}/edit/studio?scope=EBAY&market=IT&locale=it` },
  ]
  const readings = new Map()
  for (const sc of PARITY_SCOPES) {
    inFlight = `parity/${sc.key}`
    await page.goto(sc.url, { waitUntil: 'domcontentloaded' })
    const ok = await page.waitForFunction(() => document.querySelectorAll('.ag-row[row-id]').length > 0, null, { timeout: ROWS_MS }).then(() => true).catch(() => false)
    if (!ok) { failures.push(`parity ${sc.key}: NOT MEASURED — no rows rendered`); continue }
    await page.waitForTimeout(3000)
    const r = await page.evaluate(() => {
      const hdr = document.querySelector('.ag-header'); const row = document.querySelector('.ag-row[row-id]')
      const editable = [...document.querySelectorAll('.ag-row[row-id] .ag-cell[col-id].nds-cell-is-editable')]
      const text = editable.find((c) => !c.classList.contains('nds-cell-is-select') && !c.classList.contains('nds-ag-num') && !c.querySelector('.nds-cell-longtext-text'))
      const cs = text ? getComputedStyle(text) : null
      const select = editable.find((c) => c.classList.contains('nds-cell-is-select'))
      const footer = (document.querySelector('.nds-grid-sheet-status')?.innerText || '').replace(/\s+/g, ' ').trim()
      return {
        headerH: hdr ? Math.round(hdr.getBoundingClientRect().height) : null,
        rowH: row ? Math.round(row.getBoundingClientRect().height) : null,
        cellPad: cs ? `${cs.paddingLeft}/${cs.paddingRight}` : null,
        cellFont: cs ? `${cs.fontSize} ${cs.fontWeight}` : null,
        floatingFilterRow: !!document.querySelector('.ag-floating-filter'),
        /* The footer minus its row count — the hint, the `?`, whatever occupies the note slot. */
        footerNote: footer ? footer.replace(/^\d+ rows?\s*/, '') : null,
        identityHeader: document.querySelector('.ag-header-cell[col-id="ag-Grid-AutoColumn"] .ag-header-cell-text')?.textContent?.trim() ?? null,
        everyCellHasBase: editable.length ? editable.every((c) => c.classList.contains('nds-ag-cell')) : null,
        selectHasChevron: select ? !!select.querySelector('svg, .nds-select-chevron, [class*="chevron"]') : null,
        /* AM.1 — optional readings (`opt_`): compared only where BOTH scopes render such a cell; a scope
           with no list column in its landing view says n/a rather than failing. */
        opt_listChip: (() => {
          const t = document.querySelector('.ag-row[row-id] .nds-cell-list .nds-token > .t')
          if (!t) return null
          const cs = getComputedStyle(t)
          return `${cs.fontSize}/${cs.lineHeight} pad ${cs.paddingLeft}`
        })(),
        opt_listCellNotSelect: (() => {
          const cells = [...document.querySelectorAll('.ag-row[row-id] .ag-cell')].filter((c) => c.querySelector('.nds-cell-list'))
          /* The CHEVRON specifically — an `svg` test also caught the provenance mark and read false on both
             scopes, an equality that could not fail (2026-09-05 02:31). */
          return cells.length ? cells.every((c) => !c.classList.contains('nds-cell-is-select') && !c.querySelector('.nds-select-chevron, [class*="chevron"]')) : null
        })(),
        /* The FIRST row's identity band — master's parent row against the channels' alias band (Owner,
           2026-09-05: they differed in picture, second line, trailing pills and an alias mark). The ⋯
           menu is excluded: verbs are scope meaning (master has family verbs, the channel none). */
        parentBand: (() => {
          const band = document.querySelector('.ag-row[row-index="0"] .nds-identity-band')
          if (!band) return null
          const trail = [...(band.querySelector('.nds-identity-band-trail')?.children ?? [])]
            .filter((n) => !n.matches('button, [role="button"], [class*="menu"]'))
            .map((n) => (n.className || '').toString().split(' ')[0]).join(' ')
          return { pic: !!band.querySelector('.nds-identity-band-pic img'), sub: !!band.querySelector('.nds-identity-band-sub'), mark: !!band.querySelector('.nds-alias-mark'), trail }
        })(),
      }
    })
    readings.set(sc.key, r)
    console.log(`   ${sc.key.padEnd(10)} ${JSON.stringify(r)}`)
  }
  const ref = readings.get('master')
  if (!ref) failures.push('parity: NOT MEASURED — master could not be read, so there is nothing to compare the channels to')
  else {
    for (const [key, r] of readings) {
      if (key === 'master') continue
      for (const k of Object.keys(ref)) {
        if (k.startsWith('opt_') && (ref[k] == null || r[k] == null)) { console.log(`   ·  ${key} · ${k}: n/a — ${ref[k] == null ? 'master' : key} renders no such cell in its landing view`); continue }
        if (ref[k] == null) { failures.push(`parity ${key} · ${k}: NOT MEASURED — master read null, so an equal null would pass for the wrong reason`); continue }
        if (JSON.stringify(r[k]) !== JSON.stringify(ref[k])) failures.push(`parity ${key} · ${k}: ${JSON.stringify(r[k])} — master reads ${JSON.stringify(ref[k])}`)
        else parityChecked++
      }
    }
  }
}

await browser.close()

if (abstentions.length) {
  console.error(`\n🔴 ${abstentions.length} GESTURE(S) NOT MEASURED — "could not measure" is not "measured green":`)
  for (const a of abstentions.slice(0, 12)) console.error(`   · ${a}`)
  failures.push(`${abstentions.length} gesture(s) could not be measured`)
}
if (failures.length) {
  console.error(`\n❌ OPEN-GESTURE GATE FAILED — ${failures.length} finding(s):`)
  for (const f of failures.slice(0, 30)) console.error(`   · ${f}`)
  if (failures.length > 30) console.error(`   … and ${failures.length - 30} more`)
  process.exit(1)
}
const total = results.reduce((a, r) => a + r.n, 0)
const parts = []
if (GESTURE_TIMINGS.length) parts.push(`${total} open gestures across ${GESTURE_TIMINGS.length} timing(s) × ${KINDS.length} kinds × ${GESTURES.length} gestures × ${SPOTS.length} hit-points, every one opening an editor within 250ms`)
if (RUN.includes('geometry')) parts.push(`${geometryMeasured} geometry readings (3 editor kinds × 3 viewport widths, each parked against the right edge)`)
if (RUN.includes('contract')) parts.push(`${contractChecked} contract assertions read from ${CONTRACT_DOC} across three scopes`)
if (RUN.includes('parity')) parts.push(`${parityChecked} parity readings equal to master's across the two channel scopes`)
if (RUN.includes('refused')) parts.push(`${refusedChecked} refused-cell readings from a stubbed wire (no write, no fixture)`)
console.log(`\n✅ OPEN-GESTURE GATE PASSED — ${parts.join('; ')}. ${armedWrites.length} API writes armed, ${expectedHeld.length} expected saves held open, negative control held.`)
