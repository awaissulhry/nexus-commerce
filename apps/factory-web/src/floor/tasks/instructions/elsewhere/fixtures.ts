import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { onFloor } from '../../../frame/fixtures'
import { designScreen as myWorkScreen } from '../../mywork/fixtures'
import type { MyWorkViewModel } from '../../mywork/view/MyWorkView'
import { MyWorkView } from '../../mywork/view/MyWorkView'
import { designScreen as operationScreen } from '../../scans/fixtures'
import { NO_WORK, OperationView, type CountsStep, type OperationViewModel, type Work } from '../../scans/view/OperationView'
import type { NewerSpec } from '../api'
import type { InstructionFlag } from '../model'

/**
 * SCR-288 (the lead's extra id for B-W2b-232) — the W2b-4 instruction parts on two older screens, made-up data drawn by their own
 * views: SCR-090 Operation's card (floor.operation page.h#3 "Instructions (W2b)" and page.live#2 "New instruction version → banner,
 * opens before Start"; PRD-195 Spec changed "on the operation card"; FI9:01 the steps' icons) and SCR-089 My work's For your work
 * (FI9:02 "New instructions N", the second tile, counted in its condition). Each case takes an SCR-090 / SCR-089 case and adds
 * the W2b-4 facts.
 */

export type ElsewhereModel = { readonly kind: 'operation'; readonly model: OperationViewModel } | { readonly kind: 'mywork'; readonly model: MyWorkViewModel }

function ElsewhereView({ model }: { model: ElsewhereModel }) {
  return model.kind === 'operation' ? createElement(OperationView, { model: model.model }) : createElement(MyWorkView, { model: model.model })
}

const caseOf = <M,>(screen: { cases: readonly { id: string; model: M }[] }, id: string): M => {
  const found = screen.cases.find((item) => item.id === id)
  if (!found) throw new Error(`SCR-288: no case "${id}"`)
  return found.model
}

const NOT_STARTED = caseOf<OperationViewModel>(operationScreen, 'not-started')
const STEPS_CASE = caseOf<OperationViewModel>(operationScreen, 'steps')
const FOR_YOU = caseOf<MyWorkViewModel>(myWorkScreen, 'for-your-work')
const QUEUE = caseOf<MyWorkViewModel>(myWorkScreen, 'queue')

const flag = (due: InstructionFlag['due']): InstructionFlag => ({ instructionId: 'wi-7', number: 'WI-DEMO-0007', versionId: 'v-4', versionNumber: 4, due })
const newer = (decision: NewerSpec['newer']['decision'] = null): NewerSpec => ({
  workOrder: { id: 'wo-42', number: 'WO-DEMO-0042' },
  revision: { revision: 2, status: 'OBSOLETE' },
  newer: { state: 'NEWER_RELEASED', banner: true, newPages: decision?.disposition === 'REWORK', message: '', newer: { id: 'r-3', revision: 3, releasedOn: '2026-11-09' }, decision },
})

/** An SCR-090 counts case with the W2b-4 facts added to its work. */
function withWork(base: OperationViewModel, change: Partial<Work>): ElsewhereModel {
  const step = base.step as CountsStep
  return { kind: 'operation', model: { ...base, step: { ...step, work: { ...(step.work ?? NO_WORK), ...change } } } }
}

const ICONS = ['needle', 'eye', 'check'] as const
const stepsWithIcons = (base: OperationViewModel): Partial<Work> => {
  const steps = (base.step as CountsStep).work?.steps
  return steps ? { steps: { ...steps, steps: steps.steps.map((row, index) => ({ ...row, icon: ICONS[index % ICONS.length], critical: index === 0 })) } } : {}
}

export const designScreen = defineDesignScreen<ElsewhereModel>({
  screen: 'SCR-288',
  title: 'Floor › Operation and My work › Instructions (W2b-4)',
  view: onFloor(ElsewhereView),
  cases: [
    { id: 'op-new-first', label: 'Operation: first time with this instruction', model: withWork(NOT_STARTED, { instruction: flag('FIRST'), newerSpec: null }), note: 'MES-110: the line says it opens before Start; Start opens Spec & instructions once (Back returns here, the next Start goes).' },
    { id: 'op-new-changed', label: 'Operation: a new instruction version', model: withWork(NOT_STARTED, { instruction: flag('CHANGED'), newerSpec: null }), note: 'page.live#2: read when the operation opens (no live badge reaches a tablet: an instruction has no site, B-W2b-214).' },
    { id: 'op-seen', label: 'Operation: nothing new, Instructions button', model: withWork(NOT_STARTED, { instruction: flag(null), newerSpec: null }), note: 'page.h#3 "Instructions (W2b)": a button on the bundle beside Photo or comment (the frame has no menu slot).' },
    { id: 'op-spec-changed', label: 'Operation: Spec changed', model: withWork(NOT_STARTED, { instruction: flag(null), newerSpec: newer() }), note: 'PRD-195 on the operation card: keep to the frozen revision until the office decides.' },
    { id: 'op-spec-hold', label: 'Operation: Spec changed, held', model: withWork(NOT_STARTED, { instruction: flag('CHANGED'), newerSpec: newer({ disposition: 'HOLD', changeOrder: 'ECO-DEMO-0004' }) }) },
    { id: 'op-step-icons', label: 'Operation: the steps with their icons', model: withWork(STEPS_CASE, { ...stepsWithIcons(STEPS_CASE), instruction: flag(null) }), note: 'FI9:01: an open step shows its instruction icon (the office’s same picture, lib/production/instruction-icons); a ticked one its outcome.' },
    { id: 'mywork-both', label: 'My work: Messages 3 · New instructions 2', model: { kind: 'mywork', model: { ...FOR_YOU, instructions: 2 } }, note: 'FI9:02: the second tile of For your work, hidden at zero; it opens Spec & instructions on "New for you".' },
    { id: 'mywork-instructions', label: 'My work: only New instructions 1', model: { kind: 'mywork', model: { ...QUEUE, instructions: 1 } }, note: 'Counted in the unread condition: For your work shows with no message.' },
  ],
})
