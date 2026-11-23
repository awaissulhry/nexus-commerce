'use client'

import Link from 'next/link'
import { Pill, Tag, type Tone } from '@nexus/ui/primitives'
import '../where-cell.css'

/** One chip in words (the list said them in its own catalogue). */
export interface WhereChipWords {
  readonly words: string
  readonly tone: Tone
  /** pill: the state and who it waits on · tag: the one fact that matters now · dashed: what the customer sees in its portal. */
  readonly look: 'pill' | 'tag' | 'dashed'
  /** The chip opens a record (the quote's order, the quote a request became); null: words only. */
  readonly href?: string | null
  /** The full words on hover (a door says where it goes). */
  readonly title?: string | null
}

/**
 * F-CQ-102 / F-CQ-103 (customer page › Quotes & incoming, 10-design §4.3; settles C4, C6, C32, C33): the ONE chips cell "Where it is"
 * of both lists — at most 3 chips (the state and who it waits on; the one fact; what the customer sees), then the quiet lines (the
 * date folded under 840 px of list room, warning-toned when it ends soon; styles · pieces). The same part on Sales › Quotes, Sales ›
 * Incoming and the customer's tab (one list, two hosts). No amount, no person. It fetches nothing.
 */
export function WhereChips({ chips, fold, foldTone, quiet }: { chips: readonly WhereChipWords[]; fold?: string | null; foldTone?: Tone; quiet?: string | null }) {
  return (
    <span className="fw-where">
      <span className="fw-where-chips">
        {chips.slice(0, 3).map((chip, index) => {
          const body =
            chip.look === 'pill' ? (
              <Pill tone={chip.tone} title={chip.title ?? undefined}>
                {chip.words}
              </Pill>
            ) : (
              <Tag tone={chip.tone} className={chip.look === 'dashed' ? 'fw-where-dashed' : undefined} title={chip.title ?? undefined}>
                {chip.words}
              </Tag>
            )
          return chip.href ? (
            <Link key={`${index}-${chip.words}`} href={chip.href} className="fw-where-door" data-door="" title={chip.title ?? chip.words}>
              {body}
            </Link>
          ) : (
            <span key={`${index}-${chip.words}`}>{body}</span>
          )
        })}
      </span>
      {fold && <span className={foldTone === 'warning' ? 'fw-where-quiet is-warning' : 'fw-where-quiet'}>{fold}</span>}
      {quiet && <span className="fw-where-quiet">{quiet}</span>}
    </span>
  )
}
