'use client'

import Link from 'next/link'
import { ExternalLink, FilePlus2, MoreHorizontal, ScrollText } from 'lucide-react'
import { EmptyState, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { Countdown } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { Section } from '../../../../quality/_shared/parts'
import type { AuthorityNotice, AuthorityRequest } from '../api'
import { dueInstant, noticeHeld, noticePdfAddress, noticesInOrder, pickLanguage, readerChain, requestHeld, requestsInOrder } from '../model'
import type { DepthActions, DepthModel } from './types'
import { DueWord, Law, NoticeStatus, NS } from './parts'

/**
 * Register entry › Authority notices (design rec:Register entry/authority, rg-notices; PRD-387, PRD-390; B-W2b-271 on
 * B-W2b-260's API): the notices to market surveillance authorities (date, authority, reference, the copy) with Draft
 * authority notice, and the requests an authority sent (date, authority, scope, the deadline as a Countdown, the documents
 * sent as the evidence pack) with Log a request and Build evidence pack. Each table is small and read-only (DS
 * SummaryTable); a row's actions open their dialog. Nothing is sent to an authority from here: a person sends and records.
 */
export function AuthorityTab({ model, actions }: { model: DepthModel; actions?: DepthActions }) {
  const d = useT(NS)
  const q = useT('quality')
  const read = model.surveillance
  if (read.problem)
    return (
      <Section title={d('authority.title')} id="rg-notices">
        <EmptyState
          title={d('authority.failed')}
          description={q(read.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {q('common.retry')}
            </Button>
          }
        />
      </Section>
    )
  if (!read.value)
    return (
      <div className="fw-q-stack" aria-busy="true">
        <Section title={d('authority.notices')} id="rg-notices">
          <Skeleton height={20} />
          <Skeleton height={20} />
        </Section>
        <Section title={d('authority.requests')} id="rg-requests">
          <Skeleton height={20} />
        </Section>
      </div>
    )
  return (
    <div className="fw-q-stack">
      <NoticesSection model={model} actions={actions} notices={read.value.notices} law={read.value.law.authorityNotice} />
      <RequestsSection model={model} actions={actions} requests={read.value.requests} law={read.value.law.authorityRequest} />
    </div>
  )
}

function NoticesSection({ model, actions, notices, law }: { model: DepthModel; actions?: DepthActions; notices: readonly AuthorityNotice[]; law: string }) {
  const d = useT(NS)
  const locale = useLocale()
  const chain = readerChain(locale)
  const draftHeld = noticeHeld('draft', null, model.entry, model.can)
  const rows = noticesInOrder(notices).map((notice) => {
    const language = pickLanguage(Object.keys(notice.words), chain)
    const items: MenuItemDef[] = [
      { id: 'open', label: d('notice.open'), onSelect: () => actions?.onDialog?.({ kind: 'notice', noticeId: notice.id }) },
      { id: 'pdf', label: d('notice.pdfTab'), href: noticePdfAddress(model.prefix, notice.id, language), target: '_blank', icon: <ExternalLink size={14} aria-hidden /> },
    ]
    return {
      id: notice.id,
      cells: [
        notice.sentAt ? (
          <span key="d" className="fw-q-cell">
            <span>{formatDate(notice.sentAt, { locale })}</span>
            <span className="fw-q-hint">{d('notice.sentBy', { name: notice.sentBy?.name ?? '—' })}</span>
          </span>
        ) : (
          <span key="d" className="fw-q-cell">
            <span>{formatDate(notice.createdAt, { locale })}</span>
            <span className="fw-q-hint">{d('notice.drafted')}</span>
          </span>
        ),
        <span key="a" className="fw-q-cell">
          <span>{notice.authorityName}</span>
          <span className="fw-q-hint">
            {notice.market ? `${notice.market.name} (${notice.marketCode})` : notice.marketCode} · {d(`channel.${notice.channel}`)}
          </span>
        </span>,
        d(`decision.${notice.decision}`),
        <NoticeStatus key="s" notice={notice} />,
        notice.reference ? <span className="fw-q-code">{notice.reference}</span> : '—',
        notice.file ? notice.file.name : notice.status === 'SENT' ? d('notice.noCopy') : '—',
        <Menu key="m" align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': d('notice.menu', { authority: notice.authorityName }) }} items={items} />,
      ],
    }
  })
  return (
    <Section
      title={d('authority.notices')}
      sub={d('authority.noticesSub')}
      id="rg-notices"
      actions={
        <Button size="sm" variant="primary" heldReason={draftHeld ? d(draftHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'notice', noticeId: null })}>
          <FilePlus2 size={13} aria-hidden /> {d('notice.draftAction')}
        </Button>
      }
    >
      <Law law={law} plain={d('law.authorityNotice')} />
      {rows.length === 0 ? (
        <EmptyState icon={<ScrollText size={22} aria-hidden />} title={d('authority.noNotices')} description={model.entry.risk === 'YES' ? d('authority.noNoticesRisk') : d('authority.noNoticesBody')} />
      ) : (
        <SummaryTable
          label={d('authority.notices')}
          columns={[d('col.date'), d('col.authority'), d('col.decision'), d('col.status'), d('col.reference'), d('col.copy'), d('col.actions')]}
          rows={rows}
          align={[undefined, undefined, undefined, undefined, undefined, undefined, 'right']}
          widths={['14%', '26%', '14%', '12%', '13%', '15%', '6%']}
          density="roomy"
          stackOnPhone
        />
      )}
    </Section>
  )
}

function RequestsSection({ model, actions, requests, law }: { model: DepthModel; actions?: DepthActions; requests: readonly AuthorityRequest[]; law: string }) {
  const d = useT(NS)
  const locale = useLocale()
  const logHeld = !model.can.recallManage ? 'held.manage' : null
  const rows = requestsInOrder(requests).map((request) => {
    const held = (action: 'evidence' | 'answer' | 'cancel') => requestHeld(action, request, model.can)
    const items: MenuItemDef[] = (['evidence', 'answer', 'cancel'] as const).map((action) => {
      const reason = held(action)
      return {
        id: action,
        label: d(`request.${action}Action`),
        disabled: !!reason,
        description: reason ? d(reason) : undefined,
        onSelect: () => actions?.onDialog?.({ kind: action === 'evidence' ? 'requestEvidence' : action === 'answer' ? 'requestAnswer' : 'requestCancel', requestId: request.id }),
      } as MenuItemDef
    })
    const pack = request.evidence?.pack ?? null
    return {
      id: request.id,
      cells: [
        <span key="r" className="fw-q-cell">
          <span className="fw-q-code">{request.number}</span>
          <span className="fw-q-hint">{d('request.received', { date: formatDate(request.receivedAt, { locale }) })}</span>
        </span>,
        <span key="a" className="fw-q-cell">
          <span>{request.authorityName}</span>
          <span className="fw-q-hint">
            {request.market ? request.market.name : request.marketCode}
            {request.authorityReference ? ` · ${request.authorityReference}` : ''}
          </span>
        </span>,
        <span key="s" className="fw-q-cell">
          <span className="fw-reg-text fw-rgd-clip">{request.request}</span>
          <span className="fw-q-hint">
            {request.style ? request.style.code : d('request.noStyle')}
            {request.batchNumbers.length > 0 ? ` · ${request.batchNumbers.join(', ')}` : ''}
          </span>
        </span>,
        <span key="due" className="fw-q-cell">
          <DueWord request={request} />
          {request.status === 'OPEN' && (
            <span className="fw-q-hint">
              {formatDate(`${request.dueOn}T12:00:00Z`, { locale, timeZone: 'UTC' })}
              {/* The Countdown only while the day is near (an overdue one says so in its pill). */}
              {(request.due.state === 'DUE_TODAY' || request.due.state === 'DUE_SOON') && (
                <>
                  {' · '}
                  <Countdown to={dueInstant(request.dueOn)} now={model.now} announce={false} doneLabel={d('due.passed')} />
                </>
              )}
            </span>
          )}
        </span>,
        request.evidence ? (
          <span key="e" className="fw-q-cell">
            <Link className="fw-q-link" href={`${model.prefix}${recordAddress({ type: request.evidence.type, id: request.evidence.id, label: pack?.number, companyId: request.companyId }, OFFICE_PAGES)}`}>
              {pack ? pack.number : d('request.evidenceNamed')}
            </Link>
            {pack && <span className="fw-q-hint">{d(`packStatus.${pack.status === 'BUILT' || pack.status === 'BUILDING' || pack.status === 'FAILED' ? pack.status : 'OTHER'}`, { count: pack.links })}</span>}
          </span>
        ) : (
          <span key="e" className="fw-q-hint">
            {d('request.noEvidence')}
          </span>
        ),
        request.status === 'ANSWERED' ? (
          <span key="st" className="fw-q-cell">
            <span>{d('request.answeredOn', { date: request.answeredAt ? formatDateTime(request.answeredAt, { locale }) : '—' })}</span>
            {request.answeredBy && <span className="fw-q-hint">{request.answeredBy.name}</span>}
          </span>
        ) : (
          d(`requestStatus.${request.status}`)
        ),
        <Menu key="m" align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': d('request.menu', { number: request.number }) }} items={items} />,
      ],
    }
  })
  return (
    <Section
      title={d('authority.requests')}
      sub={d('authority.requestsSub')}
      id="rg-requests"
      actions={
        <Button size="sm" heldReason={logHeld ? d(logHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'request' })}>
          {d('request.logAction')}
        </Button>
      }
    >
      <Law law={law} plain={d('law.authorityRequest')} />
      {rows.length === 0 ? (
        <EmptyState title={d('authority.noRequests')} description={d('authority.noRequestsBody')} />
      ) : (
        <SummaryTable
          label={d('authority.requests')}
          columns={[d('col.request'), d('col.authority'), d('col.asks'), d('col.deadline'), d('col.documents'), d('col.status'), d('col.actions')]}
          rows={rows}
          align={[undefined, undefined, undefined, undefined, undefined, undefined, 'right']}
          widths={['12%', '17%', '25%', '16%', '13%', '11%', '6%']}
          density="roomy"
          stackOnPhone
        />
      )}
    </Section>
  )
}
