'use client'

import { BellRing, PenLine } from 'lucide-react'
import { Banner, Card, EmptyState, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { InstructionRecord } from '../../api'
import { languageName, NS, paperHeld, peopleRows, siteShare, valueOf } from '../../model'
import { useSay, VersionPill } from '../../view/parts'
import type { RecordModel } from './InstructionRecordView'

export interface AcksActions {
  onRetryAcks?: () => void
  onPaperOpen?: () => void
}

/**
 * Work instruction › Acknowledgements (design rec tab `acks`, sec wi-acks: who has read the current version — a training
 * record, not a performance record; counts per line, names per operator assigned to the operation; Remind). What it shows is
 * said first (PrivacyNote): for everyone with view, how many saw the version in force per site, of how many hold the
 * operation's skill there, and how many saw each version (counts, never names, never a ranking: Owner answers W1, F2, H3);
 * for HR (production.instructions.people) the training record by name, where the site's legal gate lets the office name a
 * worker, and Record a paper acknowledgement. Remind is held: the floor has no message for it yet. Fetches nothing.
 */
export function AcksTab({ model, record, actions }: { model: RecordModel; record: InstructionRecord; actions?: AcksActions }) {
  const t = useT(NS)
  const say = useSay()
  const ds = useDsWords()
  const locale = useLocale()
  const acks = valueOf(model.acks)
  const people = model.can.people
  const note = (
    <PrivacyNote
      level={people ? 'individual' : 'line'}
      variant="panel"
      text={people ? t('acks.privacy.people') : t('acks.privacy.counts')}
      whoMore={people ? t('acks.privacy.gate') : t('acks.privacy.whoMore')}
      labels={ds.privacyNote}
    />
  )
  if (!model.acks || model.acks.status === 'loading')
    return (
      <div className="fw-wi-stack">
        {note}
        <Card padded aria-busy="true">
          <p className="fw-wi-hint fw-wi-inline" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        </Card>
      </div>
    )
  if (model.acks.status === 'error')
    return (
      <div className="fw-wi-stack">
        {note}
        <Banner
          tone="danger"
          title={t('acks.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetryAcks?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.acks.problem)}
        </Banner>
      </div>
    )
  const value = acks!
  const current = value.current
  const paperWhy = paperHeld(value, { can: model.can, me: model.me, offline: model.offline })
  const rows = peopleRows(value)
  return (
    <div className="fw-wi-stack">
      {note}
      <div className="fw-wi-actions">
        <Button size="sm" heldReason={t('acks.remindHeld')}>
          <BellRing size={13} aria-hidden /> {t('acks.remind')}
        </Button>
        {people && (
          <Button size="sm" heldReason={paperWhy ? say(paperWhy) : null} onClick={() => actions?.onPaperOpen?.()}>
            <PenLine size={13} aria-hidden /> {t('acks.paper')}
          </Button>
        )}
      </div>
      <Card padded>
        <section className="fw-wi-stack" aria-labelledby="fw-wi-acks-current">
          <h3 id="fw-wi-acks-current" className="fw-wi-h3">
            {current ? t('acks.current', { number: current.number }) : t('acks.noCurrent')}
          </h3>
          {!current ? (
            <p className="fw-wi-hint">{t('acks.noCurrentBody')}</p>
          ) : (
            <>
              <p className="fw-wi-hint">{current.acknowledgementRequired ? t('acks.asked') : t('acks.notAsked')}</p>
              {current.perSite.length === 0 ? (
                <p className="fw-wi-hint">{t('acks.noSites')}</p>
              ) : (
                <ul className="fw-wi-plain fw-wi-sites">
                  {current.perSite.map((site) => {
                    const share = siteShare(site)
                    return (
                      <li key={site.siteId} className="fw-wi-site">
                        <span className="fw-wi-row-between">
                          <span>
                            <b>{site.code}</b> · {site.name}
                          </span>
                          <span>{site.of > 0 ? t('acks.seenOf', { seen: site.seen, of: site.of }) : t('acks.seenNoSkill', { seen: site.seen })}</span>
                        </span>
                        <ProgressBar value={share} ariaLabel={t('acks.siteBar', { site: site.code, seen: site.seen, of: site.of })} />
                      </li>
                    )
                  })}
                </ul>
              )}
              <p className="fw-wi-hint">{t('acks.ofMeans')}</p>
            </>
          )}
        </section>
      </Card>
      <SummaryTable
        label={t('acks.versionsLabel')}
        columns={[t('versions.col.version'), t('acks.col.seen')]}
        rows={[...value.versions]
          .sort((a, b) => b.number - a.number)
          .filter((version) => version.status === 'PUBLISHED' || version.status === 'SUPERSEDED')
          .map((version) => ({ id: version.versionId, cells: [<VersionPill key="pill" status={version.status} number={version.number} />, t('version.seenCount', { count: version.seen })] }))}
      />
      {people ? (
        <Card padded>
          <section className="fw-wi-stack" aria-labelledby="fw-wi-acks-people">
            <h3 id="fw-wi-acks-people" className="fw-wi-h3">
              {t('acks.people')}
            </h3>
            {value.people === null ? (
              <p className="fw-wi-hint">{t('acks.peopleNone')}</p>
            ) : rows.length === 0 ? (
              <EmptyState title={t('acks.peopleEmpty.title')} description={t('acks.peopleEmpty.body')} />
            ) : (
              <SummaryTable
                label={t('acks.peopleLabel')}
                columns={[t('acks.col.person'), t('acks.col.site'), t('acks.col.skill'), t('acks.col.last'), t('acks.col.current')]}
                rows={rows.map((row, index) => ({
                  id: row.worker?.id ?? `hidden-${row.site.id}-${index}`,
                  cells: [
                    row.worker ? row.worker.name : <span className="fw-wi-sub">{t('acks.hidden')}</span>,
                    row.site.code,
                    row.holdsSkill ? t('acks.holdsSkill') : t('acks.noSkill'),
                    row.lastSeen ? (
                      <span key="last" className="fw-wi-cell">
                        <span>{t('acks.lastSeen', { number: row.lastSeen.versionNumber, date: formatDateTime(row.lastSeen.at, { locale }) })}</span>
                        <span className="fw-wi-sub">{t(`acks.way.${row.lastSeen.way}`, { language: languageName(row.lastSeen.locale, locale) })}</span>
                      </span>
                    ) : (
                      t('acks.never')
                    ),
                    <Tag key="current" tone={row.seenCurrent ? 'success' : current ? 'warning' : 'neutral'}>
                      {row.seenCurrent ? t('acks.seenYes') : t('acks.seenNo')}
                    </Tag>,
                  ],
                }))}
                stackOnPhone
              />
            )}
            {rows.some((row) => row.workerHidden) && <p className="fw-wi-hint">{t('acks.hiddenWhy')}</p>}
          </section>
        </Card>
      ) : (
        <p className="fw-wi-hint">{t('acks.namesHR')}</p>
      )}
      <p className="fw-wi-hint">{t('acks.record', { number: record.instruction.number })}</p>
    </div>
  )
}
