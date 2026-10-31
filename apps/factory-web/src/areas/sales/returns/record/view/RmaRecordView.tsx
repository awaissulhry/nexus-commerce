'use client'

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { MoreHorizontal, PackageCheck, Wrench } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { CellSaveMark, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Kbd, Select, Spinner } from '@nexus/ui/primitives'
import { useLocale } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { Freshness, RecordFrame, Section } from '../../../../quality/_shared/parts'
import type { ReturnLine } from '../../api'
import {
  decisionDraftProblems,
  effectOf,
  garmentOf,
  minorText,
  outcomeHeldKey,
  outcomeOf,
  outcomesFor,
  ownerName,
  PICKABLE_DISPOSITIONS,
  receiptDraftOf,
  repairHref,
  returnHref,
  returnStep,
  rmaCounts,
  trackingWords,
  type Words,
} from '../../model'
import type { RmaActions, RmaModel, RmaTab } from '../../view-model'
import { CloseReturnModal } from '../../view/CloseReturnModal'
import { NewRepairModal } from '../../view/NewRepairModal'
import { InstantText, isPageKey, MilestoneTracker, Money, RepairStagePill, ReturnsMessages, ReturnStatusPill, say, useDayWords, useWords } from '../../view/parts'
import { RmaDialogs } from './RmaDialogs'

/**
 * A return's record (SCR-112, design sales.returns › Return (RMA), `?tab=lines|inspection|credit|shipments|activity`): the
 * band (‹ Returns & repairs, the RMA number, the customer and order, the status; Receive goods (r) and ⋯ Close, Cancel,
 * Copy number), the MilestoneTracker (asked for · authorised · back with us · inspected · outcome, each with its date),
 * then the tabs: Lines (what comes back, autosaved per cell until the goods arrive; a quantity above what was sold is
 * refused at the cell with the numbers), Inspection & decision (each received line graded and given a disposition that
 * sets money, stock and work in one step — per line, or several at once), Replacement & credit (the replacement order,
 * the credit notes Finance drafts and their SDI state, the repairs of the lines), Shipments (goods in with the customer's
 * DDT, goods going back) and Activity (the record's thread and history). Money only with the price grain. Fetches nothing.
 */
export function RmaRecordView({ model, actions, panels }: { model: RmaModel; actions?: RmaActions; panels?: ReactNode }) {
  return (
    <ReturnsMessages>
      <RmaRecord model={model} actions={actions} panels={panels} />
    </ReturnsMessages>
  )
}

function RmaRecord({ model, actions, panels }: { model: RmaModel; actions?: RmaActions; panels?: ReactNode }) {
  const t = useWords()
  const dayWords = useDayWords()
  const { rma, prefix, can } = model
  const tab: RmaTab = model.tab === 'activity' && !panels ? 'lines' : model.tab
  const base = returnHref(prefix, rma.id)
  const held = (action: Parameters<typeof returnStep>[0]) => {
    const words = returnStep(action, rma, can, model.offline)
    return words ? say(t, words) : null
  }
  const counts = rmaCounts(rma)

  // r: Receive goods (the record's key, design kb).
  const keys = useRef({ actions, held: held('receive'), dialog: model.dialog, rma })
  keys.current = { actions, held: held('receive'), dialog: model.dialog, rma }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || event.key !== 'r' || keys.current.dialog) return
      if (keys.current.held) return
      event.preventDefault()
      keys.current.actions?.onDialog?.({ kind: 'receive', draft: receiptDraftOf(keys.current.rma) })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const menuItem = (id: string, label: string, reason: string | null, onSelect: () => void): MenuItemDef => ({ id, label, onSelect, disabled: !!reason, description: reason ?? undefined })
  const moreItems: MenuItemDef[] = [
    menuItem('close', t('action.close'), held('close'), () => actions?.onCloseOpen?.()),
    menuItem('cancel', t('action.cancel'), held('cancel'), () => actions?.onDialog?.({ kind: 'cancel', reason: '' })),
    { id: 'sep', separator: true } as MenuItemDef,
    { id: 'number', label: t('row.copy'), onSelect: () => actions?.onCopy?.(rma.number) },
    { id: 'link', label: t('record.copyLink'), onSelect: () => actions?.onCopy?.(typeof window === 'undefined' ? base : `${window.location.origin}${base}`) },
  ]

  const tabs = [
    { id: 'lines', label: t('tab.lines'), count: counts.lines },
    { id: 'inspection', label: t('tab.inspection'), count: counts.toDecide },
    { id: 'credit', label: t('tab.credit') },
    { id: 'shipments', label: t('tab.shipments'), count: counts.shipments },
    ...(panels ? [{ id: 'activity', label: t('tab.activity') }] : []),
  ]
  const owner = ownerName(model.people, rma.ownerId, model.me)
  const milestones = rma.tracking.map((step) => ({ id: step.step, label: t(`track.${step.step}`), state: step.state, at: step.at, sub: say(t, trackingWords(step, rma), dayWords) }))

  return (
    <>
      <RecordFrame
        back={{ href: `${prefix}/sales/returns`, label: t('record.back') }}
        title={<span className="fw-q-code">{rma.number}</span>}
        meta={
          <span className="fw-q-cell-row">
            <span>{rma.party?.legalName ?? '—'}</span>
            {rma.salesOrder && (
              <Link className="fw-q-link fw-q-code" href={`${prefix}/sales/orders/${encodeURIComponent(rma.salesOrder.id)}`}>
                {rma.salesOrder.number}
              </Link>
            )}
            {rma.customerRef && <span className="fw-q-hint">{t('row.theirRef', { ref: rma.customerRef })}</span>}
            <Freshness asOf={model.asOf} live={model.live} />
          </span>
        }
        status={<ReturnStatusPill status={rma.status} />}
        actions={
          <>
            <Button size="sm" variant="primary" heldReason={held('receive')} aria-keyshortcuts="r" onClick={() => actions?.onDialog?.({ kind: 'receive', draft: receiptDraftOf(rma) })}>
              <PackageCheck size={14} aria-hidden /> {t('action.receive')} <Kbd>R</Kbd>
            </Button>
            <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('record.more') }} items={moreItems} />
          </>
        }
        tabs={tabs}
        active={tab}
        tabHref={(id) => `${base}?tab=${id}`}
        dock={panels}
        dockOpen={model.dockOpen}
        onDock={() => actions?.onDock?.()}
      >
        <div className="fw-q-stack">
          {model.offline && <Banner tone="warning" title={t('offline.title')}>{t('offline.body')}</Banner>}
          {model.changedAt && (
            <Banner
              tone="info"
              title={t('record.changed')}
              action={
                <Button size="sm" onClick={() => actions?.onReload?.()}>
                  {t('record.reload')}
                </Button>
              }
            />
          )}
          {model.receipt && (
            <Banner
              tone={model.receipt.tone}
              title={say(t, model.receipt.words)}
              action={
                <span className="fw-q-actions">
                  {model.receipt.href && (
                    <Link className="fw-q-link" href={model.receipt.href}>
                      {t('record.openIt')}
                    </Link>
                  )}
                  <Button size="sm" variant="quiet" onClick={() => actions?.onDismissReceipt?.()}>
                    {t('quality:common.dismiss')}
                  </Button>
                </span>
              }
            />
          )}
          {(rma.status === 'CANCELLED' || rma.status === 'REJECTED' || rma.status === 'CLOSED') && (
            <Banner tone="info" title={t(`record.final.${rma.status}`)}>
              {rma.statusReason ?? null}
            </Banner>
          )}
          <Card padded>
            <MilestoneTracker steps={milestones} label={t('track.label')} />
          </Card>
          <KeyValue
            columns={3}
            items={[
              { label: t('fact.site'), value: rma.site ? `${rma.site.code} · ${rma.site.name}` : '—' },
              { label: t('fact.due'), value: rma.goodsDueBy ? dayWords(rma.goodsDueBy) : '—' },
              { label: t('fact.freight'), value: rma.policy.freightPaidByNow ? t(`freight.now.${rma.policy.freightPaidByNow}`) : rma.policy.freightPaidBy === 'BY_CAUSE' ? t('freight.byCauseOpen') : '—' },
              { label: t('fact.owner'), value: owner ? ('key' in owner ? t(owner.key) : owner.name) : '—' },
              ...(can.price ? [{ label: t('fact.credit'), value: <Money minor={rma.creditTotal} currency={rma.currency} /> }] : []),
            ]}
          />
          {tab === 'lines' && <LinesTab model={model} actions={actions} />}
          {tab === 'inspection' && <InspectionTab model={model} actions={actions} />}
          {tab === 'credit' && <CreditTab model={model} actions={actions} />}
          {tab === 'shipments' && <ShipmentsTab model={model} actions={actions} />}
          {tab === 'activity' && panels}
        </div>
      </RecordFrame>
      <RmaDialogs model={model} actions={actions} />
      {model.close && <CloseReturnModal model={model.close} actions={actions} />}
      {model.newRepair && <NewRepairModal model={model.newRepair} prefix={prefix} actions={actions} />}
    </>
  )
}

// ---- Lines ----------------------------------------------------------------------------------------------------------------

function LinesTab({ model, actions }: { model: RmaModel; actions?: RmaActions }) {
  const t = useWords()
  const locale = useLocale()
  const { rma, can } = model
  const editHeld = returnStep('editLines', rma, can, model.offline)
  const editable = editHeld === null
  const latest = useRef({ actions, model })
  latest.current = { actions, model }
  const marksKey = JSON.stringify(model.marks)
  const reasonsKey = (model.reasons ?? []).map((reason) => reason.code).join(',')
  const columns = useMemo<ColDef<ReturnLine>[]>(() => {
    const now = () => latest.current
    const Mark = ({ id, field }: { id: string; field: string }) => {
      const mark = now().model.marks[`${id}:${field}`]
      if (!mark || mark.state === 'saved') return null
      return mark.state === 'refused' ? (
        <span className="fw-rr-refused" role="img" aria-label={say(t, mark.words ?? { key: 'refusal.invalid' })} title={say(t, mark.words ?? { key: 'refusal.invalid' })}>
          !
        </span>
      ) : (
        <CellSaveMark state="saving" />
      )
    }
    const LineCell = ({ data }: ICellRendererParams<ReturnLine>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-num">{data.seq}</span>
          <span className="fw-q-hint fw-q-code">{[data.order ? `${data.order.number}/${data.order.lineSeq}` : null, data.invoice?.number ? `${data.invoice.number}/${data.invoice.lineSeq}` : null].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const GarmentCell = ({ data }: ICellRendererParams<ReturnLine>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-rr-ellipsis" title={data.description}>
            {garmentOf(data) || data.description}
          </span>
          <span className="fw-q-hint fw-rr-ellipsis">{data.ppe ? t('line.ppe') : data.description}</span>
        </span>
      ) : null
    const SerialCell = ({ data }: ICellRendererParams<ReturnLine>) => (data ? <span className="fw-q-code">{data.serial ?? data.batchNumber ?? '—'}</span> : null)
    const QuantityCell = ({ data }: ICellRendererParams<ReturnLine>) =>
      data ? (
        <span className="fw-rr-cell-edit">
          <span className="fw-q-num">{data.quantity}</span>
          <Mark id={data.id} field="quantity" />
        </span>
      ) : null
    const ReasonCell = ({ data }: ICellRendererParams<ReturnLine>) => {
      if (!data) return null
      const words = data.reason ? (locale === 'it' ? data.reason.labelIt : data.reason.labelEn) : data.reasonCode
      const current = now()
      if (!editable || !current.model.reasons)
        return (
          <span className="fw-q-cell">
            <span className="fw-rr-ellipsis">{words}</span>
            {data.reasonNote && <span className="fw-q-hint fw-rr-ellipsis">{data.reasonNote}</span>}
          </span>
        )
      const items: MenuItemDef[] = current.model.reasons.map((reason) => ({ id: reason.code, label: locale === 'it' ? reason.labelIt : reason.labelEn, checked: reason.code === data.reasonCode, onSelect: () => current.actions?.onReason?.(data.id, reason.code) }) as MenuItemDef)
      return (
        <span className="fw-rr-cell-edit">
          <Menu label={words} items={items} triggerProps={{ 'aria-label': t('line.changeReason', { seq: data.seq }) }} />
          <Mark id={data.id} field="reasonCode" />
        </span>
      )
    }
    const PriceCell = ({ data }: ICellRendererParams<ReturnLine>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-num">{data.unitPrice ?? '—'}</span>
          <span className="fw-q-hint">{data.discountPct && data.discountPct !== '0' ? t('line.discount', { pct: data.discountPct }) : ''}</span>
        </span>
      ) : null
    const ReceivedCell = ({ data }: ICellRendererParams<ReturnLine>) => (data ? <span className="fw-q-num">{data.receivedQuantity}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<ReturnLine>) => {
      if (!data) return null
      const current = now()
      const only = current.model.rma.lines.length <= 1
      const reason = !editable ? say(t, editHeld) : only ? t('held.lastLine') : null
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('line.menu', { seq: data.seq }) }} items={[{ id: 'remove', label: t('line.remove'), onSelect: () => current.actions?.onRemoveLine?.(data.id), disabled: !!reason, description: reason ?? undefined }]} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<ReturnLine>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number; maxWidth?: number }): ColDef<ReturnLine> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('line', t('line.col.line'), LineCell, { flex: 0.8, minWidth: 120 }),
      column('garment', t('line.col.garment'), GarmentCell, { flex: 1.6, minWidth: 190 }),
      column('serial', t('line.col.serial'), SerialCell, { flex: 0.8, minWidth: 110 }),
      {
        ...column('quantity', t('line.col.quantity'), QuantityCell, { flex: 0.5, minWidth: 90 }),
        ...(editable ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 6 } } : {}),
        valueGetter: (params) => (params.data ? String(params.data.quantity) : ''),
        valueSetter: (params) => {
          if (params.data) latest.current.actions?.onQuantity?.(params.data.id, String(params.newValue ?? ''))
          return false
        },
      },
      column('reason', t('line.col.reason'), ReasonCell, { flex: 1.3, minWidth: 170 }),
      ...(can.price ? [column('price', t('line.col.price'), PriceCell, { flex: 0.8, minWidth: 110 })] : []),
      column('received', t('line.col.received'), ReceivedCell, { flex: 0.5, minWidth: 90 }),
      { ...column('actions', t('col.actions'), MoreCell, { width: 72, minWidth: 72, maxWidth: 72 }), pinned: 'right', suppressHeaderMenuButton: true, suppressMovable: true },
    ]
    // The marks and the reasons redraw the cells.
  }, [t, locale, editable, can.price, marksKey, reasonsKey])

  return (
    <div className="fw-q-stack">
      {!editable && editHeld && <Banner tone="info" title={t('lines.readOnly', { why: say(t, editHeld) })} />}
      {editable && <p className="fw-q-hint">{t('lines.editHint')}</p>}
      <ListFrame<ReturnLine>
        label={t('lines.table')}
        rows={rma.lines}
        rowId={(line) => line.id}
        columns={columns}
        count={t('lines.count', { count: rma.lines.length })}
        listKey={null}
        state={rma.lines.length === 0 ? <EmptyState title={t('lines.empty')} /> : undefined}
      />
    </div>
  )
}

// ---- Inspection & decision -----------------------------------------------------------------------------------------------

function InspectionTab({ model, actions }: { model: RmaModel; actions?: RmaActions }) {
  const t = useWords()
  const { rma, can } = model
  const received = rma.lines.filter((line) => line.receivedQuantity > 0)
  const decideHeld = returnStep('decide', rma, can, model.offline)
  const inspectHeld = returnStep('inspect', rma, can, model.offline)
  const drafted = received.filter((line) => line.disposition === null && model.decisions[line.id]?.disposition)
  const draftProblems = decisionDraftProblems(model.decisions, received, can.price)
  const previewProblems = model.decisionPreview?.lines.flatMap((line) => line.problems.map(() => ({ key: 'decide.problem.line', params: { seq: line.seq } }))) ?? []
  const allHeld = decideHeld ? say(t, decideHeld) : drafted.length === 0 ? t('decide.pickFirst') : model.dialogBusy ? t('quality:common.working') : draftProblems[0] ? say(t, draftProblems[0]) : previewProblems[0] ? say(t, previewProblems[0]) : null
  const ungraded = received.filter((line) => line.grade === null && line.disposition === null)

  if (received.length === 0)
    return (
      <Card padded>
        <EmptyState title={t('inspect.empty')} description={t('inspect.emptyBody')} />
      </Card>
    )
  return (
    <div className="fw-q-stack">
      <div className="fw-q-head">
        <p className="fw-q-hint">{t('inspect.intro')}</p>
        <span className="fw-q-actions">
          <Button size="sm" heldReason={inspectHeld ? say(t, inspectHeld) : ungraded.length === 0 ? t('inspect.allGraded') : null} onClick={() => actions?.onDialog?.({ kind: 'grade', lineIds: ungraded.map((line) => line.id), grade: '', cause: '', note: '' })}>
            {t('inspect.grade', { count: ungraded.length })}
          </Button>
          <Button size="sm" variant="primary" heldReason={allHeld} onClick={() => actions?.onDecide?.(drafted.map((line) => line.id))}>
            {model.dialogBusy ? <Spinner size={12} /> : null} {t('decide.all', { count: drafted.length })}
          </Button>
        </span>
      </div>
      {model.dialogProblem && model.dialog === null && <Banner tone="danger" title={say(t, model.dialogProblem)} />}
      {received.map((line) => (
        <InspectionLine key={line.id} line={line} model={model} actions={actions} decideHeld={decideHeld} />
      ))}
    </div>
  )
}

function InspectionLine({ line, model, actions, decideHeld }: { line: ReturnLine; model: RmaModel; actions?: RmaActions; decideHeld: Words | null }) {
  const t = useWords()
  const { can } = model
  const draft = model.decisions[line.id] ?? { disposition: '', outcome: '', credit: '' }
  const preview = model.decisionPreview?.lines.find((entry) => entry.lineId === line.id) ?? null
  const decided = line.disposition !== null
  const outcomes = outcomesFor(draft.disposition)
  const outcome = outcomeOf(draft, line)
  const option = preview?.options.find((entry) => entry.disposition === draft.disposition)
  const effect = decided
    ? effectOf({ disposition: line.disposition!, goodsOutcome: line.goodsOutcome, creditAmount: line.creditAmount, place: line.stock[0]?.locationCode ?? null })
    : draft.disposition
      ? effectOf({ disposition: draft.disposition, goodsOutcome: preview?.goodsOutcome ?? outcome, creditAmount: preview?.creditAmount ?? null, place: preview?.place?.code ?? null })
      : []
  const repairNeeded = decided && line.followUp === 'REPAIR_ORDER'
  const repairHeld = !can.repairsManage ? t('held.right.repairsManage') : model.offline ? t('held.offline') : null
  return (
    <Section
      title={
        <>
          {t('inspect.line', { seq: line.seq })} · {garmentOf(line) || line.description}
        </>
      }
      sub={t('inspect.receivedOf', { received: line.receivedQuantity, count: line.quantity })}
      actions={
        repairNeeded ? (
          <Button size="sm" heldReason={repairHeld} onClick={() => actions?.onMakeRepair?.(line.id)}>
            <Wrench size={14} aria-hidden /> {t('inspect.makeRepair')}
          </Button>
        ) : undefined
      }
    >
      <div className="fw-q-stack">
        {line.safety && <Banner tone="warning" title={t('inspect.safety')} />}
        <KeyValue
          columns={3}
          items={[
            { label: t('inspect.grade1'), value: line.grade ? t(`grade.${line.grade}`) : t('inspect.notGraded') },
            { label: t('inspect.cause'), value: line.cause ? t(`cause.${line.cause}`) : '—' },
            { label: t('inspect.condition'), value: line.conditionNote ?? '—' },
            { label: t('inspect.photos'), value: t('inspect.photoCount', { count: line.photos }) },
            { label: t('inspect.suggested'), value: line.suggestedOutcome ? t(`outcome.${line.suggestedOutcome}`) : '—' },
          ]}
        />
        {line.restockHeld && !decided && <p className="fw-q-hint">{t(line.safety ? 'decide.held.safety' : line.ppe ? 'decide.held.ppeRestock' : 'decide.held.restock')}</p>}
        {decided ? (
          <div className="fw-q-stack">
            <p>
              <strong>{t(`disposition.${line.disposition}`)}</strong>
              {line.goodsOutcome ? ` · ${t(`outcome.${line.goodsOutcome}`)}` : ''}
              {can.price && typeof line.creditAmount === 'number' && line.creditAmount > 0 ? (
                <>
                  {' · '}
                  <Money minor={line.creditAmount} currency={line.currency} />
                </>
              ) : null}
            </p>
            <p className="fw-q-hint">{effect.map((words) => say(t, words)).join('; ')}</p>
            {line.stock.length > 0 && <p className="fw-q-hint">{t('inspect.stockMoved', { place: line.stock.map((move) => move.locationCode ?? '—').join(', '), quantity: line.stock[0]!.quantity })}</p>}
          </div>
        ) : decideHeld && decideHeld.key.startsWith('held.right') ? (
          <p className="fw-q-hint">{say(t, decideHeld)}</p>
        ) : (
          <div className="fw-rr-decision">
            <span className="fw-q-hint">{t('decide.hint')}</span>
            <label className="fw-q-cell">
              <span className="fw-q-hint">{t('decide.disposition')}</span>
              <Select value={draft.disposition} disabled={!!decideHeld} onChange={(event) => actions?.onDecision?.(line.id, { disposition: event.target.value as never, outcome: '', credit: '' })} aria-label={t('decide.dispositionOf', { seq: line.seq })}>
                <option value="">{t('decide.pick')}</option>
                {PICKABLE_DISPOSITIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`disposition.${value}`)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="fw-q-cell">
              <span className="fw-q-hint">{t('decide.outcome')}</span>
              <Select value={outcome ?? ''} disabled={!!decideHeld || outcomes.length <= 1} onChange={(event) => actions?.onDecision?.(line.id, { outcome: event.target.value as never })} aria-label={t('decide.outcomeOf', { seq: line.seq })}>
                {outcomes.length === 0 && <option value="">—</option>}
                {outcomes.map((value) => {
                  const heldKey = outcomeHeldKey(value, line, option?.outcomes.find((entry) => entry.outcome === value)?.held ?? null)
                  return (
                    <option key={value} value={value} disabled={!!heldKey}>
                      {t(`outcome.${value}`)}
                      {heldKey ? ` — ${t(heldKey)}` : ''}
                    </option>
                  )
                })}
              </Select>
            </label>
            {can.price ? (
              <label className="fw-q-cell">
                <span className="fw-q-hint">{t('decide.credit')}</span>
                <Input inputMode="decimal" value={draft.credit} disabled={!!decideHeld || !draft.disposition} placeholder={option?.defaultCredit !== undefined ? minorText(option.defaultCredit) : minorText(typeof line.receivedValue === 'number' && draft.disposition === 'CREDIT_ONLY' ? line.receivedValue : 0)} onChange={(event) => actions?.onDecision?.(line.id, { credit: event.target.value })} aria-label={t('decide.creditOf', { seq: line.seq })} />
              </label>
            ) : (
              <span className="fw-q-hint">{t('decide.creditNoGrain')}</span>
            )}
          </div>
        )}
        {!decided && draft.disposition && (
          <p className="fw-q-hint" aria-live="polite">
            {model.decisionPreviewing ? <Spinner size={12} /> : null} {effect.map((words) => say(t, words)).join('; ')}
          </p>
        )}
        {!decided && draft.disposition === 'REPAIR' && <p className="fw-q-hint">{t('decide.repairNext')}</p>}
      </div>
    </Section>
  )
}

// ---- Replacement & credit -------------------------------------------------------------------------------------------------

function CreditTab({ model, actions }: { model: RmaModel; actions?: RmaActions }) {
  const t = useWords()
  const { rma, can, prefix } = model
  const replacementHeld = returnStep('makeReplacement', rma, can, model.offline)
  const credit = model.credit.value
  const creditHeld = !can.invoicesManage ? t('held.right.invoicesManage') : model.offline ? t('held.offline') : !credit ? t('quality:common.loading') : credit.toCredit.length === 0 ? t('credit.nothingToCredit') : null
  // One edit path (lead decision, B-W2a-83): the credit note is made ONLY in Finance, in B-W2a-80's dialog over this return.
  const creditHref = `${prefix}/finance/invoices?return=${encodeURIComponent(rma.id)}`
  return (
    <div className="fw-q-two">
      <Section
        title={t('credit.replacement')}
        sub={t('credit.replacementSub')}
        actions={
          !rma.replacementOrder ? (
            <Button size="sm" heldReason={replacementHeld ? say(t, replacementHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'replacement', note: '' })}>
              {t('credit.makeReplacement')}
            </Button>
          ) : undefined
        }
      >
        {rma.replacementOrder ? (
          <p>
            <Link className="fw-q-link fw-q-code" href={`${prefix}/sales/orders/${encodeURIComponent(rma.replacementOrder.id)}`}>
              {rma.replacementOrder.number}
            </Link>{' '}
            <span className="fw-q-hint">{t('credit.replacementState', { status: t(`orderStatus.${rma.replacementOrder.status}`) })}</span>
          </p>
        ) : (
          <p className="fw-q-hint">{t('credit.noReplacement')}</p>
        )}
      </Section>

      <Section
        title={t('credit.notes')}
        sub={t('credit.notesSub')}
        actions={
          can.invoicesView ? (
            creditHeld ? (
              <Button size="sm" heldReason={creditHeld}>
                {t('credit.makeInFinance')}
              </Button>
            ) : (
              <Button size="sm" asChild>
                <Link href={creditHref}>{t('credit.makeInFinance')}</Link>
              </Button>
            )
          ) : undefined
        }
      >
        {!can.invoicesView ? (
          <p className="fw-q-hint">{t('held.right.invoicesView')}</p>
        ) : model.credit.problem ? (
          <Banner tone="warning" title={t(model.credit.problem)} />
        ) : !credit ? (
          <p className="fw-q-loading" role="status">
            <Spinner size={12} /> {t('quality:common.loading')}
          </p>
        ) : (
          <div className="fw-q-stack">
            {credit.creditNotes.length === 0 ? (
              <p className="fw-q-hint">{t('credit.none')}</p>
            ) : (
              <SummaryTable
                label={t('credit.notes')}
                columns={[t('credit.col.number'), t('credit.col.state'), t('credit.col.credits'), ...(can.price ? [t('credit.col.amount')] : [])]}
                rows={credit.creditNotes.map((note) => ({
                  id: note.id,
                  cells: [
                    <Link key="n" className="fw-q-link fw-q-code" href={`${prefix}/finance/invoices/${encodeURIComponent(note.id)}`}>
                      {note.number ?? t('credit.draft')}
                    </Link>,
                    t(`sdi.${note.status}`),
                    note.creditOfNumber ?? '—',
                    ...(can.price ? [<Money key="a" minor={note.grossTotal} currency={note.currency} />] : []),
                  ],
                }))}
                stackOnPhone
              />
            )}
            {credit.toCredit.length > 0 && <p className="fw-q-hint">{t('credit.toCredit', { count: credit.toCredit.length })}</p>}
            {credit.notCredited.length > 0 && (
              <ul className="fw-q-lines">
                {credit.notCredited.map((entry) => (
                  <li key={entry.lineId} className="fw-q-hint">
                    {t('credit.skip', { seq: entry.seq, why: t(`credit.skipCode.${entry.code}`) })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>

      <Section title={t('credit.repairs')} sub={t('credit.repairsSub')}>
        {!can.repairsView ? (
          <p className="fw-q-hint">{t('held.right.repairsView')}</p>
        ) : model.repairs.problem ? (
          <Banner tone="warning" title={t(model.repairs.problem)} />
        ) : !model.repairs.items ? (
          <p className="fw-q-loading" role="status">
            <Spinner size={12} /> {t('quality:common.loading')}
          </p>
        ) : model.repairs.items.length === 0 ? (
          <p className="fw-q-hint">{t('credit.noRepairs')}</p>
        ) : (
          <ul className="fw-q-lines">
            {model.repairs.items.map((repair) => (
              <li key={repair.id}>
                <Link className="fw-q-link fw-q-code" href={repairHref(prefix, repair.id)}>
                  {repair.number}
                </Link>{' '}
                <RepairStagePill stage={repair.stage} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('credit.later')}>
        <ul className="fw-q-lines">
          <li className="fw-q-hint">{t('credit.laterWithout')}</li>
          <li className="fw-q-hint">{t('credit.laterFee')}</li>
        </ul>
      </Section>
    </div>
  )
}

// ---- Shipments ------------------------------------------------------------------------------------------------------------

function ShipmentsTab({ model, actions }: { model: RmaModel; actions?: RmaActions }) {
  const t = useWords()
  const { rma, can, prefix } = model
  const ddtHeld = returnStep('issueReturnDdt', rma, can, model.offline)
  const nothing = rma.receipts.length === 0 && rma.ddts.live.length === 0 && rma.ddts.cancelled.length === 0 && !rma.replacementOrder
  return (
    <div className="fw-q-stack">
      <div className="fw-q-head">
        <p className="fw-q-hint">{t('ship.intro')}</p>
        <Button size="sm" heldReason={ddtHeld ? say(t, ddtHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'ddt', draft: { transportBy: 'CARRIER', carrier: '', packages: '1', weight: '', appearance: '', freight: '', remarks: '' }, preview: null, previewing: false })}>
          {t('ship.issueDdt')}
        </Button>
      </div>
      {nothing ? (
        <Card padded>
          <EmptyState title={t('ship.empty')} description={t('ship.emptyBody')} />
        </Card>
      ) : (
        <SummaryTable
          label={t('ship.table')}
          columns={[t('ship.col.what'), t('ship.col.when'), t('ship.col.document'), t('ship.col.detail')]}
          rows={[
            ...rma.receipts.map((receipt) => ({
              id: receipt.id,
              cells: [
                t('ship.in'),
                <InstantText key="w" value={receipt.receivedAt} />,
                receipt.customerDdtNumber ? t('ship.customerDdt', { number: receipt.customerDdtNumber }) : t('ship.noCustomerDdt'),
                [t('ship.parcels', { count: receipt.parcels }), t(`parcel.${receipt.parcelCondition}`), receipt.carrierName, receipt.trackingNumber ? t('ship.tracking', { number: receipt.trackingNumber }) : null].filter(Boolean).join(' · '),
              ],
            })),
            ...rma.ddts.live.map((ddt) => ({ id: ddt.id, cells: [t('ship.out'), '—', t('ship.returnDdt', { number: ddt.number }), t('ship.lines', { count: ddt.lineIds.length })] })),
            ...rma.ddts.cancelled.map((ddt) => ({ id: ddt.id, cells: [t('ship.outCancelled'), '—', t('ship.returnDdt', { number: ddt.number }), t('ship.cancelled')] })),
            ...(rma.replacementOrder
              ? [
                  {
                    id: rma.replacementOrder.id,
                    cells: [
                      t('ship.replacement'),
                      '—',
                      <Link key="o" className="fw-q-link fw-q-code" href={`${prefix}/sales/orders/${encodeURIComponent(rma.replacementOrder.id)}?tab=shipments`}>
                        {rma.replacementOrder.number}
                      </Link>,
                      t('ship.replacementHint'),
                    ],
                  },
                ]
              : []),
          ]}
          stackOnPhone
        />
      )}
      <p className="fw-q-hint">{t('ship.labelLater')}</p>
    </div>
  )
}
