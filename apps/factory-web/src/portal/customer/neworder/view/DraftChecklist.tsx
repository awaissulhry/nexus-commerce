'use client'

import type { ReactNode } from 'react'
import { AlertCircle, Check, Circle, Clock } from 'lucide-react'
import { Tag } from '@nexus/ui/primitives'
import { partTone, type DraftChip, type DraftPartState } from '../model'
import { useOrderingWords } from '../words'

/**
 * F-CP-150 (customer page plan C5; 12 §2 "The checklist"; picture 22): the draft's seven parts as a strip of chips at the top of
 * the page — What you need · Logos · References · People and sizes · Date and delivery · Your price · Notes —, each with its
 * state (Ready ✓ · Sending later · Missing · Optional) from the domain's own checklist (the office's Drafts view reads the same).
 * A click (or Enter) scrolls to the part's card and focuses it. On a phone the strip scrolls sideways, never the page. A part's
 * state is said in words beside its icon (never by colour alone). Also the part's own heading tag on each card.
 */

const STATE_ICON: Readonly<Record<DraftPartState, ReactNode>> = {
  READY: <Check size={12} aria-hidden />,
  LATER: <Clock size={12} aria-hidden />,
  MISSING: <AlertCircle size={12} aria-hidden />,
  OPTIONAL: <Circle size={12} aria-hidden />,
}

/** A part's state as a DS Tag with its icon (the chips and each card's heading). */
export function PartState({ state }: { state: DraftPartState }) {
  const { t } = useOrderingWords()
  return (
    <Tag tone={partTone(state)} className="fw-pno-partstate">
      {STATE_ICON[state]} {t(`draftPage.state.${state}`)}
    </Tag>
  )
}

/** A part card's heading: its number, its name, its state (the chip's twin), and the card's own action on the right. */
export function PartHeading({ chip, id, action }: { chip: DraftChip; id: string; action?: ReactNode }) {
  const { t } = useOrderingWords()
  return (
    <div className="fw-pno-parthead">
      <h2 id={id} className="fw-pno-h2">
        <span className="fw-pno-partnum" aria-hidden>
          {chip.n}
        </span>
        {t(`draftPage.part.${chip.part}`)}
      </h2>
      <PartState state={chip.state} />
      {action ? <span className="fw-pno-partaction">{action}</span> : null}
    </div>
  )
}

export function DraftChecklist({ chips, onChip }: { chips: readonly DraftChip[]; onChip?: (target: string) => void }) {
  const { t } = useOrderingWords()
  return (
    <nav className="fw-pno-chips" aria-label={t('draftPage.checklist')}>
      <ol>
        {chips.map((chip) => (
          <li key={chip.part}>
            <button
              type="button"
              className={`fw-pno-chip is-${chip.state.toLowerCase()}`}
              aria-label={t('draftPage.chip', { n: chip.n, part: t(`draftPage.part.${chip.part}`), state: t(`draftPage.state.${chip.state}`) })}
              onClick={() => onChip?.(chip.target)}
            >
              <span className="fw-pno-chiptop">
                <span className="fw-pno-chipname">{t(`draftPage.part.${chip.part}`)}</span>
                <span className="fw-pno-partnum" aria-hidden>
                  {chip.n}
                </span>
              </span>
              <span className={`fw-pno-chipstate is-${chip.state.toLowerCase()}`} aria-hidden>
                {STATE_ICON[chip.state]} {t(`draftPage.state.${chip.state}`)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
