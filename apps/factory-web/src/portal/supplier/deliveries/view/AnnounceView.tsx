'use client'

import { useEffect, type ReactNode } from 'react'
import { AlertCircle, ClipboardList, Download, PackageSearch } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Stepper } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { Button, Checkbox, Input, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { DateField, FileDropzone, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { SHEET_MAX_BYTES, templateHref, type NoticePage, type SheetRead, type ShippableOrder } from '../api'
import {
  hasLeather,
  hideCounts,
  hidesOfNotice,
  hidesOfSheet,
  lineChecksOf,
  lineProblemsOf,
  linesHeld,
  listHref,
  MAX_NOTE,
  newHref,
  noticeHref,
  overOpen,
  sendHeld,
  sendReasonsOf,
  STEPS,
  termsHeld,
  termsProblemsOf,
  writeHeld,
  type LineDraft,
  type LinesDraft,
  type Problem,
  type ShipLine,
  type Step,
  type TermField,
  type TermsDraft,
  type WriteFacts,
} from '../model'
import { useDeliveryWords, type DeliveryWords } from '../words'
import { HidesTable, LineChecks, TermsFacts } from './parts'
import '../deliveries.css'

/**
 * SCR-227 › Announce a delivery (design portal.supplier.asn sub-page `announce`, /deliveries/new?po=<id>): 1 · What you ship
 * (the order's open lines, preselected; a quantity per line, partial allowed; the dye batch and your lot), 2 · Leather packing
 * list (the tannery's own CSV or Excel read and judged per hide BEFORE anything is kept: the verdict per row and per line,
 * Enter opens a row's detail; keep it, or go on without and we measure at the dock), 3 · Transport and papers, 4 · Review and
 * send → "Delivery announced. We expect it on … at …". The same steps change a SENT notice until it is received (each step
 * saves; nothing to send). ← → move between the steps reached. Nothing here is money (C2).
 */

export type SheetState =
  | { state: 'idle' }
  | { state: 'reading'; fileName: string }
  | { state: 'read'; fileName: string; read: SheetRead; keeping: boolean }
  | { state: 'failed'; fileName: string; problem: Problem; issues: readonly string[] }

export interface AnnounceViewModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  prefix: string
  /** A new notice without an order yet: the orders with lines to ship (null: an order is chosen). */
  orders: readonly ShippableOrder[] | null
  order: { id: string; number: string } | null
  step: Step
  /** A SENT notice being changed: each step saves, there is nothing to send. */
  changing: boolean
  /** The notice once it exists (null: step 1 of a new one). */
  page: NoticePage | null
  lines: readonly ShipLine[]
  linesDraft: LinesDraft
  terms: TermsDraft
  /** The note sent with the notice (needed when something is not as ordered). */
  sendNote: string
  sheet: SheetState
  facts: WriteFacts
  /** A refusal in the page's words (`notShippable`: the order in the address has nothing to ship). */
  problem: { problem: Problem | 'notShippable'; issues: readonly string[] } | null
  done: { id: string; number: string; expectedDate: string | null; site: string | null } | null
  /** Live: the notice changed elsewhere while this page had typed work. */
  stale?: boolean
  /** Design cases: a hide's detail open. */
  openHide?: string | null
}

export interface AnnounceActions {
  onLine?: (id: string, patch: Partial<LineDraft>) => void
  onTerm?: (field: TermField, value: string) => void
  onSendNote?: (value: string) => void
  onStep?: (step: Step) => void
  onNext?: () => void
  onBack?: () => void
  onFile?: (file: File) => void
  onKeepSheet?: () => void
  onOtherFile?: () => void
  onRemoveList?: () => void
  onRetry?: () => void
  onReload?: () => void
}

/** Why the step's primary waits (a key), or null. */
export function primaryHeld(model: AnnounceViewModel, locale: DeliveryWords['locale']): string | null {
  switch (model.step) {
    case 'lines':
      return linesHeld(model.linesDraft, locale, model.facts)
    case 'packing':
      if (model.sheet.state === 'reading' || (model.sheet.state === 'read' && model.sheet.keeping)) return 'held.busy'
      if (model.sheet.state === 'read') return 'held.sheetNotKept'
      return model.facts.busy ? 'held.busy' : null
    case 'transport':
      return termsHeld(model.terms, model.facts)
    default:
      return model.changing || !model.page ? null : sendHeld(model.page, model.sendNote, model.facts)
  }
}

export function AnnounceView({ model, actions }: { model: AnnounceViewModel; actions?: AnnounceActions }) {
  const words = useDeliveryWords()
  const { t } = words
  const ds = useDsWords()

  // ← → between the steps reached (design kb), never while typing or inside the list frame.
  const index = STEPS.indexOf(model.step)
  const reachable = model.page ? STEPS.length - 1 : 0
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.closest('[role="dialog"], [role="menu"], [role="grid"], [role="treegrid"], .ag-root-wrapper'))) return
      const next = event.key === 'ArrowLeft' ? index - 1 : index + 1
      if (next < 0 || next > reachable) return
      event.preventDefault()
      actions?.onStep?.(STEPS[next]!)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, reachable, actions])

  if (model.state === 'loading') {
    return (
      <div className="fw-psn" role="status" aria-busy="true" aria-label={t('state.loading')}>
        <Skeleton height={32} width="60%" />
        <Skeleton height={120} />
        <Skeleton height={120} />
      </div>
    )
  }
  if (model.state === 'missing') {
    return (
      <div className="fw-psn">
        <EmptyState icon={<AlertCircle size={24} aria-hidden />} title={t('notice.missing')} description={t('notice.missingBody')} action={
            <Button asChild>
              <a href={listHref(model.prefix)}>{t('notice.toList')}</a>
            </Button>
          } />
      </div>
    )
  }
  if (model.state === 'error') {
    return (
      <div className="fw-psn">
        <div className="fw-psn-state" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('announce.failed')}</span>
          <Button onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>
        </div>
      </div>
    )
  }

  if (model.done) {
    const done = model.done
    return (
      <div className="fw-psn fw-psn-end">
        <EndState
          tone="success"
          title={t('done.title')}
          body={done.expectedDate ? (done.site ? t('done.body', { date: words.day(done.expectedDate), site: done.site }) : t('done.bodyNoSite', { date: words.day(done.expectedDate) })) : null}
          next={[t('done.next1'), t('done.next2')]}
          reference={{ value: done.number, label: t('done.reference') }}
          actions={[
            { label: t('done.open'), href: noticeHref(model.prefix, done.id), variant: 'primary' },
            { label: t('done.list'), href: listHref(model.prefix) },
            { label: t('done.another'), href: newHref(model.prefix) },
          ]}
          labels={ds.endState}
        />
      </div>
    )
  }

  // A new notice without its order: the orders with lines to ship.
  if (!model.order && !model.page) return <OrderPicker model={model} />

  const held = primaryHeld(model, words.locale)
  const primary = model.step === 'review' ? (model.changing ? t('step.done') : t('step.send')) : model.changing && model.step !== 'packing' ? t('step.save') : t('step.next')
  const steps = STEPS.map((step) => ({ key: step, label: t(`step.${step}`) }))
  return (
    <div className="fw-psn">
      <nav aria-label={t('step.label')} className="fw-psn-stepper">
        <Stepper steps={steps} current={index} onSelect={(at) => actions?.onStep?.(STEPS[at]!)} canSelect={(at) => at !== index && at <= reachable} />
      </nav>
      {model.stale ? (
        <Banner tone="info" title={t('announce.stale')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('announce.reload')}</Button>} />
      ) : null}
      {model.problem ? (
        <Banner tone="danger" title={t(`problem.${model.problem.problem}`)}>
          {model.problem.issues.length > 0 ? (
            <ul className="fw-psn-list">
              {model.problem.issues.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
      {model.step === 'lines' ? <LinesStep model={model} actions={actions} words={words} /> : null}
      {model.step === 'packing' && model.page ? <PackingStep model={model} page={model.page} actions={actions} words={words} /> : null}
      {model.step === 'transport' ? <TransportStep model={model} actions={actions} words={words} /> : null}
      {model.step === 'review' && model.page ? <ReviewStep model={model} page={model.page} actions={actions} words={words} /> : null}
      <div className="fw-psn-footer">
        {index > 0 ? <Button onClick={() => actions?.onBack?.()}>{t('step.back')}</Button> : <span />}
        {model.step === 'review' && model.changing && model.page ? (
          <Button variant="primary" asChild>
            <a href={noticeHref(model.prefix, model.page.notice.id)}>{primary}</a>
          </Button>
        ) : (
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onNext?.()}>
            {model.facts.busy ? t('state.saving') : primary}
          </Button>
        )}
      </div>
    </div>
  )
}

function OrderPicker({ model }: { model: AnnounceViewModel }) {
  const { t, day } = useDeliveryWords()
  const orders = model.orders ?? []
  return (
    <Card padded className="fw-psn-card">
      <h2 className="fw-psn-h2">{t('pick.title')}</h2>
      {model.problem ? <Banner tone="warning" title={t(`problem.${model.problem.problem}`)} /> : null}
      {orders.length === 0 ? (
        <EmptyState icon={<PackageSearch size={24} aria-hidden />} title={t('pick.empty')} description={t('pick.emptyBody')} action={
            <Button asChild>
              <a href={`${model.prefix}/orders`}>{t('pick.toOrders')}</a>
            </Button>
          } />
      ) : (
        <>
          <p className="fw-psn-hint">{t('pick.hint')}</p>
          <ul className="fw-psn-picks" aria-label={t('pick.title')}>
            {orders.map((order) => {
              const first = [...order.lines].sort((a, b) => (a.confirmedDate ?? a.needDate).localeCompare(b.confirmedDate ?? b.needDate))[0]
              return (
                <li key={order.id}>
                  <a className="fw-psn-pick" href={newHref(model.prefix, order.id)}>
                    <strong>{order.documentNumber}</strong>
                    <span className="fw-psn-sub">
                      {t('pick.lines', { count: order.lines.length })}
                      {first ? ` · ${t('pick.firstDue', { date: day(first.confirmedDate ?? first.needDate) })}` : ''}
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Card>
  )
}

// ── 1 · What you ship ────────────────────────────────────────────────────────────────────────────────────────────────
function asksOf(line: ShipLine, words: DeliveryWords): string[] {
  const { t, qty } = words
  const asks = line.asks
  if (!asks) return []
  const out: string[] = []
  if (asks.grade) out.push(t('asks.grade', { grade: asks.grade }))
  if (asks.thicknessMinMm && asks.thicknessMaxMm) out.push(t('asks.thickness', { min: qty(asks.thicknessMinMm, null), max: qty(asks.thicknessMaxMm, null) }))
  if (asks.oneDyeBatch) out.push(t('asks.oneDyeBatch'))
  if (asks.tolerancePct) out.push(t('asks.tolerance', { pct: qty(asks.tolerancePct, null) }))
  if (asks.estimatedHides) out.push(t('asks.hides', { count: asks.estimatedHides }))
  if (asks.requiresCrViTest) out.push(t('asks.crVi'))
  return out
}

function LinesStep({ model, actions, words }: { model: AnnounceViewModel; actions?: AnnounceActions; words: DeliveryWords }) {
  const { t, day, qty, locale } = words
  const problems = lineProblemsOf(model.linesDraft, locale)
  const disabled = writeHeld(model.facts) !== null && !model.facts.busy
  const orderNumber = model.order?.number ?? model.page?.notice.purchaseOrder.number ?? ''
  return (
    <Card padded className="fw-psn-card">
      <h2 className="fw-psn-h2">{t('lines.title')}</h2>
      {model.lines.length === 0 ? (
        <EmptyState icon={<ClipboardList size={24} aria-hidden />} title={t('lines.empty')} description={t('lines.emptyBody', { order: orderNumber })} />
      ) : (
        <>
          <p className="fw-psn-hint">{t('lines.hint', { order: orderNumber })}</p>
          <ul className="fw-psn-lines" aria-label={t('lines.title')}>
            {model.lines.map((line) => {
              const draft = model.linesDraft[line.id] ?? { include: false, quantity: '', dyeBatch: '', supplierLot: '' }
              const problem = problems[line.id]
              const title = [line.supplierArticleCode, line.code, line.name].filter((part, at, all): part is string => Boolean(part) && all.indexOf(part) === at).join(' · ')
              const asks = asksOf(line, words)
              return (
                <li key={line.id} className={draft.include ? 'fw-psn-line is-on' : 'fw-psn-line'}>
                  <Checkbox checked={draft.include} disabled={disabled} onChange={(event) => actions?.onLine?.(line.id, { include: event.target.checked })} label={<strong>{t('lines.line', { seq: line.seq, title })}</strong>} />
                  <span className="fw-psn-sub">
                    {[
                      line.colour ? t('lines.colour', { colour: line.colour }) : null,
                      line.open !== null ? t('lines.open', { quantity: qty(line.open, line.uom) }) : null,
                      line.confirmedDate ? t('lines.confirmedFor', { date: day(line.confirmedDate) }) : line.needDate ? t('lines.neededOn', { date: day(line.needDate) }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {asks.length > 0 ? <span className="fw-psn-sub">{asks.join(' · ')}</span> : null}
                  {draft.include ? (
                    <div className="fw-psn-line-fields">
                      <Field label={t('lines.quantity', { unit: t(`uom.${line.uom}`) })} required error={problem && problem !== 'lines.problem.code' ? t(problem) : null} hint={overOpen(line, draft, locale) ? t('lines.over') : undefined}>
                        <Input inputMode="decimal" value={draft.quantity} disabled={disabled} onChange={(event) => actions?.onLine?.(line.id, { quantity: event.target.value })} />
                      </Field>
                      <Field label={t('lines.dyeBatch')} hint={line.asks?.oneDyeBatch ? t('lines.dyeBatchHint') : undefined} error={problem === 'lines.problem.code' && draft.dyeBatch.trim().length > 60 ? t(problem) : null}>
                        <Input value={draft.dyeBatch} maxLength={60} disabled={disabled} onChange={(event) => actions?.onLine?.(line.id, { dyeBatch: event.target.value })} />
                      </Field>
                      <Field label={t('lines.lot')} error={problem === 'lines.problem.code' && draft.supplierLot.trim().length > 60 ? t(problem) : null}>
                        <Input value={draft.supplierLot} maxLength={60} disabled={disabled} onChange={(event) => actions?.onLine?.(line.id, { supplierLot: event.target.value })} />
                      </Field>
                    </div>
                  ) : (
                    <span className="fw-psn-sub">{t('lines.staysOpen')}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </Card>
  )
}

// ── 2 · Leather packing list ─────────────────────────────────────────────────────────────────────────────────────────
function Templates({ words }: { words: DeliveryWords }) {
  const { t, locale } = words
  return (
    <span className="fw-psn-actions">
      <Button size="sm" asChild>
        <a href={templateHref('xlsx', locale)} target="_blank" rel="noreferrer">
          <Download size={13} aria-hidden /> {t('packing.templateXlsx')}
        </a>
      </Button>
      <Button size="sm" asChild>
        <a href={templateHref('csv', locale)} target="_blank" rel="noreferrer">
          <Download size={13} aria-hidden /> {t('packing.templateCsv')}
        </a>
      </Button>
    </span>
  )
}

function PackingStep({ model, page, actions, words }: { model: AnnounceViewModel; page: NoticePage; actions?: AnnounceActions; words: DeliveryWords }) {
  const { t } = words
  const notice = page.notice
  const held = writeHeld(model.facts)
  const drop = (
    <FileDropzone
      accept=".csv,.xlsx"
      maxBytes={SHEET_MAX_BYTES}
      disabled={held !== null}
      hint={held ? t(held) : t('packing.dropHint')}
      onFiles={(files) => {
        if (files[0]) actions?.onFile?.(files[0])
      }}
    />
  )
  if (!hasLeather(notice)) {
    return (
      <Card padded className="fw-psn-card">
        <h2 className="fw-psn-h2">{t('packing.title')}</h2>
        <Banner tone="info" title={t('packing.noLeather')} />
      </Card>
    )
  }
  const sheet = model.sheet
  const stored = hidesOfNotice(notice)
  let body: ReactNode
  if (sheet.state === 'reading') {
    body = (
      <div className="fw-psn-state" role="status">
        <Spinner size={14} /> <span>{t('packing.reading', { file: sheet.fileName })}</span>
      </div>
    )
  } else if (sheet.state === 'read') {
    const rows = hidesOfSheet(sheet.read)
    const counts = hideCounts(rows)
    const keepHeld = held ?? (sheet.read.unreadable > 0 ? 'held.unreadable' : sheet.keeping ? 'held.busy' : null)
    body = (
      <div className="fw-psn-stack">
        {sheet.read.unreadable > 0 ? (
          <Banner tone="danger" title={t('packing.unreadable', { count: sheet.read.unreadable, file: sheet.fileName })}>
            {t('packing.fixAndUpload')}
          </Banner>
        ) : (
          <Banner tone={sheet.read.verdict === 'NOT_AS_ORDERED' ? 'danger' : sheet.read.verdict === 'CHECK' ? 'warning' : 'success'} title={t('packing.readSummary', { count: rows.length, file: sheet.fileName })}>
            {t('packing.counts', { ok: counts.ok, check: counts.check, bad: counts.notAsOrdered })} {t('packing.notKept')}
          </Banner>
        )}
        {sheet.read.ignored.length > 0 ? <p className="fw-psn-hint">{t('packing.ignored', { columns: sheet.read.ignored.join(', ') })}</p> : null}
        <h3 className="fw-psn-h3">{t('packing.perLine')}</h3>
        <LineChecks lines={lineChecksOf(notice, sheet.read.lines).filter((line) => line.leather)} received={false} label={t('packing.perLine')} />
        <h3 className="fw-psn-h3">{t('packing.perHide')}</h3>
        <HidesTable rows={rows} label={t('packing.sheetRows', { file: sheet.fileName })} openHide={model.openHide ?? null} />
        <p className="fw-psn-hint">{t('packing.differences')}</p>
        <span className="fw-psn-actions">
          <Button variant="primary" heldReason={keepHeld ? t(keepHeld) : null} onClick={() => actions?.onKeepSheet?.()}>
            {sheet.keeping ? t('state.saving') : t('packing.keep', { count: rows.length })}
          </Button>
          <Button onClick={() => actions?.onOtherFile?.()}>{t('packing.other')}</Button>
        </span>
      </div>
    )
  } else if (stored.length > 0) {
    const counts = hideCounts(stored)
    body = (
      <div className="fw-psn-stack">
        <Banner tone={notice.verdict === 'NOT_AS_ORDERED' ? 'danger' : notice.verdict === 'CHECK' ? 'warning' : 'success'} title={t('packing.kept', { count: stored.length })}>
          {t('packing.counts', { ok: counts.ok, check: counts.check, bad: counts.notAsOrdered })}
        </Banner>
        <h3 className="fw-psn-h3">{t('packing.perLine')}</h3>
        <LineChecks lines={lineChecksOf(notice).filter((line) => line.leather)} received={false} label={t('packing.perLine')} />
        <h3 className="fw-psn-h3">{t('packing.perHide')}</h3>
        <HidesTable rows={stored} label={t('packing.yourList')} openHide={model.openHide ?? null} />
        <p className="fw-psn-hint">{t('packing.differences')}</p>
        <h3 className="fw-psn-h3">{t('packing.replace')}</h3>
        {drop}
        <span className="fw-psn-actions">
          <Button heldReason={held ? t(held) : null} onClick={() => actions?.onRemoveList?.()}>
            {t('packing.remove')}
          </Button>
        </span>
      </div>
    )
  } else {
    body = (
      <div className="fw-psn-stack">
        {sheet.state === 'failed' ? (
          <Banner tone="danger" title={t('packing.failed', { file: sheet.fileName })}>
            <ul className="fw-psn-list">
              {(sheet.issues.length > 0 ? sheet.issues : [`problem.${sheet.problem}`]).map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {drop}
        <p className="fw-psn-hint">{t('packing.none')}</p>
      </div>
    )
  }
  return (
    <Card padded className="fw-psn-card">
      <div className="fw-psn-card-head">
        <h2 className="fw-psn-h2">{t('packing.title')}</h2>
        <Templates words={words} />
      </div>
      <p className="fw-psn-hint">{t('packing.hint')}</p>
      {sheet.state === 'failed' && stored.length > 0 ? (
        <Banner tone="danger" title={t('packing.failed', { file: sheet.fileName })}>
          <ul className="fw-psn-list">
            {(sheet.issues.length > 0 ? sheet.issues : [`problem.${sheet.problem}`]).map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {body}
    </Card>
  )
}

// ── 3 · Transport and papers ─────────────────────────────────────────────────────────────────────────────────────────
function TransportStep({ model, actions, words }: { model: AnnounceViewModel; actions?: AnnounceActions; words: DeliveryWords }) {
  const { t } = words
  const problems = termsProblemsOf(model.terms)
  const disabled = writeHeld(model.facts) !== null && !model.facts.busy
  const error = (field: TermField) => (problems[field] ? t(problems[field]!) : null)
  const text = (field: TermField, max: number, hint?: string) => (
    <Field label={t(`terms.${field}`)} error={error(field)} hint={hint}>
      <Input value={model.terms[field]} maxLength={max} disabled={disabled} onChange={(event) => actions?.onTerm?.(field, event.target.value)} />
    </Field>
  )
  return (
    <Card padded className="fw-psn-card">
      <h2 className="fw-psn-h2">{t('transport.title')}</h2>
      <Banner tone="info" title={t('transport.ddtTravels')} />
      <div className="fw-psn-fields">
        <Field label={t('terms.shipDate')} required error={error('shipDate')}>
          <DateField value={model.terms.shipDate} disabled={disabled} onChange={(value) => actions?.onTerm?.('shipDate', value)} />
        </Field>
        <Field label={t('terms.expectedDate')} required hint={t('transport.expectedHint')} error={error('expectedDate')}>
          <DateField value={model.terms.expectedDate} min={model.terms.shipDate || undefined} disabled={disabled} onChange={(value) => actions?.onTerm?.('expectedDate', value)} />
        </Field>
        <Field label={t('terms.parcels')} error={error('parcels')}>
          <Input inputMode="numeric" value={model.terms.parcels} disabled={disabled} onChange={(event) => actions?.onTerm?.('parcels', event.target.value)} />
        </Field>
        {text('carrier', 100)}
        {text('trackingNumber', 100)}
        {text('supplierRef', 60, t('transport.refHint'))}
        {text('ddtNumber', 60)}
        <Field label={t('terms.ddtDate')} error={error('ddtDate')}>
          <DateField value={model.terms.ddtDate} disabled={disabled} clearable onChange={(value) => actions?.onTerm?.('ddtDate', value)} />
        </Field>
      </div>
      <Field label={t('terms.note')} hint={t('transport.noteHint')} error={error('note')}>
        <Textarea value={model.terms.note} rows={3} maxLength={MAX_NOTE} disabled={disabled} onChange={(event) => actions?.onTerm?.('note', event.target.value)} />
      </Field>
    </Card>
  )
}

// ── 4 · Review and send ──────────────────────────────────────────────────────────────────────────────────────────────
const STEP_OF_REASON: Readonly<Record<string, Step>> = { 'send.noLines': 'lines', 'send.noShipDate': 'transport', 'send.noExpected': 'transport' }

function ReviewStep({ model, page, actions, words }: { model: AnnounceViewModel; page: NoticePage; actions?: AnnounceActions; words: DeliveryWords }) {
  const { t, say } = words
  const notice = page.notice
  const draft = notice.status === 'DRAFT'
  const reasons = draft ? sendReasonsOf(page, model.sendNote) : []
  const stored = hidesOfNotice(notice)
  const counts = hideCounts(stored)
  const disabled = writeHeld(model.facts) !== null && !model.facts.busy
  return (
    <div className="fw-psn-stack">
      <Card padded className="fw-psn-card">
        <div className="fw-psn-card-head">
          <h2 className="fw-psn-h2">{t('review.lines')}</h2>
          <Pill tone={notice.verdict === 'OK' ? 'success' : notice.verdict === 'CHECK' ? 'warning' : 'danger'}>{t(`verdict.${notice.verdict}`)}</Pill>
        </div>
        <LineChecks lines={lineChecksOf(notice)} received={false} label={t('review.lines')} />
      </Card>
      {hasLeather(notice) ? (
        <Card padded className="fw-psn-card">
          <div className="fw-psn-card-head">
            <h2 className="fw-psn-h2">{t('review.packing')}</h2>
            <Button size="sm" onClick={() => actions?.onStep?.('packing')}>
              {t('review.edit')}
            </Button>
          </div>
          <p className="fw-psn-hint">{stored.length > 0 ? `${t('packing.kept', { count: stored.length })} ${t('packing.counts', { ok: counts.ok, check: counts.check, bad: counts.notAsOrdered })}` : t('review.noList')}</p>
        </Card>
      ) : null}
      <Card padded className="fw-psn-card">
        <div className="fw-psn-card-head">
          <h2 className="fw-psn-h2">{t('review.transport')}</h2>
          <Button size="sm" onClick={() => actions?.onStep?.('transport')}>
            {t('review.edit')}
          </Button>
        </div>
        <TermsFacts notice={notice} site={page.site} prefix={model.prefix} />
      </Card>
      {page.warnings.length > 0 ? <Banner tone="info" title={t('review.documents', { count: page.warnings.length })} /> : null}
      {draft && notice.verdict === 'NOT_AS_ORDERED' ? (
        <Card padded className="fw-psn-card">
          <Banner tone="warning" title={t('review.notAsOrdered')}>
            {t('review.notAsOrderedBody')}
          </Banner>
          <Field label={t('review.note')} required hint={t('review.noteHint')} error={model.sendNote.trim() === '' ? t('send.needNote') : model.sendNote.trim().length > MAX_NOTE ? t('terms.problem.long2000') : null}>
            <Textarea value={model.sendNote} rows={3} maxLength={MAX_NOTE} disabled={disabled} onChange={(event) => actions?.onSendNote?.(event.target.value)} />
          </Field>
        </Card>
      ) : null}
      {reasons.filter((reason) => reason.key !== 'send.needNote').length > 0 ? (
        <Banner tone="warning" title={t('review.before')}>
          <ul className="fw-psn-list">
            {reasons
              .filter((reason) => reason.key !== 'send.needNote')
              .map((reason) => {
                const step = STEP_OF_REASON[reason.key]
                return (
                  <li key={reason.key}>
                    {say(reason)}{' '}
                    {step ? (
                      <Button size="sm" variant="secondary" onClick={() => actions?.onStep?.(step)}>
                        {t('review.fix')}
                      </Button>
                    ) : null}
                  </li>
                )
              })}
          </ul>
        </Banner>
      ) : null}
      {model.changing ? <p className="fw-psn-hint">{t('review.changing')}</p> : null}
    </div>
  )
}
