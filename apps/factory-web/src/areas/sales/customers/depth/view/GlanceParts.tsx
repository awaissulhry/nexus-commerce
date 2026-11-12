'use client'

import Link from 'next/link'
import { SummaryTable } from '@nexus/ui/components'
import { Tag } from '@nexus/ui/primitives'
import type { Glance } from '../api'
import { creditTile, dueWords, promisesTile, valueOf, type Read } from '../model'
import { DepthCard, ReadOr, useSay } from './parts'

/**
 * Customer 360 (B-W2b-324; SAL-019; design sales.customers record › Overview), the parts of the one read: the key
 * numbers it adds (free credit, the promises), the groups under Now (samples in progress, measurement profiles, a team's
 * riders, repairs in progress), the hold and its reason on the side panel's status card, and the side panel's own cards
 * (a rider's team, the requirements in force). Each row is a link where the record has a page; "See all N" under a
 * group that has more. A part the reader may not read says what it needs. Fetches nothing.
 */

export interface GlanceModel {
  readonly read: Read<Glance>
  /** `/w/<company>` of the office addresses. */
  readonly prefix: string
  /** The record's own address (its tabs). */
  readonly recordHref: string
}

/** One word of a key-number tile the glance adds (Free credit, Promises): its label, value or hint; "—" while reading. */
export function GlanceTileText({ read, part, field }: { read: Read<Glance>; part: 'credit' | 'promises'; field: 'label' | 'value' | 'hint' }) {
  const { t, say, day, amount } = useSay()
  if (field === 'label') return <>{t(part === 'credit' ? 'numbers.freeCredit' : 'numbers.promises')}</>
  const glance = valueOf(read)
  if (!glance) return <>{field === 'value' ? '—' : t(read.status === 'error' ? 'numbers.failed' : 'numbers.reading')}</>
  const tile = part === 'credit' ? creditTile(glance.credit, amount) : promisesTile(glance.promises, day)
  const words = say(field === 'value' ? tile.value : tile.hint)
  const warn = field === 'value' && (part === 'credit' ? glance.credit?.state === 'OVER' : (glance.promises?.late ?? 0) > 0)
  return warn ? <span className={part === 'credit' ? 'fw-cdp-danger' : 'fw-cdp-warn'}>{words}</span> : <>{words}</>
}

function Withheld({ part }: { part: 'samples' | 'profiles' | 'repairs' }) {
  const { t } = useSay()
  return <p className="fw-cdp-hint">{t(`withheld.${part}`)}</p>
}

/** The groups under Now: samples in progress, measurement profiles, a team's riders, repairs in progress. */
export function GlanceNow({ model }: { model: GlanceModel }) {
  const { t, say, day } = useSay()
  const glance = valueOf(model.read)
  if (!glance) {
    return (
      <DepthCard title={t('now.title')}>
        <ReadOr status={model.read.status} problem={model.read.status === 'error' ? model.read.problem : undefined} title={t('now.title')} rows={3} />
      </DepthCard>
    )
  }
  const party = glance.party
  const samplesHref = `${model.prefix}/products/samples?party=${encodeURIComponent(party.id)}`
  return (
    <div className="fw-cdp-now">
      <DepthCard title={t('samples.title')} hint={t('samples.hint')}>
        {glance.samples === null ? (
          <Withheld part="samples" />
        ) : glance.samples.count === 0 ? (
          <p className="fw-cdp-hint">{t('samples.none')}</p>
        ) : (
          <>
            <SummaryTable
              label={t('samples.title')}
              stackOnPhone
              columns={[t('samples.col.number'), t('samples.col.style'), t('samples.col.kind'), t('samples.col.stage'), t('samples.col.due')]}
              widths={['18%', '30%', '18%', '16%', '18%']}
              rows={glance.samples.rows.map((row) => ({
                id: row.id,
                cells: [
                  <Link key="n" className="fw-cdp-code" href={`${model.prefix}/products/samples/${encodeURIComponent(row.id)}`}>
                    {row.number}
                  </Link>,
                  <span key="s" className="fw-cdp-cell">
                    <span className="fw-cdp-code">{row.style.code}</span>
                    <span className="fw-cdp-hint">{row.style.name}</span>
                  </span>,
                  t('samples.kindRound', { kind: t(`sampleKind.${row.kind}`), round: row.roundNo }),
                  t(`sampleStage.${row.stage}`),
                  <span key="d" className={row.daysLate !== null && row.daysLate > 0 ? 'fw-cdp-warn' : undefined}>
                    {say(dueWords(row, day))}
                  </span>,
                ],
              }))}
            />
            {glance.samples.count > glance.samples.rows.length && (
              <Link className="fw-cdp-link" href={samplesHref}>
                {t('glance.seeAll', { count: glance.samples.count })}
              </Link>
            )}
          </>
        )}
      </DepthCard>

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

      {glance.riders !== null && (
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

      <DepthCard title={t('repairs.title')} hint={t('repairs.hint')}>
        {glance.repairs === null ? (
          <Withheld part="repairs" />
        ) : glance.repairs.count === 0 ? (
          <p className="fw-cdp-hint">{t('repairs.none')}</p>
        ) : (
          <>
            <SummaryTable
              label={t('repairs.title')}
              stackOnPhone
              columns={[t('repairs.col.number'), t('repairs.col.kind'), t('repairs.col.stage'), t('repairs.col.opened')]}
              widths={['24%', '22%', '28%', '26%']}
              rows={glance.repairs.rows.map((row) => ({
                id: row.id,
                cells: [
                  <Link key="n" className="fw-cdp-code" href={`${model.prefix}/sales/returns/repairs/${encodeURIComponent(row.id)}`}>
                    {row.number}
                  </Link>,
                  t(`repairKind.${row.kind}`),
                  t(`repairStage.${row.stage}`),
                  day(row.createdAt),
                ],
              }))}
            />
            {glance.repairs.count > glance.repairs.rows.length && (
              <Link className="fw-cdp-link" href={`${model.prefix}/sales/returns?view=openRepairs&q=${encodeURIComponent(party.code)}`}>
                {t('glance.seeAll', { count: glance.repairs.count })}
              </Link>
            )}
          </>
        )}
      </DepthCard>
    </div>
  )
}

/** Under the status pill: "On hold" with each hold's reason, since when and by whom (the system for a credit check). */
export function GlanceStatus({ model }: { model: GlanceModel }) {
  const { t, day } = useSay()
  const glance = valueOf(model.read)
  if (!glance) return null
  if (!glance.hold.onHold) return <p className="fw-cdp-hint">{t('status.notOnHold')}</p>
  return (
    <div className="fw-cdp-hold" role="status">
      <span className="fw-cdp-tags">
        <Tag tone="danger">{t('status.onHold')}</Tag>
        {glance.credit?.state === 'OVER' && <Tag tone="danger">{t('credit.over')}</Tag>}
      </span>
      <ul className="fw-cdp-list">
        {glance.hold.holds.map((hold) => (
          <li key={hold.id} className="fw-cdp-cell">
            <span className="fw-cdp-name">
              {t(`reason.${hold.reason}`)}
              {hold.everyCompany ? ` · ${t('hold.everyCompany')}` : ''}
            </span>
            <span className="fw-cdp-hint">{hold.words}</span>
            <span className="fw-cdp-hint">{hold.placedBy ? t('status.since', { date: day(hold.placedAt), by: hold.placedBy }) : t('status.sinceSystem', { date: day(hold.placedAt) })}</span>
          </li>
        ))}
      </ul>
      <p className="fw-cdp-hint">{t('status.holdStops')}</p>
      <Link className="fw-cdp-link" href={`${model.recordHref}?tab=tax`}>
        {t('status.openHold')}
      </Link>
    </div>
  )
}

/** The side panel's own cards: a rider's team, the requirements in force with the company. */
export function GlanceAside({ model }: { model: GlanceModel }) {
  const { t } = useSay()
  const glance = valueOf(model.read)
  if (!glance) return null
  return (
    <>
      {glance.team && (
        <DepthCard title={t('team.title')}>
          <Link className="fw-cdp-cell" href={`${model.prefix}/sales/customers/${encodeURIComponent(glance.team.id)}`}>
            <span className="fw-cdp-name">{glance.team.name}</span>
            <span className="fw-cdp-code">{glance.team.code}</span>
          </Link>
          <p className="fw-cdp-hint">{t('team.hint')}</p>
        </DepthCard>
      )}
      <DepthCard title={t('reqSide.title')}>
        {glance.requirements.count === 0 ? (
          <p className="fw-cdp-hint">{t('reqSide.none')}</p>
        ) : (
          <ul className="fw-cdp-list">
            {glance.requirements.rows.map((row) => (
              <li key={row.id} className="fw-cdp-cell">
                <span className="fw-cdp-name">{t(`kind.${row.kind}`)}</span>
                <span className="fw-cdp-clip">{row.words}</span>
                <span className="fw-cdp-hint">{row.appliesAt.map((stage) => t(`stage.${stage}`)).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
        <Link className="fw-cdp-link" href={`${model.recordHref}?tab=requirements`}>
          {glance.requirements.count > 0 ? t('reqSide.all', { count: glance.requirements.count }) : t('reqSide.open')}
        </Link>
      </DepthCard>
    </>
  )
}
