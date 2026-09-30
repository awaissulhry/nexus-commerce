/**
 * Audit B32 (2026-09-30) — the sheet's chrome keeps its props while nothing it shows has changed.
 *
 * A scope adapter rebuilds its model on every render: a new toolbar object, new inline handlers, new JSX. Each save
 * changes the status three times (pending → saving → saved), and each time the whole surface re-rendered — the toolbar,
 * the footer, the grid host — because `GridSheet`'s `memo` never saw the same props twice (208 component renders for one
 * text edit, 461 for a listing-level select; budget ≤ 60).
 *
 * `stabilize` returns the PREVIOUS value wherever the new one is structurally the same, so `memo` and React's own
 * same-element bailout hold. Inline event handlers are the one thing a render always changes, so an EVENT HANDLER (a key
 * `on…`: `onExport`, `onSelect`, `onCellKeyDown`) is replaced by a stable TRAMPOLINE that calls the handler at the same
 * place in the LATEST value: a kept prop never runs a stale closure. Every other function (`resolveRow`, `exprFor`,
 * `describeView`, a component) is compared by identity — a component may call it while rendering, and its identity is how
 * it learns the data behind it changed. A React element is kept only when its type, key and props are the same, handlers included by identity
 * (its component decides what a handler means; it is never swapped behind its back). Past `maxDepth`, or in a
 * collection larger than `MAX_ENTRIES`, values are compared by identity only — row data and column definitions are never
 * walked, and a changed row array always reaches the grid.
 *
 * Pure: React is imported only for `isValidElement`.
 */
import { isValidElement } from 'react'

type Path = ReadonlyArray<string | number>
export type Resolve = (path: Path) => unknown

const TRAMPOLINE = Symbol('stableProps.trampoline')
const MAX_ENTRIES = 200

/** Event handlers: called on an event, never while rendering, so a trampoline to the latest one is always right. */
const EVENT_KEY = /^on[A-Z]/

export interface StabilizeOptions {
  /** How deep plain objects, arrays and elements are compared; below it, identity. */
  maxDepth: number
}

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function trampoline(resolve: Resolve, path: Path): (...args: unknown[]) => unknown {
  const at = [...path]
  const call = (...args: unknown[]) => {
    const fn = resolve(at)
    // Called on the object that holds it, as a method call on the latest value would be.
    return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).apply(resolve(at.slice(0, -1)), args) : undefined
  }
  ;(call as unknown as Record<symbol, boolean>)[TRAMPOLINE] = true
  return call
}

const isTrampoline = (value: unknown): boolean => typeof value === 'function' && !!(value as unknown as Record<symbol, boolean>)[TRAMPOLINE]

/** The value at `path` inside `root`. */
export function valueAt(root: unknown, path: Path): unknown {
  let at: unknown = root
  for (const key of path) {
    if (at === null || at === undefined) return undefined
    at = isValidElement(at) ? (at.props as Record<string, unknown>)[key as string] : (at as Record<string | number, unknown>)[key]
  }
  return at
}

/**
 * The stable form of `next`, given the previous raw value and the stable form handed out for it. `resolve` reads the
 * latest RAW value at a path (the trampolines call through it).
 */
export function stabilize<T>(prevRaw: unknown, prevStable: unknown, next: T, resolve: Resolve, options: StabilizeOptions): T {
  return walk(prevRaw, prevStable, next, resolve, [], 0, options.maxDepth, false) as T
}

function walk(prevRaw: unknown, prevStable: unknown, next: unknown, resolve: Resolve, path: Path, depth: number, maxDepth: number, inElement: boolean): unknown {
  if (typeof next === 'function') {
    // Inside an element a handler is the element's own business: compared by identity, never swapped.
    if (inElement || !EVENT_KEY.test(String(path[path.length - 1] ?? ''))) return next
    return isTrampoline(prevStable) ? prevStable : trampoline(resolve, path)
  }
  if (Object.is(prevRaw, next) && prevStable !== undefined) return prevStable
  if (next === null || typeof next !== 'object' || depth >= maxDepth) return next
  if (isValidElement(next)) {
    if (!isValidElement(prevRaw) || !isValidElement(prevStable) || prevRaw.type !== next.type || prevRaw.key !== next.key) return next
    const props = walk(prevRaw.props, prevRaw.props, next.props, resolve, path, depth + 1, maxDepth, true)
    return props === prevRaw.props ? prevStable : next
  }
  if (Array.isArray(next)) {
    if (next.length > MAX_ENTRIES || !Array.isArray(prevRaw) || !Array.isArray(prevStable) || prevRaw.length !== next.length) return mapArray(undefined, undefined, next, resolve, path, depth, maxDepth, inElement)
    const out = mapArray(prevRaw, prevStable, next, resolve, path, depth, maxDepth, inElement)
    return out.every((item, i) => item === prevStable[i]) ? prevStable : out
  }
  if (!isPlainObject(next)) return next
  const keys = Object.keys(next)
  if (keys.length > MAX_ENTRIES) return next
  const prevR = prevRaw && typeof prevRaw === 'object' && isPlainObject(prevRaw) && !isValidElement(prevRaw) ? prevRaw as Record<string, unknown> : undefined
  const prevS = prevStable && typeof prevStable === 'object' && isPlainObject(prevStable) && !isValidElement(prevStable) ? prevStable as Record<string, unknown> : undefined
  const out: Record<string, unknown> = {}
  let same = !!prevS && Object.keys(prevS).length === keys.length
  for (const key of keys) {
    const value = walk(prevR?.[key], prevS?.[key], (next as Record<string, unknown>)[key], resolve, [...path, key], depth + 1, maxDepth, inElement)
    out[key] = value
    if (!prevS || !(key in prevS) || prevS[key] !== value) same = false
  }
  return same ? prevS : out
}

function mapArray(prevRaw: unknown[] | undefined, prevStable: unknown[] | undefined, next: unknown[], resolve: Resolve, path: Path, depth: number, maxDepth: number, inElement: boolean): unknown[] {
  if (next.length > MAX_ENTRIES) return next
  return next.map((item, i) => walk(prevRaw?.[i], prevStable?.[i], item, resolve, [...path, i], depth + 1, maxDepth, inElement))
}
