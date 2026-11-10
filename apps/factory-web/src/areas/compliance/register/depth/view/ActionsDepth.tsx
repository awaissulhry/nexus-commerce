'use client'

import Link from 'next/link'
import { MoreHorizontal, Send, Siren } from 'lucide-react'
import { Banner, EmptyState, Menu, ProgressBar, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { Section } from '../../../../quality/_shared/parts'
import type { DistributorNotice, RecallRow } from '../api'
import { distributorHeld, distributorLog, draftsToSend, percentBack, recallAddress, recallsInOrder, recallVerb, recipientsToDraft, sendSummary } from '../model'
import type { DepthActions, DepthModel } from './types'
import { DistributorStatus, Law, NS, RecallStatus, ToldText } from './parts'

/**
 * The Actions tab's W2b parts (design rec:Register entry/actions, rg-actions W2b; B-W2b-271 on B-W2b-260's API): recall
 * progress — each recall or withdrawal with returned / remedied / disposed and a ProgressBar of what came back, opening its
 * builder page — and the distributor information log (who, when, how, the answer), with Draft notices for the customers
 * that got the garments and "Send to N distributors" (a fresh code; a result per recipient). W1's "Inform distributors"
 * still records a date typed by hand.
 */
export function ActionsDepth({ model, actions }: { model: DepthModel; actions?: DepthActions }) {
  const d = useT(NS)
  const q = useT('quality')
  const read = model.surveillance
  if (read.problem)
    return (
      <Section title={d('recalls.title')} id="rg-recalls">
        <EmptyState
          title={d('actions.failed')}
          description={q(read.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {q('common.retry')}
            </Button>
          }
        />
      </Section>
    )
  return (
    <div className="fw-q-stack">
      <RecallsSection model={model} actions={actions} />
      <DistributorsSection model={model} actions={actions} />
    </div>
  )
}

function RecallsSection({ model, actions }: { model: DepthModel; actions?: DepthActions }) {
  const d = useT(NS)
  const locale = useLocale()
  const value = model.surveillance.value
  if (!value)
    return (
      <Section title={d('recalls.title')} id="rg-recalls">
        <Skeleton height={20} />
        <Skeleton height={20} />
      </Section>
    )
  const verb = recallVerb(model.entry, value.recalls)
  const startHeld = !model.can.recallManage ? 'held.manage' : model.entry.status !== 'OPEN' ? 'held.entryClosed' : null
  const recalls = recallsInOrder(value.recalls)
  return (
    <Section
      title={d('recalls.title')}
      sub={d('recalls.sub')}
      id="rg-recalls"
      actions={
        verb.kind === 'open' ? (
          <Button size="sm" asChild>
            <Link href={recallAddress(model.prefix, verb.recallId)}>{d('recalls.openLive', { number: verb.number })}</Link>
          </Button>
        ) : (
          <Button size="sm" heldReason={startHeld ? d(startHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'startRecall' })}>
            <Siren size={13} aria-hidden /> {d('recalls.start')}
          </Button>
        )
      }
    >
      <Law law={value.law.correctiveAction} plain={d('law.correctiveAction')} />
      {recalls.length === 0 ? (
        <p className="fw-q-hint">{d('recalls.none')}</p>
      ) : (
        <ul className="fw-rgd-recalls">
          {recalls.map((recall) => (
            <RecallItem key={recall.id} recall={recall} prefix={model.prefix} locale={locale} />
          ))}
        </ul>
      )}
    </Section>
  )
}

function RecallItem({ recall, prefix, locale }: { recall: RecallRow; prefix: string; locale: ReturnType<typeof useLocale> }) {
  const d = useT(NS)
  const p = recall.progress
  const value = percentBack(p)
  return (
    <li className="fw-rgd-recall">
      <div className="fw-rgd-recall-head">
        <Link className="fw-q-link fw-q-code" href={recallAddress(prefix, recall.id)}>
          {recall.number}
        </Link>
        <span>{d(`recallKind.${recall.kind}`)}</span>
        <RecallStatus recall={recall} />
        {recall.notice.live && <span className="fw-q-hint">{d('recalls.noticeLive')}</span>}
      </div>
      <p className="fw-q-hint">
        {recall.scope.wholeStyle
          ? d('recalls.scopeStyle', { style: recall.style.code })
          : d('recalls.scopeParts', { batches: recall.scope.batchNumbers.length, serials: recall.scope.serialCount, workOrders: recall.scope.workOrderCount, shipments: recall.scope.shipmentCount })}
        {recall.startedAt ? ` · ${d('recalls.startedOn', { date: formatDate(recall.startedAt, { locale }) })}` : ''}
      </p>
      {recall.status === 'DRAFT' || recall.startedAt === null ? (
        <p className="fw-q-hint">{recall.status === 'CANCELLED' ? `${d('recalls.cancelledText')}${recall.cancelReason ? ` ${recall.cancelReason}` : ''}` : d('recalls.notStarted')}</p>
      ) : (
        <>
          <ProgressBar ariaLabel={d('recalls.progressLabel', { number: recall.number })} value={value} showValue />
          <p className="fw-rgd-counts">
            {d('recalls.counts', { sent: p.unitsSent, returned: p.unitsReturned, repaired: p.unitsRepaired, destroyed: p.unitsDestroyed, out: p.unitsStillOut })}
          </p>
        </>
      )}
    </li>
  )
}

/** The distributor information log (also the recall page's step 3). */
export function DistributorsSection({ model, actions }: { model: DepthModel; actions?: DepthActions }) {
  const d = useT(NS)
  const q = useT('quality')
  const locale = useLocale()
  const read = model.recipients
  const counts = model.surveillance.value?.distributors ?? null
  const law = model.surveillance.value?.law.distributors ?? null
  if (!read || (!read.value && !read.problem))
    return (
      <Section title={d('log.title')} id="rg-log">
        <Skeleton height={20} />
        <Skeleton height={20} />
      </Section>
    )
  if (!read.value)
    return (
      <Section title={d('log.title')} id="rg-log">
        <EmptyState
          title={d('log.failed')}
          description={q(read.problem ?? 'problem.unavailable')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {q('common.retry')}
            </Button>
          }
        />
      </Section>
    )
  const recipients = read.value
  const log = distributorLog(recipients)
  const drafts = draftsToSend(recipients).length
  const toDraft = recipientsToDraft(recipients)
  const held = (action: Parameters<typeof distributorHeld>[0], notice: DistributorNotice | null = null) => {
    const key = distributorHeld(action, recipients, notice, model.can, model.entry)
    return key ? d(key) : null
  }
  const rows = log.map((notice) => {
    const items: MenuItemDef[] = (
      [
        ['edit', 'distributorEdit'],
        ['answer', 'distributorAnswer'],
        ['fail', 'distributorFail'],
        ['cancel', 'distributorCancel'],
      ] as const
    ).map(([action, kind]) => {
      const reason = held(action, notice)
      return { id: action, label: d(`log.${action}Action`), disabled: !!reason, description: reason ?? undefined, onSelect: () => actions?.onDialog?.({ kind, noticeId: notice.id }) } as MenuItemDef
    })
    return {
      id: notice.id,
      cells: [
        <span key="p" className="fw-q-cell">
          <span>{notice.party.name}</span>
          <span className="fw-q-hint">{notice.recallNumber ? `${notice.party.code} · ${notice.recallNumber}` : notice.party.code}</span>
        </span>,
        <span key="h" className="fw-q-cell">
          <span>{d(`how.${notice.channel}`)}</span>
          <span className="fw-q-hint fw-rgd-clip">{[notice.contactName, notice.contact].filter(Boolean).join(' · ') || '—'}</span>
        </span>,
        notice.sentAt ? (
          <span key="w" className="fw-q-cell">
            <span>{formatDateTime(notice.sentAt, { locale })}</span>
            {notice.sentBy && <span className="fw-q-hint">{notice.sentBy.name}</span>}
          </span>
        ) : (
          <span key="w" className="fw-q-hint">
            {d('log.notSent')}
          </span>
        ),
        <DistributorStatus key="s" notice={notice} />,
        notice.answer ? (
          <span key="a" className="fw-q-cell">
            <span className="fw-reg-text fw-rgd-clip">{notice.answer}</span>
            <span className="fw-q-hint">{[notice.answeredByName, notice.answeredAt ? formatDate(notice.answeredAt, { locale }) : null].filter(Boolean).join(' · ')}</span>
          </span>
        ) : notice.failureReason ? (
          <span key="a" className="fw-reg-text fw-rgd-clip">
            {notice.failureReason}
          </span>
        ) : (
          '—'
        ),
        <Menu key="m" align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': d('log.menu', { party: notice.party.name }) }} items={items} />,
      ],
    }
  })
  const results = model.sendResults
  const summary = results ? sendSummary(results.results) : null
  return (
    <Section
      title={d('log.title')}
      sub={counts ? <ToldText told={counts.told} of={counts.of} /> : undefined}
      id="rg-log"
      actions={
        <span className="fw-q-cell-row">
          <Button size="sm" heldReason={held('draft')} onClick={() => actions?.onDraftDistributors?.()}>
            {d('log.draftAction', { count: toDraft })}
          </Button>
          <Button size="sm" variant="primary" heldReason={held('send')} onClick={() => actions?.onDialog?.({ kind: 'distributorSend' })}>
            <Send size={13} aria-hidden /> {d('log.sendAction', { count: drafts })}
          </Button>
        </span>
      }
    >
      {law && <Law law={law} plain={d('law.distributors')} />}
      {results && summary && (
        <Banner
          tone={summary.refused > 0 ? 'warning' : 'success'}
          title={d('log.sent', { sent: summary.sent, refused: summary.refused })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissResults?.()}>
              {q('common.close')}
            </Button>
          }
        >
          {results.results.some((result) => !result.sent) && (
            <ul className="fw-q-lines">
              {results.results
                .filter((result) => !result.sent)
                .map((result) => {
                  const notice = results.notices.find((item) => item.id === result.noticeId)
                  return <li key={result.noticeId}>{`${notice?.party.name ?? '—'}: ${result.problem ?? ''}`}</li>
                })}
            </ul>
          )}
          {results.distributorsInformed && <p className="fw-q-hint">{d('log.allTold')}</p>}
        </Banner>
      )}
      {recipients.recipients.length === 0 && log.length === 0 ? (
        <p className="fw-q-hint">{d('log.nobody')}</p>
      ) : log.length === 0 ? (
        <p className="fw-q-hint">{d('log.empty', { count: recipients.recipients.length })}</p>
      ) : (
        <SummaryTable
          label={d('log.title')}
          columns={[d('col.distributor'), d('col.how'), d('col.when'), d('col.status'), d('col.answer'), d('col.actions')]}
          rows={rows}
          align={[undefined, undefined, undefined, undefined, undefined, 'right']}
          widths={['22%', '20%', '18%', '12%', '20%', '8%']}
          density="roomy"
          stackOnPhone
        />
      )}
    </Section>
  )
}
