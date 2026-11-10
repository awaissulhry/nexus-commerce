'use client'

import { Check, Circle, CircleSlash, ListChecks } from 'lucide-react'
import { FloorButton, FloorList, FloorListRow } from '@nexus/ui/floor'
import type { Translate } from '../../../../lib/i18n/messages'
import { instructionIcon } from '../../../../lib/production/instruction-icons'
import type { OperationSteps, StepOutcome } from '../checks'

/**
 * SCR-090 "Steps in this operation" (MES-102; the DS has no FloorChecklist: composed of FloorList rows, named in the notes):
 * one tap ticks a step; each ticked row says who and when (the person's own, or "another person": names only where the API
 * gives them); Finish waits for the required ones. "Does not apply" keeps a step that a bundle does not have from holding it.
 */
export function StepsPanel({ list, t, time, onTick }: { list: OperationSteps; t: Translate; time: (value: string) => string; onTick: (code: string, outcome: StepOutcome) => void }) {
  if (list.steps.length === 0) return null
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-scans-steps">
      <h3 id="fw-scans-steps" className="fw-floor-subtitle fw-scans-panel-title">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <ListChecks />
        </span>
        {t('steps.title')}
      </h3>
      {list.steps.map((step) => {
        const done = step.tick
        // B-W2b-232 (FI9:01): an open step shows its instruction icon (the office's same picture); a ticked one its outcome.
        const Icon = step.icon ? instructionIcon(step.icon) : Circle
        const who = done ? (done.mine ? t('steps.you') : (done.by ?? t('steps.other'))) : null
        return (
          <div key={step.code} className="fw-scans-step">
            <FloorList label={step.words}>
              <FloorListRow
                icon={done ? done.outcome === 'DONE' ? <Check /> : <CircleSlash /> : <Icon />}
                tone={done ? 'success' : step.required ? 'warning' : 'neutral'}
                title={step.words}
                meta={done ? t('steps.when', { who: who!, time: time(done.at) }) : step.required ? t('steps.required') : t('steps.optional')}
                status={done ? t(`steps.outcome.${done.outcome}`) : undefined}
                onPress={done ? undefined : () => onTick(step.code, 'DONE')}
              />
            </FloorList>
            {done ? null : (
              <FloorButton size="md" variant="secondary" icon={<CircleSlash />} onClick={() => onTick(step.code, 'NOT_APPLICABLE')}>
                {t('steps.notHere')}
              </FloorButton>
            )}
          </div>
        )
      })}
    </section>
  )
}
