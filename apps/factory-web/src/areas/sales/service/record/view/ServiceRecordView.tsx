'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight, MoreHorizontal, Scale } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Pill, Spinner } from '@nexus/ui/primitives'
import { RecordPanelsView, type RecordPanelsViewModel } from '../../../../../record-panels/view/RecordPanelsView'
import { Freshness, RecordFrame, RecordProblem, RecordSkeleton } from '../../../../quality/_shared/parts'
import type { CaseRecord } from '../../api'
import { actionHeld, coverDraftOf, emptyReturnDraft, MOVE_ACTIONS, mailStatusKey, personPhrase, primaryOf, RECORD_TABS, recordHref, repairDraftOf, type MoveAction } from '../../model'
import { KindTag, NoticeLine, PriorityTag, ServiceMessages, StatusPill, useWords } from '../../parts'
import type { ServiceRecordActions, ServiceRecordModel } from '../view-model'
import { ActionsTab } from './ActionsTab'
import { CaseTab } from './CaseTab'
import { LinkedTab } from './LinkedTab'
import { RecordDialogs } from './RecordDialogs'
import { WarrantyTab } from './WarrantyTab'

export type { ServiceRecordActions, ServiceRecordModel } from '../view-model'

/**
 * SCR-413 — a service case (design sales.service "Record: Service case"; `?tab=case|warranty|linked|actions|activity`,
 * `&do=` opens a row verb's dialog): the band (‹ Warranty & service, "<number> · <customer or rider>", its kind, channel,
 * priority, garment, owner and when it was opened; its status and the freshness; ONE primary — Open the case, Decide the
 * cover (a warranty claim before it is resolved), Resolve…, Resume, Close… — and ⋯ with every other move, Decide, Make
 * repair, Make RMA, Link a record and Copy number, each held with why) and its tabs: Case, Warranty check, Linked records,
 * Actions, Activity (the record panels: thread and timeline, plus the status mails sent to the customer).
 */
export function ServiceRecordView({ model, actions, panels, panelsPreview }: { model: ServiceRecordModel; actions?: ServiceRecordActions; panels?: ReactNode; panelsPreview?: RecordPanelsViewModel }) {
  return (
    <ServiceMessages>
      <Body model={model} actions={actions} panels={panels} panelsPreview={panelsPreview} />
    </ServiceMessages>
  )
}

function Body({ model, actions, panels, panelsPreview }: { model: ServiceRecordModel; actions?: ServiceRecordActions; panels?: ReactNode; panelsPreview?: RecordPanelsViewModel }) {
  const { t, say, day, when } = useWords()
  const listHref = `${model.prefix}/sales/service`
  const back = (
    <Link className="fw-svc-link" href={listHref}>
      {t('band.back')}
    </Link>
  )
  if (!model.can.view || model.loaded.status === 'forbidden') return <RecordProblem problem="problem.forbidden" back={back} />
  if (model.loaded.status === 'loading') return <RecordSkeleton />
  if (model.loaded.status === 'notFound') return <RecordProblem problem="problem.notFound" back={back} />
  if (model.loaded.status === 'error') return <RecordProblem problem={model.loaded.problem} back={back} onRetry={() => actions?.onRetry?.()} />
  const record: CaseRecord = model.loaded.record
  const offline = model.live === 'offline'
  const primary = primaryOf(record)
  const moveHeldOf = (action: MoveAction) => say(actionHeld(record, action, offline, model.can)) ?? (model.busy ? t('common.working') : null)

  let primaryButton: ReactNode = null
  if (primary?.kind === 'decide')
    primaryButton = (
      <Button size="sm" variant="primary" heldReason={say(actionHeld(record, 'decideCover', offline, model.can))} onClick={() => actions?.onDialog?.({ kind: 'decide', draft: coverDraftOf(record), busy: false, notice: null })}>
        <Scale size={14} aria-hidden /> {t('band.decide')}
      </Button>
    )
  else if (primary?.kind === 'move')
    primaryButton = (
      <Button size="sm" variant="primary" heldReason={moveHeldOf(primary.action)} onClick={() => actions?.onMove?.(primary.action)}>
        {model.busy ? <Spinner size={12} /> : <ArrowRight size={14} aria-hidden />} {t(`band.move.${primary.action}`)}
      </Button>
    )

  const heldItem = (id: string, label: string, held: string | null, onSelect: () => void, tone?: 'danger'): MenuItemDef => ({ id, label, disabled: !!held, description: held ?? undefined, onSelect, ...(tone ? { tone } : {}) })
  // ⋯ lists the moves this status takes (one held for the right or a decision says why); the others are not offered.
  const NOT_HERE = new Set(['NOT_FROM_HERE', 'ALREADY', 'NOT_NEW', 'NOT_RESOLVED'])
  const others = MOVE_ACTIONS.filter((action) => !(primary?.kind === 'move' && primary.action === action) && !NOT_HERE.has(record.actions.find((entry) => entry.action === action)?.held ?? ''))
  const menu: MenuItemDef[] = [
    ...(record.status === 'CLOSED' ? [] : others.map((action) => heldItem(`move-${action}`, t(`band.move.${action}`), moveHeldOf(action), () => actions?.onMove?.(action), action === 'close' ? 'danger' : undefined))),
    ...(primary?.kind === 'decide' ? [] : [heldItem('decide', record.warranty.decided ? t('warranty.decideAgain') : t('warranty.decide'), say(actionHeld(record, 'decideCover', offline, model.can)), () => actions?.onDialog?.({ kind: 'decide', draft: coverDraftOf(record), busy: false, notice: null }))]),
    heldItem('repair', t('row.makeRepair'), say(actionHeld(record, 'makeRepair', offline, model.can)), () => actions?.onDialog?.({ kind: 'repair', draft: repairDraftOf(record), busy: false, notice: null })),
    heldItem('return', t('row.makeReturn'), say(actionHeld(record, 'makeReturn', offline, model.can)), () => actions?.onDialog?.({ kind: 'return', draft: emptyReturnDraft('RETURN'), reasons: { items: null, problem: null }, busy: false, notice: null })),
    heldItem('link', t('linked.link'), say(actionHeld(record, 'link', offline, model.can)), () => actions?.onDialog?.({ kind: 'link', recordType: 'SalesOrder', q: '', found: { items: null, reading: false, problem: null }, picked: null, note: '', busy: false, notice: null })),
    { id: 'copy', label: model.copied ? t('common.copied', { number: record.number }) : t('common.copyNumber'), onSelect: () => actions?.onCopy?.() },
  ]

  const garment = record.garmentSerial ?? record.serial ?? record.garmentBatch ?? record.batchNumber
  const meta = (
    <span className="fw-svc-row">
      <KindTag kind={record.kind} />
      <span>{t(`channel.${record.channel}`)}</span>
      <PriorityTag priority={record.priority} />
      {garment && <span className="fw-svc-code">{garment}</span>}
      <span>{t('band.owner', { name: say(personPhrase(record.people, record.ownerId, model.me)) ?? '' })}</span>
      <span>{t('band.opened', { date: day(record.openedAt) })}</span>
    </span>
  )
  const status = (
    <span className="fw-svc-row">
      <StatusPill status={record.status} />
      {record.notifyCustomer && <Pill tone="info">{t('band.tellsCustomer')}</Pill>}
      <Freshness asOf={model.asOf} live={model.live} />
    </span>
  )
  const tabs = RECORD_TABS.map((tab) => ({ id: tab, label: t(`tab.${tab}`), count: tab === 'linked' ? record.links.length : tab === 'activity' ? record.mails.length || null : null }))
  const activity = panels ?? (panelsPreview ? <RecordPanelsView model={panelsPreview} /> : null)

  return (
    <div className="fw-svc">
      <RecordFrame
        back={{ href: listHref, label: t('band.back') }}
        title={`${record.number} · ${record.party ? record.party.legalName : t('row.rider')}`}
        meta={meta}
        status={status}
        actions={
          <>
            {primaryButton}
            <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('band.more') }} items={menu} />
          </>
        }
        tabs={tabs}
        active={model.tab}
        tabHref={(tab) => recordHref(model.prefix, record.id, tab as (typeof RECORD_TABS)[number])}
      >
        {offline && <Banner tone="warning" title={t('record.offline')} />}
        {model.stale && (
          <Banner
            tone="warning"
            title={t('record.stale', { time: model.stale })}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onReload?.()}>
                {t('record.reload')}
              </Button>
            }
          />
        )}
        {record.closed && <Banner tone="info" title={t('record.closedBanner', { date: day(record.closed.at), name: say(personPhrase(record.people, record.closed.byId, model.me)) ?? '' })}>{record.closed.reason}</Banner>}
        <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {model.tab === 'case' && <CaseTab model={model} record={record} actions={actions} />}
        {model.tab === 'warranty' && <WarrantyTab model={model} record={record} actions={actions} />}
        {model.tab === 'linked' && <LinkedTab model={model} record={record} actions={actions} />}
        {model.tab === 'actions' && <ActionsTab model={model} record={record} actions={actions} />}
        {model.tab === 'activity' && (
          <div className="fw-svc-stack">
            <Card padded>
              <section className="fw-svc-stack" aria-labelledby="svc-mails">
                <h2 id="svc-mails" className="fw-svc-h2">
                  {t('mails.title')}
                </h2>
                <p className="fw-svc-hint">{record.notifyCustomer ? (record.contact?.email ? t('mails.on', { to: record.contact.email }) : t('mails.onNoContact')) : t('mails.off')}</p>
                {record.mails.length === 0 ? (
                  <EmptyState title={t('mails.none')} />
                ) : (
                  <ul className="fw-svc-list">
                    {record.mails.map((mail) => (
                      <li key={mail.id}>
                        <span className="fw-svc-cell">
                          <span>{mail.subject}</span>
                          <span className="fw-svc-hint">{t('mails.to', { to: mail.to.join(', '), when: when(mail.queuedAt) })}</span>
                        </span>
                        <Pill tone={mail.status === 'FAILED' || mail.status === 'BOUNCED' || mail.status === 'COMPLAINED' ? 'danger' : mail.status === 'DELIVERED' || mail.status === 'SENT' ? 'success' : 'neutral'}>{t(mailStatusKey(mail.status))}</Pill>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </Card>
            {activity ?? (
              <Card padded>
                <EmptyState title={t('activity.noThread')} description={say({ key: 'held.right', params: { right: 'right.threads.read' } }) ?? ''} />
              </Card>
            )}
          </div>
        )}
      </RecordFrame>
      <RecordDialogs model={model} record={record} actions={actions} />
    </div>
  )
}
