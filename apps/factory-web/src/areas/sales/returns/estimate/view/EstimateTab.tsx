'use client'

import { useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Plus, Send, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select, Skeleton, Tag, type Tone } from '@nexus/ui/primitives'
import { CellSaveMark } from '../../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { Section } from '../../../../quality/_shared/parts'
import type { RepairActions, RepairModel } from '../../view-model'
import { DayText, InstantText, Money, say, useWords } from '../../view/parts'
import type { Estimate, EstimateLine, EstimateStatus } from '../api'
import { BLANK_ANSWER, decisionWords, estimateHeld, newEstimateHeld, shownEstimate, termsOf, workHeldWords, type LineField } from '../model'
import { EMPTY_ESTIMATE } from '../view-model'
import { EstimateDialogs } from './EstimateDialogs'

/**
 * Repair order › Estimate (B-W2b-352; design sales.returns › Repair order › repair.estimate, SAL-387): the parts and labour
 * the customer approves before the work starts. The revision shown (each revision kept: the history under the grid), its
 * state and the customer's decision with its time, the steps (New estimate — a sent one replaced on purpose —, Edit terms,
 * Send, Record the answer, Withdraw; each held with why), the lines in the shared list frame autosaved per cell (Part or
 * job, Qty, Price, Labour minutes, Total; our cost with the cost grain), Add part / Add labour, Remove N on the rows picked,
 * the sums, and what the estimate holds of the work. Prices only with the price grain. Fetches nothing.
 */

const STATUS_TONE: Readonly<Record<EstimateStatus, Tone>> = { DRAFT: 'info', SENT: 'warning', ACCEPTED: 'success', DECLINED: 'danger', WITHDRAWN: 'neutral' }

function EstimateStatusPill({ status }: { status: EstimateStatus }) {
  const t = useWords()
  return <Pill tone={STATUS_TONE[status]}>{t(`depth:estimate.status.${status}`)}</Pill>
}

export function EstimateTab({ model, actions }: { model: RepairModel; actions?: RepairActions }) {
  const t = useWords()
  const estimates = model.estimate ?? EMPTY_ESTIMATE
  const answer = estimates.value
  if (!model.can.repairsView) return <Banner tone="info" title={t('held.right.repairsView')} />
  if (!answer)
    return estimates.problem ? (
      <Banner
        tone="warning"
        title={t('depth:estimate.failed')}
        action={
          <Button size="sm" onClick={() => actions?.onEstimateRetry?.()}>
            {t('quality:common.retry')}
          </Button>
        }
      >
        {t(estimates.problem)}
      </Banner>
    ) : (
      <Card padded>
        <div className="fw-q-stack" role="status" aria-label={t('quality:common.loading')}>
          <Skeleton height={28} />
          <Skeleton height={160} />
        </div>
      </Card>
    )
  const estimate = shownEstimate(answer, estimates.shownId)
  const newHeld = newEstimateHeld(answer, model.can, model.offline)
  const replaces = answer.newEstimate.replaces
  const work = workHeldWords(answer, model.repair.stage === 'ESTIMATED' ? 'approve' : 'startRepair')
  return (
    <div className="fw-q-stack">
      {estimates.problem && <Banner tone="warning" title={t('depth:estimate.failed')}>{t(estimates.problem)}</Banner>}
      {!answer.seesPrices && <Banner tone="info" title={t('depth:estimate.noPrices')} />}
      {work && <Banner tone="warning" title={say(t, work)} />}
      {!estimate ? (
        <Card padded>
          <EmptyState
            title={t('depth:estimate.empty')}
            description={t('depth:estimate.emptyBody')}
            action={
              <Button variant="primary" heldReason={newHeld ? say(t, newHeld) : null} onClick={() => actions?.onEstimateDialog?.({ kind: 'new', replaces: null })}>
                <Plus size={14} aria-hidden /> {t('depth:estimate.new')}
              </Button>
            }
          />
        </Card>
      ) : (
        <EstimateBody key={estimate.id} model={model} estimate={estimate} actions={actions} newHeld={newHeld ? say(t, newHeld) : null} replaces={replaces} />
      )}
      <EstimateDialogs model={model} estimates={estimates} actions={actions} />
    </div>
  )
}

function EstimateBody({ model, estimate, actions, newHeld, replaces }: { model: RepairModel; estimate: Estimate; actions?: RepairActions; newHeld: string | null; replaces: string | null }) {
  const t = useWords()
  const locale = useLocale()
  const answer = model.estimate!.value!
  const { can } = model
  const held = (action: Parameters<typeof estimateHeld>[0]) => {
    const words = estimateHeld(action, estimate, answer, can, model.offline, model.today)
    return words ? say(t, words) : null
  }
  const editHeld = held('edit')
  const editable = editHeld === null
  const [selected, setSelected] = useState<readonly string[]>([])
  const nameOf = (id: string | null) => (id ? (answer.people.find((person) => person.id === id)?.name ?? null) : null)
  const decision = decisionWords(estimate)
  const sentBy = nameOf(estimate.sentById)
  const recordedBy = nameOf(estimate.recordedById)
  const price = (value: string | undefined) => (value === undefined ? '—' : formatNumber(Number(value), locale, { style: 'currency', currency: estimate.currency }))

  const latest = useRef({ actions, model })
  latest.current = { actions, model }
  const marksKey = JSON.stringify(model.estimate?.marks ?? {})
  const columns = useMemo<ColDef<EstimateLine>[]>(() => {
    const Mark = ({ id, field }: { id: string; field: LineField }) => {
      const mark = latest.current.model.estimate?.marks[`${id}:${field}`]
      if (!mark) return null
      return mark.state === 'refused' ? (
        <span className="fw-rr-refused" role="img" aria-label={say(t, mark.words ?? { key: 'refusal.invalid' })} title={say(t, mark.words ?? { key: 'refusal.invalid' })}>
          !
        </span>
      ) : (
        <CellSaveMark state="saving" />
      )
    }
    const editableCell = (field: LineField, text: (line: EstimateLine) => string, when: (line: EstimateLine) => boolean = () => true): Partial<ColDef<EstimateLine>> =>
      editable
        ? {
            editable: (params) => !!params.data && when(params.data),
            cellEditor: 'agTextCellEditor',
            valueGetter: (params) => (params.data ? text(params.data) : ''),
            valueSetter: (params) => {
              if (params.data && String(params.newValue ?? '') !== text(params.data)) latest.current.actions?.onEstimateCell?.(params.data.id, field, String(params.newValue ?? ''))
              return false
            },
          }
        : {}
    const WhatCell = ({ data }: ICellRendererParams<EstimateLine>) =>
      data ? (
        <span className="fw-rr-cell-edit">
          <span className="fw-q-cell">
            <span className="fw-rr-ellipsis" title={data.description}>
              {data.description}
            </span>
            <span className="fw-q-hint">
              <Tag tone={data.kind === 'LABOUR' ? 'info' : 'neutral'}>{t(`depth:estimate.kind.${data.kind}`)}</Tag> {data.item ? <span className="fw-q-code">{data.item.code}</span> : null}
            </span>
          </span>
          <Mark id={data.id} field="description" />
        </span>
      ) : null
    const NumberCell = (field: LineField, draw: (line: EstimateLine) => string) =>
      function Cell({ data }: ICellRendererParams<EstimateLine>) {
        return data ? (
          <span className="fw-rr-cell-edit">
            <span className="fw-q-num">{draw(data)}</span>
            <Mark id={data.id} field={field} />
          </span>
        ) : null
      }
    const TotalCell = ({ data }: ICellRendererParams<EstimateLine>) => (data ? <Money minor={data.amount ?? null} currency={estimate.currency} /> : null)
    const MoreCell = ({ data }: ICellRendererParams<EstimateLine>) =>
      data ? (
        <Menu
          align="right"
          label={<MoreHorizontal size={16} aria-hidden />}
          triggerProps={{ 'aria-label': t('depth:estimate.lineMenu', { seq: data.seq }) }}
          items={[{ id: 'remove', label: t('depth:estimate.remove'), onSelect: () => latest.current.actions?.onEstimateRemove?.([data.id]), disabled: !editable, description: editHeld ?? undefined }]}
        />
      ) : null
    const column = (colId: string, header: string, cellRenderer: ColDef<EstimateLine>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<EstimateLine> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('line', t('line.col.line'), ({ data }: ICellRendererParams<EstimateLine>) => (data ? <span className="fw-q-num">{data.seq}</span> : null), { width: 76, minWidth: 76, maxWidth: 90 }),
      { ...column('what', t('depth:estimate.col.what'), WhatCell, { flex: 2, minWidth: 220 }), ...editableCell('description', (line) => line.description) },
      { ...column('quantity', t('depth:estimate.col.quantity'), NumberCell('quantity', (line) => formatNumber(Number(line.quantity), locale)), { flex: 0.6, minWidth: 90 }), ...editableCell('quantity', (line) => line.quantity) },
      ...(answer.seesPrices ? [{ ...column('price', t('depth:estimate.col.price'), NumberCell('unitPrice', (line) => price(line.unitPrice)), { flex: 0.9, minWidth: 120 }), ...editableCell('unitPrice', (line) => line.unitPrice ?? '') }] : []),
      { ...column('minutes', t('depth:estimate.col.minutes'), NumberCell('minutes', (line) => (line.minutes === null ? '—' : t('depth:estimate.minutes', { count: line.minutes }))), { flex: 0.8, minWidth: 120 }), ...editableCell('minutes', (line) => (line.minutes === null ? '' : String(line.minutes)), (line) => line.kind === 'LABOUR') },
      ...(answer.seesPrices ? [column('total', t('depth:estimate.col.total'), TotalCell, { flex: 0.9, minWidth: 120 })] : []),
      ...(answer.seesCosts ? [{ ...column('cost', t('depth:estimate.col.cost'), NumberCell('unitCost', (line) => (line.unitCost === null || line.unitCost === undefined ? '—' : price(line.unitCost))), { flex: 0.9, minWidth: 120 }), ...editableCell('unitCost', (line) => line.unitCost ?? '') }] : []),
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true, suppressMovable: true },
    ]
    // The marks redraw the cells.
  }, [t, locale, editable, editHeld, answer.seesPrices, answer.seesCosts, estimate.currency, marksKey])

  const revisionItems = answer.estimates.map((entry) => ({ id: entry.id, label: t('depth:estimate.revisionOption', { revision: entry.revision, status: t(`depth:estimate.status.${entry.status}`) }) }))
  const moreItems: MenuItemDef[] = [
    { id: 'terms', label: t('depth:estimate.terms.open'), onSelect: () => actions?.onEstimateDialog?.({ kind: 'terms', draft: termsOf(estimate) }), disabled: !can.repairsManage || !answer.seesPrices || model.offline, description: !can.repairsManage ? t('held.right.repairsManage') : !answer.seesPrices ? t('depth:estimate.held.prices') : model.offline ? t('held.offline') : undefined },
    { id: 'withdraw', label: t('depth:estimate.withdraw.open'), onSelect: () => actions?.onEstimateDialog?.({ kind: 'withdraw', reason: '' }), disabled: !!held('withdraw'), description: held('withdraw') ?? undefined },
  ]
  const summary = estimate.summary
  const bulk = (
    <Button size="sm" heldReason={editHeld} aria-label={t('depth:estimate.removeN', { count: selected.length })} onClick={() => actions?.onEstimateRemove?.(selected)}>
      <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('depth:estimate.removeN', { count: selected.length })}</SelectionLabel>
    </Button>
  )

  return (
    <>
      <Section
        title={
          <span className="fw-q-cell-row">
            {t('depth:estimate.title', { revision: estimate.revision })} <EstimateStatusPill status={estimate.status} />
          </span>
        }
        sub={t('depth:estimate.sub')}
        actions={
          <span className="fw-q-actions">
            {answer.estimates.length > 1 && (
              <Select size="sm" value={estimate.id} onChange={(event) => actions?.onEstimateShow?.(event.target.value)} aria-label={t('depth:estimate.revisions')}>
                {revisionItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </Select>
            )}
            <Button size="sm" heldReason={newHeld} onClick={() => actions?.onEstimateDialog?.({ kind: 'new', replaces })}>
              <Plus size={14} aria-hidden /> {t(replaces ? 'depth:estimate.revise' : 'depth:estimate.new')}
            </Button>
            {estimate.status === 'SENT' ? (
              <Button size="sm" variant="primary" heldReason={held('answer')} onClick={() => actions?.onEstimateDialog?.({ kind: 'answer', draft: BLANK_ANSWER, showProblems: false })}>
                {t('depth:estimate.answer.open')}
              </Button>
            ) : estimate.status === 'DRAFT' ? (
              <Button size="sm" variant="primary" heldReason={held('send')} onClick={() => actions?.onEstimateDialog?.({ kind: 'send' })}>
                <Send size={14} aria-hidden /> {t('depth:estimate.send.open')}
              </Button>
            ) : null}
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('depth:estimate.more') }} items={moreItems} />
          </span>
        }
      >
        <div className="fw-q-stack">
          {!editable && editHeld && <Banner tone="info" title={t('depth:estimate.readOnly', { why: editHeld })} />}
          <KeyValue
            columns={3}
            items={[
              { label: t('depth:estimate.fact.validUntil'), value: <DayText value={estimate.validUntil} /> },
              { label: t('depth:estimate.fact.sent'), value: estimate.sentAt ? <InstantText value={estimate.sentAt} /> : t('depth:estimate.notSent'), hint: sentBy ? t('depth:estimate.by', { name: sentBy }) : undefined },
              {
                label: t('depth:estimate.fact.decision'),
                value: decision ? (
                  <span className="fw-q-cell">
                    <span>{say(t, decision)}</span>
                    <InstantText value={estimate.answeredAt} />
                  </span>
                ) : (
                  t('depth:estimate.noDecision')
                ),
                hint: recordedBy ? t('depth:estimate.recordedBy', { name: recordedBy }) : estimate.declineReason ? estimate.declineReason : undefined,
              },
              { label: t('depth:estimate.fact.customerNote'), value: estimate.customerNote ?? '—' },
              { label: t('depth:estimate.fact.internalNote'), value: estimate.internalNote ?? '—' },
              ...(estimate.withdrawnAt ? [{ label: t('depth:estimate.fact.withdrawn'), value: <InstantText value={estimate.withdrawnAt} /> }] : []),
            ]}
          />
        </div>
      </Section>

      <div className="fw-rr-lines-head">
        {editable && <p className="fw-q-hint">{t('depth:estimate.editHint')}</p>}
        <span className="grow" />
        <Button size="sm" heldReason={editHeld} onClick={() => actions?.onEstimateAdd?.('PART')}>
          <Plus size={14} aria-hidden /> {t('depth:estimate.addPart')}
        </Button>
        <Button size="sm" heldReason={editHeld} onClick={() => actions?.onEstimateAdd?.('LABOUR')}>
          <Plus size={14} aria-hidden /> {t('depth:estimate.addLabour')}
        </Button>
      </div>
      <ListFrame<EstimateLine>
        label={t('depth:estimate.table', { revision: estimate.revision })}
        rows={estimate.lines}
        rowId={(line) => line.id}
        columns={columns}
        count={t('depth:estimate.count', { count: estimate.lines.length })}
        listKey={null}
        selection={{ selected, onChange: setSelected, actions: bulk }}
        isRowSelectable={() => editHeld}
        state={estimate.lines.length === 0 ? <EmptyState title={t('depth:estimate.noLines')} description={editable ? t('depth:estimate.noLinesBody') : undefined} /> : undefined}
      />

      <KeyValue
        columns={3}
        items={[
          ...(answer.seesPrices
            ? [
                { label: t('depth:estimate.sum.total'), value: <Money minor={summary.amount ?? null} currency={estimate.currency} /> },
                { label: t('depth:estimate.sum.parts'), value: <Money minor={summary.partsAmount ?? null} currency={estimate.currency} /> },
                { label: t('depth:estimate.sum.labour'), value: <Money minor={summary.labourAmount ?? null} currency={estimate.currency} /> },
              ]
            : []),
          { label: t('depth:estimate.sum.minutes'), value: t('depth:estimate.minutes', { count: summary.labourMinutes }) },
          ...(answer.seesCosts ? [{ label: t('depth:estimate.sum.cost'), value: summary.costAmount === null || summary.costAmount === undefined ? t('depth:estimate.costUnknown') : <Money minor={summary.costAmount} currency={estimate.currency} /> }] : []),
        ]}
      />

      {answer.estimates.length > 1 && (
        <Section title={t('depth:estimate.history')} sub={t('depth:estimate.historySub')}>
          <SummaryTable
            label={t('depth:estimate.history')}
            columns={[t('depth:estimate.col.revision'), t('depth:estimate.col.status'), t('depth:estimate.col.made'), t('depth:estimate.col.decision'), ...(answer.seesPrices ? [t('depth:estimate.col.total')] : [])]}
            rows={answer.estimates.map((entry) => {
              const words = decisionWords(entry)
              return {
                id: entry.id,
                cells: [
                  entry.id === estimate.id ? (
                    <strong key="r">{t('depth:estimate.revisionN', { revision: entry.revision })}</strong>
                  ) : (
                    <Button key="r" size="sm" variant="quiet" onClick={() => actions?.onEstimateShow?.(entry.id)}>
                      {t('depth:estimate.revisionN', { revision: entry.revision })}
                    </Button>
                  ),
                  <EstimateStatusPill key="s" status={entry.status} />,
                  <InstantText key="c" value={entry.createdAt} />,
                  words ? (
                    <span key="d" className="fw-q-cell">
                      <span>{say(t, words)}</span>
                      <InstantText value={entry.answeredAt} />
                    </span>
                  ) : (
                    <span key="d" className="fw-q-hint">
                      —
                    </span>
                  ),
                  ...(answer.seesPrices ? [<Money key="t" minor={entry.summary.amount ?? null} currency={entry.currency} />] : []),
                ],
              }
            })}
            stackOnPhone
          />
        </Section>
      )}
    </>
  )
}
