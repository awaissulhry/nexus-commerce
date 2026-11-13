'use client'

import { useEffect, useMemo, useRef } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import { Banner, Drawer, Field, KeyValue } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, Kbd, Spinner, Tag } from '@nexus/ui/primitives'
import { DateField } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../../lib/i18n/provider'
import type { QuoteLine, StyleDetail } from '../../../api'
import { gridShapeOf, gridValueOf, money, percent, unitPrice, type Grains } from '../../../model'
import { sizeGridWords } from '../../view/grid-copy'
import type { LineSchedule } from '../api'
import type { LineDrawerSection } from '../drawer-sections'
import { newRowKey, remainderOf, scheduleChanged, scheduleProblems, sizesText, type DeliveryRow, type Words } from '../model'
import { useDepthWords } from '../words'

export interface LineDrawerModel {
  line: QuoteLine
  style: StyleDetail | null
  currency: string
  priceBasis: 'NET' | 'GROSS'
  grains: Grains
  /** Why the schedule cannot change (W1's `sales` read-only words), or null on a draft the person edits. */
  readOnly: Words | null
  schedule: { status: 'loading' } | { status: 'ready'; value: LineSchedule | null; promiseDate: string | null } | { status: 'error' }
  /** The schedule as typed (the saved one until changed). */
  rows: readonly DeliveryRow[]
  saving: boolean
  problem: Words | null
  today: string
  /** "Line 2 of 5" and whether ⌘↑ / ⌘↓ go anywhere. */
  position: { index: number; count: number }
  /** The parts later steps add (B-W2b-343's waterfall, B-W2b-340's options): drawer-sections.tsx. */
  sections: readonly LineDrawerSection[]
}

export interface LineDrawerActions {
  onClose?: () => void
  onStep?: (step: -1 | 1) => void
  onRows?: (rows: DeliveryRow[]) => void
  onSave?: () => void
  onRetry?: () => void
}

/**
 * The quote line drawer (design pop:quotes.lineDrawer, docked beside the record: `?line=`, a block's ⋯ "Open line", the
 * Table's Enter): the line's style, colourway and kind, its quantities (SizeGridView), its price and — by grain — cost and
 * margin, the certificate cover per size, then the slot for later steps (waterfall, options), the delivery schedule (W2b:
 * deliveries by date with their pieces per size, the rest at the promise date; saved explicitly, the whole list at once)
 * and the notes. ⌘↑ / ⌘↓ the line before / after; Esc closes.
 */
export function LineDrawer({ model, actions }: { model: LineDrawerModel; actions?: LineDrawerActions }) {
  const { t, sales, say } = useDepthWords()
  const locale = useLocale()
  const { line, grains, currency } = model
  const copy = useMemo(() => sizeGridWords(sales), [sales])
  const shape = gridShapeOf([line], model.style)
  const latest = useRef(actions)
  latest.current = actions

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        latest.current?.onStep?.(event.key === 'ArrowUp' ? -1 : 1)
      } else if (event.key === 'Escape' && !(event.target as HTMLElement | null)?.closest('[role="dialog"]')) {
        latest.current?.onClose?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const schedule = model.schedule.status === 'ready' ? model.schedule.value : null
  const problems = scheduleProblems(model.rows, line, model.today)
  const changed = model.schedule.status === 'ready' && scheduleChanged(model.rows, schedule, line)
  const left = remainderOf(model.rows, line)
  const promise = model.schedule.status === 'ready' ? model.schedule.promiseDate : null
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale })
  const saveHeld = model.readOnly ? say(model.readOnly) : !changed ? t('drawer.held.noChange') : problems.length > 0 ? t('drawer.held.fix', { count: problems.length }) : model.saving ? sales('held.busy') : null
  const setRow = (key: string, patch: Partial<DeliveryRow>) => actions?.onRows?.(model.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  const refused = line.sizes.filter((row) => row.certificate.outcome === 'refused')

  return (
    <Drawer
      open
      mode="dock"
      width={520}
      onClose={() => actions?.onClose?.()}
      closeLabel={t('drawer.close')}
      title={t('drawer.title', { seq: line.seq, style: line.style.code, colour: `${line.colourway.code} · ${line.colourway.name}` })}
      subtitle={t('drawer.position', { index: model.position.index, count: model.position.count, kind: t(`table.kind.${line.kind}`) })}
      footer={
        <div className="fw-qd-drawer-foot">
          <Button size="sm" variant="quiet" heldReason={model.position.index <= 1 ? t('drawer.held.first') : null} onClick={() => actions?.onStep?.(-1)} aria-keyshortcuts="Meta+ArrowUp Control+ArrowUp">
            <ChevronUp size={14} aria-hidden /> {t('drawer.previous')}
          </Button>
          <Button size="sm" variant="quiet" heldReason={model.position.index >= model.position.count ? t('drawer.held.last') : null} onClick={() => actions?.onStep?.(1)} aria-keyshortcuts="Meta+ArrowDown Control+ArrowDown">
            <ChevronDown size={14} aria-hidden /> {t('drawer.next')}
          </Button>
          <span className="fw-q-hint fw-qd-keys" aria-hidden>
            <Kbd>⌘</Kbd>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
        </div>
      }
    >
      <div className="fw-qd-drawer">
        <section className="fw-qd-drawer-part" aria-labelledby="fw-qd-d-sizes">
          <h3 className="fw-q-h3" id="fw-qd-d-sizes">
            {t('drawer.sizes')}
          </h3>
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('drawer.style'), value: `${line.style.code} · ${line.style.name}` },
              { label: t('drawer.colourway'), value: `${line.colourway.code} · ${line.colourway.name}` },
              { label: t('drawer.pieces'), value: String(line.quantity) },
              ...(grains.price
                ? [
                    { label: sales(model.priceBasis === 'GROSS' ? 'lines.col.unitGross' : 'lines.col.unitNet'), value: unitPrice(line.unitPrice, currency, locale) },
                    { label: sales('lines.col.list'), value: line.listUnitPrice ? unitPrice(line.listUnitPrice, currency, locale) : sales('lines.noList') },
                    { label: t('table.col.discount'), value: line.discountPct ? percent(line.discountPct, locale) : '—' },
                    { label: sales('lines.col.net'), value: money(line.netAmount, currency, locale) },
                  ]
                : []),
              ...(grains.cost ? [{ label: sales('lines.col.unitCost'), value: line.costComplete ? unitPrice(line.unitCost, currency, locale) : sales('lines.costMissing') }] : []),
              ...(grains.margin ? [{ label: sales('lines.col.margin'), value: line.marginPct !== undefined ? percent(line.marginPct, locale) : '—' }] : []),
              { label: t('table.col.vat'), value: line.vatNature ?? percent(line.vatRatePct, locale) },
            ]}
          />
          {line.kind === 'SIZE_GRID' && shape.sizes.length > 0 && (
            <div className="fw-qd-drawer-grid">
              <SizeGridView colours={shape.colours} sizes={shape.sizes} value={gridValueOf([line])} caption={sales('grid.captionOf', { style: line.style.code })} locale={INTL_LOCALE[locale]} copy={copy} />
            </div>
          )}
          <p className="fw-q-hint">{refused.length === 0 ? t('drawer.certAll') : t('drawer.certRefused', { count: refused.length, sizes: refused.map((row) => row.size).join(' · ') })}</p>
          {!grains.price && <p className="fw-q-hint">{sales('summary.noPrice')}</p>}
        </section>

        {model.sections.map((section) => (
          <section key={section.id} className="fw-qd-drawer-part" aria-label={section.title}>
            <h3 className="fw-q-h3">{section.title}</h3>
            {section.body}
          </section>
        ))}

        <section className="fw-qd-drawer-part" aria-labelledby="fw-qd-d-schedule">
          <h3 className="fw-q-h3" id="fw-qd-d-schedule">
            {t('drawer.schedule')}
          </h3>
          {model.schedule.status === 'loading' ? (
            <p className="fw-q-hint" role="status">
              <Spinner size={14} /> {t('common.loading')}
            </p>
          ) : model.schedule.status === 'error' ? (
            <Banner
              tone="danger"
              title={t('drawer.scheduleFailed')}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : line.kind === 'FEE' ? (
            <p className="fw-q-hint">{t('drawer.feeNoSchedule')}</p>
          ) : (
            <>
              <p className="fw-q-hint">{t('drawer.scheduleHint')}</p>
              {model.rows.length === 0 && <p className="fw-q-hint">{promise ? t('drawer.allAtPromise', { date: day(promise) }) : t('drawer.allAtPromiseNone')}</p>}
              <ol className="fw-qd-deliveries">
                {model.rows.map((row, index) => (
                  <li key={row.key} className="fw-qd-delivery">
                    <div className="fw-qd-delivery-head">
                      <strong>{t('drawer.deliveryN', { n: index + 1 })}</strong>
                      {!model.readOnly && (
                        <Button size="sm" variant="quiet" onClick={() => actions?.onRows?.(model.rows.filter((entry) => entry.key !== row.key))} aria-label={t('drawer.removeDelivery', { n: index + 1 })}>
                          <Trash2 size={14} aria-hidden />
                        </Button>
                      )}
                    </div>
                    {model.readOnly ? (
                      <p>
                        {row.date ? day(row.date) : '—'} · {line.kind === 'SIZE_GRID' ? sizesText(Object.fromEntries(Object.entries(row.sizes).map(([size, text]) => [size, Number(text) || 0])), line.sizes.map((entry) => entry.size)) || '—' : t('drawer.theUnit')}
                        {row.note ? ` · ${row.note}` : ''}
                      </p>
                    ) : (
                      <div className="fw-qd-delivery-fields">
                        <Field label={t('drawer.date')}>
                          <DateField value={row.date} onChange={(value) => setRow(row.key, { date: value })} locale={INTL_LOCALE[locale]} min={model.today} />
                        </Field>
                        {line.kind === 'SIZE_GRID' && (
                          <div className="fw-qd-delivery-sizes" role="group" aria-label={t('drawer.piecesOf', { n: index + 1 })}>
                            {line.sizes.map((size) => (
                              <Field key={size.size} label={t('drawer.sizeOf', { size: size.size, max: size.quantity })}>
                                <Input size="sm" inputMode="numeric" value={row.sizes[size.size] ?? ''} placeholder="0" onChange={(event) => setRow(row.key, { sizes: { ...row.sizes, [size.size]: event.target.value } })} />
                              </Field>
                            ))}
                          </div>
                        )}
                        <Field label={t('drawer.note')}>
                          <Input size="sm" value={row.note} maxLength={500} onChange={(event) => setRow(row.key, { note: event.target.value })} />
                        </Field>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
              {line.kind === 'SIZE_GRID' && model.rows.length > 0 && (
                <p className="fw-q-hint" role="status">
                  {Object.keys(left).length === 0 ? t('drawer.allScheduled') : promise ? t('drawer.rest', { date: day(promise), sizes: sizesText(left, line.sizes.map((entry) => entry.size)) }) : t('drawer.restNoDate', { sizes: sizesText(left, line.sizes.map((entry) => entry.size)) })}
                </p>
              )}
              {problems.length > 0 && changed && (
                <ul className="fw-qd-problems" aria-label={t('drawer.problems')}>
                  {problems.map((problem, index) => (
                    <li key={`${problem.key}-${index}`}>
                      <Tag tone="danger">{say(problem)}</Tag>
                    </li>
                  ))}
                </ul>
              )}
              {model.problem && <Banner tone="danger" title={say(model.problem)} />}
              {!model.readOnly && (
                <div className="fw-qd-actions">
                  <Button size="sm" heldReason={line.kind === 'MADE_TO_MEASURE' && model.rows.length >= 1 ? t('drawer.held.oneUnit') : model.rows.length >= 24 ? t('drawer.held.many') : null} onClick={() => actions?.onRows?.([...model.rows, { key: newRowKey(), date: '', sizes: {}, note: '' }])}>
                    <Plus size={14} aria-hidden /> {t('drawer.addDelivery')}
                  </Button>
                  <span className="fw-qd-grow" />
                  {changed && (
                    <Button size="sm" variant="quiet" onClick={() => actions?.onRows?.(schedule ? schedule.deliveries.map((delivery) => ({ key: delivery.id, date: delivery.deliveryDate, sizes: Object.fromEntries(Object.entries(delivery.sizes ?? {}).map(([size, pieces]) => [size, String(pieces)])), note: delivery.note ?? '' })) : [])}>
                      {t('drawer.discard')}
                    </Button>
                  )}
                  <Button size="sm" variant="primary" heldReason={saveHeld} onClick={() => actions?.onSave?.()}>
                    {model.saving ? <Spinner size={12} /> : null} {t('drawer.save')}
                  </Button>
                </div>
              )}
              {model.readOnly && <p className="fw-q-hint">{say(model.readOnly)}</p>}
            </>
          )}
        </section>

        {(line.description || line.note) && (
          <section className="fw-qd-drawer-part" aria-labelledby="fw-qd-d-notes">
            <h3 className="fw-q-h3" id="fw-qd-d-notes">
              {t('drawer.notes')}
            </h3>
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                ...(line.description ? [{ label: t('drawer.description'), value: line.description }] : []),
                ...(line.note ? [{ label: t('drawer.customerNote'), value: line.note }] : []),
              ]}
            />
          </section>
        )}
      </div>
    </Drawer>
  )
}
