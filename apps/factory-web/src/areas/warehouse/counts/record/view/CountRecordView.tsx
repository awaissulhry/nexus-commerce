'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { CheckCheck, ClipboardList, MoreHorizontal, Play, Send, ShieldCheck, Stamp } from 'lucide-react'
import { Banner, Menu, type TabItem } from '@nexus/ui/components'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { heldPhrase, nextStep, RECORD_TABS, type RecordTab } from '../../model'
import { CountsMessages, KindTag, RecordFrame, say, scopeText, StatusPill, useWords } from '../../parts'
import type { CountRecordActions, CountRecordModel } from '../../view-model'
import { ApprovalTab } from './ApprovalTab'
import { DifferencesTab } from './DifferencesTab'
import { LinesTab } from './LinesTab'
import { RecordDialogs } from './RecordDialogs'

export type { CountRecordActions, CountRecordModel } from '../../view-model'

/**
 * SCR-132 — a count (design warehouse.counts "Record: Count", opens as a record page): the band (‹ Counts, "Count
 * <number> · scope", its state and kind, the site, the inventory date or the snapshot, the team; ONE primary step — Start
 * counting, Submit, Approve, Apply N differences or Sign off — held with its reason in words; Count sheets with or without
 * the expected quantities; ⋯ edit, valued list, cancel) and the tabs: Lines (the expected snapshot against what was
 * counted, typed fast: Enter down, autosave per cell, 0 for not found, ⌘Z takes the last count back), Differences (what
 * differs, by how much, its value with the cost grain, the reason, recounts) and Approval (the steps, the decision, the
 * apply, the year-end sign-off and its frozen valued list). No person's name outside this one record.
 */
export function CountRecordView({ model, actions }: { model: CountRecordModel; actions?: CountRecordActions }) {
  return (
    <CountsMessages>
      <CountRecordBody model={model} actions={actions} />
    </CountsMessages>
  )
}

const STEP_ICON: Record<string, ReactNode> = {
  start: <Play size={14} aria-hidden />,
  submit: <Send size={14} aria-hidden />,
  approve: <ShieldCheck size={14} aria-hidden />,
  apply: <CheckCheck size={14} aria-hidden />,
  signOff: <Stamp size={14} aria-hidden />,
}

function CountRecordBody({ model, actions }: { model: CountRecordModel; actions?: CountRecordActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const listHref = `${model.prefix}/warehouse/counts`
  const value = model.record.status === 'ready' ? model.record.value : null
  const base = value ? `${listHref}/${encodeURIComponent(value.id)}` : listHref
  const latest = useRef(actions)
  latest.current = actions

  // ⌘Z / Ctrl+Z: the last typed count taken back (not while a field holds an edit of its own: the field undoes that).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== 'z' || !model.undo) return
      const target = event.target as HTMLElement | null
      if (target?.closest('[role="dialog"]')) return
      if (target && (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.dataset.countCell !== 'true'))) return
      if (target?.dataset.countCell === 'true' && target.dataset.dirty === 'true') return
      event.preventDefault()
      latest.current?.onUndo?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.undo])

  const tabs: TabItem[] = RECORD_TABS.map((tab: RecordTab) => ({
    id: tab,
    href: tab === 'lines' ? base : `${base}?tab=${tab}`,
    label: t(`tab.${tab}`),
    count: !value || value.status === 'DRAFT' ? null : tab === 'lines' ? value.summary.lines : tab === 'differences' ? value.summary.differing : null,
  }))

  let title: ReactNode = null
  let bandActions: ReactNode = null
  let meta: ReactNode = null
  if (value) {
    const step = nextStep(value)
    const differing = value.summary.differing
    const stepHeld = step ? say(t, heldPhrase(value, step, model.can, value.inventoryDate ? formatDate(value.inventoryDate, place) : null)) : null
    const busyHeld = model.busy ? t('held.busy') : null
    const primary =
      step === null ? null : (
        <Button
          size="sm"
          variant="primary"
          heldReason={stepHeld ?? busyHeld}
          onClick={() => {
            if (step === 'start') actions?.onStart?.()
            else if (step === 'submit') actions?.onSubmit?.()
            else if (step === 'approve') actions?.onDialog?.({ kind: 'approve', note: '' })
            else if (step === 'apply') actions?.onDialog?.({ kind: 'apply' })
            else actions?.onDialog?.({ kind: 'signOff', phrase: '', language: locale === 'en' ? 'en' : 'it' })
          }}
        >
          {model.busy && !model.dialog ? <Spinner size={12} /> : STEP_ICON[step]} {step === 'apply' ? t('step.apply', { count: differing }) : t(`step.${step}`)}
        </Button>
      )
    const papers = value.status !== 'DRAFT' && value.status !== 'CANCELLED'
    const editHeld = say(t, heldPhrase(value, 'edit', model.can))
    const cancelHeld = say(t, heldPhrase(value, 'cancel', model.can))
    const valuedOpen = value.kind === 'YEAR_END' && ['SUBMITTED', 'APPROVED', 'APPLIED'].includes(value.status) && model.can.cost
    bandActions = (
      <span className="fw-cn-actions">
        {primary}
        {papers && (
          <Menu
            label={
              <>
                <ClipboardList size={14} aria-hidden /> {t('sheets.menu')}
              </>
            }
            align="right"
            triggerProps={{ 'aria-label': t('sheets.menu') }}
            items={[
              { id: 'with', label: t('sheets.withExpected'), onSelect: () => actions?.onSheets?.(true) },
              { id: 'blind', label: t('sheets.blind'), onSelect: () => actions?.onSheets?.(false) },
            ]}
          />
        )}
        <Menu
          label={<MoreHorizontal size={16} aria-label={t('record.more')} />}
          align="right"
          triggerProps={{ 'aria-label': t('record.more') }}
          items={[
            ...(editHeld === null ? [{ id: 'edit', label: t('record.edit'), onSelect: () => actions?.onDialog?.({ kind: 'edit', team: value.countTeam ?? '', note: value.note ?? '' }) }] : []),
            ...(value.status === 'COUNTING' && value.actions.record.allowed ? [{ id: 'found', label: t('found.open'), onSelect: () => actions?.onOpenFound?.() }] : []),
            ...(value.status === 'SUBMITTED' && value.actions.sendBack.allowed ? [{ id: 'sendBack', label: t('record.sendBack'), onSelect: () => actions?.onDialog?.({ kind: 'sendBack', reason: '', recount: value.summary.recountSuggested > 0 }) }] : []),
            ...(valuedOpen
              ? [
                  { id: 'valuedPdf', label: t('valued.previewPdf'), onSelect: () => actions?.onValuedPreview?.('pdf') },
                  { id: 'valuedXlsx', label: t('valued.previewXlsx'), onSelect: () => actions?.onValuedPreview?.('xlsx') },
                ]
              : []),
            ...(value.kind === 'YEAR_END' && value.status === 'APPLIED'
              ? [{ id: 'signOff', label: t('step.signOff'), onSelect: () => actions?.onDialog?.({ kind: 'signOff', phrase: '', language: locale === 'en' ? 'en' : 'it' }) }]
              : []),
            ...(value.valuedList && model.can.files
              ? [
                  { id: 'frozenPdf', label: t('valued.frozenPdf'), onSelect: () => actions?.onValuedFile?.(value.valuedList!.pdfFileId) },
                  ...(value.valuedList.sheetFileId ? [{ id: 'frozenXlsx', label: t('valued.frozenXlsx'), onSelect: () => actions?.onValuedFile?.(value.valuedList!.sheetFileId!) }] : []),
                ]
              : []),
            { id: 'copy', label: t('record.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(value.number).catch(() => undefined) },
            ...(cancelHeld === null ? [{ id: 'cancel', label: t('record.cancel'), onSelect: () => actions?.onDialog?.({ kind: 'cancel', reason: '' }) }] : []),
          ]}
        />
      </span>
    )
    title = (
      <span className="fw-cn-title">
        {t('record.title', { number: value.number })} <span className="fw-cn-title-sub">· {scopeText(t, value.scope)}</span>
      </span>
    )
    meta = (
      <>
        <StatusPill status={value.status} />
        <KindTag kind={value.kind} />
        <Tag tone="neutral">{value.site.code}</Tag>
        {value.inventoryDate && <span className="fw-cn-hint">{t('record.asOf', { date: formatDate(value.inventoryDate, place) })}</span>}
        {value.snapshotAt && <span className="fw-cn-hint">{t('record.snapshot', { time: formatDateTime(value.snapshotAt, place) })}</span>}
        {value.countTeam && <span className="fw-cn-hint">{t('list.team', { team: value.countTeam })}</span>}
      </>
    )
  }

  return (
    <RecordFrame
      backHref={listHref}
      loaded={model.record}
      title={title}
      meta={meta}
      actions={bandActions}
      tabs={tabs}
      tab={model.tab}
      onRetry={actions?.onRetry}
      status={
        <>
          {model.asOf ? t('stock:live.updated', { time: formatTime(model.asOf, place) }) : null}
          {model.asOf ? ' · ' : null}
          {t(`stock:live.${model.live}`)}
        </>
      }
    >
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words) ?? ''}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('stock:common.close')}
              </Button>
            ) : undefined
          }
        />
      )}
      {model.changed && (
        <Banner
          tone="info"
          title={t('record.changed', { time: formatTime(model.changed.at, place) })}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('record.reload')}
            </Button>
          }
        />
      )}
      {value?.status === 'CANCELLED' && (
        <Banner tone="info" title={t('record.cancelledBanner', { date: value.cancelledAt ? formatDate(value.cancelledAt, place) : '—' })}>
          {value.cancelReason ?? undefined}
        </Banner>
      )}
      {value?.status === 'COUNTING' && value.rejectedAt && (
        <Banner tone="warning" title={t('record.sentBackBanner', { name: value.people.rejectedBy ?? t('record.someone'), date: formatDate(value.rejectedAt, place) })}>
          {value.rejectReason ?? undefined}
        </Banner>
      )}
      {value && value.summary.movedSinceSnapshot > 0 && (
        <Banner tone="warning" title={t('record.moved', { count: value.summary.movedSinceSnapshot })}>
          {t('record.movedBody')}
        </Banner>
      )}
      {value?.status === 'DRAFT' && (
        <Banner tone="info" title={t('record.draftBanner')}>
          {value.kind === 'YEAR_END' && value.inventoryDate ? t('record.draftYearEnd', { date: formatDate(value.inventoryDate, place) }) : t('record.draftCycle')}
        </Banner>
      )}
      {value && model.tab === 'lines' && <LinesTab value={value} model={model} actions={actions} />}
      {value && model.tab === 'differences' && <DifferencesTab value={value} model={model} actions={actions} />}
      {value && model.tab === 'approval' && <ApprovalTab value={value} model={model} actions={actions} />}
      {value && model.dialog && <RecordDialogs value={value} model={model} actions={actions} />}
    </RecordFrame>
  )
}
