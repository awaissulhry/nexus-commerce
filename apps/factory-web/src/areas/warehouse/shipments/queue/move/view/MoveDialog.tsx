'use client'

import { Field } from '@nexus/ui/components'
import { NumberStepper, RadioCard } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { DepthDialog, PartRead } from '../../shared/DepthDialog'
import { DOOR_NAMESPACES, useDoorWords } from '../../shared/door-words'
import type { MoveTargets } from '../api'
import { MOVE_REASONS, moveHeld, moveTotals, REASON_LIMITS, targetHeld, type MoveActions, type MoveModel } from '../model'
import type { SplitPreview } from '../../split/api'
import '../../../shipments.css'
import '../../shared/depth.css'

/**
 * F-OS-203 (order SHIPMENTS tab, 10-design §7 D2 / D3; 18-lead-settles L6) — Move garments to… / Merge into…: ONE dialog, mounted by
 * Warehouse's record ⋯ and by the order's Shipments row ⋯ (Move.tsx is its container). The target (DRAFTs of the same customer,
 * company and site only, each held with its join reason in Warehouse's words), the garments per line (move), why, the office's words;
 * what never changes and that the customer is not told. Centred, never a drawer.
 */
export function MoveDialog({ number, model, actions }: { number: string; model: MoveModel; actions?: MoveActions }) {
  return (
    <WithMessages namespaces={DOOR_NAMESPACES}>
      <Body number={number} model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ number, model, actions }: { number: string; model: MoveModel; actions?: MoveActions }) {
  const { t, say } = useDoorWords()
  const close = () => actions?.onClose?.()
  const merge = model.mode === 'merge'
  const title = merge ? t('move.mergeTitle', { number }) : t('move.title', { number })
  if (model.preview.state !== 'ready' || model.targets.state !== 'ready') {
    const failed = model.preview.state === 'error' ? model.preview.problem : model.targets.state === 'error' ? model.targets.problem : null
    return (
      <DepthDialog title={title} held={t('move.held.reading')} onGo={() => undefined} goLabel={merge ? t('move.mergeGoBare') : t('move.goBare')} onClose={close} problem={null}>
        <PartRead problem={failed} onRetry={actions?.onRetry} label={t('move.part')} />
      </DepthDialog>
    )
  }
  const preview: SplitPreview = model.preview.value
  const targets: MoveTargets = model.targets.value
  const target = targets.targets.find((entry) => entry.id === model.targetId) ?? null
  const totals = moveTotals(preview, model.quantities)
  const goLabel = merge ? (target ? t('move.mergeGo', { number: target.number }) : t('move.mergeGoBare')) : t('move.go', { count: totals.moving })
  return (
    <DepthDialog title={title} held={say(moveHeld(model, preview, targets))} onGo={() => actions?.onGo?.()} goLabel={goLabel} onClose={close} problem={say(model.problem)} size="lg">
      <p className="fw-sh-hint">{merge ? t('move.mergeWhat', { count: preview.lines.reduce((sum, line) => sum + line.quantity, 0), number }) : t('move.what')}</p>
      {targets.targets.length === 0 ? (
        <p className="fw-sh-hint">{t('move.held.noTarget')}</p>
      ) : (
        <fieldset className="fw-shd-choices">
          <legend className="fw-sh-h3">{merge ? t('move.into') : t('move.to')}</legend>
          {targets.targets.map((entry) => {
            const held = targetHeld(entry)
            return (
              <RadioCard
                key={entry.id}
                name="move-target"
                value={entry.id}
                checked={model.targetId === entry.id}
                selected={model.targetId === entry.id}
                onChange={() => actions?.onTarget?.(entry.id)}
                title={t('move.target', { number: entry.number, orders: entry.orders.map((order) => order.number).join(', ') })}
                description={held ? (say(held) ?? undefined) : t('move.targetGarments', { count: entry.garments })}
              />
            )
          })}
        </fieldset>
      )}
      {!merge && (
        <div className="fw-shd-stack">
          <div className="fw-sh-size-grid">
            {preview.lines.map((line) => (
              <Field key={line.id} label={`${line.label} · ${line.size}`} hint={t('split.lineFacts', { quantity: line.quantity, packed: line.packed, serials: line.serials })}>
                {line.movable > 0 ? (
                  <NumberStepper size="sm" min={0} max={line.movable} value={Math.min(model.quantities[line.id] ?? 0, line.movable)} onChange={(next) => actions?.onQuantity?.(line.id, next)} aria-label={t('split.movesOf', { line: line.label, size: line.size })} decrementLabel={t('split.fewer')} incrementLabel={t('split.more')} />
                ) : (
                  <span className="fw-sh-muted">{t('split.cannotMove')}</span>
                )}
              </Field>
            ))}
          </div>
          <p className="fw-sh-hint">{t('split.totals', { moving: totals.moving, staying: totals.staying })}</p>
          <fieldset className="fw-shd-choices fw-shd-choices--grid">
            <legend className="fw-sh-h3">{t('split.reason')}</legend>
            {MOVE_REASONS.filter((reason) => preview.reasons.includes(reason)).map((reason) => (
              <RadioCard key={reason} name="move-reason" value={reason} checked={model.reason === reason} selected={model.reason === reason} onChange={() => actions?.onReason?.(reason)} title={t(`splitReason.${reason}`)} />
            ))}
          </fieldset>
        </div>
      )}
      <Field label={t('door.wordsOptional')} hint={t('door.officeOnly')}>
        <Textarea rows={2} limit={REASON_LIMITS.max} value={model.words} onChange={(event) => actions?.onWords?.(event.target.value)} />
      </Field>
      <p className="fw-sh-hint">{t('door.customerNotTold')}</p>
      <p className="fw-sh-hint">{merge ? t('move.mergeNever') : t('move.never')}</p>
    </DepthDialog>
  )
}
