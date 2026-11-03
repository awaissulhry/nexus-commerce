'use client'

import { useRef } from 'react'
import Link from 'next/link'
import { Calculator, Plus, Receipt, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, SourceIndicator, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { COST_KINDS, type CostLine, type NcrRecord } from '../../api'
import { costDraftHeld, costEditHeld, majorText, minorOf, NEW_COST, recordHref, type CostDraft, type NcrRecordActions, type NcrRecordModel } from '../view-model'
import { CellMark, type RecordWords } from './words'

/**
 * Cost (B-W2b-113; QHS-086; design rec NCR › cost, ncr-cost "Cost of this NCR": material, labour, rework time, scrap value,
 * freight — "Lines with amounts and source (computed from moves and rework scans, or typed); total; 'Charge to supplier' →
 * debit note draft in Finance"; "Typed lines autosave; computed lines read-only with SourceIndicator"; the whole tab is the
 * cost grain). The office with the cost grain only (the tab is absent otherwise; by address it says so). A typed line saves
 * on its own (amount, kind, words: per cell, its own version); a computed line is read-only and names its record, and
 * "Compute again" brings them up to date. "Charge to supplier" is held with its reason: there is no debit note yet (Finance,
 * later), the supplier claim of a Return to supplier decision asks the credit today. Amounts in the company's currency.
 */
export function CostTab({ model, record, words, actions }: { model: NcrRecordModel; record: NcrRecord; words: RecordWords; actions?: NcrRecordActions }) {
  const { t, r, sayAny, locale } = words
  const cost = model.cost
  const act = useRef(actions)
  act.current = actions
  if (!record.may.cost || !model.can.cost) return <EmptyState title={r('cost.forbidden')} description={r('cost.forbiddenBody')} />
  if (!cost || cost.loaded.status === 'idle' || cost.loaded.status === 'loading')
    return (
      <Card padded>
        <Skeleton height={140} />
      </Card>
    )
  if (cost.loaded.status === 'forbidden') return <EmptyState title={r('cost.forbidden')} description={r('cost.forbiddenBody')} />
  if (cost.loaded.status === 'error')
    return (
      <Banner tone="danger" title={r('cost.failed')} action={<Button size="sm" variant="quiet" onClick={() => actions?.cost?.onRetry?.()}>{t('common.retry')}</Button>}>
        {cost.loaded.problem}
      </Banner>
    )
  const sheet = cost.loaded.sheet
  // The record a computed line comes from, in our words (a decision of this NCR, a rework order, a stock move).
  const recordWords = (type: string) => r(['NcrDispositionLine', 'ReworkOrder', 'StockMove'].includes(type) ? `cost.record.${type}` : 'cost.record.other')
  const money = (minor: number | null | undefined) => (minor === null || minor === undefined ? '—' : new Intl.NumberFormat(locale, { style: 'currency', currency: sheet.currency }).format(minor / 100))
  const held = costEditHeld(record, model.can)
  const heldWords = sayAny(held)
  const editable = held === null
  const adding = cost.adding
  const addHeld = adding ? costDraftHeld(adding) : null
  const computeHeld = held ? heldWords : sheet.computed.upToDate ? r('cost.upToDate') : cost.computing ? t('common.working') : null

  const kindSelect = (value: string, onChange: (kind: CostDraft['kind']) => void, label: string, disabled = false) => (
    <Select size="sm" aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as CostDraft['kind'])}>
      {COST_KINDS.map((kind) => (
        <option key={kind} value={kind}>
          {r(`cost.kind.${kind}`)}
        </option>
      ))}
    </Select>
  )

  const rows = sheet.lines.map((line: CostLine) => {
    const typed = line.source === 'TYPED' && editable
    const source = line.source === 'COMPUTED' ? (
      <span className="fw-ncr-r-row">
        <SourceIndicator kind="formula" label={r('cost.computed')} description={line.record ? r('cost.computedFrom', { record: recordWords(line.record.type), label: line.record.label ?? '—' }) : r('cost.computed')} />
        {line.record ? (
          line.record.type === 'NcrDispositionLine' ? (
            <span>{`${recordWords(line.record.type)} ${line.record.label ?? ''}`.trim()}</span>
          ) : (
            <Link className="fw-q-link" href={recordHref(model.prefix, { type: line.record.type, id: line.record.id, label: line.record.label })}>
              {`${recordWords(line.record.type)} ${line.record.label ?? ''}`.trim()}
            </Link>
          )
        ) : (
          <span className="fw-ncr-r-sub">{r('cost.computed')}</span>
        )}
      </span>
    ) : (
      <span className="fw-ncr-r-row">
        <SourceIndicator kind="override" label={r('cost.typed')} description={r('cost.typedHint')} />
        <span className="fw-ncr-r-sub">{r('cost.typed')}</span>
      </span>
    )
    return {
      id: line.id,
      cells: [
        typed ? (
          <span className="fw-ncr-r-row">
            {kindSelect(line.kind, (kind) => act.current?.cost?.onCell?.(line.id, { kind }, 'kind'), r('cost.cellKind', { seq: line.seq }))}
            <CellMark cell={cost.cells[`${line.id}:kind`]} />
          </span>
        ) : (
          r(`cost.kind.${line.kind}`)
        ),
        typed ? (
          <span className="fw-ncr-r-row fw-ncr-cost-words">
            <Input
              size="xs"
              aria-label={r('cost.cellWords', { seq: line.seq })}
              defaultValue={line.description ?? ''}
              key={`${line.id}:${line.version}:d`}
              maxLength={200}
              onBlur={(event) => {
                const next = event.target.value.trim()
                if (next !== (line.description ?? '')) act.current?.cost?.onCell?.(line.id, { description: next || null }, 'description')
              }}
            />
            <CellMark cell={cost.cells[`${line.id}:description`]} />
          </span>
        ) : (
          (line.description ?? '—')
        ),
        source,
        typed ? (
          <span className="fw-ncr-r-row fw-ncr-cost-amount">
            <Input
              size="xs"
              inputMode="decimal"
              aria-label={r('cost.cellAmount', { seq: line.seq })}
              defaultValue={line.amount === undefined ? '' : majorText(line.amount)}
              key={`${line.id}:${line.version}:a`}
              className="fw-ncr-r-qty"
              onBlur={(event) => {
                const next = minorOf(event.target.value)
                if (next !== null && next !== line.amount) act.current?.cost?.onCell?.(line.id, { amount: next }, 'amount')
              }}
            />
            <CellMark cell={cost.cells[`${line.id}:amount`]} />
          </span>
        ) : (
          <span className="fw-q-num">{money(line.amount)}</span>
        ),
        line.source === 'TYPED' ? (
          <Button size="xs" variant="quiet" heldReason={heldWords} aria-label={r('cost.removeOne', { seq: line.seq })} onClick={() => act.current?.cost?.onRemove?.(line.id)}>
            <Trash2 size={13} aria-hidden /> {r('cost.remove')}
          </Button>
        ) : (
          <span className="fw-ncr-r-sub">{r('cost.readOnly')}</span>
        ),
      ],
    }
  })

  return (
    <div className="fw-q-stack">
      <Card padded>
        <div className="fw-ncr-head">
          <div className="fw-q-stack">
            <h2 className="fw-ncr-h3">{r('cost.title')}</h2>
            <p className="fw-q-hint">{r('cost.body')}</p>
          </div>
          <div className="fw-ncr-r-row">
            <Button size="sm" variant="secondary" heldReason={computeHeld} onClick={() => actions?.cost?.onCompute?.()}>
              {cost.computing ? <Spinner size={12} /> : <Calculator size={14} aria-hidden />} {r('cost.compute')}
            </Button>
            <Button size="sm" variant="primary" heldReason={heldWords ?? (adding ? r('cost.heldAdding') : null)} onClick={() => actions?.cost?.onAdd?.(NEW_COST)}>
              <Plus size={14} aria-hidden /> {r('cost.add')}
            </Button>
          </div>
        </div>
        {!sheet.computed.upToDate && !held && (
          <p className="fw-q-hint">{r('cost.stale', { add: sheet.computed.add, change: sheet.computed.change, remove: sheet.computed.remove })}</p>
        )}
      </Card>
      {held && <Banner tone="info" title={heldWords ?? ''} />}
      {sheet.computed.waiting.length > 0 && (
        <Banner tone="warning" title={r('cost.waitingTitle', { count: sheet.computed.waiting.length })}>
          <ul className="fw-q-lines">
            {sheet.computed.waiting.map((entry) => (
              <li key={entry.recordId}>{`${recordWords(entry.recordType)} ${entry.label ?? ''}: ${r(entry.recordType === 'ReworkOrder' ? 'cost.waitingRework' : 'cost.waitingDecision')}`}</li>
            ))}
          </ul>
        </Banner>
      )}
      <Card padded>
        {sheet.lines.length === 0 && !adding ? (
          <EmptyState title={r('cost.empty')} description={r('cost.emptyBody')} />
        ) : (
          <SummaryTable
            label={r('cost.label')}
            columns={[r('cost.col.kind'), r('cost.col.words'), r('cost.col.source'), r('cost.col.amount'), t('col.actions')]}
            rows={rows}
            density="roomy"
            stackOnPhone
            align={['left', 'left', 'left', 'right', 'right']}
            widths={['18%', '30%', '26%', '14%', '12%']}
          />
        )}
        {adding && (
          <div className="fw-ncr-cost-new" role="group" aria-label={r('cost.newLabel')}>
            <Field label={r('cost.col.kind')}>{kindSelect(adding.kind, (kind) => actions?.cost?.onAdd?.({ ...adding, kind }), r('cost.col.kind'))}</Field>
            <Field label={r('cost.col.words')} hint={adding.kind === 'OTHER' ? r('cost.otherHint') : undefined}>
              <Input value={adding.description} maxLength={200} onChange={(event) => actions?.cost?.onAdd?.({ ...adding, description: event.target.value })} />
            </Field>
            <Field label={r('cost.amountIn', { currency: sheet.currency })} required>
              <Input inputMode="decimal" value={adding.amount} onChange={(event) => actions?.cost?.onAdd?.({ ...adding, amount: event.target.value })} />
            </Field>
            <div className="fw-ncr-r-row">
              <Button size="sm" variant="secondary" onClick={() => actions?.cost?.onAdd?.(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="primary" heldReason={cost.busy ? t('common.working') : addHeld ? r(addHeld) : null} onClick={() => actions?.cost?.onSaveNew?.()}>
                {cost.busy ? <Spinner size={12} /> : null} {r('cost.saveNew')}
              </Button>
            </div>
          </div>
        )}
        <div className="fw-ncr-cost-total" aria-live="polite">
          <span>{r('cost.total')}</span>
          <strong className="fw-q-num">{money(sheet.total)}</strong>
        </div>
      </Card>
      <Card padded>
        <div className="fw-ncr-head">
          <div className="fw-q-stack">
            <h3 className="fw-ncr-h3">{r('cost.chargeTitle')}</h3>
            <p className="fw-q-hint">{r('cost.chargeBody')}</p>
          </div>
          <Button size="sm" variant="secondary" heldReason={r('cost.chargeHeld')}>
            <Receipt size={14} aria-hidden /> {r('cost.charge')}
          </Button>
        </div>
      </Card>
      <p className="fw-q-hint">{r('cost.foot')}</p>
    </div>
  )
}
