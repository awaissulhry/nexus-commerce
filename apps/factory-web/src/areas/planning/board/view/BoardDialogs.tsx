'use client'

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Banner, DateField, Field, KeyValue, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, Kbd, SegmentedControl, Skeleton, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { Board, PlaceByDueDate, PublishPreview } from '../api'
import {
  dayWords,
  laneKeyOf,
  minutesText,
  pctOf,
  previewPublishHeld,
  publishHeldWords,
  scheduleWords,
  whenWords,
  type Words,
} from '../model'
import type { BoardActions, BoardDialog, BoardViewModel, Loaded, PublishRangeKind } from '../view-model'

/**
 * The planning board's pop-ups (design planning.board): the bar's detail (pop:bar), the drop warning (pop:drop-warning),
 * Publish schedule vN to the floor (pop:publish), Place all by due date (the tray's backward scheduling with its
 * preview), the legend (pop:legend), the published versions and the keyboard shortcuts. The cell's orders (pop:cell-orders)
 * are the DS board's own load-cell popover. Every dialog: Esc closes and the focus goes back to its opener (DS Modal).
 */
export function BoardDialogs({ model, actions, words }: { model: BoardViewModel; actions?: BoardActions; words: Words }) {
  const dialog = model.dialog
  const board = model.read.status === 'ready' ? model.read.value : null
  if (!dialog) return null
  const close = () => actions?.onCloseDialog?.()
  switch (dialog.kind) {
    case 'bar':
      return <BarDialog dialog={dialog} board={board} model={model} actions={actions} words={words} onClose={close} />
    case 'drop':
      return <DropDialog dialog={dialog} model={model} actions={actions} words={words} />
    case 'publish':
      return <PublishDialog dialog={dialog} board={board} actions={actions} words={words} onClose={close} />
    case 'place':
      return <PlaceDialog dialog={dialog} board={board} actions={actions} words={words} onClose={close} />
    case 'legend':
      return <LegendDialog words={words} onClose={close} />
    case 'versions':
      return <VersionsDialog dialog={dialog} words={words} onClose={close} />
    case 'keys':
      return <KeysDialog words={words} onClose={close} />
  }
}

function Reading({ loaded, words, children }: { loaded: Loaded<unknown>; words: Words; children: () => ReactNode }) {
  if (loaded.status === 'loading')
    return (
      <div className="fw-pb-dialog-reading" aria-busy="true" aria-label={words.t('band.reading')}>
        <Skeleton height={18} width="40%" />
        <Skeleton height={64} />
      </div>
    )
  if (loaded.status === 'error') return <Banner tone="danger" title={words.t('error.title')}>{words.t(`error.${loaded.problem}`)}</Banner>
  return <>{children()}</>
}

const STATUS_TONE = { LATE: 'danger', AT_RISK: 'warning', ON_TIME: 'success', NO_DUE_DATE: 'neutral', DONE: 'neutral' } as const

// ---- the bar ---------------------------------------------------------------------------------------------------------

function BarDialog({ dialog, board, model, actions, words, onClose }: { dialog: Extract<BoardDialog, { kind: 'bar' }>; board: Board | null; model: BoardViewModel; actions?: BoardActions; words: Words; onClose: () => void }) {
  const { t, locale } = words
  const detail = dialog.detail.status === 'ready' ? dialog.detail.value : null
  const fromBoard = board?.workOrders.find((entry) => entry.id === dialog.workOrderId) ?? null
  const number = detail?.workOrder.number ?? fromBoard?.number ?? ''
  const href = `${model.prefix}/production/work-orders/${encodeURIComponent(dialog.workOrderId)}`
  const mayChange = board?.plan.mayChange ?? false
  const sendHeld = !mayChange ? t('held.readOnly') : model.offline ? t('held.offline') : dialog.busy ? t('held.busy') : null
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON' && (event.target as HTMLElement).tagName !== 'A') {
      event.preventDefault()
      window.location.assign(href)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('bar.title', { order: number })}
      subtitle={detail ? `${detail.workOrder.style.code} · ${detail.workOrder.style.name}` : undefined}
      footer={
        <>
          {dialog.slotId ? (
            <Button size="sm" heldReason={sendHeld} onClick={() => dialog.slotId && actions?.onSendToTray?.(dialog.slotId)}>
              {dialog.busy ? <Spinner size={12} /> : null} {t('bar.sendToTray')}
            </Button>
          ) : null}
          <span className="grow" />
          <Button size="sm" onClick={onClose}>
            {t('dialog.close')}
          </Button>
          <Button size="sm" variant="primary" asChild>
            <a href={href} aria-keyshortcuts="Enter">
              {t('bar.open')}
            </a>
          </Button>
        </>
      }
    >
      <div className="fw-pb-dialog" onKeyDown={onKeyDown}>
        {dialog.error ? <Banner tone="danger" title={dialog.error} /> : null}
        <Reading loaded={dialog.detail} words={words}>
          {() => {
            const workOrder = detail!.workOrder
            const lanes = new Map(detail!.lanes.map((lane) => [laneKeyOf(lane), lane.name]))
            const material = workOrder.readiness
            return (
              <>
                <p className="fw-pb-dialog-status">
                  <Tag tone={STATUS_TONE[workOrder.schedule.status]}>{t(`status.${workOrder.schedule.status}`)}</Tag> {scheduleWords(workOrder, words)}
                </p>
                <KeyValue
                  columns={2}
                  labelCase="sentence"
                  items={[
                    { label: t('bar.garments'), value: new Intl.NumberFormat(INTL_LOCALE[locale]).format(workOrder.garments) },
                    { label: t('bar.status'), value: t(`woStatus.${workOrder.status}`) },
                    { label: t('bar.due'), value: workOrder.dueDate ? dayWords(workOrder.dueDate, locale) : t('bar.noDue') },
                    { label: t('bar.latestSafeStart'), value: workOrder.schedule.latestSafeStart ? whenWords(workOrder.schedule.latestSafeStart, words) : '—' },
                    { label: t('bar.planned'), value: workOrder.schedule.plannedStart ? t('bar.span', { start: whenWords(workOrder.schedule.plannedStart, words), finish: whenWords(workOrder.schedule.plannedFinish ?? workOrder.schedule.plannedStart, words) }) : t('bar.notPlanned') },
                    { label: t('bar.line'), value: workOrder.line ? workOrder.line.name : t('bar.noLine') },
                    { label: t('bar.minutes'), value: t('bar.minutesValue', { minutes: minutesText(workOrder.minutes, locale) }) },
                    { label: t('bar.material'), value: material ? (material.date ? t('bar.materialOn', { word: t(`readiness.${material.word}`), date: dayWords(material.date, locale, false) }) : t(`readiness.${material.word}`)) : t('bar.materialUnknown') },
                  ]}
                />
                {workOrder.holdReason ? <Banner tone="warning" title={t('bar.onHold')}>{workOrder.holdReason}</Banner> : null}
                <SummaryTable
                  label={t('bar.sizes')}
                  columns={[t('bar.colourway'), t('bar.size'), t('bar.pieces')]}
                  rows={detail!.sizes.map((size, index) => ({ id: `${size.colourway}-${size.size}-${index}`, cells: [size.colourway, size.size, String(size.quantity)] }))}
                />
                <SummaryTable
                  label={t('bar.operations')}
                  stackOnPhone
                  columns={[t('bar.operation'), t('bar.lane'), t('bar.when'), t('bar.minutes')]}
                  rows={workOrder.operations.map((operation) => ({
                    id: operation.id,
                    cells: [
                      `${operation.seq} · ${operation.name}`,
                      lanes.get(laneKeyOf(operation.lane)) ?? operation.workCentre.name,
                      operation.plannedStart ? (
                        <span key="when">
                          {t('bar.span', { start: whenWords(operation.plannedStart, words), finish: whenWords(operation.plannedFinish ?? operation.plannedStart, words) })}
                          {operation.startsLate ? (
                            <>
                              {' '}
                              <Tag tone="danger">{t('bar.startsLate')}</Tag>
                            </>
                          ) : null}
                        </span>
                      ) : (
                        t('bar.notPlanned')
                      ),
                      minutesText(operation.minutes, locale),
                    ],
                  }))}
                />
                <p className="fw-pb-hint">{t('bar.gates')}</p>
              </>
            )
          }}
        </Reading>
      </div>
    </Modal>
  )
}

// ---- the drop warning ----------------------------------------------------------------------------------------------

function DropDialog({ dialog, model, actions, words }: { dialog: Extract<BoardDialog, { kind: 'drop' }>; model: BoardViewModel; actions?: BoardActions; words: Words }) {
  const { t, locale } = words
  const [reason, setReason] = useState('')
  const board = model.read.status === 'ready' ? model.read.value : null
  const first = dialog.days[0]
  const whereWords = (where: string) => {
    const bucket = board?.buckets.find((entry) => entry.key === where)
    if (bucket) return bucket.from === bucket.to ? dayWords(bucket.from, locale) : t('bucket.range', { from: dayWords(bucket.from, locale, false), to: dayWords(bucket.to, locale, false) })
    return /^\d{4}-\d{2}-\d{2}$/.test(where) ? dayWords(where, locale) : where
  }
  const whenPhrase = (where: string) => {
    const bucket = board?.buckets.find((entry) => entry.key === where)
    if (bucket && bucket.from !== bucket.to) return t('problem.between', { from: dayWords(bucket.from, locale, false), to: dayWords(bucket.to, locale, false) })
    return t('problem.on', { day: whereWords(where) })
  }
  const keepHeld = reason.trim().length < 3 ? t('drop.reasonHeld') : dialog.busy ? t('held.busy') : null
  const keep = () => {
    if (!keepHeld) actions?.onDropChoice?.({ kind: 'keep', reason: reason.trim() })
  }
  const cancel = () => actions?.onDropChoice?.({ kind: 'cancel' })
  return (
    <Modal
      open
      onClose={cancel}
      size="md"
      title={first ? t('drop.title', { lane: dialog.laneName, pct: pctOf(first), when: whenPhrase(first.where) }) : t('drop.titlePlain', { lane: dialog.laneName })}
      footer={
        <>
          <Button size="sm" onClick={cancel}>
            {t('drop.cancel')}
          </Button>
          <span className="grow" />
          {dialog.next ? (
            <Button size="sm" heldReason={dialog.busy ? t('held.busy') : null} onClick={() => actions?.onDropChoice?.({ kind: 'next' })}>
              {t('drop.next')}
            </Button>
          ) : null}
          <Button size="sm" variant="primary" heldReason={keepHeld} onClick={keep} aria-keyshortcuts="Enter">
            {dialog.busy ? <Spinner size={12} /> : null} {t('drop.keep')}
          </Button>
        </>
      }
    >
      <form
        className="fw-pb-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          keep()
        }}
      >
        <p>{t(dialog.source === 'api' ? 'drop.bodyApi' : 'drop.body', { order: dialog.cardLabel, lane: dialog.laneName })}</p>
        <SummaryTable
          label={t('drop.days')}
          columns={[t('drop.when'), t('drop.after'), t('drop.over')]}
          rows={dialog.days.map((day, index) => ({
            id: `${day.where}-${index}`,
            cells: [whereWords(day.where), t('drop.load', { booked: minutesText(day.booked, locale), available: minutesText(day.available, locale), pct: pctOf(day) }), t('drop.overValue', { minutes: minutesText(Math.max(0, day.booked - day.available), locale) })],
          }))}
        />
        {dialog.error ? <Banner tone="danger" title={dialog.error} /> : null}
        <Field label={t('drop.reason')} hint={t('drop.reasonHint')}>
          <Textarea
            rows={2}
            value={reason}
            limit={500}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                keep()
              }
            }}
          />
        </Field>
        <p className="fw-pb-hint">{t('drop.setting')}</p>
      </form>
    </Modal>
  )
}

// ---- publish -------------------------------------------------------------------------------------------------------

const RANGES: readonly PublishRangeKind[] = ['tomorrow', 'default', 'custom']

function PublishDialog({ dialog, board, actions, words, onClose }: { dialog: Extract<BoardDialog, { kind: 'publish' }>; board: Board | null; actions?: BoardActions; words: Words; onClose: () => void }) {
  const { t, locale } = words
  const preview: PublishPreview | null = dialog.preview.status === 'ready' ? dialog.preview.value : null
  const [from, setFrom] = useState(dialog.from ?? preview?.range.coversFrom ?? '')
  const [to, setTo] = useState(dialog.to ?? preview?.range.coversTo ?? '')
  useEffect(() => {
    if (preview) {
      setFrom(preview.range.coversFrom)
      setTo(preview.range.coversTo)
    }
  }, [preview])
  const held = dialog.done ? t('publish.doneHeld') : dialog.busy ? t('held.busy') : preview ? publishHeldWords(previewPublishHeld(preview), words, { from: preview.range.coversFrom, to: preview.range.coversTo }) : t('held.loading')
  const publish = () => {
    if (!held) actions?.onPublish?.()
  }
  const order = (id: string | null) => (id ? (board?.workOrders.find((entry) => entry.id === id)?.number ?? '') : '')
  const laneName = (key: string | null) => (key ? (board?.lanes.find((entry) => laneKeyOf(entry) === key)?.name ?? '') : '')
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={preview ? t('publish.title', { version: preview.next }) : t('publish.titlePlain')}
      footer={
        <>
          <Button size="sm" onClick={onClose}>
            {t(dialog.done ? 'dialog.close' : 'publish.cancel')}
          </Button>
          <span className="grow" />
          <Button size="sm" variant="primary" heldReason={held} onClick={publish} aria-keyshortcuts="Enter">
            {dialog.busy ? <Spinner size={12} /> : null} {preview ? t('publish.confirm', { version: preview.next }) : t('publish.confirmPlain')}
          </Button>
        </>
      }
    >
      <div
        className="fw-pb-dialog"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON' && (event.target as HTMLElement).tagName !== 'INPUT') {
            event.preventDefault()
            publish()
          }
        }}
      >
        {dialog.done ? (
          <Banner tone="success" title={t('publish.done', { version: dialog.done.number })}>
            {t('publish.doneBody', { start: whenWords(dialog.done.effectiveFrom, words) })}
          </Banner>
        ) : null}
        {dialog.error ? <Banner tone="danger" title={dialog.error} /> : null}
        <div className="fw-pb-dialog-row">
          <SegmentedControl
            size="sm"
            ariaLabel={t('publish.range')}
            options={RANGES.map((range) => ({ value: range, label: t(`publish.ranges.${range}`) }))}
            value={dialog.range}
            onChange={(value) => actions?.onPublishRange?.(value as PublishRangeKind)}
          />
          {dialog.range === 'custom' ? (
            <span className="fw-pb-dialog-row">
              <DateField className="fw-pb-date" value={from} locale={INTL_LOCALE[locale]} ariaLabel={t('publish.from')} onChange={setFrom} />
              <DateField className="fw-pb-date" value={to} locale={INTL_LOCALE[locale]} ariaLabel={t('publish.to')} min={from || undefined} onChange={setTo} />
              <Button size="sm" heldReason={!from || !to || to < from ? t('publish.customHeld') : null} onClick={() => actions?.onPublishRange?.('custom', from, to)}>
                {t('publish.review')}
              </Button>
            </span>
          ) : null}
        </div>
        <Reading loaded={dialog.preview} words={words}>
          {() => (
            <>
              <p>
                {t('publish.covers', { from: dayWords(preview!.range.coversFrom, locale), to: dayWords(preview!.range.coversTo, locale), count: preview!.range.workingDays, days: preview!.range.workingDays })}
                {' · '}
                {t('publish.bars', { count: preview!.slots, slots: preview!.slots })}
              </p>
              <h3 className="fw-pb-h3">{preview!.previous ? t('publish.diffSince', { version: preview!.previous.number }) : t('publish.diffFirst')}</h3>
              <p>{t('publish.diff', { moved: preview!.diff.moved, added: preview!.diff.added, removed: preview!.diff.removed })}</p>
              {preview!.diff.byLane.length > 0 ? (
                <SummaryTable
                  label={t('publish.byLane')}
                  columns={[t('publish.lane'), t('publish.moved'), t('publish.added'), t('publish.removed')]}
                  rows={preview!.diff.byLane.map((entry) => ({ id: laneKeyOf(entry.lane), cells: [entry.name, String(entry.moved), String(entry.added), String(entry.removed)] }))}
                />
              ) : null}
              <h3 className="fw-pb-h3">{t('publish.checks')}</h3>
              <ul className="fw-pb-checks">
                {preview!.checks.map((check) => (
                  <li key={check.code} className="fw-pb-check">
                    <Tag tone={check.state === 'PASS' ? 'success' : 'warning'}>{t(`publish.state.${check.state}`)}</Tag>
                    <span>{check.state === 'PASS' ? t(`publish.check.${check.code}.pass`) : t(`publish.check.${check.code}.warn`, { count: check.count })}</span>
                    {check.items.slice(0, 5).map((item, index) => (
                      <Button
                        key={`${check.code}-${index}`}
                        size="sm"
                        variant="quiet"
                        onClick={() => actions?.onShowCheck?.({ workOrderId: item.workOrderId, slotId: item.slotId, laneId: item.lane ? laneKeyOf(item.lane) : null })}
                      >
                        {t('publish.show', { what: item.workOrderId ? order(item.workOrderId) : item.lane ? `${laneName(laneKeyOf(item.lane))}${item.date ? ` · ${dayWords(item.date, locale, false)}` : ''}` : '' })}
                      </Button>
                    ))}
                  </li>
                ))}
              </ul>
              <h3 className="fw-pb-h3">{t('publish.what')}</h3>
              <p>{t('publish.whatBody', { version: preview!.next, start: whenWords(preview!.range.effectiveFrom, words) })}</p>
              <p className="fw-pb-hint">{t('publish.notify')}</p>
            </>
          )}
        </Reading>
      </div>
    </Modal>
  )
}

// ---- place all by due date -------------------------------------------------------------------------------------------

function PlaceDialog({ dialog, board, actions, words, onClose }: { dialog: Extract<BoardDialog, { kind: 'place' }>; board: Board | null; actions?: BoardActions; words: Words; onClose: () => void }) {
  const { t, locale } = words
  const [reason, setReason] = useState('')
  const preview: PlaceByDueDate | null = dialog.preview.status === 'ready' ? dialog.preview.value : null
  const needsReason = (preview?.overbooked ?? 0) > 0
  const held = !preview ? t('held.loading') : preview.slots.length === 0 ? t('place.nothing') : needsReason && reason.trim().length < 3 ? t('place.reasonHeld', { count: preview.overbooked }) : dialog.busy ? t('held.busy') : null
  const workOrder = (id: string) => board?.workOrders.find((entry) => entry.id === id)
  const operation = (workOrderId: string, operationId: string | null) => workOrder(workOrderId)?.operations.find((entry) => entry.id === operationId)
  const laneName = (key: string) => board?.lanes.find((entry) => laneKeyOf(entry) === key)?.name ?? ''
  const apply = () => {
    if (!held) actions?.onPlaceApply?.(needsReason ? reason.trim() : null)
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('place.title')}
      footer={
        <>
          <Button size="sm" onClick={onClose}>
            {t('place.cancel')}
          </Button>
          <span className="grow" />
          <Button size="sm" variant="primary" heldReason={held} onClick={apply}>
            {dialog.busy ? <Spinner size={12} /> : null} {preview ? t('place.apply', { count: preview.slots.length }) : t('place.applyPlain')}
          </Button>
        </>
      }
    >
      <div className="fw-pb-dialog">
        <p>{t('place.body')}</p>
        {dialog.error ? <Banner tone="danger" title={dialog.error} /> : null}
        <Reading loaded={dialog.preview} words={words}>
          {() => (
            <>
              <SummaryTable
                label={t('place.proposals')}
                stackOnPhone
                columns={[t('place.order'), t('place.operation'), t('place.lane'), t('place.when'), t('place.how')]}
                rows={preview!.slots.map((slot) => {
                  const op = operation(slot.workOrderId, slot.operationId)
                  return {
                    id: `${slot.workOrderId}-${slot.operationId}`,
                    cells: [
                      workOrder(slot.workOrderId)?.number ?? '',
                      op ? `${op.seq} · ${op.name}` : '',
                      laneName(laneKeyOf(slot.lane)),
                      t('bar.span', { start: whenWords(slot.startAt, words), finish: whenWords(slot.endAt, words) }),
                      <span key="how">
                        {t(`place.placedBy.${slot.placedBy}`)}
                        {slot.over.length ? (
                          <>
                            {' '}
                            <Tag tone="warning">{t('place.over')}</Tag>
                          </>
                        ) : null}
                      </span>,
                    ],
                  }
                })}
              />
              {preview!.skipped.length > 0 ? (
                <p className="fw-pb-hint">
                  {t('place.skipped', { count: preview!.skipped.length, orders: [...new Set(preview!.skipped.map((entry) => workOrder(entry.workOrderId)?.number ?? ''))].filter(Boolean).join(', ') })}
                </p>
              ) : null}
              {needsReason ? (
                <Field label={t('place.reason', { count: preview!.overbooked })} hint={t('drop.reasonHint')}>
                  <Textarea rows={2} value={reason} limit={500} onChange={(event) => setReason(event.target.value)} />
                </Field>
              ) : null}
              <p className="fw-pb-hint">{t('place.minutes', { minutes: minutesText(preview!.slots.reduce((sum, slot) => sum + Number(slot.minutes), 0), locale) })}</p>
            </>
          )}
        </Reading>
      </div>
    </Modal>
  )
}

// ---- legend, versions, keys ----------------------------------------------------------------------------------------

function LegendDialog({ words, onClose }: { words: Words; onClose: () => void }) {
  const { t } = words
  const rows: Array<[ReactNode, string]> = [
    [<Tag key="late" tone="danger">{t('legend.late')}</Tag>, t('legend.lateWords')],
    [<Tag key="material" tone="warning">{t('mark.material')}</Tag>, t('legend.materialWords')],
    [<Tag key="draft" tone="neutral">{t('mark.draft')}</Tag>, t('legend.draftWords')],
    [<Tag key="over" tone="warning">{t('mark.keptOver')}</Tag>, t('legend.keptOverWords')],
    [<Tag key="rush" tone="info">{t('mark.rush')}</Tag>, t('legend.rushWords')],
    [<Tag key="moved" tone="neutral">{t('legend.moved')}</Tag>, t('legend.movedWords')],
    [<Tag key="today" tone="info">{t('legend.today')}</Tag>, t('legend.todayWords')],
    [<Tag key="closed" tone="neutral">{t('legend.closed')}</Tag>, t('legend.closedWords')],
    [<Tag key="load" tone="danger">{t('legend.overLoad')}</Tag>, t('legend.overLoadWords')],
  ]
  return (
    <Modal open onClose={onClose} size="md" title={t('legend.title')} footer={<Button size="sm" onClick={onClose}>{t('dialog.close')}</Button>}>
      <dl className="fw-pb-legend">
        {rows.map(([mark, text], index) => (
          <div key={index} className="fw-pb-legend-row">
            <dt>{mark}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <p className="fw-pb-hint">{t('legend.standardMinute')}</p>
    </Modal>
  )
}

function VersionsDialog({ dialog, words, onClose }: { dialog: Extract<BoardDialog, { kind: 'versions' }>; words: Words; onClose: () => void }) {
  const { t, locale } = words
  return (
    <Modal open onClose={onClose} size="lg" title={t('versions.title')} footer={<Button size="sm" onClick={onClose}>{t('dialog.close')}</Button>}>
      <Reading loaded={dialog.versions} words={words}>
        {() =>
          dialog.versions.status === 'ready' && dialog.versions.value.length === 0 ? (
            <p>{t('versions.none')}</p>
          ) : (
            <SummaryTable
              label={t('versions.title')}
              stackOnPhone
              columns={[t('versions.number'), t('versions.covers'), t('versions.from'), t('versions.published'), t('versions.slots')]}
              rows={(dialog.versions.status === 'ready' ? dialog.versions.value : []).map((version) => ({
                id: version.id,
                cells: [
                  `v${version.number}`,
                  t('bucket.range', { from: dayWords(version.coversFrom, locale, false), to: dayWords(version.coversTo, locale, false) }),
                  whenWords(version.effectiveFrom, words),
                  version.publishedBy ? t('versions.by', { name: version.publishedBy.name, time: whenWords(version.publishedAt, words) }) : whenWords(version.publishedAt, words),
                  String(version.slots),
                ],
              }))}
            />
          )
        }
      </Reading>
      <p className="fw-pb-hint">{t('versions.hint')}</p>
    </Modal>
  )
}

const KEYS: ReadonlyArray<[readonly string[], string]> = [
  [['/'], 'keys.search'],
  [['t'], 'keys.today'],
  [['1', '2', '3'], 'keys.zoom'],
  [['o', 'r'], 'keys.view'],
  [['Space', 'M'], 'keys.pick'],
  [['←', '→', '↑', '↓'], 'keys.arrows'],
  [['Enter'], 'keys.drop'],
  [['Esc'], 'keys.cancel'],
  [['⌘', 'Z'], 'keys.undo'],
  [['⌘', '⇧', 'Z'], 'keys.redo'],
]

function KeysDialog({ words, onClose }: { words: Words; onClose: () => void }) {
  const { t } = words
  return (
    <Modal open onClose={onClose} size="md" title={t('keys.title')} footer={<Button size="sm" onClick={onClose}>{t('dialog.close')}</Button>}>
      <dl className="fw-pb-legend">
        {KEYS.map(([keys, label]) => (
          <div key={label} className="fw-pb-legend-row">
            <dt>
              {keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{t(label)}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
