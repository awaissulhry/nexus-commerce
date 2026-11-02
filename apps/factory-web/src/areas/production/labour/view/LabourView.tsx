'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { CheckCheck, MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { Button, Select } from '@nexus/ui/primitives'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { OfficeScope } from '../../../../shell/scope/scope-model'
import type { LiveState } from '../../_shared/hooks'
import type { BlockCounts, DailySheet, FigureAccess, InboxItem, LabourCounts, LabourEdit, LineDay, OffStandardCode, PersonHit, Place } from '../api'
import { decidesOneCorrection, findHeld, itemKey, LABOUR_NAMESPACES, normalHeld, normalTargets, openOf, rowApproveHeld, rowRejectHeld, searchItems, tileKind, TILES, codeWords, type AnswerDraft, type DayTarget, type ItemRecord, type LabourAddress, type LabourCan, type LegalRow, type OpenReason, type Phrase } from '../model'
import { DaysList } from './DaysList'
import { EditsTimeline } from './EditsTimeline'
import { ItemDetail } from './ItemDetail'
import { LabourDialogs } from './LabourDialogs'
import { QueueList } from './QueueList'
import { LegalBand, say, useLabourT } from './parts'
import '../labour.css'

export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'notFound' }

/** What a reject or an answer acts on, kept by the dialog (a row's verb opens it without the record). */
export interface RejectTarget {
  kind: 'CORRECTION' | 'OFF_STANDARD'
  id: string
  version: number | null
  open: string
}

/** The dialogs over the page. A sheet's figures live here alone and go when it closes. */
export type LabourDialog =
  | { kind: 'reject'; target: RejectTarget; reason: string; problem: Phrase | null }
  | { kind: 'answer'; open: string; draft: AnswerDraft; problem: Phrase | null }
  | { kind: 'close'; days: readonly DayTarget[]; note: string; problem: Phrase | null }
  | { kind: 'reopen'; day: DayTarget; reason: string; problem: Phrase | null }
  | { kind: 'find'; query: string; hits: Loaded<readonly PersonHit[]> | null; person: PersonHit | null; workDate: string }
  | { kind: 'sheet'; person: { employeeId: string; name: string | null }; workDate: string; access: Loaded<FigureAccess>; reason: OpenReason | ''; note: string; sheet: DailySheet | null; problem: Phrase | null }
  | { kind: 'keys' }

export interface LabourModel {
  prefix: string
  can: LabourCan
  address: LabourAddress
  scope: OfficeScope
  timeZone: string
  /** The site's today (YYYY-MM-DD). */
  today: string
  /** The band: one row per site in scope; null while it is read. */
  legal: readonly LegalRow[] | null
  counts: LabourCounts | null
  /** Blocks waiting and how many may be approved together. */
  blocks: BlockCounts | null
  rows: { items: readonly InboxItem[] | null; more: boolean; limitReached: boolean; problem: string | null }
  updates: number
  days: { items: readonly LineDay[] | null; from: string | null; to: string | null; problem: string | null }
  edits: { items: readonly LabourEdit[] | null; from: string | null; to: string | null; more: boolean; limitReached: boolean; problem: string | null }
  lines: readonly Place[]
  codes: readonly OffStandardCode[] | null
  asOf: string | null
  live: LiveState
  announcement: string | null
  busy: boolean
  notice: { tone: 'success' | 'danger' | 'info'; words: Phrase; detail?: readonly Phrase[] } | null
  /** The item open in its DetailModal (`?open=`). */
  detail: { key: string; loaded: Loaded<ItemRecord> } | null
  dialog: LabourDialog | null
  /** People › Payroll export is built (its page reads the closed days). */
  payrollHref: string | null
  /** The moment "now" (design cases). */
  now?: number
  selected?: readonly string[]
  focusRow?: number
}

export interface LabourActions {
  onAddress?: (next: Partial<LabourAddress>) => void
  onRetry?: () => void
  onMore?: () => void
  onMoreEdits?: () => void
  onShowUpdates?: () => void
  onApprove?: (item: InboxItem) => void
  onReject?: (item: InboxItem) => void
  /** Approve the record open in its detail. */
  onApproveOpen?: () => void
  onRejectOpen?: () => void
  onApproveNormal?: (items: readonly InboxItem[] | null) => void
  onCloseItems?: (items: readonly InboxItem[]) => void
  onDialog?: (dialog: LabourDialog | null) => void
  onRejectSend?: () => void
  onAnswerSend?: () => void
  onCloseSend?: () => void
  onReopenSend?: () => void
  onOpenDay?: (person: { employeeId: string; name: string | null }, workDate: string) => void
  onFind?: (query: string) => void
  onSheetOpen?: () => void
  onRetryDetail?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-139 Labour review & corrections and SCR-143 Off-standard time, ONE inbox (Production › Floor control; design
 * production.labour): first the legal basis, always visible; then the head (as of, live, the page's line, "Approve N normal
 * blocks" selection-aware, ⋯), the four tiles (each the queue's kind), To decide (the queue), Line days and Changes to labour
 * records. A row opens its DetailModal (`?open=`): A approve, R reject (a reason), then the next item. Nobody edits an old
 * scan: every change is a new row. No list, filter, group or total names a person (Owner answers W1, F2): a name comes
 * only inside one record, from an API that serves it only where the site's legal gate is on.
 */
export function LabourView({ model, actions }: { model: LabourModel; actions?: LabourActions }) {
  return (
    <WithMessages namespaces={LABOUR_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: LabourModel; actions?: LabourActions }) {
  const t = useLabourT()
  const locale = useLocale()
  const lists = useT('lists')
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const all = model.rows.items
  const filtered = useMemo(
    () =>
      all
        ? searchItems(
            all,
            model.address.q,
            (kind) => t(`kind.${kind}`),
            (item) => codeWords(item.code, model.codes, locale),
          )
        : null,
    [all, model.address.q, model.codes, locale, t],
  )
  const shownKey = filtered?.map(itemKey).join('|') ?? ''
  useEffect(() => setSelected((current) => current.filter((key) => shownKey.split('|').includes(key))), [shownKey])

  // A / R on the focused row of the queue (the same verbs as its buttons; never while typing or inside a dialog or menu).
  const latest = useRef({ filtered, model, actions })
  latest.current = { filtered, model, actions }
  const frame = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key !== 'a' && key !== 'r') return
      const target = event.target as HTMLElement | null
      if (!target || target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], [role="listbox"]')) return
      const row = target.closest('[row-id]')
      if (!row || !frame.current?.contains(row)) return
      const now = latest.current
      const item = now.filtered?.find((entry) => itemKey(entry) === row.getAttribute('row-id'))
      if (!item) return
      const held = key === 'a' ? rowApproveHeld(item, now.model.can, now.model.busy) : rowRejectHeld(item, now.model.can, now.model.busy)
      if (held) return
      event.preventDefault()
      if (key === 'a') now.actions?.onApprove?.(item)
      else now.actions?.onReject?.(item)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!model.can.view) {
    // B-W2b-73: the row on Today opens the one correction a person may decide; the rest of the page stays theirs to ask for.
    const words = model.can.correct ? 'page.correctOnly' : 'page.noAccess'
    const one = decidesOneCorrection(model.can, openOf(model.detail?.key))
    return (
      <div className="fw-lb">
        {model.notice && <Banner tone={model.notice.tone} title={say(t, model.notice.words)} />}
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t(`${words}.title`)} description={t(`${words}.body`)} action={model.can.correct ? <Link className="fw-lb-link" href={`${model.prefix}/home/today`}>{t('page.correctOnly.today')}</Link> : undefined} />
        </Card>
        {one && model.detail && <ItemDetail model={model} actions={actions} open={openOf(model.detail.key)} ids={[]} />}
        {one && <LabourDialogs model={model} actions={actions} />}
      </div>
    )
  }

  const place = { locale, timeZone: model.timeZone }
  const picked = (filtered ?? []).filter((item) => selected.includes(itemKey(item)))
  const normalPicked = normalTargets(picked)
  const normalCount = picked.length > 0 ? normalPicked.length : (model.blocks?.normal ?? (model.can.blocks ? null : 0))
  const held = normalHeld(normalCount, model.can, model.busy)
  const find = findHeld(model.can)
  const more = [
    find ? { id: 'find', label: t('page.find'), disabled: true, description: t(find) } : { id: 'find', label: t('page.find'), onSelect: () => actions?.onDialog?.({ kind: 'find', query: '', hits: null, person: null, workDate: model.today }) },
    model.payrollHref ? { id: 'payroll', label: t('page.payroll'), href: model.payrollHref } : { id: 'payroll', label: t('page.payroll'), disabled: true, description: t('held.noPayroll') },
    { id: 'keys', label: lists('keys.title'), onSelect: () => actions?.onDialog?.({ kind: 'keys' }) },
  ]
  const open = openOf(model.detail?.key)

  return (
    <div className="fw-lb" ref={frame}>
      <LegalBand rows={model.legal} canSettings={model.can.settings} prefix={model.prefix} />

      <div className="fw-lb-head">
        <span className="fw-lb-status" role="status">
          {model.asOf ? t('common.updated', { time: formatTime(model.asOf, place) }) : t('common.notYet')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-lb-actions">
          <Select size="sm" aria-label={t('page.lineLabel')} value={model.address.line ?? ''} onChange={(event) => actions?.onAddress?.({ line: event.target.value || null, open: null })}>
            <option value="">{t('page.lineAll')}</option>
            {model.lines.map((line) => (
              <option key={line.id} value={line.id}>
                {t('page.lineOption', { code: line.code, name: line.name })}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onApproveNormal?.(picked.length > 0 ? normalPicked : null)}>
            <CheckCheck size={14} aria-hidden /> {normalCount === null || normalCount === 0 ? t('page.approveNormal') : t('bulk.approve', { count: normalCount })}
          </Button>
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('page.more') }} items={more} />
        </span>
      </div>
      <p className="fw-lb-visually-hidden" aria-live="polite">
        {model.announcement ?? ''}
      </p>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        >
          {model.notice.detail?.length ? (
            <ul className="fw-lb-list">
              {model.notice.detail.map((line) => (
                <li key={line.key + JSON.stringify(line.params ?? {})}>{say(t, line)}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}

      <section aria-label={t('tiles.label')}>
        <MetricStrip
          metrics={TILES.map((tile) => ({
            label: t(`tile.${tile.kind}`),
            value: model.counts ? model.counts[tile.count] : '—',
            onClick: () => actions?.onAddress?.({ kind: tileKind(model.address, tile.kind), open: null }),
            active: model.address.kind === tile.kind,
            ...(tile.kind === 'LINE_DAY' && model.counts && model.counts.heldDays > 0 ? { hint: t('tile.held', { count: model.counts.heldDays }) } : {}),
          }))}
        />
      </section>

      <QueueList model={model} actions={actions} filtered={filtered} selected={selected} onSelected={setSelected} />
      <DaysList model={model} actions={actions} />
      <EditsTimeline model={model} actions={actions} />

      {model.detail && <ItemDetail model={model} actions={actions} open={open} ids={(filtered ?? []).map(itemKey)} />}
      <LabourDialogs model={model} actions={actions} />
    </div>
  )
}
