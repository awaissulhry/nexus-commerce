/**
 * Bid page — is a name cut short (an ellipsis)? (2026-10-11, lane FINAL; `FullName.tsx`.) Pure over the two widths the
 * browser gives, so it is tested in Node: the element itself, or any element inside it (a DS link that ellipsizes), is
 * wider inside than shown — or the element itself is taller inside than shown (a line clamp). A hidden element (no
 * width) never counts.
 */
export interface Measurable {
  scrollWidth: number
  clientWidth: number
  scrollHeight?: number
  clientHeight?: number
  querySelectorAll?(selector: string): ArrayLike<Measurable>
}

const cut = (e: Measurable): boolean => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1
const clamped = (e: Measurable): boolean =>
  e.clientWidth > 0 && typeof e.scrollHeight === 'number' && typeof e.clientHeight === 'number' && e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 1

export function isCut(el: Measurable): boolean {
  if (cut(el) || clamped(el)) return true
  const inner = el.querySelectorAll?.('*') ?? []
  for (let i = 0; i < inner.length; i++) if (cut(inner[i])) return true
  return false
}
