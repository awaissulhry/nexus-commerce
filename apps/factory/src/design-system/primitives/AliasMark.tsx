/**
 * AliasMark — tells a product's listings on one account and market apart: ★ the main listing, ①②③… its listing
 * aliases, in their position order. The Information sheet's channel bands and the Media page show the same mark.
 * Show it only when that account and market hold more than one listing of the product: a lone listing needs no mark
 * (Owner, 2026-09-05). Tabular glyphs, so marks line up as the list grows.
 */
const MARKS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'

/** The glyph for a listing position: 0 = the main listing (★), 1… = its aliases (①②③…, then "(21)"). */
export function aliasMarkGlyph(position: number): string {
  if (position === 0) return '★'
  return position >= 1 && position <= MARKS.length ? MARKS[position - 1] : `(${position})`
}

/** What a screen reader says for the mark. */
export function aliasMarkName(position: number): string {
  return position === 0 ? 'Main listing' : `Listing alias ${position}`
}

export interface AliasMarkProps {
  /** 0 = the main listing; 1… = the alias's position. */
  position: number
  className?: string
}

export function AliasMark({ position, className }: AliasMarkProps) {
  return <span className={`nds-alias-mark${className ? ` ${className}` : ''}`} role="img" aria-label={aliasMarkName(position)}>{aliasMarkGlyph(position)}</span>
}
