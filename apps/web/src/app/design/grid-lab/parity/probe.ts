/**
 * AGL — the measurement. `window.__parityProbe()` returns, for every scenario on the page and for
 * BOTH sides, the computed properties design §8 step 1 names: wrapper frame, header row height (reported,
 * never judged — headers are the Owner's exemption), first data row height, identity cell and each of
 * its parts, checkbox, numeric cell, totals row, group band, empty state, pager buttons, toolbar, the
 * first eight identity texts in VISUAL order, and the toolbar count after ticking the header checkbox
 * (done through a DOM click inside the probe, then undone).
 *
 * TWO KINDS OF ABSENCE, kept apart on purpose (memory: "could not measure" vs "measured empty"):
 *   - a side whose engine has not landed reports the string 'pending';
 *   - a part the DOM does not hold reports 'could not measure: <what was looked for>'.
 * A measured value is never a bare null.
 *
 * AG's DOM: a row is up to three `.ag-row` elements (pinned-left, centre, pinned-right) sharing a
 * `row-index`. Rows are ordered by that attribute, never by DOM order, and the row height is read off
 * the centre part. Cells are found across all parts of a row-index and ordered by their x position.
 *
 * Hover cannot be measured from inside the page — `:hover` is a pointer state, and a synthetic event
 * does not set it — so the full probe reports it as not measured and the runner reads it through
 * `__parityProbe.hover(id, side)` after a real `page.hover()` on the row `__parityProbe.markRow()` tagged.
 *
 * Selectors live HERE, in TypeScript: `scripts/check-ag-grid-import-boundary.mjs` scans every stylesheet
 * for `.ag-*`, and this file is the one place the lab knows the engine's class names.
 */
import type { ParityKind, Side } from './engines'

type Val = string | number | boolean | null | string[] | boolean[] | Measured
interface Measured { [k: string]: Val }
export type SideResult = Measured | 'pending'
export interface ScenarioResult { id: string; kind: ParityKind; exempt: string[]; legacy: SideResult; ag: SideResult }
export interface ProbeResult { viewport: { w: number; h: number }; visibility: Visibility; kind: ParityKind | 'mixed' | 'none'; at: string; scenarios: ScenarioResult[] }
/**
 * Whether this reading was taken in a tab the browser is actually painting. A BACKGROUND tab gets no
 * requestAnimationFrame and no ResizeObserver callbacks, and the AG side depends on both: its column fit runs in a
 * rAF and its row auto-height through a ResizeObserver per cell. Read from a hidden tab, the AG grid shows 45px rows
 * and unfitted columns that are NOT what a person sees (measured 23:58: rows went 45 → 53 the moment the tab was
 * painted once). The runner's headless page is visible; a hand probe from a Chrome tab behind another tab is not.
 */
export interface Visibility { state: DocumentVisibilityState; rafWithin300ms: boolean; note: string }

const NOPE = (what: string) => `could not measure: ${what}`

/* ── DOM helpers ─────────────────────────────────────────────────────────────────────────────── */

const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null)
const px = (n: number) => Math.round(n * 100) / 100
const text = (el: Element | null) => (el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : '')
const cs = (el: Element) => getComputedStyle(el)
/**
 * AG's VISUAL column order: pinned-left, centre, pinned-right — each by x. Plain x-order is wrong once the
 * centre is wider than the viewport: a pinned-right cell (drawn at the viewport's right edge) then sorts
 * BEFORE the centre cells scrolled past it, and "the first numeric cell" became Daily Budget on one side
 * and Spend on the other (run 1: numeric.text €60.00 vs €3797.99, totals.texts in two orders).
 */
const AG_LEFT = '.ag-grid-pinned-left-cells, .ag-pinned-left-cols-container'
const AG_RIGHT = '.ag-grid-pinned-right-cells, .ag-pinned-right-cols-container'
const rankOf = (c: Element) => (c.closest(AG_LEFT) ? 0 : c.closest(AG_RIGHT) ? 2 : 1)
const byColumn = <T extends Element>(els: T[]) => [...els].sort((a, b) => rankOf(a) - rankOf(b) || a.getBoundingClientRect().left - b.getBoundingClientRect().left)

const isPainted = (b: string) => !!b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent'
const label = (n: Element) => {
  const ks = [...n.classList].filter((k) => !k.startsWith('ag-') || k === 'ag-row' || k === 'ag-cell').slice(0, 2)
  return n.tagName.toLowerCase() + (ks.length ? '.' + ks.join('.') : '')
}
/**
 * The colour the eye sees behind an element: its own background, else the nearest painted ancestor's. A
 * transparent AG cell over a white row IS white; the legacy paints the td itself. Reported with its source.
 */
function effectiveBg(el: Element | null): Val {
  if (!el) return NOPE('no element')
  let n: Element | null = el
  while (n) {
    const b = cs(n).backgroundColor
    if (isPainted(b)) return b
    n = n.parentElement
  }
  return 'none'
}
function effectiveBgSource(el: Element | null): string {
  let n: Element | null = el
  while (n) { if (isPainted(cs(n).backgroundColor)) return n === el ? 'self' : label(n); n = n.parentElement }
  return 'none'
}
/**
 * What is painted over a row at the cell's position, topmost first: the cell, its pseudo-elements, the row's
 * pseudo-elements (AG draws hover/selection as `::before` overlays; the legacy paints the td), the row, then
 * the ancestors. `paint` is the colour the eye sees; `paintBy` says which box drew it (reported, not judged).
 */
function visiblePaint(cell: Element | null, row: Element | null): { paint: string; paintBy: string; layers: string } {
  const layers: string[] = []
  const probe = (name: string, el: Element | null, ps?: string) => {
    if (!el) return null
    const s = getComputedStyle(el, ps)
    if (ps && (s.content === 'none' || s.content === 'normal')) return null
    if (!isPainted(s.backgroundColor)) return null
    layers.push(`${name}=${s.backgroundColor}`)
    return s.backgroundColor
  }
  // The boxes BETWEEN the cell and the row: AG 36.1 paints hover and selection as a `::before` overlay on the three
  // cell containers inside the row (`.ag-grid-pinned-left-cells`, `.ag-grid-scrolling-cells`, `.ag-grid-pinned-right-cells`
  // — lane owner, 00:1x; run 3 read the row and its `::after` and called the tint absent).
  const between: Array<[string, Element | null, string | undefined]> = []
  // A pseudo-element paints ABOVE its element's own background, so read `::before`/`::after` before the box itself
  // (the DataGrid's transparent identity cell read its container's white first and missed the overlay, run 4/5).
  for (let n = cell?.parentElement ?? null; n && n !== row; n = n.parentElement) between.push([label(n) + '::before', n, '::before'], [label(n) + '::after', n, '::after'], [label(n), n, undefined])
  const order: Array<[string, Element | null, string | undefined]> = [
    ['cell', cell, undefined], ['cell::before', cell, '::before'], ['cell::after', cell, '::after'],
    ...between,
    ['row::before', row, '::before'], ['row::after', row, '::after'], ['row', row, undefined],
  ]
  let paint = '', paintBy = ''
  for (const [name, el, ps] of order) { const c = probe(name, el, ps); if (c && !paint) { paint = c; paintBy = name } }
  if (!paint) { paint = String(effectiveBg(row ?? cell)); paintBy = 'ancestor ' + effectiveBgSource(row ?? cell) }
  return { paint, paintBy, layers: layers.join(' · ') || 'none' }
}
/**
 * The row rule: the first bottom border WITH a width, looking at the cell, every box between the cell and the
 * row (AG 36 draws it on the three cell CONTAINERS inside the row — measured by hand: `.ag-grid-scrolling-cells`
 * 1px rgb(230,233,238), the row and the cell 0/transparent), then the row and their pseudo-elements.
 */
function rowRule(cell: Element | null, row: Element | null): Val {
  const between: Array<[string, Element | null, string | undefined]> = []
  for (let n = cell?.parentElement ?? null; n && n !== row; n = n.parentElement) between.push([label(n), n, undefined])
  const cands: Array<[string, Element | null, string | undefined]> = [['cell', cell, undefined], ['cell::after', cell, '::after'], ...between, ['row', row, undefined], ['row::after', row, '::after'], ['row::before', row, '::before']]
  for (const [name, el, ps] of cands) {
    if (!el) continue
    const s = getComputedStyle(el, ps)
    if (ps && (s.content === 'none' || s.content === 'normal')) continue
    if (s.borderBottomWidth !== '0px' && isPainted(s.borderBottomColor)) return { rule: `${s.borderBottomWidth} ${s.borderBottomStyle} ${s.borderBottomColor}`, ruleBy: name }
  }
  return { rule: 'none', ruleBy: 'none' }
}
/** The pinned-edge shadow: on the cell (legacy td.fz / td.fzr0) or on the pinned container that holds it (AG). */
function pinnedShadow(cell: Element | null): Val {
  if (!cell) return NOPE('no cell')
  const own = cs(cell).boxShadow
  if (own && own !== 'none') return { shadow: own, shadowBy: 'cell' }
  const box = cell.closest(AG_LEFT + ', ' + AG_RIGHT)
  if (box) { const b = cs(box).boxShadow; return { shadow: b || 'none', shadowBy: b && b !== 'none' ? label(box) : 'none' } }
  return { shadow: 'none', shadowBy: 'none' }
}

/** Read a list of computed properties off one element, plus its box. */
function read(el: Element | null, props: string[], what: string): Val {
  if (!el) return NOPE(what)
  const s = cs(el)
  const out: Measured = {}
  for (const p of props) out[p] = s.getPropertyValue(kebab(p)) || (s as unknown as Record<string, string>)[p] || ''
  // A colour behind a 0px border is the stylesheet's default (Tailwind's preflight grey), not something drawn:
  // report it as such on BOTH sides, or a 0px band and a 1px band would "differ" by a colour nobody sees.
  for (const p of props) {
    const m = /^border(Top|Right|Bottom|Left)?Color$/.exec(p)
    if (!m) continue
    const w = s.getPropertyValue(m[1] ? `border-${m[1].toLowerCase()}-width` : 'border-width')
    if (w === '0px') out[p] = 'none (0px)'
  }
  const r = el.getBoundingClientRect()
  out.width = px(r.width)
  out.height = px(r.height)
  return out
}
const kebab = (p: string) => p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

const CHIP = ['fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor', 'borderColor', 'borderWidth', 'borderRadius', 'padding', 'display', 'opacity', 'marginLeft', 'minWidth']
const FRAME = ['backgroundColor', 'borderColor', 'borderWidth', 'borderStyle', 'borderRadius', 'overflowX', 'overflowY', 'boxShadow']
const CELL = ['padding', 'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'color', 'backgroundColor', 'textAlign', 'whiteSpace', 'verticalAlign', 'boxShadow', 'borderRightColor', 'borderRightWidth', 'borderBottomColor', 'borderBottomWidth', 'minWidth', 'maxWidth', 'overflow', 'textOverflow']
const NUM = ['textAlign', 'fontSize', 'fontWeight', 'fontVariantNumeric', 'color', 'padding', 'backgroundColor', 'lineHeight']
const CHECK = ['borderRadius', 'borderColor', 'borderWidth', 'backgroundColor', 'appearance', 'margin', 'cursor', 'display']
const BTN = ['fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderColor', 'borderWidth', 'borderRadius', 'padding', 'minWidth', 'opacity', 'cursor']
const BAR = ['padding', 'gap', 'display', 'alignItems', 'justifyContent', 'backgroundColor']
const TXT = ['fontSize', 'fontWeight', 'color', 'whiteSpace', 'display']

/* ── the row model, per engine ───────────────────────────────────────────────────────────────── */

interface RowModel {
  /** data rows in VISUAL order (legacy: DOM; AG: by row-index, centre part) */
  data: Element[]
  /** every part of a data row, by index — AG rows are three elements */
  partsOf: (i: number) => Element[]
  skeleton: Element[]
  totals: Element | null
  totalsParts: Element[]
  groups: Element[]
  kids: Element[]
  subs: Element[]
  empty: Element | null
  headerRow: Element | null
  headerCheckbox: HTMLInputElement | null
  cellsOf: (i: number) => Element[]
  /** diagnostics: how the centre part was found */
  part: string
}

const AG_CENTRE = '.ag-grid-scrolling-container, .ag-grid-scrolling-rows, .ag-center-cols-container'

function agRows(root: Element): RowModel {
  const all = [...root.querySelectorAll<HTMLElement>('.ag-row')]
  const isPinned = (r: Element) => r.classList.contains('ag-row-pinned') || !!r.closest('.ag-floating-top, .ag-floating-bottom')
  const isFull = (r: Element) => r.classList.contains('ag-full-width-row')
  const byIndex = new Map<number, Element[]>()
  for (const r of all) {
    if (isPinned(r)) continue
    const i = Number(r.getAttribute('row-index'))
    if (!Number.isFinite(i)) continue
    byIndex.set(i, [...(byIndex.get(i) ?? []), r])
  }
  const indexes = [...byIndex.keys()].sort((a, b) => a - b)
  let part = 'first part (no centre container matched)'
  const centre = (parts: Element[]) => {
    const c = parts.find((p) => p.closest(AG_CENTRE))
    if (c) { part = 'centre (' + (c.closest(AG_CENTRE) as Element).className.split(' ').find((k) => /scrolling|center/.test(k)) + ')'; return c }
    // Fallback: the widest part is the centre.
    return [...parts].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0]
  }
  const rowsOrdered = indexes.map((i) => ({ i, parts: byIndex.get(i)!, main: centre(byIndex.get(i)!) }))
  const dataRows = rowsOrdered.filter(({ main }) => !isFull(main) && !main.classList.contains('sk') && !main.classList.contains('h10-am-grp') && !main.classList.contains('nds-grid-kid') && !main.classList.contains('nds-grid-sub'))
  const pinned = all.filter(isPinned)
  const totalsParts = pinned.filter((r) => r.classList.contains('h10-am-total') || r.classList.contains('totals') || pinned.length > 0)
  const headerCheckbox = root.querySelector<HTMLInputElement>('.ag-header-select-all input.ag-checkbox-input, .ag-header-select-all input, .ag-header-cell input[type="checkbox"]')
  return {
    data: dataRows.map((d) => d.main),
    partsOf: (i) => dataRows[i]?.parts ?? [],
    skeleton: rowsOrdered.filter(({ main }) => main.classList.contains('sk')).map((d) => d.main),
    totals: totalsParts.length ? (totalsParts.find((p) => p.closest(AG_CENTRE)) ?? totalsParts[0]) : null,
    totalsParts,
    // Bands carry `h10-am-grp` (the engine's band renderer). `ag-row-group` alone is NOT a band: AG marks a master-detail
    // parent with it, and on the DataGrid contract that parent is a data row (run 4 read two expanded parents as bands).
    groups: rowsOrdered.filter(({ main }) => main.classList.contains('h10-am-grp')).map((d) => d.main),
    kids: rowsOrdered.filter(({ main }) => main.classList.contains('nds-grid-kid')).map((d) => d.main),
    subs: [...root.querySelectorAll('.ag-details-row, .ag-row.nds-grid-sub')],
    empty: root.querySelector('.nds-ws-empty, .nds-grid-empty, .ag-overlay-no-rows-center, .ag-overlay-no-rows-wrapper'),
    headerRow: root.querySelector('.ag-header-row:not(.ag-header-row-group)'),
    headerCheckbox,
    cellsOf: (i) => byColumn(dataRows[i]?.parts.flatMap((p) => [...p.querySelectorAll('.ag-cell')]) ?? []),
    part,
  }
}

function legacyWsRows(root: Element): RowModel {
  const trs = [...root.querySelectorAll('tbody tr')]
  // The empty state is a `<tr><td class="empty">` — a row in the DOM, not a data row (run 1 measured it as the
  // identity cell of the empty scenarios).
  const data = trs.filter((r) => !r.matches('.h10-am-total, .sk, .h10-am-grp') && !r.querySelector(':scope > td.empty'))
  return {
    data,
    partsOf: (i) => (data[i] ? [data[i]] : []),
    skeleton: trs.filter((r) => r.matches('.sk')),
    totals: root.querySelector('tr.h10-am-total'),
    totalsParts: [...root.querySelectorAll('tr.h10-am-total')],
    groups: trs.filter((r) => r.matches('.h10-am-grp')),
    kids: [],
    subs: [],
    empty: root.querySelector('td.empty'),
    headerRow: root.querySelector('thead tr'),
    headerCheckbox: root.querySelector<HTMLInputElement>('thead th.ck input[type="checkbox"]'),
    cellsOf: (i) => (data[i] ? [...data[i].children] : []),
    part: 'tr',
  }
}

function legacyDgRows(root: Element): RowModel {
  const trs = [...root.querySelectorAll('tbody tr')]
  // The empty state is a row in the DOM (`<tr><td><div class="nds-grid-empty">`), not a data row.
  const data = trs.filter((r) => !r.matches('.nds-grid-kid, .nds-grid-sub') && !r.querySelector('.nds-grid-empty'))
  return {
    data,
    partsOf: (i) => (data[i] ? [data[i]] : []),
    skeleton: [],
    totals: root.querySelector('tfoot tr.totals'),
    totalsParts: [...root.querySelectorAll('tfoot tr.totals')],
    groups: [],
    kids: trs.filter((r) => r.matches('.nds-grid-kid')),
    subs: trs.filter((r) => r.matches('.nds-grid-sub')),
    empty: root.querySelector('.nds-grid-empty'),
    headerRow: root.querySelector('thead tr'),
    headerCheckbox: root.querySelector<HTMLInputElement>('thead th.ck input[type="checkbox"]'),
    cellsOf: (i) => (data[i] ? [...data[i].children] : []),
    part: 'tr',
  }
}

/* ── finding the grid on a side ──────────────────────────────────────────────────────────────── */

const SEL_COL = '[col-id="ag-Grid-SelectionColumn"]'
const isCkCell = (c: Element) => c.classList.contains('ck') || c.matches(SEL_COL)

interface Found { root: Element; wrapper: Element; model: RowModel; engine: 'legacy' | 'ag'; wrapperSel: string }

function find(side: Element, kind: ParityKind): Found | null {
  const agRoot = side.querySelector('.ag-root-wrapper')
  if (agRoot) {
    // Design §4: the AG WorkspaceGrid wears `.nds-wsgrid.nds-ag-ws`; the DataGrid's wrapper class is the
    // adapter's — fall back to the first bordered ancestor of the AG root inside this side.
    let wrapper: Element | null = side.querySelector(kind === 'workspace' ? '.nds-wsgrid' : '.nds-grid-wrap, .nds-ag-dg, .nds-ag-datagrid')
    let sel = wrapper ? '.' + [...wrapper.classList].join('.') : ''
    if (!wrapper) {
      let n: Element | null = agRoot
      while (n && n !== side) { if (cs(n).borderTopWidth !== '0px') { wrapper = n; sel = 'bordered ancestor .' + [...n.classList].join('.'); break } n = n.parentElement }
      if (!wrapper) { wrapper = agRoot; sel = '.ag-root-wrapper (no bordered ancestor)' }
    }
    return { root: wrapper.contains(agRoot) ? wrapper : agRoot.parentElement ?? agRoot, wrapper, model: agRows(side), engine: 'ag', wrapperSel: sel }
  }
  const wrapper = side.querySelector(kind === 'workspace' ? '.nds-wsgrid' : '.nds-grid-wrap')
  if (!wrapper) return null
  return { root: wrapper, wrapper, model: kind === 'workspace' ? legacyWsRows(wrapper) : legacyDgRows(wrapper), engine: 'legacy', wrapperSel: '.' + [...wrapper.classList].join('.') }
}

/** The identity cell: `.nm` on the workspace contract; the first non-selection cell on the DataGrid's. Same rule on both engines. */
const identityOf = (cells: Element[], _engine: 'legacy' | 'ag', kind: ParityKind) =>
  (kind === 'workspace' ? cells.find((c) => c.classList.contains('nm')) : null) ?? cells.find((c) => !isCkCell(c)) ?? null
const numericOf = (cells: Element[]) => cells.find((c) => c.classList.contains('num')) ?? cells.find((c) => c.classList.contains('r')) ?? null
const settingsOf = (cells: Element[]) => cells.find((c) => c.classList.contains('ed')) ?? null
const ckCellOf = (cells: Element[]) => cells.find(isCkCell) ?? null
const checkboxOf = (cell: Element | null): { el: Element | null; sel: string } => {
  if (!cell) return { el: null, sel: 'no selection cell' }
  for (const s of ['.ag-checkbox-input-wrapper', 'input[type="checkbox"]']) { const el = cell.querySelector(s); if (el) return { el, sel: s } }
  return { el: null, sel: 'no checkbox inside the selection cell' }
}
const identityText = (cell: Element | null) => (cell ? text(cell.querySelector('.t') ?? cell) : '')
/** The box of a cell's rendered TEXT, whatever wraps it. */
const textBox = (cell: Element) => {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
  let node: Node | null = walker.nextNode()
  while (node && !(node.textContent ?? '').trim()) node = walker.nextNode()
  const r = document.createRange()
  if (node) r.selectNodeContents(node); else r.selectNodeContents(cell)
  return r.getBoundingClientRect()
}
/** The consumer's content box inside a cell: `.nmw` (identity) or the first element child; AG wraps cells in `.ag-cell-value`/`.ag-cell-wrapper`. */
const contentOf = (cell: Element): Element => cell.querySelector('.nmw, .h10-ec, .nds-tree-lead') ?? (() => { let n: Element = cell; while (n.firstElementChild && [...n.classList].some((k) => k.startsWith('ag-'))) n = n.firstElementChild; return n === cell ? (cell.firstElementChild ?? cell) : n })()

/* ── one side ────────────────────────────────────────────────────────────────────────────────── */

async function measureSide(sideEl: Element, kind: ParityKind, id: string, side: Side): Promise<SideResult> {
  if (sideEl.hasAttribute('data-parity-pending')) return 'pending'
  let f = find(sideEl, kind)
  if (!f) return { _error: NOPE(`no grid wrapper on the ${side} side of ${id}`) }
  let settled: Val = 'n/a (legacy renders every row)'
  if (f.engine === 'ag') { const s = await settleRows(f.wrapper); settled = `${s.rendered} rows after ${s.waitedMs}ms`; f = find(sideEl, kind)! }
  const { wrapper, model, engine, wrapperSel } = f
  const cells0 = model.cellsOf(0)
  const identity = identityOf(cells0, engine, kind)
  const numeric = numericOf(cells0)
  const settings = settingsOf(cells0)
  const ckCell = ckCellOf(cells0)
  const ck = checkboxOf(ckCell)
  const first = model.data[0] ?? null
  const scope = sideEl
  const toolbar = scope.querySelector('.h10-am-toolbar')
  const pager = scope.querySelector('.h10-am-pager')
  const prefsbar = scope.querySelector('.nds-grid-prefsbar')

  const out: Measured = {
    _engine: engine,
    _wrapper: wrapperSel,
    _rowPart: model.part,
    _settled: settled,
    wrapper: read(wrapper, FRAME, 'wrapper'),
    header: { height: model.headerRow ? px(rect(model.headerRow)!.height) : NOPE('no header row') },
    rows: {
      count: model.data.length,
      firstHeight: first ? px(rect(first)!.height) : NOPE('no data row'),
      firstClass: first ? [...first.classList].filter((k) => !k.startsWith('ag-')).join(' ') : NOPE('no data row'),
      firstCellCount: cells0.length,
      skeletonCount: model.skeleton.length,
      skeletonHeight: model.skeleton[0] ? px(rect(model.skeleton[0])!.height) : NOPE('no skeleton row'),
      groupCount: model.groups.length,
      kidCount: model.kids.length,
      subCount: model.subs.length,
    },
    identity: identity ? {
      ...(read(identity, CELL, 'identity cell') as Measured),
      text: identityText(identity),
      classes: [...identity.classList].filter((k) => !k.startsWith('ag-')).join(' '),
      // What the eye sees, engine-independent: the painted colour behind the cell, the row rule, the pinned shadow,
      // and where the cell's content sits inside the row (the legacy centres with padding, AG with flex).
      paint: effectiveBg(identity), paintBy: effectiveBgSource(identity),
      ...(rowRule(identity, first) as Measured),
      ...(pinnedShadow(identity) as Measured),
      contentTop: first && identity.firstElementChild ? px(rect(contentOf(identity))!.top - rect(first)!.top) : NOPE('no content'),
      contentLeft: identity.firstElementChild ? px(rect(contentOf(identity))!.left - rect(identity)!.left) : NOPE('no content'),
    } : NOPE('no identity cell in the first row'),
    parts: identity ? partsOf(identity, kind) : NOPE('no identity cell'),
    checkboxCell: ckCell ? { ...(read(ckCell, ['padding', 'textAlign', 'verticalAlign', 'backgroundColor'], 'checkbox cell') as Measured), paint: effectiveBg(ckCell), boxTop: ck.el && first ? px(rect(ck.el)!.top - rect(first)!.top) : NOPE('no checkbox'), boxLeft: ck.el ? px(rect(ck.el)!.left - rect(ckCell)!.left) : NOPE('no checkbox') } : NOPE('no selection cell in the first row'),
    checkbox: ck.el ? { ...(read(ck.el, CHECK, 'checkbox') as Measured), _sel: ck.sel } : NOPE(ck.sel),
    // The figure's own box, by a Range: the legacy td holds a bare text node, AG wraps it in its own element.
    numeric: numeric ? { ...(read(numeric, NUM, 'numeric cell') as Measured), text: text(numeric), paint: effectiveBg(numeric), ...(rowRule(numeric, first) as Measured), textTop: first ? px(textBox(numeric).top - rect(first)!.top) : NOPE('no row'), textRight: px(rect(numeric)!.right - textBox(numeric).right), textHeight: px(textBox(numeric).height) } : NOPE('no numeric cell (.num / .r) in the first row'),
    settings: settings ? read(settings, ['textAlign', 'padding'], 'settings cell') : NOPE('no settings cell (.ed) in the first row'),
    totals: model.totals ? totalsOf(model, engine) : NOPE('no totals row'),
    group: model.groups[0] ? groupOf(model.groups[0]) : NOPE('no group band'),
    kid: model.kids[0] ? kidOf(model.kids[0], engine) : NOPE('no child row'),
    sub: model.subs[0] ? read(model.subs[0].querySelector('td') ?? model.subs[0], ['backgroundColor', 'padding', 'borderBottomColor'], 'expanded panel') : NOPE('no expanded panel'),
    empty: model.empty ? { ...(read(model.empty, ['padding', 'color', 'textAlign', 'fontSize', 'whiteSpace'], 'empty state') as Measured), text: text(model.empty).slice(0, 120) } : NOPE('no empty state'),
    stickyRight: stickyRightOf(cells0, engine),
    rowPaint: first ? (visiblePaint(identity, first) as unknown as Measured) : NOPE('no data row'),
    selectedRow: selectedRowOf(model, engine, kind),
    remainder: remainderOf(model, engine, kind),
    toolbar: toolbar ? {
      ...(read(toolbar, BAR, 'toolbar') as Measured),
      cnt: read(toolbar.querySelector('.cnt'), TXT, 'toolbar count'),
      cntText: text(toolbar.querySelector('.cnt')),
      buttons: [...toolbar.querySelectorAll('button, a')].map((b) => text(b) || b.getAttribute('aria-label') || '(icon)'),
      search: read(toolbar.querySelector('.h10-am-searchbox, .h10-am-searchbtn'), ['width', 'height', 'borderRadius', 'borderColor', 'padding'], 'search control'),
    } : NOPE('no .h10-am-toolbar on this side'),
    pager: pager ? {
      ...(read(pager, ['padding', 'gap', 'display', 'justifyContent'], 'pager') as Measured),
      pgbtn: read(pager.querySelector('.pgbtn:not(.on):not([disabled])'), BTN, 'an idle page button'),
      pgbtnOn: read(pager.querySelector('.pgbtn.on'), BTN, 'the active page button'),
      pgbtnDisabled: read(pager.querySelector('.pgbtn[disabled]'), BTN, 'a disabled page button'),
      pgbtnCount: pager.querySelectorAll('.pgbtn').length,
      pgbtnTexts: [...pager.querySelectorAll('.pgbtn')].map(text),
      rpp: read(pager.querySelector('.rpp'), TXT, 'rows-per-page'),
      rppText: text(pager.querySelector('.rpp')),
      centred: cs(pager).justifyContent,
    } : NOPE('no .h10-am-pager on this side'),
    prefsbar: prefsbar ? { ...(read(prefsbar, ['height', 'padding', 'marginBottom', 'justifyContent'], 'prefs bar') as Measured), text: text(prefsbar) } : NOPE('no .nds-grid-prefsbar'),
    latest: read(scope.querySelector('.h10-am-latest'), ['fontSize', 'color', 'padding'], 'Latest Report footer'),
    identityTexts: model.data.slice(0, 8).map((_, i) => identityText(identityOf(model.cellsOf(i), engine, kind))),
    lastIdentityTexts: model.data.slice(-3).map((_, i, arr) => identityText(identityOf(model.cellsOf(model.data.length - arr.length + i), engine, kind))),
    hoverReveal: 'not measured: a real pointer is needed — the runner reads it through __parityProbe.hover(id, side) after page.hover()',
    selection: 'not measured here: a header tick re-renders the grid, so it is a separate step — __parityProbe.selection(id, side) — that the runner guards with its own timeout',
  }
  return out
}

/**
 * The header-checkbox round trip for ONE side: tick → read the toolbar count → untick → read again.
 * Its own entry point, on purpose: the first full run froze the renderer inside this step (an engine
 * that echoes a controlled selection loops forever), and a loop in one engine must not cost the
 * measurement of everything else. The runner races it against a driver-side timeout.
 */
export async function selection(id: string, side: Side): Promise<Val> {
  const el = sideOf(id, side)
  if (!el) return NOPE('no side')
  if (el.hasAttribute('data-parity-pending')) return 'pending'
  const kind = (el.closest('[data-parity-scenario]') as HTMLElement).dataset.parityKind as ParityKind
  const f = find(el, kind)
  if (!f) return NOPE('no grid')
  return selectionOf(f.model, el.querySelector('.h10-am-toolbar'), f.engine, kind)
}

function partsOf(identity: Element, kind: ParityKind): Val {
  const out: Measured = {}
  const names: Array<[string, string]> = kind === 'workspace'
    ? [['nmw', '.nmw'], ['bulb', '.bulb'], ['tg', '.tg'], ['pb', '.pb'], ['t', '.t'], ['mk', '.mk'], ['open', '.h10-open'], ['pencil', '.h10-editpen'], ['ec', '.h10-ec'], ['treeLead', '.nds-tree-lead'], ['treeChev', '.nds-tree-chev']]
    : [['t', '.t'], ['mk', '.mk'], ['pill', '.nds-pill']]
  for (const [k, sel] of names) {
    const el = identity.querySelector(sel)
    out[k] = el ? { ...(read(el, k === 'nmw' || k === 'treeLead' ? ['display', 'gap', 'alignItems', 'maxWidth', 'paddingInlineStart'] : CHIP, sel) as Measured), text: text(el).slice(0, 60) } : NOPE(`no ${sel} in the identity cell`)
  }
  return out
}

function totalsOf(model: RowModel, engine: 'legacy' | 'ag'): Val {
  const row = model.totals!
  const cells = engine === 'ag' ? byColumn(model.totalsParts.flatMap((p) => [...p.querySelectorAll('.ag-cell')])) : [...row.children]
  const first = cells.find((c) => !isCkCell(c)) ?? null
  const num = cells.find((c) => c.classList.contains('num')) ?? cells.find((c) => c.classList.contains('r')) ?? null
  return {
    height: px(rect(row)!.height),
    classes: [...row.classList].filter((k) => !k.startsWith('ag-')).join(' '),
    firstCell: first ? { ...(read(first, ['backgroundColor', 'fontWeight', 'color', 'padding', 'textAlign', 'borderBottomColor', 'borderBottomWidth', 'borderTopColor', 'borderTopWidth', 'fontSize'], 'totals identity cell') as Measured), text: text(first), paint: effectiveBg(first), ...(rowRule(first, row) as Measured) } : NOPE('no totals identity cell'),
    numCell: num ? { ...(read(num, ['backgroundColor', 'fontWeight', 'color', 'textAlign', 'fontSize'], 'totals numeric cell') as Measured), text: text(num), paint: effectiveBg(num) } : NOPE('no totals numeric cell'),
    texts: cells.slice(0, 5).map(text),
  }
}

function groupOf(row: Element): Val {
  const td = row.querySelector('td') ?? row.querySelector('.ag-cell, .ag-group-value, [class*="grp"]') ?? row
  return {
    height: px(rect(row)!.height),
    band: { ...(read(td, ['backgroundColor', 'padding', 'borderTopColor', 'borderTopWidth', 'borderBottomColor', 'borderBottomWidth'], 'group band cell') as Measured), paint: effectiveBg(td), ...(rowRule(td, row) as Measured) },
    gl: row.querySelector('.gl') ? { ...(read(row.querySelector('.gl'), TXT, 'group label .gl') as Measured), text: text(row.querySelector('.gl')) } : NOPE('no .gl in the band'),
    gc: row.querySelector('.gc') ? { ...(read(row.querySelector('.gc'), [...TXT, 'marginLeft'], 'group count .gc') as Measured), text: text(row.querySelector('.gc')) } : NOPE('no .gc in the band'),
    text: text(row),
  }
}

function kidOf(row: Element, engine: 'legacy' | 'ag'): Val {
  const cells = engine === 'ag' ? byColumn([...row.querySelectorAll('.ag-cell')]) : [...row.children]
  return {
    height: px(rect(row)!.height),
    firstCell: read(cells[0] ?? null, ['backgroundColor', 'boxShadow', 'padding'], 'child row first cell'),
    cell: read(cells[1] ?? null, ['backgroundColor'], 'child row second cell'),
  }
}

function stickyRightOf(cells: Element[], engine: 'legacy' | 'ag'): Val {
  const el = cells.find((c) => c.classList.contains('fzr0')) ?? cells.find((c) => c.classList.contains('sticky-right')) ?? (engine === 'ag' ? cells.find((c) => c.closest('.ag-pinned-right-cols-container, [class*="pinned-right"]')) ?? null : null)
  return el ? { ...(read(el, ['boxShadow', 'borderLeftColor', 'borderLeftWidth', 'backgroundColor', 'position'], 'right-pinned cell') as Measured), classes: [...el.classList].filter((k) => !k.startsWith('ag-')).join(' '), paint: effectiveBg(el), ...(pinnedShadow(el) as Measured) } : NOPE('no right-pinned cell (fzr0 / sticky-right) in the first row')
}

function selectedRowOf(model: RowModel, engine: 'legacy' | 'ag', kind: ParityKind): Val {
  const i = model.data.findIndex((r) => r.classList.contains('on') || r.classList.contains('sel') || r.classList.contains('ag-row-selected'))
  if (i < 0) return NOPE('no selected row on screen')
  const cells = model.cellsOf(i)
  const idc = identityOf(cells, engine, kind)
  const num = numericOf(cells)
  return { index: i, identityBg: idc ? cs(idc).backgroundColor : NOPE('identity'), numericBg: num ? cs(num).backgroundColor : NOPE('numeric'), rowBg: cs(model.data[i]).backgroundColor, ...(visiblePaint(idc, model.data[i]) as unknown as Measured) }
}

function remainderOf(model: RowModel, engine: 'legacy' | 'ag', kind: ParityKind): Val {
  const i = model.data.findIndex((r) => r.classList.contains('nds-tree-remainder'))
  if (i < 0) return NOPE('no remainder row')
  const cells = model.cellsOf(i)
  const idc = identityOf(cells, engine, kind)
  const num = numericOf(cells)
  return {
    identity: idc ? { ...(read(idc, ['backgroundColor', 'color', 'fontStyle', 'fontWeight'], 'remainder identity cell') as Measured), paint: effectiveBg(idc) } : NOPE('remainder identity cell'),
    numeric: num ? { ...(read(num, ['backgroundColor', 'fontStyle'], 'remainder numeric cell') as Measured), paint: effectiveBg(num) } : NOPE('remainder numeric cell'),
    hasCheckbox: !!ckCellOf(cells)?.querySelector('input, .ag-checkbox-input-wrapper'),
    // AG hides a disabled checkbox with `hideDisabledCheckboxes` — present in the DOM, not on screen. The eye's question.
    checkboxVisible: (() => { const b = ckCellOf(cells)?.querySelector('input, .ag-checkbox-input-wrapper') ?? null; return b ? rect(b)!.width > 0 && cs(b).visibility !== 'hidden' && cs(b).display !== 'none' : false })(),
  }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Two animation frames, or 300ms if none comes (a hidden tab never paints — the wait must not hang the probe). */
const twoFrames = () => Promise.race([new Promise<boolean>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))), tick(300).then(() => false)])
async function visibility(): Promise<Visibility> {
  const raf = await Promise.race([new Promise<boolean>((r) => requestAnimationFrame(() => r(true))), tick(300).then(() => false)])
  const hidden = document.visibilityState !== 'visible' || !raf
  return { state: document.visibilityState, rafWithin300ms: raf, note: hidden ? 'HIDDEN TAB — no rAF / ResizeObserver: the AG column fit and row auto-height have not run; heights and widths read here are not a rendering' : 'visible — painted' }
}

/**
 * AG renders rows LAZILY in autoHeight mode: measured in a live tab, a 100-row grid held 14 `.ag-row`s until its
 * bottom had been scrolled into view, then 100 (and kept them). The probe reads the first 8 and the last 3 rows,
 * so before measuring a side it scrolls the grid's end, then its start, into view and waits for the row count to
 * stop changing (≤3s). Scrolling moves nothing the probe compares (rects are sizes and in-row offsets).
 */
async function settleRows(wrapper: Element): Promise<{ rendered: number; waitedMs: number }> {
  const count = () => new Set([...wrapper.querySelectorAll('.ag-row')].map((r) => r.getAttribute('row-index'))).size
  let waited = 0
  for (const block of ['end', 'start'] as const) {
    wrapper.scrollIntoView({ block })
    await twoFrames()
    let last = -1, stable = 0
    while (waited < 3000 && stable < 2) { await tick(150); waited += 150; const c = count(); stable = c === last ? stable + 1 : 0; last = c }
  }
  return { rendered: count(), waitedMs: waited }
}

/** Tick the header checkbox, read the count, untick, read again. A DOM click, so both engines' own handlers run. */
async function selectionOf(model: RowModel, toolbar: Element | null, engine: 'legacy' | 'ag', kind: ParityKind): Promise<Val> {
  const hc = model.headerCheckbox
  if (!hc) return NOPE('no header checkbox')
  const cnt = () => (toolbar ? text(toolbar.querySelector('.cnt')) : NOPE('no toolbar count on this side'))
  const firstBox = () => checkboxOf(ckCellOf(model.cellsOf(0))).el
  const checked = (el: Element | null) => (el instanceof HTMLInputElement ? el.checked : el ? el.classList.contains('ag-checked') || !!el.querySelector('input:checked') : NOPE('no row checkbox'))
  const before = cnt()
  hc.click()
  await tick(120)
  const afterTick = cnt()
  const firstChecked = checked(firstBox())
  const rowClass = model.data[0] ? [...model.data[0].classList].filter((k) => k === 'on' || k === 'sel' || k === 'ag-row-selected').join(' ') : ''
  const identityBg = (() => { const c = identityOf(model.cellsOf(0), engine, kind); return c ? cs(c).backgroundColor : NOPE('identity') })()
  const selPaint = visiblePaint(identityOf(model.cellsOf(0), engine, kind), model.data[0] ?? null)
  hc.click()
  await tick(120)
  const afterUndo = cnt()
  return { before, afterHeaderTick: afterTick, firstRowChecked: firstChecked, firstRowClass: rowClass, selectedIdentityBg: identityBg, selectedPaint: selPaint.paint, selectedPaintBy: selPaint.paintBy, selectedLayers: selPaint.layers, afterUndo, restored: afterUndo === before }
}

/* ── the page-level probe ────────────────────────────────────────────────────────────────────── */

/**
 * LIVE sections only. Next streams the page's SSR HTML inside a hidden `<div id="S:0">` segment that lingers for
 * seconds after hydration: a probe that ran 3s after load saw 38 scenarios, 19 of them display:none (legacy
 * tables with no AG root). Hidden DOM is not a rendering.
 */
const sections = () => [...document.querySelectorAll<HTMLElement>('[data-parity-scenario]')].filter((s) => !s.closest('[hidden]') && s.getClientRects().length > 0)
const sideOf = (id: string, side: Side) => sections().find((s) => s.dataset.parityScenario === id)?.querySelector<HTMLElement>(`[data-parity-side="${side}"]`) ?? null

export async function probe(): Promise<ProbeResult> {
  const secs = sections()
  const kinds = new Set(secs.map((s) => s.dataset.parityKind as ParityKind))
  const scenarios: ScenarioResult[] = []
  for (const s of secs) {
    const id = s.dataset.parityScenario!
    const kind = s.dataset.parityKind as ParityKind
    const l = s.querySelector<HTMLElement>('[data-parity-side="legacy"]')
    const a = s.querySelector<HTMLElement>('[data-parity-side="ag"]')
    scenarios.push({
      id, kind,
      exempt: (s.dataset.parityExempt ?? '').split(' ').filter(Boolean),
      legacy: l ? await measureSide(l, kind, id, 'legacy') : { _error: NOPE('no legacy side') },
      ag: a ? await measureSide(a, kind, id, 'ag') : { _error: NOPE('no ag side') },
    })
  }
  return { viewport: { w: window.innerWidth, h: window.innerHeight }, visibility: await visibility(), kind: kinds.size === 1 ? [...kinds][0] : kinds.size ? 'mixed' : 'none', at: new Date().toISOString(), scenarios }
}

/**
 * Tag a data row of a side so the runner can `page.hover()` it; returns the selector to hover. The target is the
 * row's STATUS cell, not the row: Playwright hovers the centre of a box, and a legacy `<tr>` is as wide
 * as its table, so its centre landed on different cells per scenario (run 1: the Open pill's own :hover colour
 * on one side). The same cell on both sides is the only fair pointer.
 */
export function markRow(id: string, side: Side, index = 0): string | null {
  const el = sideOf(id, side)
  if (!el) return null
  const f = find(el, (el.closest('[data-parity-scenario]') as HTMLElement).dataset.parityKind as ParityKind)
  const row = f?.model.data[index]
  document.querySelectorAll('[data-parity-hover-target], [data-parity-hover-row]').forEach((n) => { n.removeAttribute('data-parity-hover-target'); n.removeAttribute('data-parity-hover-row') })
  if (!row || !f) return null
  row.setAttribute('data-parity-hover-row', '')
  // The Status cell: the first cell after the identity, visible on both sides at any width. The first NUMERIC cell
  // is not — on the legacy the pinned-right columns overlay it in a 740px box, and a covered target is one
  // Playwright refuses to hover.
  const cells = f.model.cellsOf(index)
  const target = settingsOf(cells) ?? cells.find((c) => !isCkCell(c) && !c.classList.contains('nm')) ?? row
  target.setAttribute('data-parity-hover-target', '')
  return '[data-parity-hover-target]'
}

/** Read the hover-reveal state of the tagged row. Call after a REAL pointer hover. */
export function hover(id: string, side: Side): Val {
  const el = sideOf(id, side)
  if (!el) return NOPE('no side')
  const kind = (el.closest('[data-parity-scenario]') as HTMLElement).dataset.parityKind as ParityKind
  const f = find(el, kind)
  if (!f) return NOPE('no grid')
  const row = el.querySelector('[data-parity-hover-row]')
  const i = row ? f.model.data.indexOf(row) : -1
  if (i < 0) return NOPE('no tagged row — call markRow first')
  const cells = f.model.cellsOf(i)
  const idc = identityOf(cells, f.engine, kind)
  const num = numericOf(cells)
  const open = idc?.querySelector('.h10-open') ?? null
  const pen = cells.map((c) => c.querySelector('.h10-editpen')).find(Boolean) ?? null
  const parts = f.model.partsOf(i)
  return {
    hovered: parts.some((p) => p.matches(':hover')) || parts.some((p) => p.classList.contains('ag-row-hover')),
    partsHovered: parts.map((p) => p.matches(':hover') || p.classList.contains('ag-row-hover')),
    open: open ? read(open, ['display', 'opacity', 'color', 'backgroundColor', 'borderRadius', 'padding', 'fontSize', 'fontWeight'], '.h10-open') : NOPE('no .h10-open in the identity cell'),
    pencil: pen ? read(pen, ['opacity', 'display', 'color'], '.h10-editpen') : NOPE('no .h10-editpen in the row'),
    identityBg: idc ? cs(idc).backgroundColor : NOPE('identity'),
    numericBg: num ? cs(num).backgroundColor : NOPE('numeric'),
    rowBg: cs(f.model.data[i]).backgroundColor,
    // The colour the eye sees on the hovered row, and which box drew it (AG: a row `::before` overlay).
    ...(visiblePaint(idc, parts.find((p) => idc && p.contains(idc)) ?? f.model.data[i]) as unknown as Measured),
    numericPaint: visiblePaint(num, parts.find((p) => num && p.contains(num)) ?? f.model.data[i]).paint,
    cursor: cs(f.model.data[i]).cursor,
    cursorOnNumeric: num ? cs(num).cursor : NOPE('numeric'),
    cursorOnText: idc?.querySelector('.t') ? cs(idc.querySelector('.t')!).cursor : NOPE('no .t'),
  }
}

/** Click the sortable header labelled `label` on a side (AG headers are the engine's, so this clicks the header cell). */
export function sortBy(id: string, side: Side, label: string): Val {
  const el = sideOf(id, side)
  if (!el) return NOPE('no side')
  if (el.querySelector('.ag-root-wrapper')) {
    const cell = [...el.querySelectorAll<HTMLElement>('.ag-header-cell')].find((h) => text(h.querySelector('.ag-header-cell-text') ?? h) === label)
    if (!cell) return NOPE(`no AG header labelled ${label}`)
    ;(cell.querySelector<HTMLElement>('.ag-header-cell-label') ?? cell).click()
    return { clicked: label, engine: 'ag' }
  }
  const th = [...el.querySelectorAll<HTMLElement>('thead th')].find((h) => text(h).replace(/\s*[⇅↑↓]\s*$/, '').startsWith(label))
  const btn = th?.querySelector<HTMLElement>('button.sortable, button.sortbtn')
  if (!btn) return NOPE(`no sortable legacy header labelled ${label}`)
  btn.click()
  return { clicked: label, engine: 'legacy' }
}

/** The texts of one column, first 8 + last 3, in visual row order. AG cells carry `col-id`; legacy cells are found by header index. */
export async function columnTexts(id: string, side: Side, key: string, label: string): Promise<Val> {
  const el = sideOf(id, side)
  if (!el) return NOPE('no side')
  const kind = (el.closest('[data-parity-scenario]') as HTMLElement).dataset.parityKind as ParityKind
  let f = find(el, kind)
  if (!f) return NOPE('no grid')
  if (f.engine === 'ag') { await settleRows(f.wrapper); f = find(el, kind)! }
  const n = f.model.data.length
  const pick = (i: number) => {
    const cells = f.model.cellsOf(i)
    if (f.engine === 'ag') return text(cells.find((c) => c.getAttribute('col-id') === key) ?? null)
    const ths = [...(f.wrapper.querySelectorAll('thead th'))]
    const idx = ths.findIndex((h) => text(h).replace(/\s*[⇅↑↓]\s*$/, '').startsWith(label))
    return idx >= 0 ? text(cells[idx] ?? null) : NOPE(`no header ${label}`)
  }
  const ids = [...Array(Math.min(8, n)).keys()].map(pick)
  const tail = n > 8 ? [...Array(Math.min(3, n - 8)).keys()].map((k) => pick(n - Math.min(3, n - 8) + k)) : []
  const idents = f.model.data.slice(0, 8).map((_, i) => identityText(identityOf(f.model.cellsOf(i), f.engine, kind)))
  const sortedHeader = f.engine === 'ag'
    ? [...el.querySelectorAll('.ag-header-cell')].filter((h) => h.querySelector('.ag-sort-ascending-icon:not(.ag-hidden), .ag-sort-descending-icon:not(.ag-hidden)') || /ag-header-cell-sorted-(asc|desc)/.test(h.className)).map((h) => text(h.querySelector('.ag-header-cell-text') ?? h))
    : [...el.querySelectorAll('thead th.sorted')].map((h) => text(h))
  return { count: n, first: ids, last: tail, identityTexts: idents, sortedHeader }
}

export const list = () => sections().map((s) => ({ id: s.dataset.parityScenario, kind: s.dataset.parityKind, exempt: (s.dataset.parityExempt ?? '').split(' ').filter(Boolean), agPending: !!s.querySelector('[data-parity-side="ag"][data-parity-pending]') }))

export type ParityProbe = typeof probe & { markRow: typeof markRow; hover: typeof hover; sortBy: typeof sortBy; columnTexts: typeof columnTexts; selection: typeof selection; list: typeof list }

export function makeProbe(): ParityProbe {
  return Object.assign(probe, { markRow, hover, sortBy, columnTexts, selection, list })
}

declare global {
  interface Window {
    __parityProbe?: ParityProbe
  }
}
