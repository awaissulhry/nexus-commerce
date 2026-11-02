'use client'

import { UserPlus } from 'lucide-react'
import { FloorButton, OperatorChip } from '@nexus/ui/floor'
import { useT } from '../../../lib/i18n/provider'
import type { CrewView } from '../../api'

/**
 * The crew on a station tablet (design floor.signin "Crew on this station"; PLT-059): a strip of up to four chips, the
 * active one marked with a bar and the word "Now"; every action books to it. A tap on another chip asks that person's
 * badge or PIN. Add a person = their badge. The DS has no strip of chips: composed from OperatorChip (named in the step's
 * notes). A crew's names show on its own tablet, as the sign-in roster does; never a figure beside them.
 */
export function CrewStrip({ crew, signedIn, onAdd, onChip }: { crew: CrewView; signedIn: boolean; onAdd?: () => void; onChip?: (workerId: string, name: string) => void }) {
  const t = useT('floor')
  const full = crew.members.length >= crew.max
  return (
    <div role="group" aria-label={t('crew.title')} className="fw-floor-crew">
      {crew.members.map((member) =>
        member.active ? (
          <span key={member.workerId} className="fw-floor-crew-chip" data-active="true">
            <OperatorChip name={member.displayName} detail={t('crew.now')} />
          </span>
        ) : (
          <span key={member.workerId} className="fw-floor-crew-chip">
            <OperatorChip name={member.displayName} detail={t('crew.tap')} label={t('crew.switchTo', { name: member.displayName })} onPress={() => onChip?.(member.workerId, member.displayName)} />
          </span>
        ),
      )}
      {signedIn ? (
        <FloorButton size="sm" variant="secondary" icon={<UserPlus />} heldReason={full ? t('crew.full', { max: crew.max }) : undefined} onClick={onAdd}>
          {t('crew.add')}
        </FloorButton>
      ) : null}
      {signedIn && full ? <span className="fw-floor-muted">{t('crew.full', { max: crew.max })}</span> : null}
    </div>
  )
}
