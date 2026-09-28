'use client'

/**
 * GDS — `MetafieldValue`: a stored value drawn by its TYPE inside a grid cell (2026-09-24).
 *
 * One component for every type a connected store can declare, so a store's fields look like what
 * they are with no per-store code: a file as a picture, a colour as a swatch, a yes/no as a mark, a
 * rating as stars, references as their names (with a picture when there is one), lists as chips.
 * The rules live in `metafieldDisplay.ts` (pure, tested); this file only draws them.
 *
 * Like `ShapeValue`, it is a VALUE component for a host cell renderer (the channel sheet's
 * `CascadeCell`), which keeps its own source, save and edit marks around it. Nothing here is
 * absolutely positioned — an absolutely positioned child escapes an AG cell (PES.7 ruling #12).
 */
import { memo } from 'react'
import { Check, FileText, Minus, Star } from 'lucide-react'

import { TokenChip } from '../../primitives'
import { MediaMark } from '../../components/MediaChoice'
import { cdnFit } from '../../lib/cdn-image'
import { EmptyValue } from './cells'
import { ListChipValue } from './shapeCells'
import { metafieldDisplay, type MetafieldDisplayOptions, type MetafieldReference } from './metafieldDisplay'

const SHOWN_PICTURES = 3
const SHOWN_CHIPS = 2
const SHOWN_COLORS = 4
const STARS = 5

export interface MetafieldValueProps extends MetafieldDisplayOptions {
  /** The field's type, e.g. `list.file_reference`. */
  type: string
  /** The stored value: JSON for lists and structured values, plain text otherwise. */
  raw: string | null | undefined
}

function More({ count }: { count: number }) {
  return count > 0 ? <span className="nds-cell-list-more">+{count}</span> : null
}

function Picture({ item }: { item: MetafieldReference }) {
  return item.src
    // eslint-disable-next-line @next/next/no-img-element -- an AG cell is not a Next layout box
    ? <img className="nds-mf-picture" src={cdnFit(item.src, 48)} alt="" loading="lazy" draggable={false} />
    : <span className="nds-mf-picture nds-mf-picture--none" aria-hidden><FileText size={12} /></span>
}

function References({ items, text }: { items: MetafieldReference[]; text: string }) {
  const summary = `${items.length} ${items.length === 1 ? 'reference' : 'references'}: ${text}`
  // Files ARE pictures: a strip of them, then the first name.
  if (items.every(item => item.kind === 'file')) {
    const first = items[0]
    return (
      <span className="nds-mf-refs" aria-label={summary}>
        {items.slice(0, SHOWN_PICTURES).map((item, i) => <Picture key={`${i}:${item.id}`} item={item} />)}
        <span className={`nds-mf-text${first.named ? '' : ' nds-mf-pending'}`}>{first.label}</span>
        <More count={items.length - 1} />
      </span>
    )
  }
  // Everything else as Shopify's cells draw it (measured 2026-09-27): a chip per reference, its picture or swatch in
  // front of its name — a product's photo, an icon entry's icon, a colour entry's swatch — and nothing when it has none.
  return (
    <span className="nds-cell-list" aria-label={summary}>
      {items.slice(0, SHOWN_CHIPS).map((item, i) => (
        <TokenChip key={`${i}:${item.id}`} className={`nds-cell-listchip nds-mf-refchip${item.named ? '' : ' nds-mf-pending'}`}>
          <MediaMark choice={{ image: item.src, swatch: item.swatch, label: item.label }} size="chip" />{item.label}
        </TokenChip>
      ))}
      <More count={items.length - SHOWN_CHIPS} />
    </span>
  )
}

export const MetafieldValue = memo(function MetafieldValue({ type, raw, labels, images, swatches }: MetafieldValueProps) {
  const d = metafieldDisplay(type, raw, { labels, images, swatches })
  switch (d.kind) {
    case 'empty':
      return <EmptyValue />
    case 'number':
      return <span className="nds-mf-text nds-mf-number">{d.text}</span>
    case 'invalid':
      return <span className="nds-mf-text nds-mf-invalid">{d.text}</span>
    case 'boolean':
      return (
        <span className="nds-mf-bool" data-value={d.value ? 'yes' : 'no'}>
          {d.value ? <Check size={13} aria-hidden /> : <Minus size={13} aria-hidden />}
          <span>{d.text}</span>
        </span>
      )
    case 'colors':
      return (
        <span className="nds-mf-colors" aria-label={d.text}>
          {d.colors.slice(0, SHOWN_COLORS).map((color, i) => (
            // The swatch's colour IS the stored value — data, not a design colour.
            <span key={`${i}:${color}`} className="nds-mf-swatch" style={{ backgroundColor: color }} aria-hidden />
          ))}
          <span className="nds-mf-text">{d.colors[0]}</span>
          <More count={d.colors.length - 1} />
        </span>
      )
    case 'rating': {
      // Whole stars, then a half star for a remainder of a half or more: 4.5 of 5 reads as four and a half.
      const stars = Math.max(0, Math.min(STARS, (d.value / d.max) * STARS))
      const whole = Math.floor(stars), half = stars - whole >= 0.5
      return (
        <span className="nds-mf-rating" aria-label={`Rating ${d.text}`}>
          {Array.from({ length: STARS }, (_, i) => <Star key={i} size={12} aria-hidden className={i < whole ? 'on' : i === whole && half ? 'half' : undefined} />)}
          <span className="nds-mf-text">{d.text}</span>
        </span>
      )
    }
    case 'references':
      return <References items={d.items} text={d.text} />
    case 'values':
      return <ListChipValue value={d.items} />
    case 'text':
      return <span className="nds-mf-text">{d.text}</span>
  }
})
