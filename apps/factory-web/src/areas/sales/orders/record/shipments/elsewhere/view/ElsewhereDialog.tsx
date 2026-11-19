'use client'

import type { KeyboardEvent } from 'react'
import Link from 'next/link'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, NumberStepper, Select, Spinner } from '@nexus/ui/primitives'
import { ELSEWHERE_LIMITS, type ElsewhereProblem } from '@nexus/factory-domain/shipping/elsewhere'
import { DateField, DateTimeField, Modal, Textarea } from '../../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../../lib/i18n/provider'
import type { ReadyCell } from '../../../../../../warehouse/shipments/api'
import { zonedToday } from '../../../../../../warehouse/shipments/model'
import type { Phrase } from '../../../../model'
import type { ElsewherePreview, ElsewhereRecorded } from '../api'
import { elsewhereBody, garmentsOf, problemPlaces, recordHeld, type ElsewhereForm, type ElsewhereTransport } from '../model'
import { clampGarments, NOTHING_SEEN, problemShown, recordHeldWords, stepperEnds, type ElsewhereField, type ElsewhereSeen } from '../model' // F-OP-307

/** F-OP-123 — the dialog's view model (RecordElsewhere fills it; this view fetches nothing). */
export interface ElsewhereDialogModel {
  readonly order: { readonly id: string; readonly number: string; readonly customer: string; /** Pieces still waiting for quality. */ readonly waiting: number }
  readonly prefix: string
  /** This order's released garments on no shipment (each cell up to what it can still ship); reading; or the read failed. */
  readonly cells: readonly ReadyCell[] | 'loading' | 'failed'
  readonly form: ElsewhereForm
  /** The API's preview of the recording (null: nothing asked yet, or being read). */
  readonly preview: ElsewherePreview | null
  /** The live rules (the API's own, on this clock). */
  readonly problems: readonly ElsewhereProblem[]
  readonly busy: boolean
  readonly refusal: { readonly words: Phrase; readonly detail: string | null } | null
  readonly done: ElsewhereRecorded | null
  /** Now (ISO): the latest "Left on" offered. */
  readonly now: string
  /** F-OP-307: whether the person tried to record, and the fields they left (a problem shows only then). Absent: nothing yet. */
  readonly seen?: ElsewhereSeen
}

export interface ElsewhereDialogActions {
  onChange?: (next: Partial<ElsewhereForm>) => void
  onRetryCells?: () => void
  /** F-OP-307: the person left a field (its problem may show now). */
  onLeave?: (field: ElsewhereField) => void
  /** F-OP-307: the person pressed Record (or ⌘↵), held or not (every problem may show now). */
  onTry?: () => void
  onRecord?: () => void
  onClose?: () => void
}

const TRANSPORTS: readonly ElsewhereTransport[] = ['CARRIER', 'SENDER', 'RECIPIENT']
const DAY_MS = 86_400_000

/**
 * F-OP-123 (order page N5; 10-order-page §8.5; review R-9, R-10, R-23) — "Record a shipment made elsewhere…": the garments that left
 * (this order's released garments only, each up to what it can still ship; a serial-tracked style names each serial), the paper DDT
 * (its number and date — required unless an immediate invoice travelled instead), when it left (by default the DDT's day), how it
 * travelled, and whether the customer is told (the site's notice). The live rules sit under their fields: "Not in the future", "Not
 * before the garments were released ({date})", "At most 60 days back", "Only released garments". A customer on hold: held words, and
 * for a person who may release holds a required reason. "No Nexus DDT number is issued". Done: the shipment, SHIPPED, made elsewhere.
 * ⌘↵ records when nothing holds it; Esc closes (the DS Modal returns the focus).
 */
export function ElsewhereDialog({ model, actions }: { model: ElsewhereDialogModel; actions?: ElsewhereDialogActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const { form, preview } = model
  const cells = Array.isArray(model.cells) ? (model.cells as readonly ReadyCell[]) : []
  const body = elsewhereBody(model.order.id, form, cells)
  const places = problemPlaces(model.problems, body, { releasedOn: (iso) => formatDate(iso, { locale }) })
  const held = recordHeld({ busy: model.busy, form, problems: model.problems, preview, customer: model.order.customer })
  const words = (phrase: Phrase) => t(phrase.key, phrase.params)
  const change = (next: Partial<ElsewhereForm>) => actions?.onChange?.(next)
  const close = () => actions?.onClose?.()
  const seen = model.seen ?? NOTHING_SEEN // F-OP-307
  const record = () => {
    actions?.onTry?.() // F-OP-307: a try shows every problem (held or not)
    if (!held) actions?.onRecord?.()
  }
  const keys = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !model.done) {
      event.preventDefault()
      record()
    }
  }
  const earliest = preview?.earliest ?? null
  const min = new Date(Date.parse(model.now) - ELSEWHERE_LIMITS.daysBack * DAY_MS).toISOString()
  const count = garmentsOf(form)

  return (
    <Modal
      open
      onClose={close}
      title={t('elsewhere.title')}
      subtitle={t('elsewhere.subtitle', { order: model.order.number, customer: model.order.customer })}
      size="lg"
      footer={
        model.done ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={close}>
              {t('elsewhere.doneClose')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={close}>
              {t('elsewhere.cancel')}
            </Button>
            {/* F-OP-307: a click on Record is a try even while it is held (the held button keeps the click to itself; it bubbles here). */}
            <span className="fw-so-inline" onClick={() => actions?.onTry?.()}>
              <Button size="sm" variant="primary" heldReason={held ? words(recordHeldWords(held, places, seen) ?? held) : null} onClick={() => actions?.onRecord?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
                {t('elsewhere.record', { count })}
              </Button>
            </span>
          </>
        )
      }
    >
      {model.done ? (
        <div className="fw-so-stack" role="status">
          <Banner tone="success" title={t('elsewhere.done', { number: model.done.shipment.number })}>
            <Link className="fw-so-link" href={`${model.prefix}/warehouse/shipments/${model.done.shipment.id}`}>
              {t('elsewhere.open', { number: model.done.shipment.number })}
            </Link>
          </Banner>
          {model.done.warnings.length > 0 && (
            <Banner tone="warning" title={t('elsewhere.warnings')}>
              {model.done.warnings.join(' ')}
            </Banner>
          )}
        </div>
      ) : (
        <form
          className="fw-so-stack"
          onSubmit={(event) => {
            event.preventDefault()
            record()
          }}
          onKeyDown={keys}
        >
          {model.refusal && (
            <Banner tone="danger" title={words(model.refusal.words)}>
              {model.refusal.detail}
            </Banner>
          )}
          {/* R-9: the customer on hold — held words; a person who may release holds says why. */}
          {preview?.holds.held && (
            <Banner tone="warning" title={t('elsewhere.heldCustomer', { customer: model.order.customer })}>
              {[preview.holds.accountHold, preview.holds.creditHeld ? t('elsewhere.creditHeld', { customer: model.order.customer }) : null, preview.holds.mayRelease ? null : t('elsewhere.held.customer', { customer: model.order.customer })].filter(Boolean).join(' ')}
            </Banner>
          )}
          {preview?.holds.held && preview.holds.mayRelease && (
            <Field label={t('elsewhere.reason')} hint={t('elsewhere.reasonHint')} error={problemShown(seen, 'reason') && form.holdReason.trim() === '' ? t('elsewhere.held.reason') : undefined}>
              <Textarea rows={2} maxLength={ELSEWHERE_LIMITS.reason} value={form.holdReason} onChange={(event) => change({ holdReason: event.target.value })} onBlur={() => actions?.onLeave?.('reason')} />
            </Field>
          )}

          <section className="fw-so-stack" aria-label={t('elsewhere.lines')}>
            <h3 className="fw-so-h3">{t('elsewhere.lines')}</h3>
            {model.order.waiting > 0 && <p className="fw-so-hint">{t('elsewhere.waitQuality', { count: model.order.waiting })}</p>}
            {model.cells === 'loading' ? (
              <p className="fw-so-hint" role="status">
                <Spinner size={14} /> {t('elsewhere.reading')}
              </p>
            ) : model.cells === 'failed' ? (
              <Banner
                tone="warning"
                title={t('elsewhere.readFailed')}
                action={
                  <Button size="sm" onClick={() => actions?.onRetryCells?.()}>
                    {t('elsewhere.retry')}
                  </Button>
                }
              />
            ) : cells.length === 0 ? (
              <p className="fw-so-hint">{t('elsewhere.noneReleased')}</p>
            ) : (
              cells.map((cell) => {
                const read = preview?.lines.find((line) => line.workOrderSizeId === cell.workOrderSizeId)
                const quantity = form.quantities[cell.workOrderSizeId] ?? 0
                const problems = places.byCell[cell.workOrderSizeId] ?? []
                const label = `${cell.styleCode} · ${cell.colourwayName} · ${cell.size}`
                const ends = stepperEnds(quantity, cell.shippable) // F-OP-307 (walk #18)
                return (
                  <div key={cell.workOrderSizeId} className="fw-so-stack">
                    <Field
                      label={label}
                      hint={[t('elsewhere.cap', { count: cell.shippable }), read?.releasedAt ? t('elsewhere.releasedOn', { date: formatDate(read.releasedAt, { locale }) }) : null].filter(Boolean).join(' · ')}
                      error={problems.length > 0 ? problems.map(words).join(' ') : undefined}
                    >
                      {/* F-OP-307 (walk #18): no native min / max — a disabled − says nothing; the ends are held with words in their
                          names and the held look (orders.css), and the count is kept within 0 and the cap here. */}
                      <NumberStepper
                        size="sm"
                        className={`fw-so-nstep${ends.floor ? ' is-floor' : ''}${ends.ceiling ? ' is-ceiling' : ''}`}
                        value={quantity}
                        onChange={(next) => change({ quantities: { ...form.quantities, [cell.workOrderSizeId]: clampGarments(next, cell.shippable) } })}
                        decrementLabel={ends.floor ? t('elsewhere.minusHeld', { cell: label }) : t('elsewhere.minus', { cell: label })}
                        incrementLabel={ends.ceiling ? t('elsewhere.plusHeld', { cell: label, count: cell.shippable }) : t('elsewhere.plus', { cell: label })}
                      />
                    </Field>
                    {cell.serialTracked && quantity > 0 && (
                      <Field label={t('elsewhere.serials')} hint={t('elsewhere.serialsHint')}>
                        <Input size="sm" value={form.serials[cell.workOrderSizeId] ?? ''} onChange={(event) => change({ serials: { ...form.serials, [cell.workOrderSizeId]: event.target.value } })} />
                      </Field>
                    )}
                  </div>
                )
              })
            )}
            {places.lines.length > 0 && count > 0 && <p className="fw-so-hint">{places.lines.map(words).join(' ')}</p>}
          </section>

          <section className="fw-so-stack" aria-label={t('elsewhere.paper')}>
            <h3 className="fw-so-h3">{t('elsewhere.paper')}</h3>
            <p className="fw-so-hint">{t('elsewhere.noNexusDdt')}</p>
            <Checkbox checked={form.invoiceInstead} onChange={() => change({ invoiceInstead: !form.invoiceInstead })} label={t('elsewhere.invoiceInstead')} />
            <div className="fw-so-two">
              <Field label={t('elsewhere.ddtNumber')} error={problemShown(seen, 'ddt') && places.ddt.length > 0 ? places.ddt.map(words).join(' ') : undefined} hint={preview && !preview.ddtCitable ? t('elsewhere.notCitable') : undefined}>
                <Input size="sm" maxLength={ELSEWHERE_LIMITS.ddtNumber} value={form.ddtNumber} onChange={(event) => change({ ddtNumber: event.target.value })} onBlur={() => actions?.onLeave?.('ddt')} />
              </Field>
              <Field label={t('elsewhere.ddtDate')}>
                <DateField value={form.ddtDate} max={zonedToday(new Date(model.now))} onChange={(value) => change({ ddtDate: value })} />
              </Field>
            </div>
            {preview?.ddtUsed && <p className="fw-so-hint">{t('elsewhere.ddtUsed')}</p>}
          </section>

          <section className="fw-so-stack" aria-label={t('elsewhere.leftOn')}>
            <Field label={t('elsewhere.leftOn')} hint={earliest ? t('elsewhere.beforeRelease', { date: formatDate(earliest, { locale }) }) : undefined} error={places.left.length > 0 ? places.left.map(words).join(' ') : undefined}>
              <DateTimeField value={form.shippedAt} min={earliest && earliest > min ? earliest : min} max={model.now} stepMinutes={5} ariaLabel={t('elsewhere.leftOn')} onChange={(value) => change({ shippedAt: value })} />
            </Field>
            <Field label={t('elsewhere.how')}>
              <Select size="sm" value={form.transportBy} onChange={(event) => change({ transportBy: event.target.value as ElsewhereTransport })}>
                {TRANSPORTS.map((value) => (
                  <option key={value} value={value}>
                    {t(`elsewhere.by.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
            {form.transportBy === 'CARRIER' && (
              <div className="fw-so-two">
                <Field label={t('ship.col.carrier')}>
                  <Input size="sm" maxLength={100} value={form.carrierName} onChange={(event) => change({ carrierName: event.target.value })} />
                </Field>
                <Field label={t('elsewhere.trackingNumber')}>
                  <Input size="sm" maxLength={100} value={form.trackingNumber} onChange={(event) => change({ trackingNumber: event.target.value })} />
                </Field>
              </div>
            )}
            {preview && <p className="fw-so-hint">{preview.noticeOn ? t('elsewhere.tellOn', { customer: model.order.customer }) : t('elsewhere.tellOff', { customer: model.order.customer })}</p>}
            <Field label={t('elsewhere.note')}>
              <Textarea rows={2} maxLength={ELSEWHERE_LIMITS.note} value={form.note} onChange={(event) => change({ note: event.target.value })} />
            </Field>
          </section>
        </form>
      )}
    </Modal>
  )
}
