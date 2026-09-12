/**
 * AGD — `rowProps` / `cellProps` / `headerProps` HANDLERS on AG's DOM (lane-owner decision 1).
 *
 * The legacy spread those props onto its `<tr>` / `<td>` / `<th>`. AG owns those elements, so the
 * handlers are DELEGATED: one listener per event type on the document, which resolves the element
 * the event rose through (`.ag-header-cell`, `.ag-cell`, `.ag-row`) back to the consumer's handler
 * and calls it with the native event RETARGETED so `currentTarget` is that element — the three ads
 * sites read `e.currentTarget.classList`, `e.dataTransfer`, and call `preventDefault()` (a drop
 * target spanning the whole row; a row-click toggle).
 *
 * 🔴 On the DOCUMENT, not on the grid's wrapper, and that is load-bearing. React attaches its own
 * listeners to the app's root container; a listener on the wrapper sits BELOW that root and would
 * run BEFORE every React handler inside the cells — so a consumer's `<button onClick={(e) =>
 * e.stopPropagation()}>` inside a cell could no longer keep the row handler from firing, which it
 * did on the legacy `<tr>`. From the document the order is the legacy's: inner React handlers
 * first, and a stopped event never arrives here at all.
 *
 * Only BUBBLING events are delegable; `mouseenter` / `mouseleave` / `focus` / `blur` are not, and
 * no consumer passes them. `className` / `style` / `title` / `data-*` / `aria-*` are attributes,
 * applied by `rowDom.ts`.
 */

/** native event type → the React prop name the legacy element would have carried. */
export const DELEGATED_EVENTS: ReadonlyArray<readonly [type: string, prop: string]> = [
  ['click', 'onClick'],
  ['dblclick', 'onDoubleClick'],
  ['contextmenu', 'onContextMenu'],
  ['pointerdown', 'onPointerDown'],
  ['pointerup', 'onPointerUp'],
  ['mousedown', 'onMouseDown'],
  ['mouseup', 'onMouseUp'],
  ['keydown', 'onKeyDown'],
  ['keyup', 'onKeyUp'],
  ['dragstart', 'onDragStart'],
  ['dragenter', 'onDragEnter'],
  ['dragover', 'onDragOver'],
  ['dragleave', 'onDragLeave'],
  ['drop', 'onDrop'],
  ['dragend', 'onDragEnd'],
]

const PROP_OF: ReadonlyMap<string, string> = new Map(DELEGATED_EVENTS)

export type HandlerBag = Record<string, unknown>

export interface DelegationTarget {
  /** The grid's wrapper (`.nds-ag-dg`); events outside it are not this grid's. */
  root: HTMLElement
  /** `rowProps(row)` for the row element, or nothing (a full-width sub row had no `rowProps`). */
  rowHandlers: (rowEl: HTMLElement) => HandlerBag | undefined
  /** `cellProps(row, column, index)` for the cell element. */
  cellHandlers: (cellEl: HTMLElement) => HandlerBag | undefined
  /** `headerProps(column, index)` for the header cell element. */
  headerHandlers: (headerEl: HTMLElement) => HandlerBag | undefined
}

/**
 * The native event, with `currentTarget` replaced by the element the consumer's handler belonged
 * to. Every other member reads through to the native event with the native receiver — a proxied
 * receiver makes `dataTransfer` / `clientX` throw "Illegal invocation" — and the few React-only
 * members the handlers might touch are answered from the native state.
 */
export function retarget<E extends Event>(ev: E, currentTarget: Element): E {
  return new Proxy(ev, {
    get(target, key) {
      if (key === 'currentTarget') return currentTarget
      if (key === 'nativeEvent') return target
      if (key === 'isDefaultPrevented') return () => target.defaultPrevented
      if (key === 'isPropagationStopped') return () => target.cancelBubble
      if (key === 'persist') return () => undefined
      const v = Reflect.get(target, key, target)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
    set(target, key, value) {
      return Reflect.set(target, key, value, target)
    },
  })
}

const ROOT_SELECTOR = '.nds-ag-dg'
const targets = new Map<HTMLElement, DelegationTarget>()
let installed = false

const call = (bag: HandlerBag | undefined, prop: string, ev: Event, el: HTMLElement): void => {
  const h = bag?.[prop]
  if (typeof h === 'function') (h as (e: Event) => void)(retarget(ev, el))
}

function dispatch(ev: Event): void {
  const t = ev.target as Element | null
  if (!t || typeof t.closest !== 'function') return
  const rootEl = t.closest(ROOT_SELECTOR) as HTMLElement | null
  if (!rootEl) return
  const target = targets.get(rootEl)
  if (!target) return
  const prop = PROP_OF.get(ev.type)
  if (!prop) return
  const header = t.closest('.ag-header-cell') as HTMLElement | null
  if (header) { call(target.headerHandlers(header), prop, ev, header); return }
  // Bubbling order: the cell's handler, then — unless it stopped the event — the row's.
  const cell = t.closest('.ag-cell') as HTMLElement | null
  if (cell) {
    call(target.cellHandlers(cell), prop, ev, cell)
    if (ev.cancelBubble) return
  }
  const row = t.closest('.ag-row') as HTMLElement | null
  if (row) call(target.rowHandlers(row), prop, ev, row)
}

function install(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  for (const [type] of DELEGATED_EVENTS) document.addEventListener(type, dispatch)
}

function uninstall(): void {
  if (!installed || typeof document === 'undefined') return
  installed = false
  for (const [type] of DELEGATED_EVENTS) document.removeEventListener(type, dispatch)
}

/** Register a grid; returns the unregister. The document listeners exist only while a grid is registered. */
export function registerDelegation(target: DelegationTarget): () => void {
  targets.set(target.root, target)
  install()
  return () => {
    if (targets.get(target.root) === target) targets.delete(target.root)
    if (targets.size === 0) uninstall()
  }
}

/** Test seam: how many grids are registered. */
export function delegationCount(): number {
  return targets.size
}
