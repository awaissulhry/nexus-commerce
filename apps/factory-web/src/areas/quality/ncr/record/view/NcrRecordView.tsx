'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CheckCheck, Lock, ShieldCheck } from 'lucide-react'
import { reportHref } from '../../api'
import { EscalateDialog } from '../../view/EscalateDialog'
import { Banner, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { Freshness, RecordProblem, RecordSkeleton } from '../../../_shared/parts'
import { bandHeld, isOpenStage, RECORD_TABS, type Say } from '../../model'
import { NcrStepUp, SeverityTag, StagePill } from '../../parts'
import { CloseNcrDialog } from '../../view/CloseNcrDialog'
import { escalateRecordHeld, recordHref, tabHref, type NcrRecordActions, type NcrRecordModel } from '../view-model'
import { ContainmentTab } from './ContainmentTab'
import { CostTab } from './CostTab'
import { DispositionTab } from './DispositionTab'
import { LinkedTab } from './LinkedTab'
import { ProblemTab } from './ProblemTab'
import { RecordDialogs } from './RecordDialogs'
import { NcrRecordMessages, RecordNotice, useRecordWords } from './words'
import '../record.css'
// ---- B-TH-266: the NCR on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

export type { NcrRecordActions, NcrRecordModel } from '../view-model'

/**
 * SCR-145 — the NCR record (design quality.ncr "Record: NCR", a record page; `?tab=problem|containment|disposition|cost|linked`), on
 * RecordFrame (B-TH-266; threads plan O-QA-NCR, the rule of picture 38, the tabs of picture 39): the band in the shell's band row
 * (‹ Nonconformances, "<number> <title>", ONE pill — its stage —, its severity, where it came from, the site, the CAPA it is escalated
 * to, the freshness; ONE primary next step — Mark contained, Mark decided, Close NCR… — held with what is still missing; ⋯ Copy
 * number, Escalate to CAPA…, NCR report (PDF) (a new tab), Keep a version of the report, Close early, Open the PPE register entry,
 * Cancel NCR…, then the frame's Keyboard line), the Thread button (⌘J) and the NCR's ONE thread docked beside every tab — internal,
 * notes only (an NCR's thread is never shared) —, Activity's tools in its "⋯" (R-ACT). Tabs 6 → 5: Problem & evidence, Containment,
 * Disposition, Cost (the cost grain only; absent otherwise), Linked records. Closing is the closing checklist and an e-signature (the
 * office's fresh code). Every banner is in the ONE notice of the body column.
 */
// B-TH-266: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function NcrRecordView({ model, actions, thread, printThread }: { model: NcrRecordModel; actions?: NcrRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <NcrRecordMessages>
      <Body model={model} actions={actions} thread={thread} printThread={printThread} />
    </NcrRecordMessages>
  )
}

function Body({ model, actions, thread, printThread }: { model: NcrRecordModel; actions?: NcrRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const words = useRecordWords(model.people, model.timeZone)
  const { t, r, say } = words
  const listHref = `${model.prefix}/quality/ncr`
  const back = (
    <Link className="fw-q-link" href={listHref}>
      {r('band.back')}
    </Link>
  )
  const ready = model.loaded.status === 'ready' ? model.loaded.record : null

  // B-TH-266: the keys are the frame's (its Keyboard line, PR-14: no "?" overlay); ⌘S shows in the edit bar.

  // Loading, not found, failed, no right: inside the frame (the band stays), no thread.
  if (!model.can.view || model.loaded.status !== 'ready') {
    const state = model.loaded.status
    return (
      <RecordFrame
        recordType="Nonconformance"
        personId={model.personId ?? null}
        band={{ back, title: state === 'loading' && model.can.view ? <Skeleton width={260} height={22} /> : r('band.title'), moreLabel: r('band.more') }}
        thread={null}
        threadLabel={r('band.dockLabel')}
      >
        {!model.can.view || state === 'forbidden' ? (
          <RecordProblem problem="problem.forbidden" back={back} />
        ) : state === 'loading' ? (
          <RecordSkeleton />
        ) : state === 'notFound' ? (
          <RecordProblem problem="problem.notFound" back={back} />
        ) : (
          <RecordProblem problem={model.loaded.status === 'error' ? model.loaded.problem : 'problem.unavailable'} back={back} onRetry={() => actions?.onRetry?.()} />
        )}
      </RecordFrame>
    )
  }
  const record = ready!
  const ncr = record.ncr
  const held = bandHeld(record)

  const sayHeld = (permission: boolean, own: Say | null, noRight: Say): string | null => (permission ? say(own) : say(noRight))
  let primary: ReactNode = null
  if (ncr.stage === 'OPEN')
    primary = (
      <Button size="sm" variant="primary" heldReason={model.busy ? t('common.working') : sayHeld(model.can.manage, held.contain, { key: 'held.noManage' })} onClick={() => actions?.onMove?.('CONTAINED')}>
        {model.busy ? <Spinner size={12} /> : <ShieldCheck size={14} aria-hidden />} {r('band.contain')}
      </Button>
    )
  else if (ncr.stage === 'CONTAINED')
    primary = (
      <Button size="sm" variant="primary" heldReason={model.busy ? t('common.working') : sayHeld(model.can.manage, held.decide, { key: 'held.noManage' })} onClick={() => actions?.onMove?.('DECIDED')}>
        {model.busy ? <Spinner size={12} /> : <CheckCheck size={14} aria-hidden />} {r('band.decide')}
      </Button>
    )
  else if (ncr.stage === 'DECIDED')
    primary = (
      <Button size="sm" variant="primary" heldReason={sayHeld(model.can.close, held.close, { key: 'held.noClose' })} onClick={() => actions?.onClose?.()}>
        <Lock size={14} aria-hidden /> {r('band.close')}
      </Button>
    )

  const closeHeld = sayHeld(model.can.close, held.close, { key: 'held.noClose' })
  const cancelHeld = sayHeld(model.can.manage, held.cancel, { key: 'held.noManage' })
  const registerHeld = !isOpenStage(ncr.stage) ? say({ key: 'held.frozen', params: { stage: ncr.stage } }) : model.can.manage ? null : say({ key: 'held.noManage' })
  // B-W2b-113: escalate (the CAPA it names already, a cancelled NCR, the rights), the report (a new tab; keep a version).
  const escalateHeld = words.sayAny(escalateRecordHeld(record, model.can))
  const keepHeld = model.keepingReport ? t('common.working') : model.can.manage ? null : say({ key: 'held.noManage' })
  const menu: MenuItemDef[] = [
    { id: 'copy', label: model.copied ? t('common.copied', { number: ncr.number }) : t('common.copyNumber'), onSelect: () => actions?.onCopy?.() },
    { id: 'escalate', label: r('band.escalate'), disabled: !!escalateHeld, description: escalateHeld ?? undefined, onSelect: () => actions?.onEscalate?.() },
    { id: 'report', label: r('band.report'), description: r('band.reportHint'), onSelect: () => window.open(reportHref(ncr.id), '_blank', 'noopener') },
    { id: 'keepReport', label: r('band.keepReport'), disabled: !!keepHeld, description: keepHeld ?? undefined, onSelect: () => actions?.onKeepReport?.() },
    ...(ncr.stage === 'OPEN' || ncr.stage === 'CONTAINED' ? [{ id: 'close', label: r('band.closeEarly'), disabled: !!closeHeld, description: closeHeld ?? undefined, onSelect: () => actions?.onClose?.() }] : []),
    ...(ncr.style?.ppe && !record.register ? [{ id: 'register', label: r('band.register'), disabled: !!registerHeld, description: registerHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'register', description: '', busy: false, notice: null }) }] : []),
    ...(isOpenStage(ncr.stage) ? [{ id: 'cancel', label: r('band.cancel'), tone: 'danger' as const, disabled: !!cancelHeld, description: cancelHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'cancelNcr', reason: '', busy: false, notice: null }) }] : []),
  ]

  const source =
    ncr.sourceType && ncr.sourceId ? (
      <Link className="fw-q-link" href={recordHref(model.prefix, { type: ncr.sourceType, id: ncr.sourceId })}>
        {r('band.from', { source: t(`recordType.${ncr.sourceType}`) })}
      </Link>
    ) : (
      <span>{t(`source.${ncr.source}`)}</span>
    )
  const meta = (
    <span className="fw-ncr-r-row">
      <SeverityTag severity={ncr.severity} />
      <Freshness asOf={model.asOf} live={model.live} />
      {source}
      {model.site && <span className="fw-q-code">{model.site.code}</span>}
      {ncr.style?.ppe && <Tag tone="info">{r('band.ppe')}</Tag>}
      {record.capaRecord && (
        <Link className="fw-q-link" href={recordHref(model.prefix, { type: 'Capa', id: record.capaRecord.id, label: record.capaRecord.number })}>
          {r('band.capa', { number: record.capaRecord.number })}
        </Link>
      )}
    </span>
  )
  // B-TH-266: ONE pill in the band — the stage; the freshness travels with the identity.
  const status = <StagePill stage={ncr.stage} />

  const linkedCount = record.links.length + record.holds.length
  // B-W2b-113: the Cost tab only for a reader with the cost grain (by address it says so).
  // B-W2b-113: the Cost tab only for a reader with the cost grain (by address it says so).
  const tabs: TabItem[] = RECORD_TABS.filter((tab) => tab !== 'cost' || (record.may.cost && model.can.cost)).map((tab) => ({
    id: tab,
    href: tabHref(model.prefix, ncr.id, tab),
    label: r(`tab.${tab}`),
    count: tab === 'containment' ? record.containment.length : tab === 'disposition' ? record.decisions.length : tab === 'linked' ? linkedCount : null,
  }))

  return (
    <>
      <RecordFrame
        recordType="Nonconformance"
        personId={model.personId ?? null}
        threadLabel={r('band.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back,
          title: `${ncr.number} ${ncr.title}`,
          status,
          meta,
          primary: primary ?? undefined,
          more: menu,
          moreLabel: r('band.more'),
        }}
      >
        <Tabs ariaLabel={r('band.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
        {/* B-TH-266: the ONE notice of the body column — most serious first, the rest behind "N more". */}
        <RecordNotices>
          {model.notice && <RecordNotice notice={model.notice} words={words} onDismiss={actions?.onDismissNotice} />}
          {model.stale && !model.dialog && <Banner tone="warning" title={r('stale.title', { time: model.stale })} action={<Button size="sm" variant="quiet" onClick={() => actions?.onReload?.()}>{r('stale.reload')}</Button>} />}
          {model.live === 'offline' && <Banner tone="warning" title={r('offline')} />}
          {ncr.stage === 'CLOSED' && <Banner tone="success" title={r('band.closedBanner', { when: words.when(ncr.closedAt), who: words.person(ncr.closedById) })} />}
          {ncr.stage === 'CANCELLED' && <Banner tone="info" title={r('band.cancelledBanner', { reason: ncr.cancelReason ?? '—' })} />}
        </RecordNotices>
        {model.tab === 'problem' && <ProblemTab model={model} record={record} words={words} actions={actions} />}
        {model.tab === 'containment' && <ContainmentTab model={model} record={record} words={words} actions={actions} />}
        {model.tab === 'disposition' && <DispositionTab model={model} record={record} words={words} actions={actions} />}
        {model.tab === 'cost' && <CostTab model={model} record={record} words={words} actions={actions} />}
        {model.tab === 'linked' && <LinkedTab model={model} record={record} words={words} actions={actions} />}
      </RecordFrame>
      <RecordDialogs model={model} record={record} words={words} actions={actions} />
      {model.close && <CloseNcrDialog model={model.close} actions={actions?.close} />}
      {model.escalate && <EscalateDialog model={model.escalate} actions={actions?.escalate} />}
      <NcrStepUp state={model.stepUp} onSubmit={(code) => actions?.onStepUp?.(code)} onCancel={() => actions?.onStepUpCancel?.()} />
    </>
  )
}
