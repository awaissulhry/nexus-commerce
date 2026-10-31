'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCheck, Lock, MoreHorizontal, ShieldCheck } from 'lucide-react'
import { Banner, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { RecordPanelsView, type RecordPanelsViewModel } from '../../../../../record-panels/view/RecordPanelsView'
import { isPageKey } from '../../../_shared/hooks'
import { Freshness, RecordFrame, RecordProblem, RecordSkeleton } from '../../../_shared/parts'
import type { ListKey } from '../../../../../list-frame/model'
import { bandHeld, isOpenStage, RECORD_TABS, type Say } from '../../model'
import { KeysDialog, NcrStepUp, SeverityTag, StagePill } from '../../parts'
import { CloseNcrDialog } from '../../view/CloseNcrDialog'
import { recordHref, tabHref, type NcrRecordActions, type NcrRecordModel } from '../view-model'
import { ContainmentTab } from './ContainmentTab'
import { DispositionTab } from './DispositionTab'
import { LinkedTab } from './LinkedTab'
import { ProblemTab } from './ProblemTab'
import { RecordDialogs } from './RecordDialogs'
import { NcrRecordMessages, RecordNotice, useRecordWords } from './words'
import '../record.css'

export type { NcrRecordActions, NcrRecordModel } from '../view-model'

/**
 * SCR-145 — the NCR record (design quality.ncr "Record: NCR", a record page; `?tab=problem|containment|disposition|
 * linked|activity`): the band (‹ Nonconformances, "<number> <title>", severity, where it came from, its stage, the
 * freshness; ONE primary next step — Mark contained, Mark decided, Close NCR… — held with what is still missing, and ⋯:
 * Copy number, Cancel NCR…, Open the PPE register entry, Keyboard shortcuts) and its sections as link tabs with counts:
 * Problem & evidence, Containment, Disposition, Linked records, Activity (the record panels: thread, files, history).
 * Closing is the closing checklist and an e-signature (the office's fresh code).
 */
export function NcrRecordView({ model, actions, panels, panelsPreview }: { model: NcrRecordModel; actions?: NcrRecordActions; panels?: ReactNode; panelsPreview?: RecordPanelsViewModel }) {
  return (
    <NcrRecordMessages>
      <Body model={model} actions={actions} panels={panels} panelsPreview={panelsPreview} />
    </NcrRecordMessages>
  )
}

function Body({ model, actions, panels, panelsPreview }: { model: NcrRecordModel; actions?: NcrRecordActions; panels?: ReactNode; panelsPreview?: RecordPanelsViewModel }) {
  const words = useRecordWords(model.people, model.timeZone)
  const { t, r, say } = words
  const listHref = `${model.prefix}/quality/ncr`
  const back = (
    <Link className="fw-q-link" href={listHref}>
      {r('band.back')}
    </Link>
  )
  const ready = model.loaded.status === 'ready' ? model.loaded.record : null

  // `?` opens the keys (never while typing or in a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '?' && isPageKey(event) && !model.dialog) {
        event.preventDefault()
        actions?.onKeys?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.dialog, actions])

  if (!model.can.view || model.loaded.status === 'forbidden') return <RecordProblem problem="problem.forbidden" back={back} />
  if (model.loaded.status === 'loading') return <RecordSkeleton />
  if (model.loaded.status === 'notFound') return <RecordProblem problem="problem.notFound" back={back} />
  if (model.loaded.status === 'error') return <RecordProblem problem={model.loaded.problem} back={back} onRetry={() => actions?.onRetry?.()} />
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
  const menu: MenuItemDef[] = [
    { id: 'copy', label: model.copied ? t('common.copied', { number: ncr.number }) : t('common.copyNumber'), onSelect: () => actions?.onCopy?.() },
    ...(ncr.stage === 'OPEN' || ncr.stage === 'CONTAINED' ? [{ id: 'close', label: r('band.closeEarly'), disabled: !!closeHeld, description: closeHeld ?? undefined, onSelect: () => actions?.onClose?.() }] : []),
    ...(ncr.style?.ppe && !record.register ? [{ id: 'register', label: r('band.register'), disabled: !!registerHeld, description: registerHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'register', description: '', busy: false, notice: null }) }] : []),
    ...(isOpenStage(ncr.stage) ? [{ id: 'cancel', label: r('band.cancel'), tone: 'danger' as const, disabled: !!cancelHeld, description: cancelHeld ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'cancelNcr', reason: '', busy: false, notice: null }) }] : []),
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.(true) },
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
      {source}
      {model.site && <span className="fw-q-code">{model.site.code}</span>}
      {ncr.style?.ppe && <Tag tone="info">{r('band.ppe')}</Tag>}
    </span>
  )
  const status = (
    <span className="fw-ncr-r-row">
      <StagePill stage={ncr.stage} />
      <Freshness asOf={model.asOf} live={model.live} />
    </span>
  )
  const actionsNode = (
    <>
      {primary}
      <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': r('band.more') }} items={menu} />
    </>
  )

  const linkedCount = record.links.length + record.holds.length
  const tabs = RECORD_TABS.map((tab) => ({
    id: tab,
    label: r(`tab.${tab}`),
    count: tab === 'containment' ? record.containment.length : tab === 'disposition' ? record.decisions.length : tab === 'linked' ? linkedCount : null,
  }))
  const ownKeys: ListKey[] = [{ keys: ['⌘', 'S'], does: r('keys.save') }]
  const activity = panels ?? (panelsPreview ? <RecordPanelsView model={panelsPreview} /> : null)

  return (
    <>
      <RecordFrame back={{ href: listHref, label: r('band.back') }} title={`${ncr.number} ${ncr.title}`} meta={meta} status={status} actions={actionsNode} tabs={tabs} active={model.tab} tabHref={(tab) => tabHref(model.prefix, ncr.id, tab as (typeof RECORD_TABS)[number])}>
        {model.live === 'offline' && <Banner tone="warning" title={r('offline')} />}
        {model.stale && !model.dialog && <Banner tone="warning" title={r('stale.title', { time: model.stale })} action={<Button size="sm" variant="quiet" onClick={() => actions?.onReload?.()}>{r('stale.reload')}</Button>} />}
        {ncr.stage === 'CLOSED' && <Banner tone="success" title={r('band.closedBanner', { when: words.when(ncr.closedAt), who: words.person(ncr.closedById) })} />}
        {ncr.stage === 'CANCELLED' && <Banner tone="info" title={r('band.cancelledBanner', { reason: ncr.cancelReason ?? '—' })} />}
        <RecordNotice notice={model.notice} words={words} onDismiss={actions?.onDismissNotice} />
        {model.tab === 'problem' && <ProblemTab model={model} record={record} words={words} actions={actions} />}
        {model.tab === 'containment' && <ContainmentTab model={model} record={record} words={words} actions={actions} />}
        {model.tab === 'disposition' && <DispositionTab model={model} record={record} words={words} actions={actions} />}
        {model.tab === 'linked' && <LinkedTab model={model} record={record} words={words} actions={actions} />}
        {model.tab === 'activity' && (activity ?? <p className="fw-q-hint">{r('activity.none')}</p>)}
      </RecordFrame>
      <RecordDialogs model={model} record={record} words={words} actions={actions} />
      {model.close && <CloseNcrDialog model={model.close} actions={actions?.close} />}
      <NcrStepUp state={model.stepUp} onSubmit={(code) => actions?.onStepUp?.(code)} onCancel={() => actions?.onStepUpCancel?.()} />
      {model.keysOpen && <KeysDialog own={ownKeys} withSelection={false} onClose={() => actions?.onKeys?.(false)} />}
    </>
  )
}
