'use client'

/**
 * MediaMark — the small picture or colour swatch in front of a choice (a chip, a picker row, a card).
 *
 * One mark for every media picker (sheet pop-up rebuild, docs/sheet-popup-editor/PLAN-2026-09-27.md §4.1), so a
 * colour entry looks the same in the cell's chip, in the pick list and in the ordered list:
 *   - a picture when the choice has one — asked from the image CDN at twice the box, so a 28px row does not download
 *     a 2048px master (`cdnSquare`, the same rule `Thumbnail` uses);
 *   - else a swatch when it has a real `#RRGGBB` colour;
 *   - else NOTHING. No grey box, no placeholder icon: rule UI.5 (`docs/2026-09-21-product-sheet-ui-plan.md`) — an
 *     empty picture slot reads as "a picture is missing" when the value never has one.
 * A picture that fails to load falls back to the swatch if there is one, else to a muted "unavailable" mark: here a
 * picture DID exist, and hiding the failure would be the dishonest answer.
 *
 * The swatch colour is DATA (the store's own hex), passed as a custom property, so no hex is written into a style.
 */
import { useState, type CSSProperties } from 'react'
import { ImageOff } from 'lucide-react'

import { cdnSquare } from '../lib/cdn-image'
import { isHexColour, mediaMarkKind, type MediaChoice } from '../lib/media-choice'

export type { MediaChoice } from '../lib/media-choice'

/** Box sizes in px: a chip line, a list row, a card. */
export const MEDIA_MARK_PX = { chip: 18, row: 28, card: 40 } as const

export interface MediaMarkProps {
  choice: Pick<MediaChoice, 'image' | 'swatch' | 'label'>
  size?: keyof typeof MEDIA_MARK_PX
  className?: string
}

export function MediaMark({ choice, size = 'row', className }: MediaMarkProps) {
  const [failed, setFailed] = useState(false)
  const kind = mediaMarkKind(choice)
  const px = MEDIA_MARK_PX[size]
  const cls = ['nds-media-mark', size, className].filter(Boolean).join(' ')
  if (kind === 'none') return null
  if (kind === 'image' && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img className={cls} src={cdnSquare(choice.image as string, px * 2)} alt="" width={px} height={px} loading="lazy" decoding="async"
        onError={() => setFailed(true)} />
    )
  }
  if (isHexColour(choice.swatch)) {
    return <span className={`${cls} swatch`} aria-hidden style={{ '--nds-media-swatch': choice.swatch } as CSSProperties} />
  }
  return (
    <span className={`${cls} unavailable`} role="img" aria-label={`Picture of ${choice.label} is unavailable`}>
      <ImageOff size={Math.round(px * 0.55)} aria-hidden />
    </span>
  )
}
