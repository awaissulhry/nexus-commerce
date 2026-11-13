'use client'

import { Check, Flag } from 'lucide-react'
import { Banner, Field, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Radio, Select, Tag } from '@nexus/ui/primitives'
import { CellSaveMark, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { OrderRow } from '../../api'
import { PRIORITY_LEVELS, type PriorityLevel } from '../../depth/api'
import { confirmationHref, depthEditHeld, NAMESPACE, printHeld, PRIORITY_TONE, selectionHeld, selectionOutcome, urgentReasonProblem, URGENT_REASON_MAX } from '../../depth/model'
import type { ListDepthActions, ListDepthModel } from '../use-list-depth'
import '../../depth/depth.css'

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The list's W2b columns (design sales.orders grid "Priority (W2b) · Season (W2b)" and "Inline edit: priority and site only (W2b),
 * per cell with CellSaveMark"): the Priority cell is the level, changed in place by the person who may (orders.manage; a closed or
 * cancelled order says why) — saving ↻, saved ✓, refused with the reason; URGENT asks its reason first —, the Season cell its code.
 * Site has no write in the API (named in the step's notes), so it is not drawn as editable.
 */
export function depthColumns(model: ListDepthModel, actions: ListDepthActions | undefined, d: Translate): ColDef<OrderRow>[] {
  const PriorityCell = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    const row = model.rows?.get(data.id)
    if (!row) return <span className="fw-sod-hint">{model.rows === null ? '…' : '—'}</span>
    const level = row.priority.level
    const held = depthEditHeld(data.status, model.can)
    const save = model.saves.get(data.id)
    return (
      <span className="fw-sod-priority">
        {held ? (
          <Pill tone={PRIORITY_TONE[level]} title={row.priority.urgentReason ?? (model.can.manage ? d(held.key) : undefined)}>
            {d(`priority.level.${level}`)}
          </Pill>
        ) : (
          <Select size="sm" aria-label={d('list.priorityOf', { number: data.number })} title={row.priority.urgentReason ?? undefined} value={level} disabled={save?.state === 'saving'} onChange={(event) => actions?.onPriority?.(data, event.target.value as PriorityLevel)}>
            {PRIORITY_LEVELS.map((entry) => (
              <option key={entry} value={entry}>
                {d(`priority.level.${entry}`)}
              </option>
            ))}
          </Select>
        )}
        {save?.state === 'saving' && <CellSaveMark state="saving" />}
        {save?.state === 'saved' && (
          <span className="fw-sod-saved" role="img" aria-label={d('list.saved')}>
            <Check size={13} aria-hidden />
          </span>
        )}
        {save?.state === 'refused' && (
          <Tag tone="danger" title={d(save.reason.key, save.reason.params)}>
            {d('list.refused')}
          </Tag>
        )}
      </span>
    )
  }
  const SeasonCell = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    const row = model.rows?.get(data.id)
    return <span>{row?.season?.code ?? (model.rows === null ? '…' : '—')}</span>
  }
  return [
    { colId: 'priority', headerName: d('list.col.priority'), minWidth: 132, flex: 0.8, sortable: false, cellRenderer: PriorityCell },
    { colId: 'season', headerName: d('list.col.season'), minWidth: 96, flex: 0.6, sortable: false, cellRenderer: SeasonCell },
  ]
}

/** The row's ⋯ verb "Print confirmation (W2b)": the confirmation PDF in a new tab; held while the order waits for a yes or was cancelled. */
export function printVerb(row: OrderRow, prefix: string, d: Translate): MenuItemDef {
  const held = printHeld(row.status)
  return held ? { id: 'print', label: d('list.print'), disabled: true, description: d(held.key) } : { id: 'print', label: d('list.print'), href: confirmationHref(prefix, row.id), target: '_blank' }
}

/** The selection's bulk verb: "Set priority for N" (held with its reason before the click). */
export function SetPriorityButton({ count, model, onClick }: { count: number; model: ListDepthModel; onClick: () => void }) {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <SetButton count={count} model={model} onClick={onClick} />
    </WithMessages>
  )
}

function SetButton({ count, model, onClick }: { count: number; model: ListDepthModel; onClick: () => void }) {
  const d = useT(NAMESPACE)
  const held = selectionHeld(count, model.can)
  return (
    <Button size="sm" aria-label={d('list.setPriority', { count })} heldReason={held ? d(held.key, held.params) : null} onClick={onClick}>
      <Flag size={13} aria-hidden /> <SelectionLabel>{d('list.setPriority', { count })}</SelectionLabel>
    </Button>
  )
}

/**
 * Set priority (design sales.orders grid "Set priority (W2b)" on a selection, and one row's URGENT): the level, URGENT's reason,
 * then what happened — changed, already at that level, left out (closed, cancelled, or not yours), not found.
 */
export function SetPriorityDialog({ model, actions }: { model: ListDepthModel; actions?: ListDepthActions }) {
  if (!model.dialog) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <PriorityModal model={model} actions={actions} />
    </WithMessages>
  )
}

function PriorityModal({ model, actions }: { model: ListDepthModel; actions?: ListDepthActions }) {
  const d = useT(NAMESPACE)
  const dialog = model.dialog!
  const problem = urgentReasonProblem(dialog.level, dialog.reason)
  const held = dialog.busy ? d('held.busy') : problem ? d(problem) : null
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      title={dialog.single ? d('priority.titleOne') : d('selection.title', { count: dialog.ids.length })}
      size="sm"
      footer={
        dialog.outcome ? (
          <>
            <span className="grow" />
            <Button size="sm" variant="primary" onClick={close}>
              {d('common.done')}
            </Button>
          </>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" onClick={close}>
              {d('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onDialogGo?.()}>
              {dialog.busy ? d('common.working') : dialog.single ? d('priority.go') : d('selection.go', { count: dialog.ids.length })}
            </Button>
          </>
        )
      }
    >
      <form
        className="fw-sod-stack"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held && !dialog.outcome) actions?.onDialogGo?.()
        }}
      >
        {dialog.problem && <Banner tone="danger" title={d(dialog.problem.key, dialog.problem.params)} />}
        {dialog.outcome ? (
          <Banner tone={dialog.outcome.skipped.length > 0 || dialog.outcome.unknown > 0 ? 'warning' : 'success'} title={d('selection.done', { level: d(`priority.level.${dialog.outcome.priorityLevel}`) })}>
            <ul className="fw-sod-list">
              {selectionOutcome(dialog.outcome).map((entry) => (
                <li key={entry.key}>{d(entry.key, entry.params)}</li>
              ))}
            </ul>
          </Banner>
        ) : (
          <>
            <fieldset className="fw-sod-radios">
              <legend className="fw-sod-legend">{d('priority.legend')}</legend>
              {PRIORITY_LEVELS.map((level) => (
                <Radio key={level} name="fw-sod-selection-priority" value={level} checked={dialog.level === level} onChange={() => actions?.onDialog?.({ level })} label={d(`priority.level.${level}`)} />
              ))}
            </fieldset>
            <p className="fw-sod-hint">{d(`priority.means.${dialog.level}`)}</p>
            {dialog.level === 'URGENT' && (
              <Field label={d('priority.reason')} hint={d('priority.reasonHint', { max: URGENT_REASON_MAX })}>
                <Textarea value={dialog.reason} onChange={(event) => actions?.onDialog?.({ reason: event.target.value })} rows={2} maxLength={URGENT_REASON_MAX + 10} />
              </Field>
            )}
          </>
        )}
      </form>
    </Modal>
  )
}
