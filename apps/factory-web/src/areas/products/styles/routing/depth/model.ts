import { minutesFromAllowances } from '@nexus/factory-domain/product/minutes/rules'
import { minutesOf } from '@nexus/factory-domain/product/routing/operations'
import type { MachineClassChoice, SettingBody } from '../../../operations/depth/api'
import { plainOf, typedOf } from '../../../operations/depth/model'
import type { StyleNotice } from '../../record/record-model'
import type { PlanRow, RoutingDepth, RoutingTimesView, StepDepth, StepMinutesBody, StyleOptionsView } from './api'

/**
 * The Routing tab in depth, pure (B-W2b-235; design products.styles › Operations (routing): "Quality checkpoint (W2b)",
 * "Setup / run / wait / move (W2b)", "Only for sizes, colours or options (W2b)", "Extra minutes for big sizes or options
 * (W2b)", pop:styles.opDrawer "Sizes, colours, options it runs for (W2b)"): the rows (the routing in depth beside its
 * times, one per step), why a step cannot change now, a step's minutes as a draft and what its save sends (only what
 * changed), the extra minutes of one size cell, the variants as a draft and in words, the checkpoint plans a step may
 * take, and the selection's held reasons. The hook and the views use these; the tests hold them.
 */

export type Part<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export type StepTimes = RoutingTimesView['steps'][number]
export const RUN_SOURCES = ['VERSION', 'ALLOWANCES', 'TYPED'] as const
export type RunSource = (typeof RUN_SOURCES)[number]

/** factory-domain routing-depth CHECKPOINT_STAGES (written here: its file reaches `node:crypto`; the test holds them equal). */
export const CHECKPOINT_STAGES = ['CUTTING', 'IN_LINE', 'END_OF_LINE'] as const

// ---- rows -------------------------------------------------------------------------------------------------------------------

export interface DepthRow {
  stepId: string
  seq: number
  code: string
  name: string
  depth: StepDepth | null
  times: StepTimes | null
}

/** One row per step in routing order: its depth (variants, checkpoint, settings) beside its times (run, set-up, wait, move, sizes). */
export function rowsOf(depth: RoutingDepth | null, times: RoutingTimesView | null): DepthRow[] {
  const byId = new Map<string, DepthRow>()
  for (const step of depth?.steps ?? []) byId.set(step.stepId, { stepId: step.stepId, seq: step.seq, code: step.code, name: step.name, depth: step, times: null })
  for (const step of times?.steps ?? []) {
    const row = byId.get(step.stepId)
    if (row) row.times = step
    else byId.set(step.stepId, { stepId: step.stepId, seq: step.seq, code: step.code, name: step.name, depth: null, times: step })
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

/** Why the routing's depth cannot change now (a message key), or null. */
export function depthHeld(view: Pick<RoutingDepth, 'editable' | 'revision' | 'style'> | null, canManage: boolean): string | null {
  if (!canManage) return 'depth.held.noManage'
  if (!view) return 'depth.held.reading'
  if (view.style.status === 'ARCHIVED') return 'depth.held.archived'
  if (view.revision.status !== 'DRAFT') return 'depth.held.frozen'
  return view.editable ? null : 'depth.held.frozen'
}

/** The step's run in words (a message key and its params): "v2 (approved)", "own allowances", "typed". */
export function runWords(times: Pick<StepTimes, 'run'>): { key: string; params?: Record<string, string | number> } {
  if (times.run.from === 'VERSION') return { key: times.run.timeVersion?.status === 'APPROVED' ? 'run.version' : 'run.versionOld', params: { number: times.run.timeVersion?.number ?? '—' } }
  return { key: times.run.from === 'ALLOWANCES' ? 'run.allowances' : 'run.typed' }
}

/** A size cell's value: the step's extra minutes in that size ("+4"), or null (none). */
export const extraOf = (times: Pick<StepTimes, 'sizeTimes'> | null, size: string): string | null => times?.sizeTimes.find((entry) => entry.size === size)?.extraMinutes ?? null

/** A size cell typed: the step's whole list with that size changed (null or 0 removes it), or why not (a message key). */
export function sizeCellBody(times: Pick<StepTimes, 'sizeTimes' | 'run'>, size: string, value: string | null): { body: StepMinutesBody } | { problem: string } {
  const typed = value === null ? '' : plainOf(value)
  if (typed !== '' && !/^-?\d+(?:\.\d{1,6})?$/.test(typed)) return { problem: 'times.problem.extra' }
  const zero = typed === '' || Number(typed) === 0
  if (!zero && Number(times.run.standardMinutes) + Number(typed) <= 0) return { problem: 'times.problem.belowZero' }
  const rest = times.sizeTimes.filter((entry) => entry.size !== size).map((entry) => ({ size: entry.size, extraMinutes: entry.extraMinutes }))
  return { body: { sizeTimes: zero ? rest : [...rest, { size, extraMinutes: typed }] } }
}

// ---- a step's minutes as a draft (the Times dialog) ---------------------------------------------------------------------------

export interface TimesDraft {
  run: RunSource
  typed: string
  basic: string
  personal: string
  fatigue: string
  delay: string
  setup: string
  wait: string
  move: string
  /** Extra minutes per size code ('' = none). */
  extras: Record<string, string>
}

export function timesDraftOf(step: StepTimes, sizes: readonly string[], locale: 'it' | 'en'): TimesDraft {
  return {
    run: step.run.from,
    typed: typedOf(step.run.standardMinutes, locale),
    basic: typedOf(step.run.basicMinutes ?? step.run.standardMinutes, locale),
    personal: typedOf(step.run.personalPct ?? '0', locale),
    fatigue: typedOf(step.run.fatiguePct ?? '0', locale),
    delay: typedOf(step.run.delayPct ?? '0', locale),
    setup: typedOf(step.setupMinutes, locale),
    wait: typedOf(step.waitMinutes, locale),
    move: typedOf(step.moveMinutes, locale),
    extras: Object.fromEntries(sizes.map((size) => [size, typedOf(extraOf(step, size), locale)])),
  }
}

export type TimesField = 'run' | 'typed' | 'basic' | 'personal' | 'fatigue' | 'delay' | 'setup' | 'wait' | 'move' | `size:${string}`

/** The run the draft gives per garment (to show sizes' minutes), or null when it cannot be computed. */
export function draftRunMinutes(draft: TimesDraft, step: StepTimes): string | null {
  if (draft.run === 'VERSION') return step.library.inForceVersionId !== null ? step.library.standardMinutes : step.run.from === 'VERSION' ? step.run.standardMinutes : null
  if (draft.run === 'TYPED') {
    const typed = minutesOf(plainOf(draft.typed))
    return typed.ok ? typed.minutes : null
  }
  const built = minutesFromAllowances({ basicMinutes: plainOf(draft.basic), personalPct: plainOf(draft.personal) || '0', fatiguePct: plainOf(draft.fatigue) || '0', delayPct: plainOf(draft.delay) || '0' })
  return built.ok ? built.minutes.standardMinutes : null
}

const SIDE = /^\d+(?:\.\d{1,6})?$/
const SIGNED = /^-?\d+(?:\.\d{1,6})?$/

/** Every field's problem (a message key). */
export function timesProblems(draft: TimesDraft, step: StepTimes): Partial<Record<TimesField, string>> {
  const problems: Partial<Record<TimesField, string>> = {}
  // The library's approved version in force today (a step that already follows a version keeps it while none is in force).
  if (draft.run === 'VERSION' && step.run.from !== 'VERSION') {
    if (!step.library.governed) problems.run = 'times.problem.noVersion'
    else if (step.library.inForceVersionId === null) problems.run = 'times.problem.notInForce'
  }
  if (draft.run === 'TYPED' && !minutesOf(plainOf(draft.typed)).ok) problems.typed = 'times.problem.typed'
  if (draft.run === 'ALLOWANCES') {
    const built = minutesFromAllowances({ basicMinutes: plainOf(draft.basic), personalPct: plainOf(draft.personal) || '0', fatiguePct: plainOf(draft.fatigue) || '0', delayPct: plainOf(draft.delay) || '0' })
    if (!built.ok)
      for (const issue of built.issues) {
        if (issue.path === 'basicMinutes') problems.basic = 'times.problem.typed'
        if (issue.path === 'personalPct') problems.personal = 'times.problem.allowance'
        if (issue.path === 'fatiguePct') problems.fatigue = 'times.problem.allowance'
        if (issue.path === 'delayPct') problems.delay = 'times.problem.allowance'
      }
  }
  for (const field of ['setup', 'wait', 'move'] as const) {
    const value = plainOf(draft[field])
    if (value !== '' && !SIDE.test(value)) problems[field] = 'times.problem.side'
  }
  const run = draftRunMinutes(draft, step)
  for (const [size, text] of Object.entries(draft.extras)) {
    const value = plainOf(text)
    if (value === '') continue
    if (!SIGNED.test(value)) problems[`size:${size}`] = 'times.problem.extra'
    else if (run !== null && Number(value) !== 0 && Number(run) + Number(value) <= 0) problems[`size:${size}`] = 'times.problem.belowZero'
  }
  return problems
}

const sideOf = (text: string): string | null => {
  const value = plainOf(text)
  return value === '' ? null : value
}
const sameNumber = (a: string | null, b: string | null): boolean => (a === null || b === null ? a === b : Number(a) === Number(b))

/** What the Times dialog sends: only what changed (null: nothing). The run is sent when its source or its numbers move. */
export function timesBodyOf(draft: TimesDraft, step: StepTimes, sizes: readonly string[]): StepMinutesBody | null {
  const body: StepMinutesBody = {}
  const run = step.run
  if (draft.run === 'VERSION') {
    // Copied again only when a version is in force today and the step does not follow it already.
    if (step.library.inForceVersionId !== null && (run.from !== 'VERSION' || run.timeVersion?.id !== step.library.inForceVersionId)) body.run = { from: 'VERSION' }
  } else if (draft.run === 'TYPED') {
    const typed = minutesOf(plainOf(draft.typed))
    if (typed.ok && (run.from !== 'TYPED' || !sameNumber(typed.minutes, run.standardMinutes))) body.run = { from: 'TYPED', standardMinutes: typed.minutes }
  } else {
    const built = minutesFromAllowances({ basicMinutes: plainOf(draft.basic), personalPct: plainOf(draft.personal) || '0', fatiguePct: plainOf(draft.fatigue) || '0', delayPct: plainOf(draft.delay) || '0' })
    if (built.ok) {
      const moved = run.from !== 'ALLOWANCES' || !sameNumber(built.minutes.basicMinutes, run.basicMinutes) || !sameNumber(built.minutes.personalPct, run.personalPct) || !sameNumber(built.minutes.fatiguePct, run.fatiguePct) || !sameNumber(built.minutes.delayPct, run.delayPct)
      if (moved) body.run = { from: 'ALLOWANCES', basicMinutes: built.minutes.basicMinutes, personalPct: built.minutes.personalPct, fatiguePct: built.minutes.fatiguePct, delayPct: built.minutes.delayPct }
    }
  }
  if (!sameNumber(sideOf(draft.setup), step.setupMinutes)) body.setupMinutes = sideOf(draft.setup)
  if (!sameNumber(sideOf(draft.wait), step.waitMinutes)) body.waitMinutes = sideOf(draft.wait)
  if (!sameNumber(sideOf(draft.move), step.moveMinutes)) body.moveMinutes = sideOf(draft.move)
  const next = sizes.flatMap((size) => {
    const value = plainOf(draft.extras[size] ?? '')
    return value === '' || Number(value) === 0 ? [] : [{ size, extraMinutes: value }]
  })
  const now = step.sizeTimes.filter((entry) => Number(entry.extraMinutes) !== 0)
  const sizesMoved = next.length !== now.length || next.some((entry) => !sameNumber(entry.extraMinutes, now.find((stored) => stored.size === entry.size)?.extraMinutes ?? null))
  if (sizesMoved) body.sizeTimes = next
  return Object.keys(body).length > 0 ? body : null
}

/** Why the Times dialog cannot be saved (a message key), or null. */
export function timesSaveHeld(draft: TimesDraft, step: StepTimes, sizes: readonly string[], busy: boolean): string | null {
  const problems = timesProblems(draft, step)
  if (Object.keys(problems).length > 0) return 'times.held.fix'
  if (timesBodyOf(draft, step, sizes) === null) return 'times.held.same'
  return busy ? 'held.busy' : null
}

// ---- variants (Only for sizes, colours or options) --------------------------------------------------------------------------------

export interface VariantsDraft {
  sizes: string[]
  colourwayIds: string[]
  optionValueIds: string[]
}

export const variantsDraftOf = (step: Pick<StepDepth, 'variants'>): VariantsDraft => ({ sizes: step.variants.sizes.map((size) => size.code), colourwayIds: step.variants.colourways.map((colourway) => colourway.id), optionValueIds: [...step.variants.optionValueIds] })

/** The body in the style's own order (sizes of the range, colourways of the style, options as offered). */
export function variantsBodyOf(draft: VariantsDraft, depth: Pick<RoutingDepth, 'sizes' | 'colourways'>, options: readonly OptionChoice[]): VariantsDraft {
  return {
    sizes: depth.sizes.map((size) => size.code).filter((code) => draft.sizes.includes(code)),
    colourwayIds: depth.colourways.map((colourway) => colourway.id).filter((id) => draft.colourwayIds.includes(id)),
    optionValueIds: [...options.map((option) => option.id).filter((id) => draft.optionValueIds.includes(id)), ...draft.optionValueIds.filter((id) => !options.some((option) => option.id === id))],
  }
}

export const sameVariants = (a: VariantsDraft, b: VariantsDraft): boolean => [a.sizes, a.colourwayIds, a.optionValueIds].every((list, index) => {
  const other = [b.sizes, b.colourwayIds, b.optionValueIds][index]!
  return list.length === other.length && list.every((value) => other.includes(value))
})

export const everyCell = (draft: VariantsDraft): boolean => draft.sizes.length === 0 && draft.colourwayIds.length === 0 && draft.optionValueIds.length === 0

/** "Only for sizes 54, 56 · colourway BLK · option Hood: detachable" as parts (the view joins them in its words). */
export function variantParts(draft: VariantsDraft, depth: Pick<RoutingDepth, 'sizes' | 'colourways'>, options: readonly OptionChoice[]): { sizes: string[]; colourways: string[]; options: string[] } {
  return {
    sizes: depth.sizes.filter((size) => draft.sizes.includes(size.code)).map((size) => size.label),
    colourways: depth.colourways.filter((colourway) => draft.colourwayIds.includes(colourway.id)).map((colourway) => colourway.code),
    options: draft.optionValueIds.map((id) => options.find((option) => option.id === id)?.label ?? id.slice(0, 8)),
  }
}

export interface OptionChoice {
  id: string
  label: string
}

/** The option values a step may be for: the active values of the style's active offers, "Group: value". */
export function optionChoicesOf(options: StyleOptionsView | null, locale: 'it' | 'en'): OptionChoice[] {
  if (!options) return []
  return options.offers
    .filter((offer) => offer.status === 'ACTIVE' && offer.group.status === 'ACTIVE')
    .flatMap((offer) =>
      offer.values
        .filter((value) => value.status === 'ACTIVE')
        .map((value) => ({ id: value.id, label: `${offer.group.nameI18n?.[locale] ?? offer.group.name}: ${value.nameI18n?.[locale] ?? value.name}` })),
    )
}

// ---- checkpoints ----------------------------------------------------------------------------------------------------------------

/** The plans a step's checkpoint may be: cutting, in-line or end-of-line, of the style's company (any for a style of every company), not retired. */
export function checkpointChoices(plans: readonly PlanRow[], styleCompanyId: string | null): PlanRow[] {
  return plans
    .filter((plan) => (CHECKPOINT_STAGES as readonly string[]).includes(plan.stage))
    .filter((plan) => styleCompanyId === null || plan.companyId === styleCompanyId)
    .filter((plan) => plan.status !== 'RETIRED')
    .sort((a, b) => a.stage.localeCompare(b.stage) || a.code.localeCompare(b.code))
}

// ---- the selection --------------------------------------------------------------------------------------------------------------

/** Why "Copy library settings" for the picked steps is held (a message key), or null. */
export function copyLibraryHeld(rows: readonly DepthRow[], held: string | null, busy: boolean): string | null {
  if (held) return held
  if (!rows.some((row) => (row.depth?.librarySettings ?? 0) > 0)) return 'bulk.held.noLibrary'
  return busy ? 'held.busy' : null
}

// ---- the hook's model --------------------------------------------------------------------------------------------------------------

export type DepthDialog =
  | { kind: 'times'; stepId: string }
  | { kind: 'variants'; stepIds: string[] }
  | { kind: 'checkpoint'; stepId: string }
  | { kind: 'settings'; stepId: string }
  | { kind: 'copyLibrary'; stepIds: string[] }

export interface CellMark {
  /** waiting: typed offline, sent when the browser is back online. */
  state: 'saving' | 'waiting' | 'refused'
  value?: string | null
  problem?: string
}

export interface RoutingDepthModel {
  depth: Part<RoutingDepth>
  times: Part<RoutingTimesView>
  dialog: DepthDialog | null
  busy: boolean
  selected: string[]
  /** Size cells being saved or refused: `${stepId}:${size}`. */
  marks: Record<string, CellMark>
  /** The checkpoint picker's plans (null while unread; 'forbidden': the role does not read Quality's plans; 'failed'). */
  plans: PlanRow[] | null | 'forbidden' | 'failed'
  /** The options the style offers (null while unread; 'failed'). */
  options: StyleOptionsView | null | 'failed'
  /** The machine classes (null while unread; [] without plant.view). */
  classes: MachineClassChoice[] | null
  notice: StyleNotice | null
  /** The browser is offline: a size cell waits on this page (marked), every dialog's Save is held. */
  offline?: boolean
  canManage: boolean
  /** The company a checkpoint plan is read for (the style's, else the page's). */
  companyId: string | null
}

export interface RoutingDepthActions {
  onRetry?: () => void
  onDialog?: (dialog: DepthDialog | null) => void
  onSelect?: (stepIds: string[]) => void
  onTimes?: (stepId: string, body: StepMinutesBody) => Promise<boolean>
  onSizeCell?: (stepId: string, size: string, value: string | null) => void
  onVariants?: (stepIds: readonly string[], body: VariantsDraft) => Promise<boolean>
  onCheckpoint?: (stepId: string, inspectionPlanId: string | null) => Promise<boolean>
  onSettings?: (stepId: string, change: { settings: SettingBody[] } | { fromLibrary: true }) => Promise<boolean>
  onCopyLibrary?: (stepIds: readonly string[]) => Promise<boolean>
  /** The W1 SMV cell of a step whose run is not typed: a typed SMV through the step's minutes; the library's version. */
  onTypedRun?: (stepId: string, standardMinutes: string) => Promise<boolean>
  onUseLibrary?: (stepId: string) => Promise<boolean>
  onLoadPlans?: () => void
  onLoadOptions?: () => void
  onLoadClasses?: () => void
  onDismissNotice?: () => void
}

export const NO_DEPTH: RoutingDepthModel = { depth: { status: 'idle' }, times: { status: 'idle' }, dialog: null, busy: false, selected: [], marks: {}, plans: null, options: null, classes: null, notice: null, canManage: false, companyId: null }
