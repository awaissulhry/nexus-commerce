'use client'

import { useMemo, useRef } from 'react'
import { CheckCheck, PanelRight, Plus, X } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { ACTION_KINDS, CAPA_LIMITS } from '@nexus/factory-domain/quality/capa/rules'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { CapaAction, CapaRecord } from '../../api'
import { actionEditHeld, addActionHeld, doneHeld, dueSay, emptyActionDraft } from '../../model'
import { CellMark, personWords, useCapaWords } from '../../parts'
import type { CapaRecordActions, CapaRecordModel } from '../view-model'
import { ActionDrawer } from './ActionDrawer'

/**
 * Actions (design rec CAPA › actions, capa-actions "Corrective and preventive actions", D5–D7; QHS-096): the actions on the
 * shared list frame (a short list inside a record: no saved views, no selection). What it is, its kind, owner and due day
 * autosave per cell with the action's version (a mark per cell); the reminders sent and the escalation path come from the
 * scheduler (3 days before and on the due day; overdue → the path, else the company's quality rule). Enter (or the row's
 * Open) docks the action's drawer beside the list (pop:capa-action). Done needs evidence — a note, or a file of the action.
 */
export function ActionsTab({ model, record, actions }: { model: CapaRecordModel; record: CapaRecord; actions?: CapaRecordActions }) {
  const { t, say } = useCapaWords()
  const locale = useLocale()
  const act = useRef(actions)
  act.current = actions
  const capa = record.capa
  const offline = model.live === 'offline'
  const addHeld = say(addActionHeld(capa, record.actions, model.can)) ?? (offline ? t('held.offline') : null)
  const people = model.people ?? []
  const nameOf = (id: string | null) => personWords([...record.people, ...people], id, model.me, t)
  const ownerOptions = (id: string) => (people.some((person) => person.id === id) ? people : [{ id, name: nameOf(id), manages: false, remindable: false, me: false }, ...people])

  const columns = useMemo<ColDef<CapaAction>[]>(() => {
    const ActionCell = ({ data }: ICellRendererParams<CapaAction>) => {
      if (!data) return null
      const editable = actionEditHeld(data, capa, model.can) === null && !offline
      return (
        <span className="fw-capa-cell">
          <span className="fw-q-name">{t('actions.seq', { seq: data.seq })}</span>
          {editable ? (
            <span className="fw-capa-row">
              <Input
                size="xs"
                fieldClassName="fw-capa-grow"
                aria-label={t('actions.cellDescription', { seq: data.seq })}
                defaultValue={data.description}
                key={`${data.id}:${data.version}`}
                maxLength={CAPA_LIMITS.description}
                onBlur={(event) => act.current?.onActionCell?.(data.id, 'description', event.target.value)}
              />
              <CellMark cell={model.cells[`${data.id}:description`]} />
            </span>
          ) : (
            <span className="fw-capa-hint" title={data.description}>
              {data.description}
            </span>
          )}
        </span>
      )
    }
    const KindCell = ({ data }: ICellRendererParams<CapaAction>) => {
      if (!data) return null
      if (actionEditHeld(data, capa, model.can) !== null || offline) return <span>{t(`kind.${data.kind}`)}</span>
      return (
        <span className="fw-capa-row">
          <Select size="xs" aria-label={t('actions.cellKind', { seq: data.seq })} value={data.kind} onChange={(event) => act.current?.onActionCell?.(data.id, 'kind', event.target.value)}>
            {ACTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kind.${kind}`)}
              </option>
            ))}
          </Select>
          <CellMark cell={model.cells[`${data.id}:kind`]} />
        </span>
      )
    }
    const OwnerCell = ({ data }: ICellRendererParams<CapaAction>) => {
      if (!data) return null
      if (actionEditHeld(data, capa, model.can) !== null || offline) return <span>{nameOf(data.ownerId)}</span>
      return (
        <span className="fw-capa-row">
          <Select size="xs" aria-label={t('actions.cellOwner', { seq: data.seq })} value={data.ownerId} onChange={(event) => act.current?.onActionCell?.(data.id, 'ownerId', event.target.value)}>
            {ownerOptions(data.ownerId).map((person) => (
              <option key={person.id} value={person.id}>
                {person.id === model.me ? t('common.me', { name: person.name }) : person.name}
              </option>
            ))}
          </Select>
          <CellMark cell={model.cells[`${data.id}:ownerId`]} />
        </span>
      )
    }
    const DueCell = ({ data }: ICellRendererParams<CapaAction>) => {
      if (!data) return null
      const late = data.status === 'OPEN' ? dueSay(data.dueOn, model.today) : null
      const editable = actionEditHeld(data, capa, model.can) === null && !offline
      return (
        <span className="fw-capa-cell">
          {editable ? (
            <span className="fw-capa-row">
              <Input
                size="xs"
                type="date"
                aria-label={t('actions.cellDue', { seq: data.seq })}
                defaultValue={data.dueOn}
                min={model.today}
                key={`${data.id}:${data.version}`}
                onBlur={(event) => act.current?.onActionCell?.(data.id, 'dueOn', event.target.value)}
              />
              <CellMark cell={model.cells[`${data.id}:dueOn`]} />
            </span>
          ) : (
            <span className="fw-q-num">{formatDate(data.dueOn, { locale })}</span>
          )}
          {late && <span className={late.key === 'due.late' ? 'fw-capa-bad fw-q-hint' : 'fw-q-hint'}>{say(late)}</span>}
        </span>
      )
    }
    const StateCell = ({ data }: ICellRendererParams<CapaAction>) =>
      data ? (
        <span className="fw-capa-cell">
          <span>
            <Tag tone={data.status === 'DONE' ? 'success' : data.status === 'CANCELLED' ? 'neutral' : data.overdue ? 'danger' : 'warning'}>{data.status === 'OPEN' && data.overdue ? t('actionStatus.OVERDUE') : t(`actionStatus.${data.status}`)}</Tag>
          </span>
          {data.doneAt && <span className="fw-capa-hint">{`${formatDateTime(data.doneAt, { locale })} · ${nameOf(data.doneById)}`}</span>}
          {data.status === 'CANCELLED' && data.cancelReason && (
            <span className="fw-capa-hint" title={data.cancelReason}>
              {t('actions.cancelledBecause', { reason: data.cancelReason })}
            </span>
          )}
        </span>
      ) : null
    const RemindersCell = ({ data }: ICellRendererParams<CapaAction>) =>
      data ? (
        <span className="fw-capa-cell">
          <span className="fw-q-num">{t('actions.reminders', { count: data.remindersSent })}</span>
          {data.lastRemindedAt && <span className="fw-capa-hint">{t('actions.lastReminded', { date: formatDateTime(data.lastRemindedAt, { locale }) })}</span>}
        </span>
      ) : null
    const EscalationCell = ({ data }: ICellRendererParams<CapaAction>) =>
      data ? (
        <span className="fw-capa-cell">
          <span>{data.escalateToId ? nameOf(data.escalateToId) : t('actions.byRule')}</span>
          {data.escalatedAt && <span className="fw-capa-bad fw-q-hint">{t('actions.escalatedAt', { date: formatDateTime(data.escalatedAt, { locale }) })}</span>}
        </span>
      ) : null
    const EvidenceCell = ({ data }: ICellRendererParams<CapaAction>) =>
      data ? (
        <span className="fw-capa-cell" title={data.evidenceNote ?? undefined}>
          <span className="fw-capa-hint">{data.evidenceNote ?? '—'}</span>
          {data.files > 0 && <span className="fw-capa-hint">{t('actions.files', { count: data.files })}</span>}
        </span>
      ) : null
    const DoCell = ({ data }: ICellRendererParams<CapaAction>) => {
      if (!data) return null
      const done = say(doneHeld(data, capa, model.can, model.me)) ?? (offline ? t('held.offline') : null)
      const cancel = say(actionEditHeld(data, capa, model.can)) ?? (offline ? t('held.offline') : null)
      return (
        <span className="fw-capa-row fw-capa-do">
          <Button size="xs" variant="quiet" aria-label={t('actions.open', { seq: data.seq })} onClick={() => act.current?.onOpenAction?.(data.id)}>
            <PanelRight size={13} aria-hidden />
          </Button>
          {data.status === 'OPEN' && (
            <>
              <Button size="xs" heldReason={done} onClick={() => act.current?.onDialog?.({ kind: 'done', actionId: data.id, evidence: '', busy: false, notice: null })}>
                <CheckCheck size={13} aria-hidden /> {t('actions.done')}
              </Button>
              <Button size="xs" variant="quiet" heldReason={cancel} aria-label={t('actions.cancelOne', { seq: data.seq })} onClick={() => act.current?.onDialog?.({ kind: 'cancelAction', actionId: data.id, reason: '', busy: false, notice: null })}>
                <X size={13} aria-hidden />
              </Button>
            </>
          )}
        </span>
      )
    }
    return [
      { colId: 'action', headerName: t('actions.col.action'), minWidth: 280, flex: 2, cellRenderer: ActionCell },
      { colId: 'kind', headerName: t('actions.col.kind'), minWidth: 140, flex: 0.6, cellRenderer: KindCell },
      { colId: 'owner', headerName: t('actions.col.owner'), minWidth: 170, flex: 0.8, cellRenderer: OwnerCell },
      { colId: 'due', headerName: t('actions.col.due'), minWidth: 160, flex: 0.7, cellRenderer: DueCell },
      { colId: 'state', headerName: t('actions.col.state'), minWidth: 150, flex: 0.7, cellRenderer: StateCell },
      { colId: 'reminders', headerName: t('actions.col.reminders'), minWidth: 150, flex: 0.6, cellRenderer: RemindersCell },
      { colId: 'escalation', headerName: t('actions.col.escalation'), minWidth: 160, flex: 0.7, cellRenderer: EscalationCell },
      { colId: 'evidence', headerName: t('actions.col.evidence'), minWidth: 180, flex: 1, cellRenderer: EvidenceCell },
      { colId: 'do', headerName: t('col.more'), minWidth: 190, maxWidth: 210, sortable: false, cellRenderer: DoCell },
    ]
    // nameOf / ownerOptions read the people and the record's names, both in the dependencies.
  }, [t, say, locale, capa, record.people, people, model.can, model.cells, model.me, model.today, offline])

  const addButton = (
    <Button size="sm" variant="primary" heldReason={addHeld} aria-keyshortcuts="a" onClick={() => actions?.onDialog?.({ kind: 'addAction', draft: emptyActionDraft(model.today, model.me), busy: false, notice: null })}>
      <Plus size={14} aria-hidden /> {t('actions.add')}
    </Button>
  )
  const keys: ListKey[] = [
    { keys: ['a'], does: t('keys.addAction') },
    { keys: ['⌘', '↑'], does: t('keys.previousAction') },
    { keys: ['⌘', '↓'], does: t('keys.nextAction') },
  ]
  const open = record.actions.filter((action) => action.status === 'OPEN').length
  const overdue = record.actions.filter((action) => action.status === 'OPEN' && action.overdue).length

  return (
    <div className="fw-capa-stack">
      <div className="fw-q-head">
        <p className="fw-capa-hint">{t('actions.intro')}</p>
        <div className="fw-q-actions">{addButton}</div>
      </div>
      <ListFrame<CapaAction>
        label={t('actions.label')}
        rows={record.actions}
        rowId={(row) => row.id}
        columns={columns}
        count={t('actions.count', { count: record.actions.length, open, overdue })}
        listKey={null}
        keys={keys}
        onOpen={(row) => actions?.onOpenAction?.(row.id)}
        state={record.actions.length === 0 ? <EmptyState title={t('actions.empty')} description={t('actions.emptyBody')} action={addHeld ? undefined : addButton} /> : undefined}
      />
      <p className="fw-capa-hint">{t('actions.foot')}</p>
      {model.drawer && <ActionDrawer model={model} record={record} actions={actions} />}
    </div>
  )
}
