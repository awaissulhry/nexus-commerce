'use client'

import type { ReactNode } from 'react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Section } from '../../../../quality/_shared/parts'
import { Timeline } from '../../../../../lib/i18n/ds-parts'
import type { ProfileRecord } from '../../api'
import { activityOf } from '../../model'
import { useWords } from '../../parts'

/**
 * The rider profile's Activity tab (design rider.activity): everything that happened to the rider's garment type, newest first —
 * each revision recorded in the office or sent by the link (who, where), each factory review (confirmed, more asked, by whom),
 * each worksheet kept, each quote or order line made to it. B-W2b-371 (XF2:02): then the rider's thread (internal notes, messages to
 * the customer, files), one per rider and garment type, read and written only by readers of measurements (the platform's thread
 * gate); a person who reads no threads is told so.
 */
export function ActivityTab({ record, thread }: { record: ProfileRecord; thread?: ReactNode }) {
  const { t, say } = useWords()
  const steps = activityOf(record)
  return (
    <div className="fw-mtm-stack">
      <Section id="mtm-activity" title={t('activity.title')} sub={t('activity.sub')}>
        {steps.length === 0 ? (
          <EmptyState title={t('activity.none')} />
        ) : (
          <Timeline label={t('activity.title')} steps={steps.map((step) => ({ key: step.key, label: say(step.label) ?? '', tone: step.tone === 'neutral' ? 'neutral' : step.tone, at: step.at, detail: step.detail ? (say(step.detail) ?? undefined) : undefined }))} />
        )}
      </Section>
      {thread ?? (
        <Card padded>
          <p className="fw-mtm-hint">{t('activity.noThread')}</p>
        </Card>
      )}
    </div>
  )
}
