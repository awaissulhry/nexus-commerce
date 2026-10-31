'use client'

import { useMemo, useRef } from 'react'
import Link from 'next/link'
import { CheckCheck, Plus, X } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ContainmentAction, NcrRecord } from '../../api'
import { actionHeld, addActionHeld, instantOf, localOf } from '../../model'
import { holdStatusKey, NEW_ACTION, recordHref, type NcrRecordActions, type NcrRecordModel } from '../view-model'
import { CellMark, type RecordWords } from './words'

/**
 * Containment (design rec NCR › containment, ncr-cont; QHS-082): the immediate actions with their owners and due times,
 * on the shared list frame (a short list inside a record: no saved views, no selection). Owner, due time and what the
 * action is autosave per cell with the action's version (a mark per cell); done needs evidence — a note, or a photo of
 * the action — and "Hold stock" names its hold (placed here through the hold's fields, or one of the goods). Cancel keeps
 * its reason (B-W2b-17: in its own place under the state, never as evidence). Held with the reason once the NCR is
 * decided, or for a role that does not follow NCRs up.
 */
export function ContainmentTab({ model, record, words, actions }: { model: NcrRecordModel; record: NcrRecord; words: RecordWords; actions?: NcrRecordActions }) {
  const { t, r, say, person, when } = words
  const act = useRef(actions)
  act.current = actions
  const addHeld = addActionHeld(record, model.can)
  const people = model.people ?? []

  const columns = useMemo<ColDef<ContainmentAction>[]>(() => {
    const ActionCell = ({ data }: ICellRendererParams<ContainmentAction>) => {
      if (!data) return null
      const editable = actionHeld(data, record, model.can) === null
      return (
        <span className="fw-ncr-r-cell">
          <span className="fw-q-name">{`${data.seq}. ${r(`kind.${data.kind}`)}`}</span>
          {editable ? (
            <span className="fw-ncr-r-row">
              <Input
                size="xs"
                aria-label={r('containment.cellDescription', { seq: data.seq })}
                defaultValue={data.description ?? ''}
                key={`${data.id}:${data.version}`}
                placeholder={r('containment.descriptionPlaceholder')}
                onBlur={(event) => {
                  const next = event.target.value.trim()
                  if (next !== (data.description ?? '')) act.current?.onActionCell?.(data.id, { description: next || null }, 'description')
                }}
              />
              <CellMark cell={model.cells[`${data.id}:description`]} />
            </span>
          ) : (
            <span className="fw-ncr-r-sub">{data.description ?? '—'}</span>
          )}
        </span>
      )
    }
    const OwnerCell = ({ data }: ICellRendererParams<ContainmentAction>) => {
      if (!data) return null
      if (actionHeld(data, record, model.can) !== null) return <span>{person(data.ownerId)}</span>
      const options = data.ownerId && !people.some((entry) => entry.id === data.ownerId) ? [{ id: data.ownerId, name: person(data.ownerId), me: false }, ...people] : people
      return (
        <span className="fw-ncr-r-row">
          <Select size="xs" aria-label={r('containment.cellOwner', { seq: data.seq })} value={data.ownerId ?? ''} onChange={(event) => act.current?.onActionCell?.(data.id, { ownerId: event.target.value || null }, 'owner')}>
            <option value="">{t('common.nobody')}</option>
            {options.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.me ? t('common.me', { name: entry.name }) : entry.name}
              </option>
            ))}
          </Select>
          <CellMark cell={model.cells[`${data.id}:owner`]} />
        </span>
      )
    }
    const DueCell = ({ data }: ICellRendererParams<ContainmentAction>) => {
      if (!data) return null
      if (actionHeld(data, record, model.can) !== null) return <span className="fw-q-num">{when(data.dueAt)}</span>
      return (
        <span className="fw-ncr-r-cell">
          <span className="fw-ncr-r-row">
            <Input
              size="xs"
              type="datetime-local"
              aria-label={r('containment.cellDue', { seq: data.seq })}
              defaultValue={localOf(data.dueAt, model.timeZone)}
              key={`${data.id}:${data.version}`}
              onBlur={(event) => {
                const next = instantOf(event.target.value, model.timeZone)
                const same = next === data.dueAt || (next !== null && data.dueAt !== null && new Date(next).getTime() === new Date(data.dueAt).getTime())
                if (!same) act.current?.onActionCell?.(data.id, { dueAt: next }, 'due')
              }}
            />
            <CellMark cell={model.cells[`${data.id}:due`]} />
          </span>
          {data.overdue && <span className="fw-ncr-r-sub fw-ncr-r-bad">{r('containment.overdue')}</span>}
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<ContainmentAction>) =>
      data ? (
        <span className="fw-ncr-r-cell">
          <span>
            <Tag tone={data.status === 'DONE' ? 'success' : data.status === 'CANCELLED' ? 'neutral' : data.overdue ? 'danger' : 'warning'}>{r(`actionStatus.${data.status}`)}</Tag>
          </span>
          {data.doneAt && <span className="fw-ncr-r-sub">{`${when(data.doneAt)} · ${person(data.doneById)}`}</span>}
          {data.status === 'CANCELLED' && data.cancelReason && (
            <span className="fw-ncr-r-sub" title={data.cancelReason}>
              {r('containment.cancelledBecause', { reason: data.cancelReason })}
            </span>
          )}
        </span>
      ) : null
    const EvidenceCell = ({ data }: ICellRendererParams<ContainmentAction>) => {
      if (!data) return null
      // An action cancelled before B-W2b-17 kept its reason as "Cancelled: …" in its evidence: shown as the reason only.
      const evidence = data.status === 'CANCELLED' && data.evidenceNote?.startsWith('Cancelled: ') ? null : data.evidenceNote
      return (
        <span className="fw-ncr-r-cell" title={evidence ?? undefined}>
          <span className="fw-ncr-r-sub">{evidence ?? '—'}</span>
          {data.files > 0 && <span className="fw-ncr-r-sub">{r('containment.files', { count: data.files })}</span>}
        </span>
      )
    }
    const LinkCell = ({ data }: ICellRendererParams<ContainmentAction>) => {
      if (!data) return null
      if (data.hold)
        return (
          <span className="fw-ncr-r-cell">
            <Link className="fw-q-link" href={recordHref(model.prefix, { type: 'QualityHold', id: data.hold.id })}>
              {r('containment.hold', { type: t(`recordType.${data.hold.subjectType}`), count: data.hold.count })}
            </Link>
            <span className="fw-ncr-r-sub">{r(holdStatusKey(data.hold.status))}</span>
          </span>
        )
      if (data.record) return <Link className="fw-q-link" href={recordHref(model.prefix, { type: data.record.type, id: data.record.id })}>{t(`recordType.${data.record.type}`)}</Link>
      return <span className="fw-ncr-r-sub">—</span>
    }
    const DoCell = ({ data }: ICellRendererParams<ContainmentAction>) => {
      if (!data) return null
      const held = actionHeld(data, record, model.can)
      if (data.status !== 'OPEN') return <span className="fw-ncr-r-sub">{say(held)}</span>
      return (
        <span className="fw-ncr-r-row">
          <Button size="xs" heldReason={say(held)} onClick={() => act.current?.onDialog?.({ kind: 'doneAction', actionId: data.id, evidence: '', photoName: null, hold: { subject: '', reasonCode: '', note: '' }, busy: false, notice: null })}>
            <CheckCheck size={13} aria-hidden /> {r('containment.done')}
          </Button>
          <Button size="xs" variant="quiet" heldReason={say(held)} aria-label={r('containment.cancelOne', { seq: data.seq })} onClick={() => act.current?.onDialog?.({ kind: 'cancelAction', actionId: data.id, reason: '', busy: false, notice: null })}>
            <X size={13} aria-hidden /> {r('containment.cancel')}
          </Button>
        </span>
      )
    }
    return [
      { colId: 'action', headerName: r('col.action'), minWidth: 220, flex: 1.6, cellRenderer: ActionCell },
      { colId: 'owner', headerName: r('col.owner'), minWidth: 170, flex: 0.9, cellRenderer: OwnerCell },
      { colId: 'due', headerName: r('col.due'), minWidth: 190, flex: 0.9, cellRenderer: DueCell },
      { colId: 'state', headerName: r('col.state'), minWidth: 150, flex: 0.8, cellRenderer: StateCell },
      { colId: 'evidence', headerName: r('col.evidence'), minWidth: 180, flex: 1.2, cellRenderer: EvidenceCell },
      { colId: 'link', headerName: r('col.link'), minWidth: 150, flex: 0.8, cellRenderer: LinkCell },
      { colId: 'do', headerName: t('col.actions'), minWidth: 200, flex: 0.9, sortable: false, cellRenderer: DoCell },
    ]
  }, [t, r, say, person, when, record, model.can, model.cells, model.prefix, model.timeZone, people])

  const addButton = (
    <Button size="sm" variant="primary" heldReason={say(addHeld)} onClick={() => actions?.onDialog?.({ kind: 'addAction', draft: NEW_ACTION, busy: false, notice: null })}>
      <Plus size={14} aria-hidden /> {r('containment.add')}
    </Button>
  )

  return (
    <div className="fw-q-stack">
      <div className="fw-ncr-head">
        <p className="fw-q-hint">{r('containment.intro')}</p>
        {addButton}
      </div>
      <ListFrame<ContainmentAction>
        label={r('containment.label')}
        rows={record.containment}
        rowId={(row) => row.id}
        columns={columns}
        count={r('containment.count', { count: record.containment.length })}
        listKey={null}
        state={record.containment.length === 0 ? <EmptyState title={r('containment.empty')} description={r('containment.emptyBody')} action={addHeld ? undefined : addButton} /> : undefined}
      />
      <p className="fw-q-hint">{r('containment.foot')}</p>
    </div>
  )
}
