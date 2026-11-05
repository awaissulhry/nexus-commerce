'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { CheckCheck, ClipboardList, Plus } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { recordAddress } from '../../../../../lib/records/record-links'
import type { IncidentAction, IncidentRecord } from '../../api'
import { actionSelectHeld, actionsHeld, madeRecordKey, newActionDraft } from '../../model'
import type { IncidentRecordActions, IncidentRecordModel } from '../../view-model'
import { SectionHead, useWhen, useWords } from '../../view/parts'

/** Where a made record opens: its own page once built (RECORD_PAGES), else its record panels. */
export const madeHref = (prefix: string, record: NonNullable<IncidentAction['record']>): string => `${prefix}${recordAddress({ type: record.type, id: record.id, label: record.label }, OFFICE_PAGES)}`

/**
 * design rec:Incident/actions — corrective actions (action · owner · due · status · evidence · made into: maintenance job / DVR
 * measure / training need, with its link). "Make a job" and "Add to improvement plan" create the linked record in one step;
 * "Plan training" waits for the safety courses' page (said in words). The shared list frame without saved views (a record's
 * list): Mark done N, Enter opens the action.
 */
export function ActionsTab({ model, incident, actions, onHelp }: { model: IncidentRecordModel; incident: IncidentRecord; actions?: IncidentRecordActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const when = useWhen()
  const held = actionsHeld(incident)
  const selected = model.selected ?? []
  const picked = incident.actions.filter((action) => selected.includes(action.id) && action.status === 'OPEN')
  const open = (action: IncidentAction) => actions?.onDialog?.({ kind: 'action', actionId: action.id, mode: 'view', draft: { ...newActionDraft(), title: action.title, dueOn: action.dueOn ?? '' }, machines: null, busy: false, problem: null })

  const columns = useMemo<ColDef<IncidentAction>[]>(
    () => [
      {
        colId: 'title',
        headerName: t('col.action'),
        minWidth: 240,
        flex: 2.4,
        valueGetter: (params) => (params.data ? `${params.data.seq}. ${params.data.title}` : ''),
        cellRenderer: ({ data }: ICellRendererParams<IncidentAction>) =>
          data ? (
            <Button size="sm" variant="link" wrap onClick={() => open(data)}>
              {`${data.seq}. ${data.title}`}
            </Button>
          ) : null,
      },
      { colId: 'owner', headerName: t('col.owner'), minWidth: 140, flex: 1, valueGetter: (params) => (params.data ? (params.data.owner?.name ?? t('action.noOwner')) : '') },
      {
        colId: 'dueOn',
        headerName: t('col.due'),
        minWidth: 140,
        flex: 1,
        valueGetter: (params) => params.data?.dueOn ?? '',
        cellRenderer: ({ data }: ICellRendererParams<IncidentAction>) => (data ? <span className="fw-inc-cell">{data.dueOn ? when.day(data.dueOn) : t('action.noDue')}{data.overdue ? <Tag tone="danger">{t('action.overdue')}</Tag> : null}</span> : null),
      },
      { colId: 'status', headerName: t('col.status'), minWidth: 110, flex: 1, valueGetter: (params) => (params.data ? t(`actionStatus.${params.data.status}`) : '') },
      {
        colId: 'evidence',
        headerName: t('col.evidence'),
        minWidth: 200,
        flex: 1.6,
        valueGetter: (params) => {
          const action = params.data
          if (!action) return ''
          if (action.status === 'DONE') return [t('action.doneBy', { at: action.doneAt ? when.at(action.doneAt) : '—', by: action.doneBy ?? t('record.someone') }), action.evidenceNote].filter(Boolean).join(' · ')
          if (action.status === 'CANCELLED') return [t('action.cancelledAt', { at: action.cancelledAt ? when.at(action.cancelledAt) : '—' }), action.cancelReason].filter(Boolean).join(' · ')
          return action.evidenceNote ?? '—'
        },
      },
      {
        colId: 'madeInto',
        headerName: t('col.madeInto'),
        minWidth: 200,
        flex: 1.4,
        valueGetter: (params) => (params.data?.record ? `${t(madeRecordKey(params.data))}: ${params.data.record.label}` : params.data ? t('madeInto.none') : ''),
        cellRenderer: ({ data }: ICellRendererParams<IncidentAction>) =>
          data?.record ? (
            <span className="fw-inc-cell">
              <span className="fw-inc-muted">{t(madeRecordKey(data))}</span>
              <Link href={madeHref(model.prefix, data.record)}>{data.record.label}</Link>
            </span>
          ) : data ? (
            <span className="fw-inc-muted">{t('madeInto.none')}</span>
          ) : null,
      },
    ],
    // The words follow the language.
    [t, when, model.prefix],
  )

  return (
    <div className="fw-inc-tab">
      <section className="fw-inc-section" aria-labelledby="fw-inc-actions">
        <SectionHead id="fw-inc-actions" title={t('actions.title')} note={t('actions.note')}>
          <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onDialog?.({ kind: 'action', actionId: 'new', mode: 'edit', draft: newActionDraft('NONE', incident.machine?.id ?? null), machines: null, busy: false, problem: null })}>
            <Plus size={13} aria-hidden /> {t('actions.new')}
          </Button>
        </SectionHead>
        <ListFrameActions model={model} incident={incident} actions={actions} columns={columns} picked={picked} onOpen={open} onHelp={onHelp} />
      </section>
    </div>
  )
}

function ListFrameActions({ model, incident, actions, columns, picked, onOpen, onHelp }: { model: IncidentRecordModel; incident: IncidentRecord; actions?: IncidentRecordActions | undefined; columns: ColDef<IncidentAction>[]; picked: IncidentAction[]; onOpen: (action: IncidentAction) => void; onHelp: () => void }) {
  const t = useWords()
  const canBulk = incident.canManage && incident.status === 'OPEN'
  return (
    <ListFrame<IncidentAction>
      label={t('actions.title')}
      listKey={null}
      rows={incident.actions}
      rowId={(action) => action.id}
      columns={columns}
      count={t('actions.count', { count: incident.actions.length })}
      selection={
        canBulk
          ? {
              selected: model.selected ?? [],
              onChange: (ids) => actions?.onSelected?.(ids),
              actions: (
                <Button size="sm" variant="primary" aria-label={t('bulk.done', { count: picked.length })} heldReason={model.bulkBusy ? t('held.saving') : picked.length === 0 ? t('held.noneOpen') : null} onClick={() => void actions?.onBulkDone?.(picked)}>
                  <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.done', { count: picked.length })}</SelectionLabel>
                </Button>
              ),
            }
          : undefined
      }
      isRowSelectable={canBulk ? (action) => (actionSelectHeld(incident, action) ? t(actionSelectHeld(incident, action)!) : null) : undefined}
      keys={[{ keys: ['Enter'], does: t('keys.openAction') }]}
      onHelp={onHelp}
      onOpen={onOpen}
      state={incident.actions.length === 0 ? <EmptyState icon={<ClipboardList size={22} aria-hidden />} title={t('actions.emptyTitle')} description={t('actions.empty')} /> : undefined}
      cards={{ fields: { title: { role: 'title' } } }}
    />
  )
}
