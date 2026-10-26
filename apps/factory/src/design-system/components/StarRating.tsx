'use client'

import { useRef, type KeyboardEvent } from 'react'
import { Star } from 'lucide-react'
import {
  ratingCountWords, starChoiceWords, starFills, starInputValue, starKeyTarget, starTabStop, starWords, type StarFill,
} from './starRatingModel'

export interface StarRatingProps {
  /** The rating. `null` = no rating yet ("No rating"), never drawn as a zero. */
  value: number | null
  /** How many stars. Default 5. */
  max?: number
  /** sm 12 px (grids, cards) · md 16 px · lg 20 px. */
  size?: 'sm' | 'md' | 'lg'
  /** How many ratings the value comes from: "(128)" after the stars, "128 ratings" to a screen reader. */
  count?: number
  /** The accessible name. Read: default "4.5 out of 5 stars". Input: the group's name, default "Rating". */
  label?: string
  /** `read` (default) draws the value; `input` lets a person pick a whole star. */
  mode?: 'read' | 'input'
  /** Input: the star picked (1…max). */
  onChange?: (n: number) => void
  /** Input: a form field of this name carries the picked star. */
  name?: string
  className?: string
}

function StarIcon({ fill }: { fill: StarFill }) {
  return (
    <span className={`nds-star${fill === 'full' ? '' : ` ${fill}`}`} aria-hidden>
      <Star className="off" aria-hidden focusable={false} />
      <Star className="on" aria-hidden focusable={false} />
    </span>
  )
}

/**
 * Stars for a rating (Reviews parts, 2026-10-26; the stars `MetafieldValue` drew, made one part).
 *
 * Read: one `role="img"` named in words ("4.5 out of 5 stars"); the stars round DOWN to the nearest half, the name keeps
 * the number. An empty star's outline is `--nds-border-strong` (1.7:1), so it never carries the value alone.
 * Input: a `radiogroup` of one button per star, one Tab stop (roving tabindex), ←/→ ↑/↓ Home/End pick as they move; the
 * empty outline is the icon tier (`--nds-text-3`, 3:1 as a control's edge must be).
 */
export function StarRating({ value, max, size = 'md', count, label, mode = 'read', onChange, name, className }: StarRatingProps) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const sizeClass = size === 'md' ? '' : ` ${size}`

  if (mode === 'input') {
    const fills = starFills(value, max)
    const picked = starInputValue(value, max)
    const tabStop = starTabStop(value, max)
    const pick = (n: number) => {
      onChange?.(n)
      buttons.current[n - 1]?.focus()
    }
    const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
      const next = starKeyTarget(event.key, picked, fills.length)
      if (next == null) return
      event.preventDefault()
      pick(next)
    }
    return (
      <span className={`nds-stars nds-stars-input${sizeClass}${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={label ?? 'Rating'}>
        {fills.map((_, i) => {
          const n = i + 1
          return (
            <button
              key={n}
              ref={el => { buttons.current[i] = el }}
              type="button"
              role="radio"
              aria-checked={picked === n}
              aria-label={starChoiceWords(n)}
              tabIndex={n === tabStop ? 0 : -1}
              onClick={() => pick(n)}
              onKeyDown={onKey}
            >
              <StarIcon fill={n <= picked ? 'full' : 'empty'} />
            </button>
          )
        })}
        {name != null && <input type="hidden" name={name} value={picked || ''} />}
      </span>
    )
  }

  return (
    <span className={`nds-stars${sizeClass}${className ? ` ${className}` : ''}`}>
      <span className="nds-stars-row" role="img" aria-label={label ?? starWords(value, max)}>
        {starFills(value, max).map((fill, i) => <StarIcon key={i} fill={fill} />)}
      </span>
      {count != null && Number.isFinite(count) && (
        <span className="nds-stars-count">
          <span aria-hidden>({Math.max(0, Math.round(count)).toLocaleString('en-US')})</span>
          <span className="nds-vh">{ratingCountWords(count)}</span>
        </span>
      )}
    </span>
  )
}
