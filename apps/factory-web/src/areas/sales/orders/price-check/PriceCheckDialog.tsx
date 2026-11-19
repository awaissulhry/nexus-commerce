'use client'

import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { money, parsePrice, unitPrice } from '../../quotes/model'
import type { OfficeSource, PriceCheck } from './api'
import { FILE_KEY, isClosedOrder, minorOfTyped, pricePlanOf, saveHeldOf, sourceWords, TOTAL_KEY, type PriceAs } from './model'
import type { PriceCheckDialogActions, PriceCheckDialogModel } from './use-price-check'
import './price-check.css'

/**
 * F-CP-114 (customer page plan C2d, C3; design 11-money §3.3, picture 21 "Customer's price…"; review A3; lead pick "one editor, two
 * doors") — the ONE window where the office types the customer's price of an order: a centred DS Modal (a sheet on a phone) with
 * where it comes from (From the customer's PO · Typed by us) and the PO file (this order's files; saving marks it priced), a row per
 * line (Line · Pieces · Our unit price · the customer's price as Unit price / Line total · Without VAT), one optional "Customer's total
 * for the whole order" and a note. Save prices is held in words while nothing changed, a value is no amount, the order is closed or
 * cancelled, or the reader may not change orders. ONE banner: "Someone changed these prices meanwhile. Here they are now." after a
 * 409, or a refused save in words. The Work tab opens it (row ⋯ "Set customer's price…", the Customer's price cell); the order page's
 * Money tab mounts the same window later (F-CP-142). Draws its model; the hook (use-price-check.ts) reads and saves.
 */
export function PriceCheckDialog(props: { model: PriceCheckDialogModel; actions?: PriceCheckDialogActions | undefined }) {
  return (
    <WithMessages namespaces={['orders']}>
      <Dialog {...props} />
    </WithMessages>
  )
}

function Dialog({ model, actions }: { model: PriceCheckDialogModel; actions?: PriceCheckDialogActions | undefined }) {
  const t = useT('orders')
  const check = model.read.status === 'ready' ? model.read.check : null
  const held = check && model.draft ? saveHeldOf(check, pricePlanOf(check, model.draft), model.busy) : model.read.status === 'reading' ? { key: 'priceCheck.reading' } : { key: 'priceCheck.readFailed' }
  return (
    <Modal
      open
      size="lg"
      sheet
      onClose={() => actions?.onClose?.()}
      closeHeld={model.busy ? t('priceCheck.saving') : null}
      busy={model.read.status === 'reading'}
      title={t('priceCheck.title', { number: check?.number ?? model.number })}
      subtitle={check ? t('priceCheck.currency', { currency: check.currency }) : undefined}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" heldReason={model.busy ? t('priceCheck.saving') : null} onClick={() => actions?.onClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onSave?.()}>
            {t('priceCheck.save')}
          </Button>
        </>
      }
    >
      <PriceCheckBody model={model} actions={actions} />
    </Modal>
  )
}

/** The window's content (drawn on its own by the tests and the design cases: the DS Modal draws nothing before hydration). */
export function PriceCheckBody({ model, actions }: { model: PriceCheckDialogModel; actions?: PriceCheckDialogActions | undefined }) {
  const t = useT('orders')
  if (model.read.status === 'reading')
    return (
      <div className="fw-pc" role="status" aria-busy="true" aria-label={t('priceCheck.reading')}>
        <Skeleton height={32} />
        <Skeleton height={120} />
        <Skeleton height={32} />
      </div>
    )
  if (model.read.status === 'failed')
    return (
      <div className="fw-pc">
        <Banner
          tone="danger"
          title={t('priceCheck.readFailed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.read.problem)}
        </Banner>
      </div>
    )
  if (!model.draft) return null
  return <PriceForm check={model.read.check} model={model} actions={actions} />
}

function PriceForm({ check, model, actions }: { check: PriceCheck; model: PriceCheckDialogModel; actions?: PriceCheckDialogActions | undefined }) {
  const t = useT('orders')
  const locale = useLocale()
  const draft = model.draft!
  const closed = isClosedOrder(check.status)
  // Held, not hidden: a closed or cancelled order (or a reader who may not change orders) reads the prices, typing nothing.
  const writable = !closed && check.mayWrite.allowed && !model.busy
  const plan = pricePlanOf(check, draft)
  const problems = { ...(plan.kind === 'problems' ? plan.problems : {}), ...model.fields }
  const say = (phrase: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | undefined) => (phrase ? t(phrase.key, phrase.params) : undefined)
  // ONE banner: the refusal or "Here they are now" first; else why nothing can be typed.
  const banner = model.notice ? (
    <Banner tone={model.notice.tone} title={say(model.notice.words)} />
  ) : closed ? (
    <Banner tone="info" title={t('priceCheck.closed')} />
  ) : !check.mayWrite.allowed ? (
    <Banner tone="info" title={t('held.noManage')} />
  ) : null
  const asOptions = [
    { value: 'unit', label: t('priceCheck.unit') },
    { value: 'line', label: t('priceCheck.lineTotal') },
  ]
  const valueText = (as: PriceAs, value: string) => (value.trim() === '' ? '—' : as === 'unit' ? unitPrice(parsePrice(value), check.currency, locale) : money(minorOfTyped(value), check.currency, locale))
  const rows = check.lines.map((line) => {
    const typed = draft.lines[line.lineId] ?? { as: 'unit' as const, value: '' }
    const problem = say(problems[line.lineId])
    return {
      id: line.lineId,
      cells: [
        <span key="line" className="fw-pc-line">
          <span>{`${line.seq} · ${line.label}`}</span>
          {line.row && <span className="nds-summary-sub">{t(sourceWords(line.row.source))}</span>}
        </span>,
        formatNumber(line.pieces, locale),
        unitPrice(line.ourUnitPrice, check.currency, locale),
        writable ? (
          <SegmentedControl key="as" size="sm" ariaLabel={t('priceCheck.asOf', { line: line.label })} value={typed.as} onChange={(value) => actions?.onLine?.(line.lineId, { as: value as PriceAs })} options={asOptions} />
        ) : (
          t(typed.as === 'unit' ? 'priceCheck.unit' : 'priceCheck.lineTotal')
        ),
        writable ? (
          <span key="value" className="fw-pc-value">
            <Input size="sm" inputMode="decimal" prefix={check.currency} aria-label={t('priceCheck.valueOf', { line: line.label })} aria-invalid={problem ? true : undefined} value={typed.value} onChange={(event) => actions?.onLine?.(line.lineId, { value: event.target.value })} />
            {problem && <span className="fw-pc-error">{problem}</span>}
          </span>
        ) : (
          valueText(typed.as, typed.value)
        ),
      ],
    }
  })
  const fileProblem = say(problems[FILE_KEY])
  const totalProblem = say(problems[TOTAL_KEY])
  return (
    <div className="fw-pc">
      {banner}
      {check.total.priceOtherCurrency > 0 && <p className="fw-pc-hint">{t('priceCheck.otherCurrency', { count: check.total.priceOtherCurrency })}</p>}
      <div className="fw-pc-row">
        <Field label={t('priceCheck.source')}>
          <SegmentedControl
            size="sm"
            ariaLabel={t('priceCheck.source')}
            disabled={!writable}
            value={draft.source}
            onChange={(value) => actions?.onSource?.(value as OfficeSource)}
            options={[
              { value: 'CUSTOMER_PO', label: t('priceCheck.fromPo') },
              { value: 'OFFICE', label: t('priceCheck.typedByUs') },
            ]}
          />
        </Field>
        {draft.source === 'CUSTOMER_PO' && (
          <Field label={t('priceCheck.poFile')} hint={t('priceCheck.poFileHint')} error={fileProblem}>
            {model.files.status === 'failed' ? (
              <span className="fw-pc-inline">
                <span className="fw-pc-hint">{t('priceCheck.filesFailed')}</span>
                <Button size="sm" variant="quiet" onClick={() => actions?.onRetryFiles?.()}>
                  {t('common.retry')}
                </Button>
              </span>
            ) : (
              <Select size="sm" value={draft.fileId} disabled={!writable || model.files.status === 'reading'} onChange={(event) => actions?.onFile?.(event.target.value)}>
                <option value="">{model.files.status === 'reading' ? t('priceCheck.filesReading') : t('priceCheck.poFileNone')}</option>
                {model.files.status === 'ready' && model.files.files.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      <SummaryTable
        label={t('priceCheck.tableLabel', { number: check.number })}
        density="roomy"
        stackOnPhone
        columns={[t('priceCheck.col.line'), t('priceCheck.col.pieces'), t('priceCheck.col.ours'), t('priceCheck.col.as'), t('priceCheck.col.value')]}
        align={['left', 'right', 'right', 'left', 'left']}
        widths={['30%', '10%', '16%', '24%', '20%']}
        rows={rows}
      />
      <div className="fw-pc-row">
        <Field label={`${t('priceCheck.orderTotal')} ${t('priceCheck.optional')}`} hint={t('priceCheck.orderTotalHint')} error={totalProblem}>
          {writable ? (
            <Input size="sm" inputMode="decimal" prefix={check.currency} value={draft.total} onChange={(event) => actions?.onTotal?.(event.target.value)} />
          ) : (
            <span>{check.total.row?.netAmount != null ? money(check.total.row.netAmount, check.currency, locale) : '—'}</span>
          )}
        </Field>
        <Field label={t('priceCheck.note')}>
          {writable ? <Input size="sm" value={draft.note} maxLength={1000} onChange={(event) => actions?.onNote?.(event.target.value)} /> : <span>{draft.note || '—'}</span>}
        </Field>
      </div>
    </div>
  )
}
