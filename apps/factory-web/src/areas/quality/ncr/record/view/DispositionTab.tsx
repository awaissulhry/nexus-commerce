'use client'

import { useMemo, useRef } from 'react'
import Link from 'next/link'
import { BadgeCheck, Hammer, PackageCheck, Plus, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { Decision, NcrRecord } from '../../api'
import { addDecisionHeld, decisionHeld, isOpenStage, recordLabel } from '../../model'
import { DecidedBar } from '../../parts'
import { carryGap, carryKindOf, EMPTY_CARRY, plainQuantity, recordHref, type NcrRecordActions, type NcrRecordModel } from '../view-model'
import { CellMark, codeLabel, type RecordWords } from './words'

/**
 * Disposition (design rec NCR › disposition, ncr-disp; QHS-083, QHS-091): the quantity split across decisions, with the
 * "28 of 40 decided · 12 left" bar. Quantity and note autosave per cell while the decision is neither approved nor
 * carried out; approvals are explicit (another person with quality.ncr.approve, four eyes); each decision is carried out
 * by its code — its stock move, its repair, its supplier claim, or "Create rework order". The SCRAP of garments still in
 * work cannot be posted from an NCR yet (B-W2a-47 gap): its button is held with that reason, never a fake success.
 */
export function DispositionTab({ model, record, words, actions }: { model: NcrRecordModel; record: NcrRecord; words: RecordWords; actions?: NcrRecordActions }) {
  const { t, r, say, person, when, amount, locale } = words
  const act = useRef(actions)
  act.current = actions
  const ncr = record.ncr
  const addHeld = addDecisionHeld(record, model.can)
  const waiting = record.decisions.filter((decision) => decision.state === 'WAITING_APPROVAL').length
  // What cannot be carried out from here at all (the SCRAP of garments still in work …), said above the grid too.
  const gaps = record.decisions.filter((decision) => !decision.doneAt && isOpenStage(ncr.stage)).flatMap((decision) => {
    const key = carryGap(decision, ncr)
    return key ? [{ id: decision.id, seq: decision.seq, disposition: decision.disposition, key }] : []
  })

  const columns = useMemo<ColDef<Decision>[]>(() => {
    const CodeCell = ({ data }: ICellRendererParams<Decision>) =>
      data ? (
        <span className="fw-ncr-r-cell">
          <span className="fw-q-name">{`${data.seq}. ${codeLabel(data.disposition, locale)}`}</span>
          <span className="fw-ncr-r-sub">{data.disposition ? r(`outcome.${data.disposition.outcome}`) : '—'}</span>
        </span>
      ) : null
    const QuantityCell = ({ data }: ICellRendererParams<Decision>) => {
      if (!data) return null
      const held = decisionHeld(data, record, model.can, model.me).edit
      if (held) return <span className="fw-q-num">{amount(data.quantity, ncr.uom)}</span>
      return (
        <span className="fw-ncr-r-row">
          <Input
            size="xs"
            inputMode="decimal"
            aria-label={r('disposition.cellQuantity', { seq: data.seq })}
            defaultValue={plainQuantity(data.quantity)}
            key={`${data.id}:${data.version}`}
            className="fw-ncr-r-qty"
            onBlur={(event) => {
              const next = event.target.value.trim().replace(',', '.')
              if (next && next !== plainQuantity(data.quantity)) act.current?.onDecisionCell?.(data.id, { quantity: next }, 'quantity')
            }}
          />
          <span className="fw-ncr-r-sub">{t(`uom.${ncr.uom}`)}</span>
          <CellMark cell={model.cells[`${data.id}:quantity`]} />
        </span>
      )
    }
    const ApprovalCell = ({ data }: ICellRendererParams<Decision>) => {
      if (!data) return null
      if (!data.approvalRequired) return <span className="fw-ncr-r-sub">{r('disposition.noApproval')}</span>
      if (data.approvedAt)
        return (
          <span className="fw-ncr-r-cell">
            <span>{r('disposition.approvedBy', { name: person(data.approvedById) })}</span>
            <span className="fw-ncr-r-sub">{when(data.approvedAt)}</span>
          </span>
        )
      const held = decisionHeld(data, record, model.can, model.me).approve
      return (
        <span className="fw-ncr-r-cell">
          <Button size="xs" heldReason={say(held)} onClick={() => act.current?.onApprove?.(data.id)}>
            <BadgeCheck size={13} aria-hidden /> {r('disposition.approve')}
          </Button>
          <span className="fw-ncr-r-sub">{r('disposition.decidedBy', { name: person(data.decidedById) })}</span>
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<Decision>) =>
      data ? (
        <span className="fw-ncr-r-cell">
          <span>
            <Tag tone={data.state === 'DONE' ? 'success' : data.state === 'WAITING_APPROVAL' ? 'warning' : 'info'}>{r(`decisionState.${data.state}`)}</Tag>
          </span>
          {data.doneAt && <span className="fw-ncr-r-sub">{when(data.doneAt)}</span>}
        </span>
      ) : null
    const OutcomeCell = ({ data }: ICellRendererParams<Decision>) => {
      if (!data) return null
      const parts = []
      if (data.stockMove)
        parts.push(
          <span key="move" className="fw-ncr-r-sub">
            {r('disposition.move', { reason: r(`move.${data.stockMove.reason ?? 'OTHER'}`), quantity: data.stockMove.quantity ? amount(data.stockMove.quantity, data.stockMove.uom ?? ncr.uom) : '—', from: data.stockMove.from ?? '—', to: data.stockMove.to ?? '—' })}
          </span>,
        )
      if (data.followUp)
        parts.push(
          <Link key="follow" className="fw-q-link" href={recordHref(model.prefix, { type: data.followUp.type, id: data.followUp.id, label: data.followUp.label })}>
            {recordLabel(t, data.followUp.type, data.followUp.label)}
          </Link>,
        )
      if (parts.length === 0) return <span className="fw-ncr-r-sub">{r(data.doneAt ? 'disposition.noMove' : `carryKind.${carryKindOf(data)}`)}</span>
      return <span className="fw-ncr-r-cell">{parts}</span>
    }
    const NoteCell = ({ data }: ICellRendererParams<Decision>) => {
      if (!data) return null
      const held = decisionHeld(data, record, model.can, model.me).edit
      if (held) return <span className="fw-ncr-r-sub" title={data.note ?? undefined}>{data.note ?? '—'}</span>
      return (
        <span className="fw-ncr-r-row">
          <Input
            size="xs"
            aria-label={r('disposition.cellNote', { seq: data.seq })}
            defaultValue={data.note ?? ''}
            key={`${data.id}:${data.version}`}
            onBlur={(event) => {
              const next = event.target.value.trim()
              if (next !== (data.note ?? '')) act.current?.onDecisionCell?.(data.id, { note: next || null }, 'note')
            }}
          />
          <CellMark cell={model.cells[`${data.id}:note`]} />
        </span>
      )
    }
    const DoCell = ({ data }: ICellRendererParams<Decision>) => {
      if (!data) return null
      const held = decisionHeld(data, record, model.can, model.me)
      if (data.doneAt) return <span className="fw-ncr-r-sub">{r('decisionState.DONE')}</span>
      const kind = carryKindOf(data)
      const gap = carryGap(data, ncr)
      const carryHeld = say(held.carryOut) ?? (gap ? r(gap) : null)
      return (
        <span className="fw-ncr-r-row">
          {kind === 'rework' ? (
            <Button size="xs" heldReason={carryHeld} onClick={() => act.current?.onDialog?.({ kind: 'rework', decisionId: data.id, operationId: '', description: data.note ?? '', busy: false, notice: null })}>
              <Hammer size={13} aria-hidden /> {r('disposition.rework')}
            </Button>
          ) : (
            <Button size="xs" heldReason={carryHeld} onClick={() => act.current?.onDialog?.({ kind: 'carryOut', decisionId: data.id, draft: EMPTY_CARRY, busy: false, notice: null })}>
              <PackageCheck size={13} aria-hidden /> {r(kind === 'none' ? 'disposition.markDone' : 'disposition.carryOut')}
            </Button>
          )}
          <Button size="xs" variant="quiet" heldReason={say(held.edit)} aria-label={r('disposition.removeOne', { seq: data.seq })} onClick={() => act.current?.onDialog?.({ kind: 'removeDecision', decisionId: data.id, busy: false, notice: null })}>
            <Trash2 size={13} aria-hidden /> {r('disposition.remove')}
          </Button>
        </span>
      )
    }
    return [
      { colId: 'code', headerName: r('col.decision'), minWidth: 190, flex: 1.1, cellRenderer: CodeCell },
      { colId: 'quantity', headerName: t('col.quantity'), minWidth: 140, flex: 0.6, cellRenderer: QuantityCell },
      { colId: 'approval', headerName: r('col.approval'), minWidth: 170, flex: 0.9, cellRenderer: ApprovalCell },
      { colId: 'state', headerName: r('col.state'), minWidth: 140, flex: 0.7, cellRenderer: StateCell },
      { colId: 'outcome', headerName: r('col.outcome'), minWidth: 190, flex: 1.1, cellRenderer: OutcomeCell },
      { colId: 'note', headerName: r('col.note'), minWidth: 170, flex: 1, cellRenderer: NoteCell },
      { colId: 'do', headerName: t('col.actions'), minWidth: 230, flex: 1, sortable: false, cellRenderer: DoCell },
    ]
  }, [t, r, say, person, when, amount, locale, record, ncr, model.can, model.me, model.cells, model.prefix])

  const decideButton = (
    <Button
      size="sm"
      variant="primary"
      heldReason={say(addHeld)}
      onClick={() => {
        actions?.onNeed?.('dispositions')
        actions?.onDialog?.({ kind: 'decide', draft: { dispositionCodeId: '', quantity: plainQuantity(ncr.decided.left), note: '' }, busy: false, notice: null })
      }}
    >
      <Plus size={14} aria-hidden /> {r('disposition.decide')}
    </Button>
  )

  return (
    <div className="fw-q-stack">
      <Card padded>
        <div className="fw-ncr-head">
          <div className="fw-ncr-r-bar">
            <DecidedBar ncr={ncr} />
          </div>
          {decideButton}
        </div>
        <p className="fw-q-hint">{waiting > 0 ? r('disposition.waitingHint', { count: waiting }) : r('disposition.approvalHint')}</p>
      </Card>
      {gaps.length > 0 && (
        <Banner tone="warning" title={r('disposition.gapsTitle', { count: gaps.length })}>
          <ul className="fw-q-lines">
            {gaps.map((gap) => (
              <li key={gap.id}>{`${gap.seq}. ${codeLabel(gap.disposition, locale)}: ${r(gap.key)}`}</li>
            ))}
          </ul>
        </Banner>
      )}
      <ListFrame<Decision>
        label={r('disposition.label')}
        rows={record.decisions}
        rowId={(row) => row.id}
        columns={columns}
        count={r('disposition.count', { count: record.decisions.length })}
        listKey={null}
        state={record.decisions.length === 0 ? <EmptyState title={r('disposition.empty')} description={r('disposition.emptyBody')} action={addHeld ? undefined : decideButton} /> : undefined}
      />
      <p className="fw-q-hint">{r('disposition.foot')}</p>
    </div>
  )
}
