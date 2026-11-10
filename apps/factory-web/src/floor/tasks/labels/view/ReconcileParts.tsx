'use client'

import type { ReactNode } from 'react'
import { CircleCheck, Info, PackageX, TriangleAlert, Undo2 } from 'lucide-react'
import { FloorButton, QuantityPad } from '@nexus/ui/floor'
import type { Translate } from '../../../../lib/i18n/messages'
import { useT } from '../../../../lib/i18n/provider'
import { TaskLine } from '../../shared/view/TaskParts'
import { SPOIL_REASONS, type ReconcileModel, type SpoilHeld, type SpoilReason } from '../reconcile'

/**
 * B-W2b-259 (MES-140) on SCR-096: the label reconciliation in the print section (design floor.labels sec:print "printed vs used
 * vs spoiled, 'Log spoiled'") and the Log spoiled labels step (page.h "Log spoiled labels (W2b)"): how many of the picked
 * size's labels, then one tap on why (spoiled: damaged, misprinted, lost, jammed; or handed back unused). Online only: held
 * with the reason offline. Words from the figures (catalogue floor-labels-depth); never a person.
 */

export function ReconcilePanel({ model, onLog }: { model: ReconcileModel; onLog: () => void }) {
  const t = useT('floor-labels-depth')
  const { size, total } = model
  const off = size ? size.difference : total.difference
  let status: ReactNode
  if (off === 0)
    status = (
      <TaskLine tone="success" icon={<CircleCheck />}>
        {t('panel.balanced')}
      </TaskLine>
    )
  else
    status = (
      <TaskLine tone="warning" icon={<TriangleAlert />}>
        {t(off > 0 ? 'panel.missing' : 'panel.over', { count: Math.abs(off) })}
      </TaskLine>
    )
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-labels-reconcile">
      <h3 id="fw-labels-reconcile" className="fw-floor-subtitle">
        {t('panel.title')}
      </h3>
      {size ? <p className="fw-labels-figures">{t('panel.size', { size: size.label, printed: size.printed, used: size.used, spoiled: size.spoiled, returned: size.returned })}</p> : null}
      {status}
      {!model.balanced && model.holdsRelease ? (
        <TaskLine tone="info" icon={<Info />}>
          {t('panel.holds')}
        </TaskLine>
      ) : null}
      <p className="fw-floor-muted">{t('panel.total', { printed: total.printed, used: total.used, spoiled: total.spoiled, returned: total.returned })}</p>
      <FloorButton size="lg" variant="secondary" icon={<PackageX />} heldReason={heldWords(model.held, t)} onClick={onLog}>
        {t('panel.log')}
      </FloorButton>
      {/* A held button says why on screen too (the DS rule). */}
      {model.held && model.held !== 'busy' ? <p className="fw-floor-muted">{t(`held.${model.held}`)}</p> : null}
    </section>
  )
}

const heldWords = (held: SpoilHeld, t: Translate): string | undefined => (held ? t(`held.${held}`) : undefined)

export interface SpoilStepModel {
  readonly size: string
  readonly printed: number
  readonly used: number
  /** Already logged spoiled or returned. */
  readonly logged: number
  /** Labels that may still be logged (printed − spoiled − returned). */
  readonly room: number
  readonly count: number
  readonly held: SpoilHeld
}

export function SpoilStep({ model, onCount, onChoose, notice }: { model: SpoilStepModel; onCount: (value: number | null) => void; onChoose: (choice: SpoilReason | 'RETURNED') => void; notice?: ReactNode }) {
  const t = useT('floor-labels-depth')
  const pad = useT('floor-labels')
  const held = heldWords(model.held, t)
  return (
    <section className="fw-floor-section" aria-labelledby="fw-labels-spoil">
      <h2 id="fw-labels-spoil" className="fw-floor-section-title">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <PackageX />
        </span>
        {t('spoil.title')}
      </h2>
      <p className="fw-floor-lead">{t('spoil.question', { size: model.size, count: model.printed, used: model.used, logged: model.logged })}</p>
      <QuantityPad
        label={t('spoil.count', { size: model.size })}
        value={model.count}
        onChange={onCount}
        unit={pad('reprint.unit')}
        min={1}
        max={Math.max(1, model.room)}
        decimals={0}
        showPad={false}
        decrementLabel={pad('pad.minus')}
        incrementLabel={pad('pad.plus')}
        clearLabel={pad('pad.clear')}
        backLabel={pad('pad.back')}
        emptyLabel={pad('pad.empty')}
        rangeLabel={() => t('spoil.range', { max: model.room })}
      />
      <div className="fw-task-reasons" role="group" aria-label={t('spoil.why')}>
        {SPOIL_REASONS.map((reason) => (
          <FloorButton key={reason} size="lg" variant="secondary" block heldReason={held} onClick={() => onChoose(reason)}>
            {t(`spoil.reason.${reason}`)}
          </FloorButton>
        ))}
        <FloorButton size="lg" variant="secondary" block icon={<Undo2 />} heldReason={held} onClick={() => onChoose('RETURNED')}>
          {t('spoil.returned')}
        </FloorButton>
      </div>
      {held ? <p className="fw-floor-muted">{held}</p> : null}
      <p className="fw-floor-muted">{t('spoil.logged')}</p>
      {notice}
    </section>
  )
}
