'use client'

import { type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight, Scale } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { Freshness, RecordProblem, RecordSkeleton } from '../../../../quality/_shared/parts'
// ---- B-TH-259: the case on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
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
 * SCR-413 — a service case (design sales.service "Record: Service case"; `?tab=case|warranty|linked`, `&do=` opens a row verb's
 * dialog), on RecordFrame (B-TH-259; the rule of picture 38, the tabs of picture 39 / 08-tabs O-SAL-SVC): the band in the shell's band
 * row — ‹ Warranty & service, "<number> · <customer or rider>", ONE pill (its status), its kind, channel, priority, garment, owner,
 * when it was opened, whether it tells the customer and the freshness as its details; ONE primary — Open the case, Decide the cover
 * (a warranty claim before it is resolved), Resolve…, Resume, Close… — the Thread button (⌘J) and ⋯ with every other move, Decide,
 * Make repair, Make RMA, Link a record and Copy number, each held with why. The case's thread is docked beside every tab (its
 * customer's only; a rider's case: notes only), Activity's tools in its "⋯" (R-ACT). Tabs 5 → 3: Case (with the status mails sent
 * to the customer, R1-G04), Warranty check, Linked records & actions (the actions under the records they create). ONE notice.
 */
// B-TH-259: `thread` is the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows.
export function ServiceRecordView({ model, actions, thread, printThread }: { model: ServiceRecordModel; actions?: ServiceRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <ServiceMessages>
      <Body model={model} actions={actions} thread={thread} printThread={printThread} />
    </ServiceMessages>
  )
}

/** B-TH-259 (R1-G04): the status mails sent to the customer — on Case now (they were under Activity). */
function StatusMails({ record }: { record: CaseRecord }) {
  const { t, when } = useWords()
  return (
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
  )
}

function Body({ model, actions, thread, printThread }: { model: ServiceRecordModel; actions?: ServiceRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const { t, say, day } = useWords()
  const listHref = `${model.prefix}/sales/service`
  const back = (
    <Link className="fw-svc-link" href={listHref}>
      {t('band.back')}
    </Link>
  )
  // B-TH-259: the states before the case is read sit in the frame with the way back and no thread.
  const waiting = (title: ReactNode, children: ReactNode) => (
    <RecordFrame recordType="ServiceCase" personId={model.me} band={{ back: <Link href={listHref}>{t('band.back')}</Link>, title, moreLabel: t('band.more') }} thread={null} threadLabel={t('record.dockLabel')}>
      {children}
    </RecordFrame>
  )
  if (!model.can.view || model.loaded.status === 'forbidden') return waiting(t('record.title'), <RecordProblem problem="problem.forbidden" back={back} />)
  if (model.loaded.status === 'loading') return waiting(<Skeleton width={240} height={22} />, <RecordSkeleton />)
  if (model.loaded.status === 'notFound') return waiting(t('record.title'), <RecordProblem problem="problem.notFound" back={back} />)
  if (model.loaded.status === 'error') return waiting(t('record.title'), <RecordProblem problem={model.loaded.problem} back={back} onRetry={() => actions?.onRetry?.()} />)
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
      {/* B-TH-259: ONE pill in the band (the status); "Tells the customer" is a detail. */}
      {record.notifyCustomer && <Tag tone="info">{t('band.tellsCustomer')}</Tag>}
      <Freshness asOf={model.asOf} live={model.live} />
    </span>
  )
  // B-TH-259: tabs 5 → 3 — Case counts its status mails, Linked records & actions its records.
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({ id: tab, href: recordHref(model.prefix, record.id, tab), label: t(`tab.${tab}`), count: tab === 'linked' ? record.links.length : tab === 'case' ? record.mails.length || null : null }))

  return (
    <div className="fw-svc">
      <RecordFrame
        recordType="ServiceCase"
        personId={model.me}
        threadLabel={t('record.dockLabelOf', { number: record.number })}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back: <Link href={listHref}>{t('band.back')}</Link>,
          title: `${record.number} · ${record.party ? record.party.legalName : t('row.rider')}`,
          status: <StatusPill status={record.status} />,
          meta,
          primary: primaryButton ?? undefined,
          more: menu,
          moreLabel: t('band.more'),
        }}
      >
        <div className="fw-svc-stack">
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
          {/* B-TH-259: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
          <RecordNotices>
            <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
            {record.closed && <Banner tone="info" title={t('record.closedBanner', { date: day(record.closed.at), name: say(personPhrase(record.people, record.closed.byId, model.me)) ?? '' })}>{record.closed.reason}</Banner>}
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
          </RecordNotices>
          {model.tab === 'case' && (
            // B-TH-259 (R1-G04): Case, then the status mails sent to the customer.
            <div className="fw-svc-stack">
              <CaseTab model={model} record={record} actions={actions} />
              <StatusMails record={record} />
            </div>
          )}
          {model.tab === 'warranty' && <WarrantyTab model={model} record={record} actions={actions} />}
          {model.tab === 'linked' && (
            // B-TH-259: Linked records & actions — the records linked, then the actions that make one (each lands in the list above).
            <div className="fw-svc-stack">
              <LinkedTab model={model} record={record} actions={actions} />
              <ActionsTab model={model} record={record} actions={actions} />
            </div>
          )}
        </div>
      </RecordFrame>
      <RecordDialogs model={model} record={record} actions={actions} />
    </div>
  )
}
