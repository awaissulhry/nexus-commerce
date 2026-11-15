'use client'

import { BellRing, ExternalLink, Hourglass, Link2, Mail, ShieldCheck, Truck } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { AsOf } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListKeysInfo } from '../../../../../list-frame/ListKeysInfo'
import { WithMessages } from '../../../../../record-panels/i18n'
import { nudgeOf, sinceWords, whoWords, type WaitingModel, type WaitingRow } from '../model'
import '../../today.css'
import '../waiting-on.css'

export interface WaitingOnActions {
  onNudge?: (row: WaitingRow) => void
  onRetry?: () => void
}

const KIND_ICON = { APPROVAL_REQUEST: ShieldCheck, PO_CONFIRMATION: Truck, QUOTE_ANSWER: Hourglass, MESSAGE_REPLY: Mail, LINK_UNOPENED: Link2 } as const

/**
 * Today › Waiting on others (design home.today `waiting-on`, W2b; COL-035): what I asked for and still wait on — my approval
 * requests not decided, the purchase orders I sent and the quotes I sent not answered, my mail with no reply in 3 working days,
 * the links I sent nobody opened — each one line: what, whom I wait for, since when (and by when, when the record says), the
 * record as a real link; Nudge on an approval I asked for (once a day; held with its reason). Empty: "You are not waiting on
 * anyone." It draws ONE model.
 */
export function WaitingOnView({ model, actions }: { model: WaitingModel; actions?: WaitingOnActions }) {
  return (
    <WithMessages namespaces={['home-mywork', 'lists']}>
      <WaitingOn model={model} actions={actions} />
    </WithMessages>
  )
}

function WaitingOn({ model, actions }: { model: WaitingModel; actions?: WaitingOnActions }) {
  const t = useT('home-mywork')
  const locale = useLocale()
  const rows = model.rows.status === 'ready' ? model.rows.data.items : []
  return (
    <section className="fw-today-section" aria-labelledby="fw-mywork-waiting">
      <div className="fw-today-head">
        <h2 id="fw-mywork-waiting" className="fw-today-h">
          {t('waiting.title')}
        </h2>
        {model.rows.status === 'ready' && (
          <>
            <span className="fw-today-muted">{t('waiting.count', { count: rows.length })}</span>
            <AsOf at={model.rows.data.asOf} now={model.now} />
          </>
        )}
      </div>
      {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} />}
      {model.rows.status === 'loading' ? (
        <div className="fw-mywork-waiting" aria-busy="true">
          <p className="fw-today-muted" role="status">
            {t('loading')}
          </p>
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      ) : model.rows.status === 'error' ? (
        <Banner tone="danger" title={t('waiting.error')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>}>
          {t(model.rows.problem)}
        </Banner>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Hourglass size={22} aria-hidden />} title={t('waiting.empty.title')} description={t('waiting.empty.body')} />
      ) : (
        <>
          <ul className="fw-mywork-waiting" aria-label={t('waiting.title')}>
            {rows.map((row) => {
              const Icon = KIND_ICON[row.kind]
              const who = whoWords(row)
              const since = sinceWords(row)
              const nudge = nudgeOf(row, model.held)
              return (
                <li key={row.key} className="fw-mywork-waiting-row">
                  <Icon size={16} className="fw-mywork-waiting-icon" aria-hidden />
                  <span className="fw-mywork-waiting-text">
                    <span className="fw-mywork-waiting-what">{t(`waiting.kind.${row.kind}`, { record: row.record.label })}</span>
                    <span className="fw-today-muted">
                      {t(who.key, { name: who.name })} · {t(since.key, { count: since.count })}
                      {row.due ? ` · ${t('waiting.due', { date: formatDate(row.due, { locale, timeZone: 'UTC' }) })}` : ''}
                    </span>
                  </span>
                  <span className="fw-mywork-waiting-actions">
                    <Tag tone="neutral">{t(`waiting.tag.${row.kind}`)}</Tag>
                    {nudge.offered && (
                      <Button size="sm" variant="secondary" heldReason={nudge.held ? t(nudge.held) : null} aria-label={t('waiting.nudge.on', { record: row.record.label })} onClick={() => actions?.onNudge?.(row)}>
                        <BellRing size={13} aria-hidden /> {t('waiting.nudge.label')}
                      </Button>
                    )}
                    <a className="fw-today-record" href={row.href} title={t('waiting.open', { record: row.record.label })}>
                      {row.record.label}
                      <ExternalLink size={12} aria-hidden />
                    </a>
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="fw-today-queue-foot">
            <ListKeysInfo keys={[{ keys: ['Tab'], does: t('waiting.keys.move') }, { keys: ['↵'], does: 'keys.open' }]} />
          </div>
        </>
      )}
    </section>
  )
}
