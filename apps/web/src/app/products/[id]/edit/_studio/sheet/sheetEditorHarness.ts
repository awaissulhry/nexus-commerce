/**
 * A node-only harness that MOUNTS a real cell editor — the editor, the DS panel inside it, and every component below —
 * and replays a key the way a browser inside an AG Grid popup editor delivers it (P3, 2026-09-30).
 *
 * WHY. The Enter bug that shipped (P0, measured in production 2026-09-29) lived in the ORDER of listeners: AG's popup
 * listener ends the edit with the value the editor last reported, and it runs after React's CAPTURE handlers and before
 * React's BUBBLE handlers. A choice an editor made in its bubble handler was always too late. Tests that called a
 * panel's `onCommit` directly, or read one component's props, could not see that. This harness keeps the order:
 *   1. every `onKeyDownCapture` from the editor's root down to the focused element (a `stopPropagation()` ends here:
 *      AG never sees the key, so the editor must end the edit itself);
 *   2. AG — unless the column's `suppressKeyboardEvent` says the key is the editor's — ends the edit on Enter or Tab and
 *      commits the LAST value the editor reported through `onValueChange` (the AG 36 React contract), or cancels when
 *      the editor's `isCancelAfterEnd` says so;
 *   3. the `onKeyDown` bubble handlers, which matter only when AG left the key alone.
 *
 * `apps/web` vitest has no DOM library, so this renders on a small hook runtime (state, refs, memo, effects, ids,
 * context) and gives each host element a fake node with just enough DOM for the editors' own reads: `closest`,
 * `querySelector(All)` over simple selectors, `focus` / `document.activeElement`, zero-size geometry. React itself is
 * mocked by the test file (`vi.mock('react', …)` with `mockedReact`), so every component in the tree runs on this runtime.
 */

type Props = Record<string, any>
type Deps = readonly unknown[] | undefined

const ELEMENT = [Symbol.for('react.transitional.element'), Symbol.for('react.element')]
const FRAGMENT = Symbol.for('react.fragment')
const FORWARD_REF = Symbol.for('react.forward_ref')
const MEMO = Symbol.for('react.memo')
const CONTEXT = Symbol.for('react.context')
const PROVIDER = Symbol.for('react.provider')
const CONSUMER = Symbol.for('react.consumer')
const PORTAL = Symbol.for('react.portal')
const PASS_THROUGH = [Symbol.for('react.strict_mode'), Symbol.for('react.suspense'), Symbol.for('react.profiler')]

/* ── fake DOM ─────────────────────────────────────────────────────────────────────────────────────────────── */

export const fakeDocument = {
  activeElement: null as FakeElement | null, body: null as FakeElement | null,
  documentElement: { style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' } },
  addEventListener() {}, removeEventListener() {},
}

export class FakeElement {
  host!: HostNode
  scrollTop = 0
  scrollLeft = 0
  readonly style: Record<string, unknown> = {}
  readonly ownerDocument = fakeDocument
  get tagName() { return this.host.type.toUpperCase() }
  get className() { return String(this.host.props.className ?? '') }
  get id() { return String(this.host.props.id ?? '') }
  get parentElement(): FakeElement | null { return this.host.parent?.el ?? null }
  get children(): FakeElement[] { return this.host.children.filter((c) => c.type !== '#text').map((c) => c.el) }
  get textContent(): string { return textOf(this.host) }
  get value(): string { return String(this.host.props.value ?? this.host.props.defaultValue ?? '') }
  get checked(): boolean { return !!this.host.props.checked }
  get disabled(): boolean { return !!this.host.props.disabled }
  get selectionStart() { return this.value.length }
  get selectionEnd() { return this.value.length }
  /** Non-null: every mounted node counts as rendered (the editors skip `offsetParent === null` as hidden). */
  get offsetParent(): object { return this.host.parent?.el ?? {} }
  readonly offsetHeight = 0
  readonly offsetWidth = 0
  readonly clientHeight = 0
  readonly clientWidth = 0
  readonly clientTop = 0
  readonly scrollHeight = 0
  readonly classList = {
    add: () => {}, remove: () => {}, toggle: () => false,
    contains: (name: string) => this.className.split(/\s+/).includes(name),
  }
  getAttribute(name: string): string | null {
    const v = this.host.props[name === 'class' ? 'className' : name]
    return v === undefined || v === null || v === false ? null : String(v)
  }
  hasAttribute(name: string) { return this.getAttribute(name) !== null }
  setAttribute() {}
  removeAttribute() {}
  focus() { fakeDocument.activeElement = this }
  blur() { if (fakeDocument.activeElement === this) fakeDocument.activeElement = null }
  select() {}
  setSelectionRange() {}
  scrollIntoView() {}
  scrollTo() {}
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } }
  getClientRects() { return [] }
  contains(other: unknown): boolean {
    for (let at = other instanceof FakeElement ? other.host : null; at; at = at.parent) if (at === this.host) return true
    return false
  }
  matches(selector: string) { return matchesSelector(this.host, selector) }
  closest(selector: string): FakeElement | null {
    for (let at: HostNode | null = this.host; at; at = at.parent) if (at.type !== '#text' && matchesSelector(at, selector)) return at.el
    return null
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (node: HostNode) => {
      for (const child of node.children) {
        if (child.type === '#text') continue
        if (matchesSelector(child, selector)) out.push(child.el)
        walk(child)
      }
    }
    walk(this.host)
    return out
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
}
export class FakeInput extends FakeElement {}
export class FakeTextArea extends FakeElement {}
export class FakeSelect extends FakeElement {}
export class FakeButton extends FakeElement {}

function textOf(node: HostNode): string {
  return node.type === '#text' ? node.text ?? '' : node.children.map(textOf).join('')
}

/* `tag.class#id[attr][attr="v"]:not(…)` joined by descendant spaces or `>`, comma lists. Enough for the editors' reads. */
function matchesSelector(node: HostNode, selector: string): boolean {
  return selector.split(',').some((one) => matchesComplex(node, one.trim()))
}
function matchesComplex(node: HostNode, selector: string): boolean {
  const parts = selector.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean)
  const match = (at: HostNode | null, i: number): boolean => {
    if (!at || i < 0) return i < 0
    if (!matchesCompound(at, parts[i])) return false
    if (i === 0) return true
    if (parts[i - 1] === '>') return match(at.parent, i - 2)
    for (let up = at.parent; up; up = up.parent) if (match(up, i - 1)) return true
    return false
  }
  return match(node, parts.length - 1)
}
function matchesCompound(node: HostNode, compound: string): boolean {
  if (node.type === '#text') return false
  let rest = compound
  const nots: string[] = []
  rest = rest.replace(/:not\(([^)]*)\)/g, (_, inner: string) => { nots.push(inner); return '' })
  if (nots.some((n) => matchesCompound(node, n))) return false
  const tag = rest.match(/^[a-zA-Z][\w-]*/)?.[0]
  if (tag && tag.toLowerCase() !== node.type.toLowerCase()) return false
  const classes = node.props.className ? String(node.props.className).split(/\s+/) : []
  for (const m of rest.matchAll(/\.([\w-]+)/g)) if (!classes.includes(m[1])) return false
  for (const m of rest.matchAll(/#([\w-]+)/g)) if (node.props.id !== m[1]) return false
  for (const m of rest.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const v = node.props[m[1] === 'class' ? 'className' : m[1]]
    if (v === undefined || v === null || v === false) return false
    if (m[2] !== undefined && String(v) !== m[2]) return false
  }
  return true
}

/* ── hook runtime ────────────────────────────────────────────────────────────────────────────────────────── */

export interface HostNode { type: string; props: Props; children: HostNode[]; parent: HostNode | null; el: FakeElement; text?: string }

interface Instance { slots: unknown[]; at: number; id: number }
interface Effect { instance: Instance; slot: number; fn: () => unknown; layout: boolean }

const runtime = {
  instances: new Map<string, Instance>(),
  elements: new Map<string, FakeElement>(),
  current: null as Instance | null,
  effects: [] as Effect[],
  cleanups: new Map<string, () => void>(),
  contexts: new Map<object, unknown[]>(),
  dirty: false,
  nextId: 0,
}

const changed = (prev: Deps, next: Deps) => !prev || !next || prev.length !== next.length || next.some((d, i) => !Object.is(d, prev[i]))
function slot<T>(init: () => T): [Instance, number, T] {
  const instance = runtime.current
  if (!instance) throw new Error('sheetEditorHarness: a hook ran outside a component render')
  const i = instance.at++
  if (!(i in instance.slots)) instance.slots[i] = init()
  return [instance, i, instance.slots[i] as T]
}

const hooks = {
  useState<T>(init: T | (() => T)) {
    const [instance, i] = slot(() => (typeof init === 'function' ? (init as () => T)() : init))
    const set = (next: T | ((prev: T) => T)) => {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(instance.slots[i] as T) : next
      if (!Object.is(value, instance.slots[i])) { instance.slots[i] = value; runtime.dirty = true }
    }
    return [instance.slots[i] as T, set] as const
  },
  useReducer<S, A>(reducer: (s: S, a: A) => S, initial: S, init?: (s: S) => S) {
    const [state, set] = hooks.useState<S>(() => (init ? init(initial) : initial))
    return [state, (action: A) => set((prev) => reducer(prev, action))] as const
  },
  useRef<T>(init: T) { return slot(() => ({ current: init }))[2] },
  useMemo<T>(fn: () => T, deps: Deps) {
    const [instance, i, held] = slot(() => ({ deps: undefined as Deps, value: undefined as T, fresh: true }))
    if (held.fresh || changed(held.deps, deps)) instance.slots[i] = { deps, value: fn(), fresh: false }
    return (instance.slots[i] as { value: T }).value
  },
  useCallback<T>(fn: T, deps: Deps) { return hooks.useMemo(() => fn, deps) },
  useEffect(fn: () => unknown, deps?: Deps) { effectHook(fn, deps, false) },
  useLayoutEffect(fn: () => unknown, deps?: Deps) { effectHook(fn, deps, true) },
  useInsertionEffect(fn: () => unknown, deps?: Deps) { effectHook(fn, deps, true) },
  useId() { const [instance] = slot(() => 0); return `:h${instance.id}:` },
  useContext(context: { _currentValue?: unknown }) {
    const stack = runtime.contexts.get(context)
    return stack?.length ? stack[stack.length - 1] : context._currentValue
  },
  useImperativeHandle(ref: unknown, create: () => unknown) {
    if (typeof ref === 'function') ref(create())
    else if (ref && typeof ref === 'object') (ref as { current: unknown }).current = create()
  },
  useSyncExternalStore<T>(_subscribe: unknown, getSnapshot: () => T) { return getSnapshot() },
  useTransition() { return [false, (fn: () => void) => fn()] as const },
  useDeferredValue<T>(value: T) { return value },
  useDebugValue() {},
}
function effectHook(fn: () => unknown, deps: Deps, layout: boolean) {
  const [instance, i, held] = slot(() => ({ deps: undefined as Deps, fresh: true }))
  if (held.fresh || changed(held.deps, deps)) {
    instance.slots[i] = { deps, fresh: false }
    runtime.effects.push({ instance, slot: i, fn, layout })
  }
}

/** The `react` module the test mocks in: the real one, with this runtime's hooks. */
export function mockedReact<T extends Record<string, unknown>>(real: T): T {
  const merged = { ...real, ...hooks }
  return { ...merged, default: { ...(real.default as object), ...hooks } } as unknown as T
}

/* ── render ──────────────────────────────────────────────────────────────────────────────────────────────── */

const nameOf = (type: any): string =>
  typeof type === 'string' ? type
    : typeof type === 'function' ? type.displayName || type.name || 'Anonymous'
      : type?.$$typeof === FORWARD_REF ? type.displayName || type.render?.displayName || type.render?.name || 'ForwardRef'
        : type?.$$typeof === MEMO ? nameOf(type.type) : String(type?.$$typeof?.description ?? 'Unknown')

function instanceFor(path: string): Instance {
  let instance = runtime.instances.get(path)
  if (!instance) { instance = { slots: [], at: 0, id: ++runtime.nextId }; runtime.instances.set(path, instance) }
  instance.at = 0
  return instance
}

function callComponent(path: string, run: () => unknown): unknown {
  const previous = runtime.current
  runtime.current = instanceFor(path)
  try { return run() } finally { runtime.current = previous }
}

function attachRef(ref: unknown, el: FakeElement) {
  if (typeof ref === 'function') ref(el)
  else if (ref && typeof ref === 'object' && 'current' in (ref as object)) (ref as { current: unknown }).current = el
}

function renderNode(node: unknown, path: string, parent: HostNode, out: HostNode[]) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ type: '#text', text: String(node), props: {}, children: [], parent, el: new FakeElement() })
    return
  }
  if (Array.isArray(node) || (typeof node === 'object' && Symbol.iterator in (node as object) && !(node as any).$$typeof)) {
    let i = 0
    for (const child of node as Iterable<unknown>) {
      const key = child && typeof child === 'object' && (child as any).key != null ? `k${(child as any).key}` : `i${i}`
      renderNode(child, `${path}/${key}`, parent, out)
      i++
    }
    return
  }
  const element = node as { $$typeof: symbol; type: any; props: Props; key: string | null; children?: unknown }
  if (element.$$typeof === PORTAL) { renderNode(element.children, `${path}/portal`, parent, out); return }
  if (!ELEMENT.includes(element.$$typeof)) throw new Error(`sheetEditorHarness: cannot render ${String(element.$$typeof?.description ?? typeof node)}`)
  const { type, props } = element
  const here = `${path}:${nameOf(type)}`
  if (typeof type === 'string') {
    const host: HostNode = { type, props, children: [], parent, el: undefined as unknown as FakeElement }
    let el = runtime.elements.get(here)
    if (!el) {
      const Kind = type === 'input' ? FakeInput : type === 'textarea' ? FakeTextArea : type === 'select' ? FakeSelect : type === 'button' ? FakeButton : FakeElement
      el = new Kind()
      runtime.elements.set(here, el)
    }
    el.host = host
    host.el = el
    out.push(host)
    renderNode(props.children, here, host, host.children)
    if (props.ref) attachRef(props.ref, el)
    return
  }
  if (type === FRAGMENT || PASS_THROUGH.includes(type)) { renderNode(props.children, here, parent, out); return }
  if (typeof type === 'function') {
    if (type.prototype?.isReactComponent) throw new Error(`sheetEditorHarness: class component ${nameOf(type)} is not supported`)
    renderNode(callComponent(here, () => type(props)), here, parent, out)
    return
  }
  if (type?.$$typeof === FORWARD_REF) {
    const { ref, ...rest } = props
    renderNode(callComponent(here, () => type.render(rest, ref ?? null)), here, parent, out)
    return
  }
  if (type?.$$typeof === MEMO) { renderNode({ ...element, type: type.type }, path, parent, out); return }
  if (type?.$$typeof === CONTEXT || type?.$$typeof === PROVIDER) {
    const context = type.$$typeof === PROVIDER ? type._context : type
    const stack = runtime.contexts.get(context) ?? []
    runtime.contexts.set(context, [...stack, props.value])
    try { renderNode(props.children, here, parent, out) } finally { runtime.contexts.set(context, stack) }
    return
  }
  if (type?.$$typeof === CONSUMER) { renderNode(props.children(hooks.useContext(type._context)), here, parent, out); return }
  throw new Error(`sheetEditorHarness: unsupported element type ${nameOf(type)}`)
}

/* ── the mounted editor ──────────────────────────────────────────────────────────────────────────────────── */

export interface KeyEvent {
  key: string; type: 'keydown'; target: FakeElement; currentTarget: FakeElement | null
  shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; defaultPrevented: boolean
  nativeEvent: { isComposing: boolean; key: string }
  preventDefault(): void; stopPropagation(): void; isPropagationStopped(): boolean; persist(): void
}

export interface Mounted {
  root: HostNode
  /** Every host element, depth first. */
  all(): HostNode[]
  find(predicate: (node: HostNode) => boolean): HostNode | undefined
  /** Re-render until no state changes, running effects after each pass (as a commit would). */
  settle(): void
  /** Settle, let pending promises resolve, and settle again. */
  flush(): Promise<void>
  /** A keydown event for `key`, targeted at `target`. */
  keyEvent(key: string, target: HostNode, init?: Partial<Pick<KeyEvent, 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>>): KeyEvent
  /** Capture handlers root → target. Returns true when one stopped propagation. */
  capture(target: HostNode, event: KeyEvent): boolean
  /** Bubble handlers target → root. */
  bubble(target: HostNode, event: KeyEvent): void
  /** A full keydown with no grid in between (arrows, typing): capture, then bubble. */
  press(target: HostNode, key: string): void
  /** An input's change: sets the value the handler reads and calls `onChange`, then settles. */
  change(target: HostNode, value: string, extra?: Record<string, unknown>): void
  /** A click: `onClick` on the target (the editors under test never rely on bubbling clicks). */
  click(target: HostNode): void
  unmount(): void
}

export function mount(element: unknown): Mounted {
  runtime.instances.clear()
  runtime.elements.clear()
  runtime.cleanups.forEach((c) => c())
  runtime.cleanups.clear()
  runtime.effects = []
  runtime.contexts.clear()
  fakeDocument.activeElement = null
  const container: HostNode = { type: 'div', props: { className: 'ag-popup-editor' }, children: [], parent: null, el: new FakeElement() }
  container.el.host = container
  fakeDocument.body = container.el

  const renderOnce = () => {
    const children: HostNode[] = []
    runtime.dirty = false
    runtime.effects = []
    renderNode(element, 'root', container, children)
    container.children = children
    const queued = runtime.effects
    runtime.effects = []
    // Layout effects, then passive ones; children before parents, as a commit runs them.
    for (const effect of [...queued.filter((e) => e.layout).reverse(), ...queued.filter((e) => !e.layout).reverse()]) {
      const key = `${effect.instance.id}:${effect.slot}`
      runtime.cleanups.get(key)?.()
      const cleanup = effect.fn()
      if (typeof cleanup === 'function') runtime.cleanups.set(key, cleanup as () => void)
      else runtime.cleanups.delete(key)
    }
  }
  const settle = () => {
    for (let pass = 0; pass < 30; pass++) {
      renderOnce()
      if (!runtime.dirty) return
    }
    throw new Error('sheetEditorHarness: the editor kept changing its state after 30 renders')
  }
  settle()

  const all = () => {
    const out: HostNode[] = []
    const walk = (n: HostNode) => { for (const c of n.children) { if (c.type !== '#text') out.push(c); walk(c) } }
    walk(container)
    return out
  }
  const pathTo = (target: HostNode) => {
    const path: HostNode[] = []
    for (let at: HostNode | null = target; at; at = at.parent) path.unshift(at)
    return path
  }
  const mounted: Mounted = {
    get root() { return container },
    all,
    find: (predicate) => all().find(predicate),
    settle,
    flush: async () => {
      settle()
      // Microtasks only: a test may fake the timers, and loaded choices resolve as promises.
      for (let i = 0; i < 20; i++) await Promise.resolve()
      settle()
    },
    keyEvent(key, target, init = {}) {
      let stopped = false
      const event: KeyEvent = {
        key, type: 'keydown', target: target.el, currentTarget: null,
        shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...init, defaultPrevented: false,
        nativeEvent: { isComposing: false, key },
        preventDefault() { event.defaultPrevented = true },
        stopPropagation() { stopped = true },
        isPropagationStopped: () => stopped,
        persist() {},
      }
      return event
    },
    capture(target, event) {
      for (const node of pathTo(target)) {
        const handler = node.props.onKeyDownCapture
        if (typeof handler !== 'function') continue
        event.currentTarget = node.el
        handler(event)
        if (event.isPropagationStopped()) return true
      }
      return false
    },
    bubble(target, event) {
      for (const node of pathTo(target).reverse()) {
        const handler = node.props.onKeyDown
        if (typeof handler !== 'function') continue
        event.currentTarget = node.el
        handler(event)
        if (event.isPropagationStopped()) return
      }
    },
    press(target, key) {
      const event = mounted.keyEvent(key, target)
      if (!mounted.capture(target, event)) mounted.bubble(target, event)
      settle()
    },
    change(target, value, extra = {}) {
      if (typeof target.props.onChange !== 'function') throw new Error(`sheetEditorHarness: <${target.type}> has no onChange`)
      const el = target.el as FakeElement & { value: string }
      const shadow = Object.create(el, { value: { value }, selectionStart: { value: value.length }, checked: { value: extra.checked ?? el.checked } })
      // One native `input` event is two React events, dispatched in this order: onInput, then onChange — each capture, then bubble.
      for (const name of ['Input', 'Change']) {
        let stopped = false
        const event = { type: name.toLowerCase(), target: shadow, currentTarget: shadow, nativeEvent: {}, preventDefault() {}, stopPropagation() { stopped = true }, persist() {}, ...extra }
        const path = pathTo(target)
        for (const node of path) {
          if (stopped) break
          const handler = node.props[`on${name}Capture`]
          if (typeof handler === 'function') handler({ ...event, currentTarget: node.el })
        }
        for (const node of [...path].reverse()) {
          if (stopped) break
          const handler = node.props[`on${name}`]
          if (typeof handler === 'function') handler({ ...event, currentTarget: node.el })
        }
      }
      settle()
    },
    click(target) {
      const handler = target.props.onClick
      if (typeof handler !== 'function') throw new Error(`sheetEditorHarness: <${target.type}> has no onClick`)
      handler({ target: target.el, currentTarget: target.el, preventDefault() {}, stopPropagation() {}, button: 0, detail: 1 })
      settle()
    },
    unmount() {
      runtime.cleanups.forEach((c) => c())
      runtime.cleanups.clear()
    },
  }
  return mounted
}

/* ── the grid, as the popup editor sees it ───────────────────────────────────────────────────────────────── */

export interface EditSession {
  /** Every value the editor reported through `onValueChange`, in order. */
  reported: unknown[]
  /** How the edit ended: by AG (its own Enter/Tab) or by the editor calling `stopEditing`. */
  ended: null | { by: 'grid' | 'editor'; cancel: boolean; value: unknown }
  /** The params AG hands a React cell editor. */
  params: Props
}

/**
 * The params AG 36 gives a React popup editor, recording what the editor reports and how the edit ends. A committed value
 * is the last reported one (or the opening value when nothing was reported); `isCancelAfterEnd` turns a commit into a
 * cancel, as AG's React proxy does.
 */
export function editSession(value: unknown, extra: Props = {}, lifecycle: { isCancelAfterEnd?: () => boolean } = {}): EditSession {
  const session: EditSession = { reported: [], ended: null, params: {} }
  const end = (by: 'grid' | 'editor', cancel?: boolean) => {
    if (session.ended) return
    const cancelled = !!cancel || !!lifecycle.isCancelAfterEnd?.()
    session.ended = { by, cancel: cancelled, value: cancelled ? value : session.reported.length ? session.reported[session.reported.length - 1] : value }
  }
  const api = {
    stopEditing: (cancel?: boolean) => end('editor', cancel),
    tabToNextCell: () => true, tabToPreviousCell: () => true, getFocusedCell: () => null,
    getGridOption: () => undefined, setFocusedCell() {}, startEditingCell() {}, refreshCells() {},
  }
  session.params = {
    value, initialValue: value, eventKey: null, charPress: null, rowIndex: 0, node: { id: 'r1', rowIndex: 0, data: extra.data ?? {} },
    data: extra.data ?? {}, colDef: {}, column: { getActualWidth: () => 180, getColId: () => 'col', getColDef: () => ({}) },
    api, context: {}, cellStartedEdit: true, eGridCell: undefined,
    onValueChange: (next: unknown) => { session.reported.push(next) },
    stopEditing: (cancel?: boolean) => end('editor', cancel),
    parseValue: (v: unknown) => v, formatValue: (v: unknown) => v,
    ...extra,
  }
  ;(session as EditSession & { endByGrid: () => void }).endByGrid = () => end('grid')
  return session
}

/**
 * Enter or Tab, delivered in the browser's order around AG's popup listener (see the header). Returns how the edit ended.
 * `suppressKeyboardEvent` is the column's own: when it answers true, AG leaves the key to the editor.
 */
export function gridKey(
  mounted: Mounted, session: EditSession, target: HostNode, key: 'Enter' | 'Tab',
  suppressKeyboardEvent?: (params: { event: KeyEvent; editing: boolean }) => boolean,
): EditSession['ended'] {
  const event = mounted.keyEvent(key, target)
  const stopped = mounted.capture(target, event)
  mounted.settle()
  if (!stopped && !session.ended) {
    const suppressed = !!suppressKeyboardEvent?.({ event, editing: true })
    if (!suppressed) (session as EditSession & { endByGrid: () => void }).endByGrid()
    else { mounted.bubble(target, event); mounted.settle() }
  }
  return session.ended
}

/** Globals the editors read (window size, document focus, observers). Installed by the test with `vi.stubGlobal`. */
export const harnessGlobals = {
  window: {
    innerWidth: 1400, innerHeight: 900, devicePixelRatio: 1,
    getComputedStyle: () => ({ getPropertyValue: () => '', font: '', paddingLeft: '0px', paddingRight: '0px', lineHeight: '20px' }),
    addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (fn: (t: number) => void) => { fn(0); return 1 }, cancelAnimationFrame() {},
  },
  document: fakeDocument,
  Element: FakeElement, HTMLElement: FakeElement, HTMLInputElement: FakeInput, HTMLTextAreaElement: FakeTextArea,
  HTMLSelectElement: FakeSelect, HTMLButtonElement: FakeButton, Node: FakeElement,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
  requestAnimationFrame: (fn: (t: number) => void) => { fn(0); return 1 },
  cancelAnimationFrame: () => {},
  getComputedStyle: () => ({ getPropertyValue: () => '', font: '', paddingLeft: '0px', paddingRight: '0px', lineHeight: '20px' }),
}
