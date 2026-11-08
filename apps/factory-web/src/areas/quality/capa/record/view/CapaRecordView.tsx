'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight, Lock, MoreHorizontal } from 'lucide-react'
import { Banner, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { RecordPanelsView, type RecordPanelsViewModel } from '../../../../../record-panels/view/RecordPanelsView'
import type { ListKey } from '../../../../../list-frame/model'
import { isPageKey } from '../../../_shared/hooks'
import { Freshness, RecordFrame, RecordProblem, RecordSkeleton } from '../../../_shared/parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { addActionHeld, editHeld, emptyActionDraft, keepReportHeld, primaryOf, recordHref, reportHref, RECORD_TABS } from '../../model'
import { CapaMessages, KeysDialog, NoticeLine, personWords, PriorityTag, StagePill, TypeTag, useCapaWords } from '../../parts'
import { CloseCapaDialog } from '../../view/CloseCapaDialog'
import type { CapaRecordActions, CapaRecordModel } from '../view-model'
import { ActionsTab } from './ActionsTab'
import { ProblemTab } from './ProblemTab'
import { RecordDialogs } from './RecordDialogs'
import { ReportTab } from './ReportTab'

export type { CapaRecordActions, CapaRecordModel } from '../view-model'

/**
 * SCR-146-record — a CAPA or an 8D (design quality.capa "Record: CAPA", a record page; `?tab=problem|actions|report|activity`):
 * the band (‹ Corrective actions, "<number> <title>", its type, priority, customer, owner and due day, its stage and the
 * freshness; ONE primary — the next stage, or Close… at the last one, held with what is missing — and ⋯: Move to a stage…,
 * 8D report (a new tab), Keep a version of the report, Copy number, Cancel…, Keyboard shortcuts) and its tabs: Problem
 * (D1 team, D2 problem, D3 containment from the NCRs, the causes the NCRs name, the sources), Actions (D5–D7 with their
 * reminders and escalation, the docked drawer), Report (the 8D in a language, the versions kept, Share with the customer),
 * Activity (the record panels: thread, files, history, tasks). The W3 tabs (Root cause, Effectiveness) are not drawn.
 */
export function CapaRecordView({ model, actions, panels, panelsPreview }: { model: CapaRecordModel; actions?: CapaRecordActions; panels?: ReactNode; panelsPreview?: RecordPanelsViewModel }) {
  return (
    <CapaMessages>
      <Body model={model} actions={actions} panels={panels} panelsPreview={panelsPreview} />
    </CapaMessages>
  )
}

function Body({ model, actions, panels, panelsPreview }: { model: CapaRecordModel; actions?: CapaRecordActions; panels?: ReactNode; panelsPreview?: RecordPanelsViewModel }) {
  const { t, say } = useCapaWords()
  const locale = useLocale()
  const listHref = `${model.prefix}/quality/capa`
  const back = (
    <Link className="fw-q-link" href={listHref}>
      {t('band.back')}
    </Link>
  )
  const record = model.loaded.status === 'ready' ? model.loaded.record : null

  // ?: the keys; a: Add action (design kb "a — Add action (record, Actions tab)") — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog || model.close || model.keysOpen) return
      if (event.key === '?') {
        event.preventDefault()
        actions?.onKeys?.(true)
      } else if (event.key === 'a' && model.tab === 'actions' && record && !addActionHeld(record.capa, record.actions, model.can)) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'addAction', draft: emptyActionDraft(model.today, model.me), busy: false, notice: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, model.close, model.keysOpen, model.tab, model.can, model.today, model.me, record, actions])

  if (!model.can.view || model.loaded.status === 'forbidden') return <RecordProblem problem="problem.forbidden" back={back} />
  if (model.loaded.status === 'loading') return <RecordSkeleton />
  if (model.loaded.status === 'notFound') return <RecordProblem problem="problem.notFound" back={back} />
  if (model.loaded.status === 'error') return <RecordProblem problem={model.loaded.problem} back={back} onRetry={() => actions?.onRetry?.()} />
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
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.(true) },
  ]

  const meta = (
    <span className="fw-capa-row">
      <TypeTag type={capa.type} />
      <PriorityTag priority={capa.priority} />
      <span>{capa.customer ? t('band.for', { customer: capa.customer.name }) : t('band.internal')}</span>
      <span>{t('band.owner', { name: personWords([...record!.people, ...(model.people ?? [])], capa.ownerId, model.me, t) })}</span>
      <span>{t('band.due', { date: formatDate(capa.dueOn, { locale }) })}</span>
    </span>
  )
  const status = (
    <span className="fw-capa-row">
      <StagePill stage={capa.status} />
      <Freshness asOf={model.asOf} live={model.live} />
    </span>
  )
  const tabs = RECORD_TABS.map((tab) => ({
    id: tab,
    label: t(`tab.${tab}`),
    count: tab === 'actions' ? record!.actions.filter((action) => action.status !== 'CANCELLED').length : tab === 'report' ? record!.documents.length : null,
  }))
  const ownKeys: ListKey[] = [
    { keys: ['a'], does: t('keys.addAction') },
    { keys: ['⌘', 'S'], does: t('keys.save') },
    { keys: ['⌘', '↑'], does: t('keys.previousAction') },
    { keys: ['⌘', '↓'], does: t('keys.nextAction') },
  ]
  const activity = panels ?? (panelsPreview ? <RecordPanelsView model={panelsPreview} /> : null)

  // The docked action drawer covers the right edge: the record keeps its width free beside it on a wide screen.
  return (
    <div className={model.drawer ? 'fw-capa-docked' : undefined}>
      <RecordFrame
        back={{ href: listHref, label: t('band.back') }}
        title={`${capa.number} ${capa.title}`}
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
        tabHref={(tab) => recordHref(model.prefix, capa.id, tab as (typeof RECORD_TABS)[number])}
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
        {capa.status === 'CLOSED' && <Banner tone="success" title={t('record.closedBanner', { date: capa.closedAt ? formatDate(capa.closedAt, { locale }) : '—', name: personWords(record!.people, capa.closedById, model.me, t) })}>{capa.closeNote}</Banner>}
        {capa.status === 'CANCELLED' && <Banner tone="info" title={t('record.cancelledBanner', { reason: capa.cancelReason ?? '—' })} />}
        <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {model.tab === 'problem' && <ProblemTab model={model} record={record!} actions={actions} />}
        {model.tab === 'actions' && <ActionsTab model={model} record={record!} actions={actions} />}
        {model.tab === 'report' && <ReportTab model={model} record={record!} actions={actions} />}
        {model.tab === 'activity' && (activity ?? <p className="fw-q-hint">{t('activity.none')}</p>)}
      </RecordFrame>
      <RecordDialogs model={model} record={record!} actions={actions} />
      {model.close && <CloseCapaDialog model={model.close} actions={actions?.close} />}
      {model.keysOpen && <KeysDialog own={ownKeys} withSelection={false} onClose={() => actions?.onKeys?.(false)} />}
    </div>
  )
}
