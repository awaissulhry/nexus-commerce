'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight, Lock } from 'lucide-react'
import { Banner, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { isPageKey } from '../../../_shared/hooks'
import { Freshness, RecordProblem, RecordSkeleton } from '../../../_shared/parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { addActionHeld, editHeld, emptyActionDraft, keepReportHeld, primaryOf, recordHref, reportHref, RECORD_TABS } from '../../model'
import { CapaMessages, NoticeLine, personWords, PriorityTag, StagePill, TypeTag, useCapaWords } from '../../parts'
import { CloseCapaDialog } from '../../view/CloseCapaDialog'
import type { CapaRecordActions, CapaRecordModel } from '../view-model'
import { ActionsTab } from './ActionsTab'
import { ProblemTab } from './ProblemTab'
import { RecordDialogs } from './RecordDialogs'
import { ReportTab } from './ReportTab'
// ---- B-TH-266: the CAPA on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

export type { CapaRecordActions, CapaRecordModel } from '../view-model'

/**
 * SCR-146-record — a CAPA or an 8D (design quality.capa "Record: CAPA", a record page; `?tab=problem|actions|report`), on RecordFrame
 * (B-TH-266; threads plan O-QA-CAPA, the rule of picture 38, the tabs of picture 39): the band in the shell's band row (‹ Corrective
 * actions, "<number> <title>", ONE pill — its stage —, its type, priority, customer, owner and due day, the freshness; ONE primary —
 * the next stage, or Close… at the last one, held with what is missing —; ⋯ Move to a stage…, 8D report (a new tab), Keep a version
 * of the report, Copy number, Cancel…, then the frame's Keyboard line), the Thread button (⌘J) and the CAPA's ONE thread docked beside
 * every tab — the customer an 8D is written for is its only party, an internal CAPA notes only —, Activity's tools in its "⋯" (R-ACT).
 * Tabs 4 → 3: Problem (D1 team, D2 problem, D3 containment from the NCRs, the causes the NCRs name, the sources), Actions (D5–D7 with
 * their reminders and escalation, the docked drawer; its keys in the list's footer), Report (the 8D in a language, the versions kept,
 * Share with the customer — held, in words, on another customer's complaint: B-TH-232). Every banner in the ONE notice. The W3 tabs
 * (Root cause, Effectiveness) are not drawn.
 */
// B-TH-266: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function CapaRecordView({ model, actions, thread, printThread }: { model: CapaRecordModel; actions?: CapaRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <CapaMessages>
      <Body model={model} actions={actions} thread={thread} printThread={printThread} />
    </CapaMessages>
  )
}

function Body({ model, actions, thread, printThread }: { model: CapaRecordModel; actions?: CapaRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const { t, say } = useCapaWords()
  const locale = useLocale()
  const listHref = `${model.prefix}/quality/capa`
  const back = (
    <Link className="fw-q-link" href={listHref}>
      {t('band.back')}
    </Link>
  )
  const record = model.loaded.status === 'ready' ? model.loaded.record : null

  // a: Add action (design kb "a — Add action (record, Actions tab)") — never while typing or in a dialog. B-TH-266: the page's keys
  // are in the Actions list's footer and the frame's Keyboard line (PR-14: no "?" overlay).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog || model.close) return
      if (event.key === 'a' && model.tab === 'actions' && record && !addActionHeld(record.capa, record.actions, model.can)) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'addAction', draft: emptyActionDraft(model.today, model.me), busy: false, notice: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.close, model.tab, model.can, model.today, model.me, record, actions])

  // Loading, not found, failed, no right: inside the frame (the band stays), no thread.
  if (!model.can.view || model.loaded.status !== 'ready') {
    const loaded = model.loaded
    return (
      <RecordFrame
        recordType="Capa"
        personId={model.personId ?? null}
        band={{ back, title: loaded.status === 'loading' && model.can.view ? <Skeleton width={260} height={22} /> : t('band.title'), moreLabel: t('band.more') }}
        thread={null}
        threadLabel={t('band.dockLabel')}
      >
        {!model.can.view || loaded.status === 'forbidden' ? (
          <RecordProblem problem="problem.forbidden" back={back} />
        ) : loaded.status === 'loading' ? (
          <RecordSkeleton />
        ) : loaded.status === 'notFound' ? (
          <RecordProblem problem="problem.notFound" back={back} />
        ) : (
          <RecordProblem problem={loaded.status === 'error' ? loaded.problem : 'problem.unavailable'} back={back} onRetry={() => actions?.onRetry?.()} />
        )}
      </RecordFrame>
    )
  }
  const capa = record!.capa
  const offline = model.live === 'offline'
  const held = say(editHeld(capa, model.can)) ?? (offline ? t('held.offline') : null)
  const primary = primaryOf(capa)
  const closeHeld = say(editHeld(capa, model.can))
  let primaryButton: ReactNode = null
  if (primary?.kind === 'move')
    primaryButton = (
      <Button size="sm" variant="primary" heldReason={model.busy ? t('common.working') : held} onClick={() => actions?.onMove?.(primary.to)}>
        {model.busy ? <Spinner size={12} /> : <ArrowRight size={14} aria-hidden />} {t('band.moveTo', { stage: t(`stage.${primary.to}`) })}
      </Button>
    )
  else if (primary?.kind === 'close')
    primaryButton = (
      <Button size="sm" variant="primary" heldReason={closeHeld ?? (offline ? t('held.offline') : null)} onClick={() => actions?.onClose?.()}>
        <Lock size={14} aria-hidden /> {t('band.close')}
      </Button>
    )

  const keepHeld = say(keepReportHeld(record!, model.can, offline)) ?? (model.report.keeping ? t('common.working') : null)
  const menu: MenuItemDef[] = [
    ...(capa.status !== 'CLOSED' && capa.status !== 'CANCELLED' ? [{ id: 'stage', label: t('band.stage'), disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'stage', to: '', busy: false, notice: null }) }] : []),
    { id: 'report', label: t('band.report'), description: t('band.reportHint'), href: reportHref(model.prefix, capa.id, model.report.language), target: '_blank' },
    { id: 'keep', label: t('band.keep'), disabled: !!keepHeld, description: keepHeld ?? undefined, onSelect: () => actions?.onKeep?.() },
    { id: 'copy', label: model.copied ? t('common.copied', { number: capa.number }) : t('common.copyNumber'), onSelect: () => actions?.onCopy?.() },
    ...(capa.status !== 'CLOSED' && capa.status !== 'CANCELLED' ? [{ id: 'cancel', label: t('band.cancel'), tone: 'danger' as const, disabled: !!held, description: held ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'cancelCapa', reason: '', busy: false, notice: null }) }] : []),
  ]

  const meta = (
    <span className="fw-capa-row">
      <TypeTag type={capa.type} />
      <PriorityTag priority={capa.priority} />
      <span>{capa.customer ? t('band.for', { customer: capa.customer.name }) : t('band.internal')}</span>
      <span>{t('band.owner', { name: personWords([...record!.people, ...(model.people ?? [])], capa.ownerId, model.me, t) })}</span>
      <span>{t('band.due', { date: formatDate(capa.dueOn, { locale }) })}</span>
      <Freshness asOf={model.asOf} live={model.live} />
    </span>
  )
  // B-TH-266: ONE pill in the band — the stage; the freshness travels with the identity.
  const status = <StagePill stage={capa.status} />
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: recordHref(model.prefix, capa.id, tab),
    label: t(`tab.${tab}`),
    count: tab === 'actions' ? record!.actions.filter((action) => action.status !== 'CANCELLED').length : tab === 'report' ? record!.documents.length : null,
  }))

  // The docked action drawer covers the right edge. B-TH-266: where the thread is docked the drawer lies over the thread's column (the
  // body keeps its width; Esc gives the thread back); without a thread the body keeps its width free beside it on a wide screen.
  return (
    <div className={model.drawer && !thread ? 'fw-capa-docked' : undefined}>
      <RecordFrame
        recordType="Capa"
        personId={model.personId ?? null}
        threadLabel={t('band.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back,
          title: `${capa.number} ${capa.title}`,
          status,
          meta,
          primary: primaryButton ?? undefined,
          more: menu,
          moreLabel: t('band.more'),
        }}
      >
        <Tabs ariaLabel={t('band.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
        {/* B-TH-266: the ONE notice of the body column — most serious first, the rest behind "N more". */}
        <RecordNotices>
          {model.notice && <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />}
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
          {offline && <Banner tone="warning" title={t('record.offline')} />}
          {capa.status === 'CLOSED' && <Banner tone="success" title={t('record.closedBanner', { date: capa.closedAt ? formatDate(capa.closedAt, { locale }) : '—', name: personWords(record!.people, capa.closedById, model.me, t) })}>{capa.closeNote}</Banner>}
          {capa.status === 'CANCELLED' && <Banner tone="info" title={t('record.cancelledBanner', { reason: capa.cancelReason ?? '—' })} />}
        </RecordNotices>
        {model.tab === 'problem' && <ProblemTab model={model} record={record!} actions={actions} />}
        {model.tab === 'actions' && <ActionsTab model={model} record={record!} actions={actions} />}
        {model.tab === 'report' && <ReportTab model={model} record={record!} actions={actions} />}
      </RecordFrame>
      <RecordDialogs model={model} record={record!} actions={actions} />
      {model.close && <CloseCapaDialog model={model.close} actions={actions?.close} />}
    </div>
  )
}
