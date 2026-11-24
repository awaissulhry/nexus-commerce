'use client'

import Link from 'next/link'
import { SummaryTable } from '@nexus/ui/components'
import type { Glance } from '../api'
import { valueOf, type Read } from '../model'
import { DepthCard, ReadOr, useSay } from './parts'

/**
 * Customer 360 (B-W2b-324; SAL-019), the parts of the one read that People & addresses draws: the measurement profiles kept for
 * the customer and a team's riders. A part the reader may not read says what it needs. Fetches nothing.
 * F-CO-203 (customer Overview co-w2 W2.3): the Overview's old parts went — the key-number tiles (free credit, promises), the samples
 * and repairs groups, the status card's hold and the side panel's cards: the Overview's strips, Next dates, Linked records, People
 * and Customer facts say them now (areas/sales/customers/record/overview).
 */

export interface GlanceModel {
  readonly read: Read<Glance>
  /** `/w/<company>` of the office addresses. */
  readonly prefix: string
  /** The record's own address (its tabs). */
  readonly recordHref: string
}

function Withheld({ part }: { part: 'profiles' }) {
  const { t } = useSay()
  return <p className="fw-cdp-hint">{t(`withheld.${part}`)}</p>
}

/** F-SA-274: the glance's parts People & addresses draws — the measurement profiles and a team's riders; default both. */
export const GLANCE_NOW_PARTS = ['profiles', 'riders'] as const
export type GlanceNowPart = (typeof GLANCE_NOW_PARTS)[number]

export function GlanceNow({ model, parts = GLANCE_NOW_PARTS }: { model: GlanceModel; /* F-SA-274 */ parts?: readonly GlanceNowPart[] }) {
  const show = (part: GlanceNowPart) => parts.includes(part) // F-SA-274
  const { t, day } = useSay()
  const glance = valueOf(model.read)
  if (!glance) {
    return (
      <DepthCard title={t('now.title')}>
        <ReadOr status={model.read.status} problem={model.read.status === 'error' ? model.read.problem : undefined} title={t('now.title')} rows={3} />
      </DepthCard>
    )
  }
  const party = glance.party
  return (
    <div className="fw-cdp-now">
      {show('profiles') && (
      <DepthCard title={t('profiles.title')} hint={t('profiles.hint')}>
        {glance.profiles === null ? (
          <Withheld part="profiles" />
        ) : glance.profiles.count === 0 ? (
          <p className="fw-cdp-hint">{t(party.kind === 'PERSON' ? 'profiles.noneRider' : 'profiles.none')}</p>
        ) : (
          <>
            <SummaryTable
              label={t('profiles.title')}
              stackOnPhone
              columns={[t('profiles.col.rider'), t('profiles.col.garment'), t('profiles.col.revision'), t('profiles.col.base'), t('profiles.col.taken')]}
              widths={['28%', '20%', '14%', '14%', '24%']}
              rows={glance.profiles.rows.map((row) => ({
                id: row.id,
                cells: [row.riderName, row.garmentType, t('profiles.rev', { revision: row.revision }), row.baseSize ?? '—', day(row.takenAt)],
              }))}
            />
            {glance.profiles.count > glance.profiles.rows.length && <p className="fw-cdp-hint">{t('glance.more', { count: glance.profiles.count - glance.profiles.rows.length })}</p>}
          </>
        )}
      </DepthCard>
      )}

      {show('riders') && glance.riders !== null && (
        <DepthCard title={t('riders.title')} hint={t('riders.hint')}>
          {glance.riders.count === 0 ? (
            <p className="fw-cdp-hint">{t('riders.none')}</p>
          ) : (
            <>
              <SummaryTable
                label={t('riders.title')}
                stackOnPhone
                columns={[t('riders.col.rider'), t('riders.col.status'), t('riders.col.profiles')]}
                widths={['56%', '22%', '22%']}
                rows={glance.riders.rows.map((row) => ({
                  id: row.id,
                  cells: [
                    <Link key="r" className="fw-cdp-cell" href={`${model.prefix}/sales/customers/${encodeURIComponent(row.id)}`}>
                      <span className="fw-cdp-name">{row.name}</span>
                      <span className="fw-cdp-code">{row.code}</span>
                    </Link>,
                    t(`partyStatus.${row.status}`),
                    glance.profiles === null ? '—' : String(row.profiles),
                  ],
                }))}
              />
              {glance.riders.count > glance.riders.rows.length && <p className="fw-cdp-hint">{t('glance.more', { count: glance.riders.count - glance.riders.rows.length })}</p>}
            </>
          )}
        </DepthCard>
      )}

    </div>
  )
}
