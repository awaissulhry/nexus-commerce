'use client'

import { CircleAlert, Hourglass } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { draftTitleOf, productRowsOf, rowLabelOf } from '../../../../../lib/order-draft/model'
import type { DraftRecord } from '../../../../../lib/order-draft/schema'
import { useDraftWords } from '../../../../../lib/order-draft/words'
import { useSizeCopy } from '../../../../../lib/order-draft/view/RowWindows'
import { SizeGridEditor } from '@nexus/ui/grid/size-grid/index'
import type { StyleDetail } from '../../../inquiries/api'
import { useFlowWords } from '../../record/flow-words'
import { cellsOf, confirmAsOf, confirmHeldOf, missingOf, openDetailsOf, productHeldOf, promiseProblemOf, sizesTextOf } from '../confirm-model'
import type { ConfirmActions, ConfirmState } from '../use-confirm-order'
import { YellowLine } from '../../../../../lib/record-sections/YellowLine' // owb-of7 step 4
import './office-draft.css'

export interface ConfirmWindowModel {
  readonly record: DraftRecord
  readonly confirm: ConfirmState
  readonly details: Readonly<Record<string, StyleDetail>>
  /** The styles the product picker offers (the customer's own and the open ones); null while read. */
  readonly styles: readonly { readonly id: string; readonly code: string; readonly name: string }[] | null
  /** Why nothing can be written (a reader): the window's act holds with it. */
  readonly writeHeld: string | null
  /** Today in the company's zone (YYYY-MM-DD): a promised day before it is refused. */
  readonly today: string
}

/**
 * owb-of5 step 4 (design plan § 5g, § 5zl A; prototype office.js officeModal confirm, core.js confirm) — THE Confirm window, one for the
 * band, the orders sheet and Incoming: the promised day (beside the day the customer wants; a past or empty day refused in words), the
 * open details as yellow lines (only what is NOT a stop today), one section per row with what the order still needs (a product, a
 * colour, pieces: today's fields). A line without a product → "Pick the product first" and the main button held (A-5, L1). Draws its
 * model; fetches nothing (the container's hook reads and sends).
 */
export function ConfirmOrderWindowView({ model, actions }: { model: ConfirmWindowModel; actions?: ConfirmActions }) {
  const { t, locale } = useDraftWords()
  const f = useFlowWords()
  const copy = useSizeCopy()
  const { record, confirm } = model
  const rows = productRowsOf(record.request)
  const quote = confirmAsOf(rows) === 'QUOTE'
  const product = productHeldOf(rows, confirm.entries)
  const promise = promiseProblemOf(confirm.promise, model.today)
  const held = confirmHeldOf(rows, confirm.entries)
  const open = openDetailsOf(record.request.stillOpen, rows, t)
  const title = draftTitleOf(record.request, t)
  const styles = model.styles ?? []
  const travel = rows.flatMap((row) => row.choices.map((choice) => `${choice.topic}: ${choice.picked ?? t('state.OPEN')}`))
  const missing = <Tag tone="danger">{t('state.MISSING')}</Tag>
  const wanted = record.request.requestedDate
  // The act's held words, the first that holds: who may not write, a send running, a line without a product, the promised day, a row's need.
  const actHeld =
    model.writeHeld ??
    (confirm.busy ? t('save.saving') : null) ??
    (product ? f('cf.pickProduct', { seq: product.seq }) : null) ??
    (promise ? f(promise) : null) ??
    (held ? (held.seq === 0 ? t('cf.noRows') : t('cf.heldRow', { seq: held.seq, list: held.needs.map((key) => t(key)).join(', ') })) : null)
  return (
    <Modal
      open
      sheet
      size="lg"
      onClose={() => actions?.onClose?.()}
      title={t(quote ? 'cf.windowQuote' : 'cf.window', { title })}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.onClose?.()} disabled={confirm.busy}>
            {t('pc.cancel')}
          </Button>
          <Button variant="primary" heldReason={actHeld} onClick={() => actions?.onSend?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {quote ? t('cf.goQuote') : t('cf.title')}
          </Button>
        </>
      }
    >
      <div className="fw-od-dialog">
        {confirm.failed ? <Banner tone="danger" title={confirm.failed === 'cf.failed' ? f('cf.failed') : confirm.failed} /> : null}
        {/* A-5 (the one stop that stays): a line without a product — pick it here, or in the sheet; the main button waits. */}
        {product ? (
          <Banner tone="danger" title={f('cf.pickProductTitle')}>
            {f('cf.pickProductWhy', { seq: product.seq })}
          </Banner>
        ) : null}
        {quote ? <Banner tone="info" title={t('cf.quote', { seq: rows.find((row) => row.sizing === 'MADE_TO_MEASURE')!.seq })} /> : null}
        {/* The promised day, beside the day the customer wants: the customer sees it; a past or empty day is refused in words. */}
        <div className="fw-od-fields">
          <Field label={f('cf.promised')} error={promise ? f(promise) : undefined} hint={f('cf.promiseHint')}>
            <Input type="date" value={confirm.promise} min={model.today} onChange={(event) => actions?.onPromise?.(event.target.value)} aria-invalid={promise ? true : undefined} />
          </Field>
          <Field label={f('cf.wanted')}>
            <span>{wanted ? formatDate(`${wanted.slice(0, 10)}T12:00:00Z`, { locale }) : f('cf.wantedNone')}</span>
          </Field>
        </div>
        {/* The open details: yellow lines — what is still open and does NOT stop the confirm (the history keeps it). */}
        {open.length > 0 ? (
          // owb-of7 step 4: the open details are THE yellow line (lib/record-sections YellowLine): the words, then "Go on" = confirm
          // with them open (the same act and the same held words as the window's main button).
          <YellowLine onGoOn={() => actions?.onSend?.()} held={actHeld}>
            <strong>{f('cf.openTitle', { count: open.length })}</strong>
            <ul className="fw-od-notes">
              {open.map((entry) => (
                <li key={entry.id}>
                  <Hourglass size={14} aria-hidden /> <strong>{entry.label}</strong>
                  {entry.what ? `: ${entry.what}` : ''}
                </li>
              ))}
            </ul>
            <p className="fw-od-quiet">{f('cf.openWhy')}</p>
          </YellowLine>
        ) : null}
        {rows.map((row) => {
          const entry = confirm.entries[row.id]
          if (!entry) return null
          const needs = missingOf(row, entry)
          const colours = entry.styleId ? (model.details[entry.styleId]?.colourways ?? []).filter((colourway) => colourway.status === 'ACTIVE') : []
          const colour = colours.find((colourway) => colourway.id === entry.colourwayId) ?? null
          const offered = colour?.offeredSizes ?? []
          return (
            <section key={row.id} className="fw-od-section fw-od-confirmrow" aria-label={rowLabelOf(row, t)}>
              <div className="fw-od-parthead">
                <strong>{rowLabelOf(row, t)}</strong>
                {row.sizing ? <Tag tone="info">{t(`siz.${row.sizing}`)}</Tag> : null}
                {needs.length === 0 ? <Tag tone="success">{t('state.DECIDED')}</Tag> : null}
                {!entry.styleId ? (
                  <Tag tone="danger">
                    <CircleAlert size={12} aria-hidden /> {f('cf.noProduct')}
                  </Tag>
                ) : null}
              </div>
              {entry.needs ? (
                <div className="fw-od-fields">
                  <Field label={<>{t('row.style')} {!entry.styleId ? missing : null}</>}>
                    <Select value={entry.styleId ?? ''} onChange={(event) => actions?.onStyle?.(row.id, event.target.value)}>
                      <option value="">{t('cf.pickStyle')}</option>
                      {styles.map((style) => (
                        <option key={style.id} value={style.id}>
                          {style.code} · {style.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={<>{t('col.colour')} {!entry.colourwayId ? missing : null}</>}>
                    <Select value={entry.colourwayId ?? ''} disabled={!entry.styleId} onChange={(event) => actions?.onEntry?.(row.id, { colourwayId: event.target.value || null })}>
                      <option value="">{t('cf.pickColour')}</option>
                      {colours.map((colourway) => (
                        <option key={colourway.id} value={colourway.id}>
                          {colourway.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={<>{t('pc.sizesCaption')} {needs.includes('need.pieces') ? missing : null}</>} hint={row.pieces.mode === 'PEOPLE' ? t('cf.fromPeople', { count: row.pieces.people }) : entry.styleId ? undefined : t('cf.sizesAfterStyle')}>
                    {/* od-w2.5: the style's size grid once a colour with its sizes is picked; typed only when the style has no size chart. */}
                    {offered.length > 0 && colour ? (
                      <SizeGridEditor
                        layout="auto"
                        colours={[{ key: row.id, label: colour.name, offered: [...offered] }]}
                        sizes={offered.map((size) => ({ key: size, label: size }))}
                        value={{ [row.id]: cellsOf(entry.sizesText) }}
                        onChange={(next) => actions?.onEntry?.(row.id, { sizesText: sizesTextOf(next[row.id] ?? {}) })}
                        issues={[]}
                        caption={`${t('pc.sizesCaption')} · ${rowLabelOf(row, t)}`}
                        locale={INTL_LOCALE[locale]}
                        copy={copy}
                      />
                    ) : (
                      <Input value={entry.sizesText} placeholder="48:2 50:3" disabled={entry.styleId !== null && entry.colourwayId === null} onChange={(event) => actions?.onEntry?.(row.id, { sizesText: event.target.value })} />
                    )}
                  </Field>
                  {record.seesPrices ? (
                    <Field label={t('cf.unit')}>
                      <Input value={entry.unitPrice} inputMode="decimal" onChange={(event) => actions?.onEntry?.(row.id, { unitPrice: event.target.value })} />
                    </Field>
                  ) : null}
                </div>
              ) : (
                <div className="fw-od-fields">
                  <p className="fw-od-quiet">
                    {t('cf.fromDraft')}: {entry.sizesText.replace(/:/g, ' × ')}
                  </p>
                  {record.seesPrices ? (
                    <Field label={`${t('cf.unit')} · ${t('cf.listPrice')}`}>
                      <Input value={entry.unitPrice} inputMode="decimal" onChange={(event) => actions?.onEntry?.(row.id, { unitPrice: event.target.value })} />
                    </Field>
                  ) : null}
                </div>
              )}
            </section>
          )
        })}
        {travel.length > 0 ? <p className="fw-od-quiet">{t(quote ? 'cf.travelQuote' : 'cf.travel', { words: travel.join(' · ') })}</p> : null}
      </div>
    </Modal>
  )
}
