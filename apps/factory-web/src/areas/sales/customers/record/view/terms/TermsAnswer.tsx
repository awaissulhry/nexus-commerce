'use client'

import type { ReactElement } from 'react'
import { Ban, CircleAlert, Clock, Hourglass, Info } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { FilterChip, Skeleton } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../../lib/i18n/provider'
import type { TermsAnswer as Answer, TermsChipId } from '../../terms/answer'
import { said, sentenceOf, TERMS_ANSWER_ID } from '../../terms/model'
import { useTermsSay } from './say'

/**
 * F-CT-302 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §4; 18-lead-settles Z27, Z28) — the tab's answer line: ONE
 * sentence for the company the reader works in (a DS Banner: danger when a danger chip shows, warning when a warning one does) and the
 * chips of what waits on us (DS FilterChips, People's pattern; pressed = its rows are marked). A chip opens its section and marks
 * EXACTLY its rows; a door chip leaves for Quotes › Order waits. No tab count. Draws its model; reads nothing.
 */

const ICON: Readonly<Record<TermsChipId, ReactElement>> = {
  hold: <Ban size={13} aria-hidden />,
  waitHold: <Clock size={13} aria-hidden />,
  waitPo: <Clock size={13} aria-hidden />,
  waitOrder: <Clock size={13} aria-hidden />,
  noIdentity: <CircleAlert size={13} aria-hidden />,
  noSdi: <CircleAlert size={13} aria-hidden />,
  viesEnds: <Hourglass size={13} aria-hidden />,
  viesInvalid: <CircleAlert size={13} aria-hidden />,
  viesUnchecked: <CircleAlert size={13} aria-hidden />,
}

export function TermsAnswer({ answer, chip, reading, onChip }: { answer: Answer | null; chip: TermsChipId | null; reading?: boolean; onChip?: (chip: TermsChipId | null) => void }) {
  const say = useTermsSay()
  const locale = useLocale()
  if (reading || !answer)
    return (
      <div id={TERMS_ANSWER_ID} className="fw-ctr-ans">
        <Banner tone="info" title={<Skeleton height={16} width="60%" />} />
      </div>
    )
  const icon = answer.tone === 'danger' ? <Ban size={18} aria-hidden /> : answer.tone === 'warning' ? <Clock size={18} aria-hidden /> : <Info size={18} aria-hidden />
  const words = sentenceOf(answer.words.map(say), locale)
  return (
    <div id={TERMS_ANSWER_ID} className="fw-ctr-ans">
      <Banner
        tone={answer.tone}
        icon={icon}
        title={
          <span className="fw-ctr-ans-t">
            <span>{answer.lead ? `${say(answer.lead)} ${words}` : words}</span>
            {answer.fallback ? <span className="fw-ctr-sub">{say(answer.fallback)}</span> : null}
          </span>
        }
      >
        {answer.chips.length > 0 ? (
          <div className="fw-ctr-chips" role="group" aria-label={say(said('ct.answer.chipsLabel'))}>
            {answer.chips.map((item) => (
              <FilterChip key={item.id} className={`is-${item.tone}`} pressed={item.door ? undefined : chip === item.id} onClick={() => onChip?.(chip === item.id ? null : item.id)}>
                {ICON[item.id]}
                {say(item.label)}
              </FilterChip>
            ))}
          </div>
        ) : null}
      </Banner>
    </div>
  )
}
