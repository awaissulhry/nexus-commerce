/**
 * AGD — `rowProps` / `cellProps` / `headerProps` ATTRIBUTES on AG's DOM.
 *
 * The legacy spread them onto its `<tr>` / `<td>` / `<th>`; AG owns those elements and offers no
 * option for a `title`, a `data-*`, an `aria-expanded` or an inline `style` on a row, so the
 * adapter applies them to the element itself, and takes back what it applied when the props
 * change. `splitElementProps` is the pure half (tested); `applyElementProps` the DOM half. Event
 * handlers are not attributes — `rowEvents.ts` delegates those.
 */

export interface SplitProps {
  attrs: Record<string, string>
  style: Record<string, string>
  classes: string[]
}

export interface AppliedState {
  attrs: string[]
  style: string[]
  classes: string[]
}

const isHandler = (key: string): boolean => /^on[A-Z]/.test(key)
const SKIP = new Set(['children', 'dangerouslySetInnerHTML', 'key', 'ref', 'className', 'style'])

/**
 * What of a React props bag can be put on an element by hand: `className` → classes, `style` →
 * inline declarations, everything else that is a string / number / `true` → an attribute (`true`
 * as the empty string, the way React renders a boolean attribute); handlers, `false`, `null` and
 * `undefined` are not attributes.
 */
export function splitElementProps(props: Record<string, unknown> | undefined | null): SplitProps {
  const out: SplitProps = { attrs: {}, style: {}, classes: [] }
  if (!props) return out
  for (const [key, value] of Object.entries(props)) {
    if (isHandler(key) || SKIP.has(key)) continue
    if (value === true) out.attrs[key] = ''
    else if (typeof value === 'string') out.attrs[key] = value
    else if (typeof value === 'number' && Number.isFinite(value)) out.attrs[key] = String(value)
  }
  const cls = props.className
  if (typeof cls === 'string' && cls.trim()) out.classes = cls.split(/\s+/).filter(Boolean)
  const style = props.style
  if (style && typeof style === 'object') {
    for (const [k, v] of Object.entries(style as Record<string, unknown>)) {
      if (typeof v === 'string') out.style[k] = v
      else if (typeof v === 'number' && Number.isFinite(v)) out.style[k] = String(v)
    }
  }
  return out
}

/** Apply `next` to the element, removing whatever `prev` applied that `next` no longer states. */
export function applyElementProps(el: HTMLElement, next: SplitProps, prev: AppliedState | undefined): AppliedState {
  for (const k of prev?.attrs ?? []) if (!(k in next.attrs)) el.removeAttribute(k)
  for (const [k, v] of Object.entries(next.attrs)) if (el.getAttribute(k) !== v) el.setAttribute(k, v)
  const style = el.style as unknown as Record<string, string>
  for (const k of prev?.style ?? []) if (!(k in next.style)) style[k] = ''
  for (const [k, v] of Object.entries(next.style)) if (style[k] !== v) style[k] = v
  const nextClasses = new Set(next.classes)
  for (const c of prev?.classes ?? []) if (!nextClasses.has(c)) el.classList.remove(c)
  for (const c of nextClasses) el.classList.add(c)
  return { attrs: Object.keys(next.attrs), style: Object.keys(next.style), classes: [...nextClasses] }
}

/** The applied state per element, so a re-render diffs against what THIS adapter put there and nothing else. */
export const appliedByElement: WeakMap<Element, AppliedState> = new WeakMap()

export function applyTo(el: HTMLElement, next: SplitProps): void {
  appliedByElement.set(el, applyElementProps(el, next, appliedByElement.get(el)))
}

export function clearFrom(el: HTMLElement): void {
  const prev = appliedByElement.get(el)
  if (!prev) return
  applyElementProps(el, { attrs: {}, style: {}, classes: [] }, prev)
  appliedByElement.delete(el)
}
