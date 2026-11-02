'use client'

import { Scissors } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import type { WorkOrder } from '../../../_shared/api'
import { quantityText } from '../../../_shared/model'
import { overCells, priorityBad, SHIFT_NAMESPACE, splitAskHeld } from '../model'
import type { SplitActions, SplitModel } from '../use-split'
import '../every-shift.css'

/**
 * Split work order (design pop:wo-split, MES-010): the pieces of each size to move into a child work order with its own due
 * date; genealogy kept. The API's preview follows the typing: what each side keeps and gets, with its planned materials.
 * Nothing is written until Split. Pieces and materials only: no cost, no person.
 */
export function SplitDialog({ workOrder, model, actions }: { workOrder: WorkOrder; model: SplitModel; actions?: SplitActions }) {
  const t = useT(SHIFT_NAMESPACE)
  const tp = useT('production')
  const scoped = useScopedT(SHIFT_NAMESPACE)
  const locale = useLocale()
  const { draft, preview } = model
  const over = new Set(overCells(workOrder.cells, draft.moves))
  const held = splitAskHeld(workOrder, draft, preview, model.busy)
  return (
    <Modal
      open
      onClose={() => (model.busy ? undefined : actions?.onClose?.())}
      title={t('split.title', { number: workOrder.number })}
      subtitle={t('split.subtitle')}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()} heldReason={model.busy ? tp('held.busy') : null}>
            {tp('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? scoped(held.key, held.params) : null} onClick={() => actions?.onSplit?.()}>
            {model.busy ? <Spinner size={12} /> : <Scissors size={13} aria-hidden />} {t('split.go')}
          </Button>
        </>
      }
    >
      <div className="fw-pr-dialog">
        {model.problem && <Banner tone="danger" title={scoped(model.problem.key, model.problem.params)} />}
        <SummaryTable
          label={t('split.cells')}
          stackOnPhone
          columns={[t('split.col.cell'), t('split.col.pieces'), t('split.col.move'), t('split.col.keeps')]}
          align={[undefined, 'right', 'right', 'right']}
          rows={workOrder.cells.map((cell) => {
            const moved = draft.moves[cell.id] ?? 0
            return {
              id: cell.id,
              cells: [
                `${cell.colourwayCode} ${cell.size}`,
                String(cell.quantity),
                <Input
                  key="move"
                  size="sm"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={cell.quantity}
                  aria-label={t('split.moveLabel', { cell: `${cell.colourwayCode} ${cell.size}` })}
                  aria-invalid={over.has(cell.id) || undefined}
                  value={moved === 0 ? '' : String(moved)}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    actions?.onDraft?.({ moves: { ...draft.moves, [cell.id]: Number.isInteger(value) && value > 0 ? value : 0 } })
                  }}
                />,
                over.has(cell.id) ? t('split.tooMany') : String(cell.quantity - moved),
              ],
            }
          })}
        />
        <div className="fw-es-fields">
          <Field label={t('split.due')} hint={t('split.dueHint')}>
            <DateField value={draft.dueDate} onChange={(value) => actions?.onDraft?.({ dueDate: value })} clearable clearLabel={tp('new.dueClear')} ariaLabel={t('split.due')} />
          </Field>
          <Field label={tp('overview.priority')} error={priorityBad(draft.priority) ? tp('overview.priorityBad') : undefined}>
            <Input size="sm" type="number" inputMode="numeric" value={draft.priority} onChange={(event) => actions?.onDraft?.({ priority: event.target.value })} />
          </Field>
        </div>
        <Checkbox checked={draft.rush} onChange={(event) => actions?.onDraft?.({ rush: event.target.checked })} label={t('rush.label')} />
        <Field label={t('split.note')}>
          <Textarea value={draft.note} onChange={(event) => actions?.onDraft?.({ note: event.target.value })} rows={2} maxLength={2000} />
        </Field>
        {model.reading && (
          <p className="fw-pr-hint" role="status">
            <Spinner size={12} /> {t('split.reading')}
          </p>
        )}
        {preview && preview.refusal === null && preview.problems.length === 0 && preview.parent && preview.child && (
          <>
            <p className="fw-pr-hint" role="status">
              {t('split.outcome', { number: workOrder.number, keeps: preview.parent.pieces, child: preview.numberPreview ?? t('split.newNumber'), gets: preview.child.pieces })}
            </p>
            {preview.child.materials.length > 0 && (
              <SummaryTable
                label={t('split.materials')}
                stackOnPhone
                columns={[t('split.col.material'), t('split.col.parent'), t('split.col.child')]}
                align={[undefined, 'right', 'right']}
                rows={preview.child.materials.map((material) => {
                  const own = preview.parent!.materials.find((entry) => entry.itemId === material.itemId && entry.itemColourId === material.itemColourId)
                  return {
                    id: `${material.itemId}|${material.itemColourId ?? ''}`,
                    cells: [[material.itemCode, material.colourCode].filter(Boolean).join(' · '), own ? `${quantityText(own.planned, locale)} ${own.baseUom}` : '—', `${quantityText(material.planned, locale)} ${material.baseUom}`],
                  }
                })}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
