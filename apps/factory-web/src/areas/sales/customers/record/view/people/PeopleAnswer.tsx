'use client'

import type { ReactElement } from 'react'
import { CalendarClock, CircleAlert, Clock, FileText, Hourglass, ShieldAlert, Users } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { FilterChip, Skeleton } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../../lib/i18n/provider'
import type { PeopleAnswer as Answer, PeopleChip } from '../../people/answer'
import { PEOPLE_ANSWER_ID, said } from '../../people/model'
import { sentenceOf, usePeopleSay } from './say'

/**
 * F-CA-109 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 10-design §4; 18-lead-settles Z5) — the tab's answer line: ONE sentence (a
 * DS Banner, a warning when something waits on us) and the chips of what waits on us (DS FilterChips; pressed = its filter is on). A chip
 * is a door to EXACTLY its rows: its section shows only those, with "Show all" to leave. Draws its model; reads nothing.
 */

const ICON: Readonly<Record<PeopleChip, ReactElement>> = {
  check: <Clock size={13} aria-hidden />,
  basis: <ShieldAlert size={13} aria-hidden />,
  expired: <Hourglass size={13} aria-hidden />,
  ends: <CalendarClock size={13} aria-hidden />,
  seats: <Users size={13} aria-hidden />,
  noQuotes: <CircleAlert size={13} aria-hidden />,
  noInvoices: <CircleAlert size={13} aria-hidden />,
  registered: <FileText size={13} aria-hidden />,
  noRegistered: <CircleAlert size={13} aria-hidden />,
}

export function PeopleAnswer({ answer, filter, reading, onChip }: { answer: Answer | null; filter: PeopleChip | null; reading?: boolean; onChip?: (chip: PeopleChip | null) => void }) {
  const say = usePeopleSay()
  const locale = useLocale()
  if (reading || !answer)
    return (
      <div id={PEOPLE_ANSWER_ID} className="fw-ca-ans">
        <Banner tone="info" title={<Skeleton height={16} width="60%" />} />
      </div>
    )
  return (
    <div id={PEOPLE_ANSWER_ID} className="fw-ca-ans">
      <Banner tone={answer.tone} icon={answer.tone === 'warning' ? <Clock size={18} aria-hidden /> : undefined} title={sentenceOf(answer.words.map(say), locale)}>
        {answer.chips.length > 0 ? (
          <div className="fw-ca-chips" role="group" aria-label={say(said('answer.chipsLabel'))}>
            {answer.chips.map((chip) => (
              <FilterChip key={chip.id} className={`is-${chip.tone}`} pressed={filter === chip.id} onClick={() => onChip?.(filter === chip.id ? null : chip.id)}>
                {ICON[chip.id]}
                {say(chip.label)}
              </FilterChip>
            ))}
          </div>
        ) : null}
      </Banner>
    </div>
  )
}
