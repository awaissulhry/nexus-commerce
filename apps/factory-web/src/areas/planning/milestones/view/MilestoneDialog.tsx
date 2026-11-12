'use client'

import { CheckCheck, ExternalLink, FastForward, Pencil, Trash2 } from 'lucide-react'
import { Banner, KeyValue } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { dayText, heldOf, lateWords, milestoneName, rowsOf, stateTone, stateWords, workOrdersWords, type MilestoneRow, type Words } from '../model'
import type { MilestonesActions, MilestonesModel } from '../view-model'

/**
 * A milestone in a centred dialog (design planning.milestones sec:calendar "Click → popover with Mark done (date) and the gate
 * it opens"; the Owner's preference: details in a centred modal): what it is, its order and customer, target, actual, state
 * and lateness, the gate's planner, the sample round it waits for, the order's leather, who passed it (a person, or its
 * event), the start before it (by whom, when, why), and what it opens: the order's work orders the planning board holds while
 * it waits. Actions held with the reason in words: Mark done…, Start before the gate…, Change…, Remove…, the order in a new
 * tab. Production start and ship read only (they follow the work orders and the shipments). Esc closes.
 */
export function MilestoneDialog({ model, actions, words }: { model: MilestonesModel; actions?: MilestonesActions; words: Words }) {
  const { t, locale } = words
  const id = model.controls.open
  if (!id || model.dialog !== null) return null
  const world = model.world.status === 'ready' ? model.world.value : null
  const row: MilestoneRow | undefined = rowsOf(world).find((entry) => entry.id === id)
  const close = () => actions?.onOpen?.(null)
  if (!row) {
    return (
      <Modal open onClose={close} title={t('dialog.gone.title')} size="sm">
        <p className="fw-tna-hint">{model.world.status === 'loading' ? t('held.loading') : t('dialog.gone.body')}</p>
      </Modal>
    )
  }
  const gate = row.gate
  const place = { locale, timeZone: world?.timeZone ?? 'Europe/Rome' }
  const items = [
    { label: t('dialog.order'), value: `${row.order.number} · ${row.order.customer.name}`, hint: row.order.customerRef ? t('dialog.customerRef', { ref: row.order.customerRef }) : undefined },
    { label: t('dialog.target'), value: dayText(row.target, locale) },
    { label: t('dialog.actual'), value: dayText(row.actual, locale), hint: row.late !== null ? lateWords(row, t) : undefined },
    ...(gate
      ? [
          { label: t('dialog.owner'), value: gate.owner?.name ?? '—' },
          ...(gate.sampleRound ? [{ label: t('dialog.round'), value: `${gate.sampleRound.number} · ${gate.sampleRound.decision ? t(`decision.${gate.sampleRound.decision}`) : t('decision.none')}` }] : []),
          ...(gate.leather ? [{ label: t('dialog.leather'), value: t(`leather.${gate.leather}`) }] : []),
          ...(gate.passedAt
            ? [{ label: t('dialog.passed'), value: gate.via === 'OFFICE' ? t('dialog.passedBy', { name: gate.passedBy?.name ?? '—', day: dayText(gate.passedOn, locale) }) : t(`via.${gate.via ?? 'OFFICE'}`, { day: dayText(gate.passedOn, locale) }) }]
            : []),
          ...(gate.startedBefore
            ? [{ label: t('dialog.startedBefore'), value: t('dialog.startedBy', { name: gate.startedBefore.by?.name ?? '—', when: formatDateTime(gate.startedBefore.at, place) }), hint: gate.startedBefore.reason }]
            : []),
        ]
      : [
          { label: t('dialog.comesFrom'), value: t(`dialog.follows.${row.kind}`) },
          // B-W2b-284: production start follows the production work orders; a sample or a repair is shown apart, never counted.
          ...(row.kind === 'START' && row.order.workOrders.byKind.length > 0 ? [{ label: t('dialog.workOrders'), value: workOrdersWords(row.order.workOrders.byKind, t) }] : []),
        ]),
  ]
  const passHeld = gate ? heldOf(gate.actions.pass, t) : null
  const startHeld = gate ? heldOf(gate.actions.startBefore, t) : null
  const editHeld = gate ? heldOf(gate.actions.edit, t) : null
  const removeHeld = gate ? heldOf(gate.actions.remove, t) : null
  return (
    <Modal
      open
      onClose={close}
      title={t('dialog.title', { name: milestoneName(row, t), order: row.order.number })}
      subtitle={t(`milestoneKind.${row.kind}`)}
      size="md"
      footer={
        <span className="fw-tna-footer">
          <Button size="sm" variant="quiet" onClick={() => actions?.onOpenOrder?.(row.order.id, true)}>
            <ExternalLink size={13} aria-hidden /> {t('dialog.openOrder')}
          </Button>
          <span className="fw-tna-inline">
            {gate && (
              <>
                <Button size="sm" variant="quiet" heldReason={removeHeld} onClick={() => actions?.onRemove?.(gate.id)}>
                  <Trash2 size={13} aria-hidden /> {t('dialog.remove')}
                </Button>
                <Button size="sm" heldReason={editHeld} onClick={() => actions?.onEdit?.(gate.id)}>
                  <Pencil size={13} aria-hidden /> {t('dialog.edit')}
                </Button>
                <Button size="sm" heldReason={startHeld} onClick={() => actions?.onStartBefore?.([gate.id])}>
                  <FastForward size={13} aria-hidden /> {t('dialog.startBefore')}
                </Button>
                <Button size="sm" variant="primary" heldReason={passHeld} onClick={() => actions?.onPass?.([gate.id])}>
                  <CheckCheck size={13} aria-hidden /> {t('dialog.done')}
                </Button>
              </>
            )}
          </span>
        </span>
      }
    >
      <div className="fw-tna-dialog">
        <span className="fw-tna-inline">
          <Pill tone={stateTone(row)}>{stateWords(row, t)}</Pill>
          {row.late !== null && <span className="fw-tna-sub">{lateWords(row, t)}</span>}
        </span>
        <KeyValue items={items} columns={2} labelCase="sentence" />
        {gate && gate.state === 'WAITING' && (
          <Banner tone="warning" title={gate.holds > 0 ? t('dialog.holds', { count: gate.holds, order: row.order.number }) : t('dialog.holdsNone', { order: row.order.number })}>
            {t('dialog.holdsHow')}
          </Banner>
        )}
        {gate && gate.state !== 'WAITING' && <p className="fw-tna-hint">{gate.state === 'PASSED' ? t('dialog.opened', { order: row.order.number }) : t('dialog.openedEarly', { order: row.order.number })}</p>}
      </div>
    </Modal>
  )
}
