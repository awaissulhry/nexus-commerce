'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCheck, ClipboardList, FileX, Play, Send, ShieldCheck, ShieldOff, Stamp } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { rightRef } from '../../../../../lib/i18n/rights'
import { heldPhrase, isWideTab, nextStep, RECORD_TABS, type RecordTab } from '../../model'
import { CountsMessages, KindTag, say, scopeText, StatusPill, useWords } from '../../parts'
import type { CountRecordActions, CountRecordModel } from '../../view-model'
// ---- B-TH-264: the count on RecordFrame (the band in the shell's row, the docked thread — notes only —, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'
import { ApprovalTab } from './ApprovalTab'
import { DifferencesTab } from './DifferencesTab'
import { LinesTab } from './LinesTab'
// B-W2b-320: the count freezes its lines' moves (SCM-226).
import { FreezeTag } from '../../depth/view/CountDepthParts'
import { RecordDialogs } from './RecordDialogs'

export type { CountRecordActions, CountRecordModel } from '../../view-model'

/**
 * SCR-132 — a count (design warehouse.counts "Record: Count", opens as a record page), on RecordFrame (B-TH-264; the rule of picture
 * 38): the band in the shell's band row (‹ Counts, "Count <number> · scope", ONE state pill, its kind, the site, the inventory date or
 * the snapshot, the team; ONE primary step — Start counting, Submit, Approve, Apply N differences or Sign off — held with its reason
 * in words; Count sheets with or without the expected quantities; ⋯ edit, valued list, cancel, its Keyboard line), the docked thread
 * beside every tab (notes only: a count has no party; Activity's tools in its "⋯", R-ACT) and the tabs 4 → 3: Lines (the expected
 * snapshot against what was counted, typed fast: Enter down, autosave per cell, 0 for not found, ⌘Z takes the last count back),
 * Differences (what differs, by how much, its value with the cost grain, the reason, recounts) and Approval (the steps, the
 * decision, the apply, the year-end sign-off and its frozen valued list). ONE notice in the body column. No person's name outside
 * this one record.
 */
// B-TH-264: `thread` is the docked thread (the office's OfficeRecordThread docked, or a design case's); `printThread` what the print
// view shows of it.
export function CountRecordView({ model, actions, thread, printThread }: { model: CountRecordModel; actions?: CountRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <CountsMessages>
      <CountRecordBody model={model} actions={actions} thread={thread} printThread={printThread} />
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

function CountRecordBody({ model, actions, thread, printThread }: { model: CountRecordModel; actions?: CountRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
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
  let primary: ReactNode = null
  let more: MenuItemDef[] = []
  let status: ReactNode = null
  let meta: ReactNode = null
  if (value) {
    const step = nextStep(value)
    const differing = value.summary.differing
    const stepHeld = step ? say(t, heldPhrase(value, step, model.can, value.inventoryDate ? formatDate(value.inventoryDate, place) : null)) : null
    const busyHeld = model.busy ? t('held.busy') : null
    const stepButton =
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
    // The band's primary: the step, and Count sheets beside it (a paper the counters take to the shelves).
    primary = (
      <span className="fw-cn-actions">
        {stepButton}
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
      </span>
    )
    more = [
      ...(editHeld === null ? [{ id: 'edit', label: t('record.edit'), onSelect: () => actions?.onDialog?.({ kind: 'edit', team: value.countTeam ?? '', note: value.note ?? '' }) }] : []),
      ...(value.status === 'COUNTING' && value.actions.record.allowed ? [{ id: 'found', label: t('found.open'), onSelect: () => actions?.onOpenFound?.() }] : []),
      ...(value.status === 'SUBMITTED' && value.actions.sendBack.allowed ? [{ id: 'sendBack', label: t('record.sendBack'), onSelect: () => actions?.onDialog?.({ kind: 'sendBack', reason: '', recount: value.summary.recountSuggested > 0 }) }] : []),
      ...(valuedOpen
        ? [
            { id: 'valuedPdf', label: t('valued.previewPdf'), onSelect: () => actions?.onValuedPreview?.('pdf') },
            { id: 'valuedXlsx', label: t('valued.previewXlsx'), onSelect: () => actions?.onValuedPreview?.('xlsx') },
          ]
        : []),
      ...(value.kind === 'YEAR_END' && value.status === 'APPLIED' ? [{ id: 'signOff', label: t('step.signOff'), onSelect: () => actions?.onDialog?.({ kind: 'signOff', phrase: '', language: locale === 'en' ? 'en' : 'it' }) }] : []),
      ...(value.valuedList && model.can.files
        ? [
            { id: 'frozenPdf', label: t('valued.frozenPdf'), onSelect: () => actions?.onValuedFile?.(value.valuedList!.pdfFileId) },
            ...(value.valuedList.sheetFileId ? [{ id: 'frozenXlsx', label: t('valued.frozenXlsx'), onSelect: () => actions?.onValuedFile?.(value.valuedList!.sheetFileId!) }] : []),
          ]
        : []),
      { id: 'copy', label: t('record.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(value.number).catch(() => undefined) },
      ...(cancelHeld === null ? [{ id: 'cancel', label: t('record.cancel'), tone: 'danger' as const, onSelect: () => actions?.onDialog?.({ kind: 'cancel', reason: '' }) }] : []),
    ]
    title = (
      <span className="fw-cn-title">
        {t('record.title', { number: value.number })} <span className="fw-cn-title-sub">· {scopeText(t, value.scope)}</span>
      </span>
    )
    status = <StatusPill status={value.status} />
    meta = (
      <>
        <KindTag kind={value.kind} />
        <Tag tone="neutral">{value.site.code}</Tag>
        {value.freezeMoves && <FreezeTag />}
        {value.inventoryDate && <span className="fw-cn-hint">{t('record.asOf', { date: formatDate(value.inventoryDate, place) })}</span>}
        {value.snapshotAt && <span className="fw-cn-hint">{t('record.snapshot', { time: formatDateTime(value.snapshotAt, place) })}</span>}
        {value.countTeam && <span className="fw-cn-hint">{t('list.team', { team: value.countTeam })}</span>}
      </>
    )
  }

  const back = <Link href={listHref}>{t('record.back')}</Link>
  const frame = {
    recordType: 'StockCount',
    personId: model.personId ?? null,
    threadLabel: t('record.dockLabel'),
  }

  // Loading, not found, no right, a failed read: the band and its state, no thread yet.
  if (model.record.status !== 'ready' || !value) {
    const loaded = model.record
    return (
      <RecordFrame {...frame} thread={null} band={{ back, title: loaded.status === 'loading' ? <Skeleton width={260} height={22} /> : t('record.name'), moreLabel: t('record.more') }}>
        {loaded.status === 'loading' ? (
          <Card padded aria-busy="true">
            <p className="fw-cn-hint" role="status">
              <Spinner size={14} /> {t('record.loading')}
            </p>
            <div className="fw-cn-stack tight">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} height={22} />
              ))}
            </div>
          </Card>
        ) : (
          <Card padded>
            <EmptyState
              icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
              title={t(loaded.status === 'error' ? 'record.failed' : loaded.status === 'forbidden' ? 'stock:problem.forbidden' : 'record.notFound')}
              description={
                loaded.status === 'error'
                  ? t(`stock:${loaded.problem}`)
                  : loaded.status === 'forbidden'
                    ? t('stock:problem.noPermission', { right: rightRef('inventory.counts.view') })
                    : t('record.notFoundBody')
              }
              action={
                loaded.status === 'error' ? (
                  <Button size="sm" onClick={actions?.onRetry}>
                    {t('stock:problem.retry')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={listHref}>{t('record.backToList')}</Link>
                  </Button>
                )
              }
            />
          </Card>
        )}
      </RecordFrame>
    )
  }

  return (
    <RecordFrame {...frame} thread={thread ?? null} printThread={printThread} wide={isWideTab(model.tab)} band={{ back, title, status, meta, primary, more, moreLabel: t('record.more') }}>
      <div className="fw-cn">
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

        {/* B-TH-264: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
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
          {value.status === 'CANCELLED' && (
            <Banner tone="info" title={t('record.cancelledBanner', { date: value.cancelledAt ? formatDate(value.cancelledAt, place) : '—' })}>
              {value.cancelReason ?? undefined}
            </Banner>
          )}
          {value.status === 'COUNTING' && value.rejectedAt && (
            <Banner tone="warning" title={t('record.sentBackBanner', { name: value.people.rejectedBy ?? t('record.someone'), date: formatDate(value.rejectedAt, place) })}>
              {value.rejectReason ?? undefined}
            </Banner>
          )}
          {value.summary.movedSinceSnapshot > 0 && (
            <Banner tone="warning" title={t('record.moved', { count: value.summary.movedSinceSnapshot })}>
              {t('record.movedBody')}
            </Banner>
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
          {/* The shell's band says the tab's live state; offline, the page says since when its figures are. */}
          {model.live === 'offline' && <Banner tone="warning" title={model.asOf ? `${t('stock:live.offline')} · ${t('stock:live.updated', { time: formatTime(model.asOf, place) })}` : t('stock:live.offline')} />}
          {value.status === 'DRAFT' && (
            <Banner tone="info" title={t('record.draftBanner')}>
              {value.kind === 'YEAR_END' && value.inventoryDate ? t('record.draftYearEnd', { date: formatDate(value.inventoryDate, place) }) : t('record.draftCycle')}
            </Banner>
          )}
        </RecordNotices>

        {model.tab === 'lines' && <LinesTab value={value} model={model} actions={actions} />}
        {model.tab === 'differences' && <DifferencesTab value={value} model={model} actions={actions} />}
        {model.tab === 'approval' && <ApprovalTab value={value} model={model} actions={actions} />}
        {model.dialog && <RecordDialogs value={value} model={model} actions={actions} />}
      </div>
    </RecordFrame>
  )
}
