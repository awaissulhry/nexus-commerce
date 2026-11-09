import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { workCentreCheck, type ReleaseCheck } from '../../production/work-orders/release'
import type { MissingWorkCentre } from '../../production/work-orders/spec'
import { STAGE_WORDS, type Frequency, type PlanStage } from '../../quality/plans/rules'
import { frequencyText, RECORD_KIND_WORDS, recordKindOf, type RecordKind } from '../../quality/triggers/rules'
import { Dec, type Decimal } from '../../tax/decimal'
import { decimalText } from '../units/units'

/**
 * A routing in depth (B-W2b-225; features PRD-118, PRD-119, PRD-124, PRD-128; design products.operations › Machine &
 * settings, products.styles › Operations (routing) "Quality checkpoint", "Only for sizes, colours or options" and the
 * operation drawer's variants), pure. apps/factory-api's modules/product/routing-depth and
 * production/work-orders/routing-copy.ts read and write through it; the …_routings_instructions_w2b_guards triggers
 * (B-W2b-205) stay the last word.
 *
 *   settings     machine and stitch settings (PRD-118), a list per library operation (its default) or per routing step
 *                (that style's, frozen with its revision): machine class, stitch type, needle, thread, stitches per cm,
 *                tension, foot, notes; each says something; at most SETTING_LIMITS.perList. The tablet shows them with the
 *                instruction (`settingLine`).
 *   variants     a step only for some cells (PRD-128): sizes of the style's range, colourways of the style, option values;
 *                empty = every one. A work order's copy keeps the steps one of its cells needs (`stepsForCells`); a work
 *                order whose cells need no scanned step is held at release in words (`workCentresForCells`). No option
 *                value exists yet (the options of a style come later): a step names none.
 *   checkpoint   an inspection plan at a step (PRD-119): a cutting, in-line or end-of-line plan of the style's company; the
 *                bundle's first report there opens its check (`checkpointKindOf`, the plan version's frequency; a cutting
 *                plan a cutting check, in-line a roving or first-piece check, end of line an end-of-line check), only for
 *                the cells the step is for. A final inspection is opened at the bench, not at a step.
 *   effectivity  the days a revision's routing applies to new work orders (PRD-124): from its release day (Europe/Rome)
 *                to the next release's day; a work order made before keeps its frozen copy (`effectiveDays`,
 *                `revisionOn`, `endOfDays`).
 */

type Words = Readonly<{ it: string; en: string }>
const w = (it: string, en: string): Words => Object.freeze({ it, en })

// ---- machine and stitch settings (PRD-118) ---------------------------------------------------------------------------------

export const SETTING_LIMITS = Object.freeze({ perList: 10, text: 120, notes: 500, stitchType: 20 })
/** Stitches per centimetre: Decimal(6, 2), above 0. */
export const STITCHES_RULE = 'a number above 0 with at most 4 digits and 2 decimals'
const STITCHES = /^\d{1,4}(?:\.\d{1,2})?$/

/** A setting as typed (trimmed by the contract; null or left out: not said). */
export interface SettingInput {
  readonly machineClassId?: string | null | undefined
  readonly stitchType?: string | null | undefined
  readonly needle?: string | null | undefined
  readonly thread?: string | null | undefined
  readonly stitchesPerCm?: string | null | undefined
  readonly tension?: string | null | undefined
  readonly foot?: string | null | undefined
  readonly notes?: string | null | undefined
}

/** A setting as stored, in its list's order (seq from 1). */
export interface SettingData {
  readonly seq: number
  readonly machineClassId: string | null
  readonly stitchType: string | null
  readonly needle: string | null
  readonly thread: string | null
  readonly stitchesPerCm: string | null
  readonly tension: string | null
  readonly foot: string | null
  readonly notes: string | null
}

/** A machine class as the rules read it. */
export interface MachineClassFacts {
  readonly id: string
  readonly code: string
  readonly active: boolean
}

export type SettingsPlan = { readonly ok: true; readonly settings: readonly SettingData[] } | { readonly ok: false; readonly issues: readonly Issue[] }

const said = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/**
 * The whole list as typed, numbered 1, 2, 3 … in the order sent. A machine class must exist; one switched off is kept only
 * where it is already named (`kept`: the ids the list named before), never newly chosen.
 */
export function planSettings(inputs: readonly SettingInput[], classes: ReadonlyMap<string, MachineClassFacts>, kept: ReadonlySet<string> = new Set()): SettingsPlan {
  const issues: Issue[] = []
  if (inputs.length > SETTING_LIMITS.perList) issues.push({ path: 'settings', message: `At most ${SETTING_LIMITS.perList} settings per operation (${inputs.length} sent).` })
  const settings = inputs.map((input, index): SettingData => {
    const at = `settings/${index}`
    const machineClassId = input.machineClassId ?? null
    if (machineClassId !== null) {
      const found = classes.get(machineClassId)
      if (!found) issues.push({ path: `${at}/machineClassId`, message: 'No such machine class.' })
      else if (!found.active && !kept.has(machineClassId)) issues.push({ path: `${at}/machineClassId`, message: `Machine class ${found.code} is switched off: choose another.` })
    }
    const stitches = said(input.stitchesPerCm)
    if (stitches !== null && (!STITCHES.test(stitches) || new Dec(stitches).lte(0))) issues.push({ path: `${at}/stitchesPerCm`, message: `Stitches per cm: ${STITCHES_RULE}.` })
    const setting: SettingData = {
      seq: index + 1,
      machineClassId,
      stitchType: said(input.stitchType),
      needle: said(input.needle),
      thread: said(input.thread),
      stitchesPerCm: stitches === null || !STITCHES.test(stitches) ? stitches : decimalText(stitches),
      tension: said(input.tension),
      foot: said(input.foot),
      notes: said(input.notes),
    }
    if (setting.machineClassId === null && setting.stitchesPerCm === null && [setting.stitchType, setting.needle, setting.thread, setting.tension, setting.foot, setting.notes].every((value) => value === null)) {
      issues.push({ path: at, message: 'A setting says something: a machine class, a stitch type, a needle, a thread, stitches per cm, a tension, a foot or a note.' })
    }
    return setting
  })
  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings }
}

/** Two lists are the same (order included). */
export function sameSettings(a: readonly SettingData[], b: readonly SettingData[]): boolean {
  const key = (setting: SettingData) => JSON.stringify([setting.machineClassId, setting.stitchType, setting.needle, setting.thread, setting.stitchesPerCm, setting.tension, setting.foot, setting.notes])
  return a.length === b.length && a.every((setting, index) => key(setting) === key(b[index]!))
}

/** One line for the tablet, beside the instruction: "Lockstitch · 301 · 134 LR Nm 110 · Tkt 40 · 3.5 per cm · roller foot". */
export function settingLine(setting: SettingData, machineClass: { readonly labelIt: string; readonly labelEn: string } | null): Words {
  const parts = (perCm: string) => [setting.stitchType, setting.needle, setting.thread, setting.stitchesPerCm === null ? null : `${setting.stitchesPerCm} ${perCm}`, setting.tension, setting.foot].filter((part): part is string => part !== null)
  const line = (label: string | null, perCm: string) => [label, ...parts(perCm)].filter((part): part is string => part !== null).join(' · ')
  return w(line(machineClass?.labelIt ?? null, 'punti/cm'), line(machineClass?.labelEn ?? null, 'per cm'))
}

// ---- operations only for some cells (PRD-128) --------------------------------------------------------------------------------

export const VARIANT_LIMITS = Object.freeze({ sizes: 60, colourways: 60, optionValues: 60 })

/** What a step is for; every list empty: every cell. */
export interface StepVariants {
  readonly sizes: readonly string[]
  readonly colourwayIds: readonly string[]
  readonly optionValueIds: readonly string[]
}

export const EVERY_CELL: StepVariants = Object.freeze({ sizes: [], colourwayIds: [], optionValueIds: [] })

export const isLimited = (variants: StepVariants): boolean => variants.sizes.length > 0 || variants.colourwayIds.length > 0 || variants.optionValueIds.length > 0

/** The words of option values that do not exist yet (a step names none until a style has options). */
export const NO_OPTIONS_YET: Words = w(
  'Le opzioni dello stile (cappuccio, paraschiena …) non esistono ancora: una fase non può valere solo per un\'opzione.',
  "A style's options (hood, back protector …) do not exist yet: a step cannot be only for an option.",
)

export type VariantsPlan = { readonly ok: true; readonly variants: StepVariants } | { readonly ok: false; readonly issues: readonly Issue[] }

/**
 * The cells a step is for, as typed: sizes of the style's range, colourways of the style, no option value (none exists
 * yet), each once. Answered in the style's order (the range's sizes, the colourways' order).
 */
export function planVariants(input: StepVariants, style: { readonly sizes: readonly string[]; readonly colourwayIds: readonly string[] }): VariantsPlan {
  const issues: Issue[] = []
  const once = (values: readonly string[], path: string, what: string) => {
    const seen = new Set<string>()
    values.forEach((value, index) => {
      if (seen.has(value)) issues.push({ path: `${path}/${index}`, message: `${what} ${value} is named twice.` })
      seen.add(value)
    })
  }
  once(input.sizes, 'sizes', 'Size')
  once(input.colourwayIds, 'colourwayIds', 'Colourway')
  input.sizes.forEach((size, index) => {
    if (!style.sizes.includes(size)) issues.push({ path: `sizes/${index}`, message: `Size ${size} is not in the style's range (${style.sizes.join(', ')}).` })
  })
  input.colourwayIds.forEach((colourwayId, index) => {
    if (!style.colourwayIds.includes(colourwayId)) issues.push({ path: `colourwayIds/${index}`, message: 'Not a colourway of this style.' })
  })
  if (input.optionValueIds.length > 0) issues.push({ path: 'optionValueIds', message: NO_OPTIONS_YET.en })
  if (issues.length > 0) return { ok: false, issues }
  const inOrder = (values: readonly string[], order: readonly string[]) => [...new Set(values)].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return { ok: true, variants: { sizes: inOrder(input.sizes, style.sizes), colourwayIds: inOrder(input.colourwayIds, style.colourwayIds), optionValueIds: [] } }
}

export const sameVariants = (a: StepVariants, b: StepVariants): boolean =>
  JSON.stringify([a.sizes, a.colourwayIds, a.optionValueIds]) === JSON.stringify([b.sizes, b.colourwayIds, b.optionValueIds])

/** A cell of a work order as the variants read it (its option values: none until order lines carry options). */
export interface CellFacts {
  readonly colourwayId: string
  readonly size: string
  readonly optionValueIds?: readonly string[] | undefined
}

/** Is the step done on garments of this cell? */
export function stepIsFor(variants: StepVariants, cell: CellFacts): boolean {
  if (variants.sizes.length > 0 && !variants.sizes.includes(cell.size)) return false
  if (variants.colourwayIds.length > 0 && !variants.colourwayIds.includes(cell.colourwayId)) return false
  if (variants.optionValueIds.length > 0 && !(cell.optionValueIds ?? []).some((value) => variants.optionValueIds.includes(value))) return false
  return true
}

export interface LeftOut<Step> {
  readonly step: Step
  readonly variants: StepVariants
}

/**
 * The steps a work order's copy keeps: every step for every cell, and a step only for some cells when at least one of its
 * cells is one of them. A work order with no cell yet keeps every step (its release is held for the cells anyway).
 */
export function stepsForCells<Step extends { readonly id: string }>(steps: readonly Step[], variantsOf: (stepId: string) => StepVariants | undefined, cells: readonly CellFacts[]): { readonly kept: Step[]; readonly leftOut: LeftOut<Step>[] } {
  const kept: Step[] = []
  const leftOut: LeftOut<Step>[] = []
  for (const step of steps) {
    const variants = variantsOf(step.id) ?? EVERY_CELL
    if (!isLimited(variants) || cells.length === 0 || cells.some((cell) => stepIsFor(variants, cell))) kept.push(step)
    else leftOut.push({ step, variants })
  }
  return { kept, leftOut }
}

/** "Only for sizes 54, 56 · colourway BLK" in both languages; null for every cell. */
export function variantWords(variants: StepVariants, colourwayCode: (id: string) => string): Words | null {
  if (!isLimited(variants)) return null
  const sizes = variants.sizes.join(', ')
  const colourways = variants.colourwayIds.map(colourwayCode).join(', ')
  const it = [variants.sizes.length > 0 ? `${variants.sizes.length === 1 ? 'taglia' : 'taglie'} ${sizes}` : null, variants.colourwayIds.length > 0 ? `${variants.colourwayIds.length === 1 ? 'variante' : 'varianti'} ${colourways}` : null, variants.optionValueIds.length > 0 ? `${variants.optionValueIds.length} opzioni` : null].filter((part): part is string => part !== null)
  const en = [variants.sizes.length > 0 ? `${variants.sizes.length === 1 ? 'size' : 'sizes'} ${sizes}` : null, variants.colourwayIds.length > 0 ? `${variants.colourwayIds.length === 1 ? 'colourway' : 'colourways'} ${colourways}` : null, variants.optionValueIds.length > 0 ? `${variants.optionValueIds.length} options` : null].filter((part): part is string => part !== null)
  return w(`Solo per ${it.join(' · ')}`, `Only for ${en.join(' · ')}`)
}

/**
 * The release's WORK_CENTRES answer once the steps are kept for the cells: the routing's own answer (W1), unless steps were
 * left out and none of the kept ones is scanned (the floor would have nothing to report: held, in words).
 */
export function workCentresForCells(
  siteCode: string,
  routingSteps: number,
  kept: readonly { readonly scanRequired: boolean }[],
  leftOut: readonly LeftOut<{ readonly seq: number; readonly code: string; readonly name: string }>[],
  missing: readonly MissingWorkCentre[],
  cellLabels: readonly string[],
): ReleaseCheck {
  if (routingSteps > 0 && leftOut.length > 0 && !kept.some((step) => step.scanRequired)) {
    const message = `None of the routing's scanned steps is for this work order's cells (${cellLabels.join(', ')}): the floor would have nothing to report. Change which sizes or colours the steps are for in a new revision, or the cells.`
    return {
      code: 'WORK_CENTRES',
      state: 'BLOCKED',
      message,
      problems: leftOut.map((entry) => ({ path: `checks/WORK_CENTRES/steps/${entry.step.seq}`, message: `Step ${entry.step.seq} ${entry.step.code} (${entry.step.name}) is for other cells.` })),
    }
  }
  return workCentreCheck(siteCode, routingSteps, missing)
}

// ---- minutes per size (the step's run with its size's extra; B-W2b-215's rows) -------------------------------------------------

/** The step's minutes per garment of a size: its run plus the size's extra minutes (3 decimals). */
export function minutesInSize(standardMinutes: string, extras: readonly { readonly size: string; readonly extraMinutes: string }[], size: string): string {
  const extra = extras.find((entry) => entry.size === size)
  const total: Decimal = new Dec(standardMinutes).plus(extra ? new Dec(extra.extraMinutes) : 0)
  return decimalText(total.toDecimalPlaces(3, Dec.ROUND_HALF_UP))
}

// ---- quality checkpoints (PRD-119) -------------------------------------------------------------------------------------------

/** The plan stages a step's checkpoint may be: an inspection of the work at a step. */
export const CHECKPOINT_STAGES: readonly PlanStage[] = Object.freeze(['CUTTING', 'IN_LINE', 'END_OF_LINE'])

/** Why a plan cannot be this step's checkpoint (null: it can). */
export function checkpointRefusal(plan: { readonly code: string; readonly stage: PlanStage; readonly companyId: string }, styleCompanyId: string | null): string | null {
  if (plan.stage === 'FINAL') return `Plan ${plan.code} is a final inspection: it is opened at the bench or at packing, not at a step. A step's checkpoint is a cutting, in-line or end-of-line plan.`
  if (!CHECKPOINT_STAGES.includes(plan.stage)) return `Plan ${plan.code} is an ${STAGE_WORDS[plan.stage].en.toLowerCase()} plan: a step's checkpoint checks the work (a cutting, in-line or end-of-line plan).`
  if (styleCompanyId !== null && plan.companyId !== styleCompanyId) return `Plan ${plan.code} belongs to another company than the style's.`
  return null
}

/** The record a checkpoint opens at a bundle's first report, with the plan version's frequency (none said: every lot). */
export function checkpointKindOf(stage: PlanStage, frequency: Frequency | null): Exclude<RecordKind, 'INCOMING' | 'FINAL'> | null {
  if (!CHECKPOINT_STAGES.includes(stage)) return null
  const kind = recordKindOf(stage, frequency ?? 'EVERY_LOT')
  // B-W2b-213 added FINAL to the record kinds (a rule's final inspection); a step checkpoint never opens one.
  return kind === null || kind === 'INCOMING' || kind === 'FINAL' ? null : kind
}

export interface CheckpointFacts {
  readonly code: string
  readonly name: string
  readonly stage: PlanStage
  readonly companyId: string
  readonly approved: { readonly number: number; readonly frequency: Frequency | null; readonly frequencyValue: number | null } | null
}

/** What the checkpoint does, in words, and what to fix (no approved version: it opens nothing). */
export function checkpointWords(plan: CheckpointFacts): { readonly kind: Exclude<RecordKind, 'INCOMING' | 'FINAL'> | null; readonly does: Words; readonly warning: Words | null } {
  const frequency = plan.approved?.frequency ?? null
  const kind = checkpointKindOf(plan.stage, frequency)
  if (!plan.approved || kind === null) {
    return {
      kind,
      does: w(`${plan.code}: nessun controllo finché non c'è una versione approvata.`, `${plan.code}: no check until a version is approved.`),
      warning: w(`Il piano ${plan.code} non ha una versione approvata: il punto di controllo non apre nulla finché non ne viene approvata una.`, `Plan ${plan.code} has no approved version: the checkpoint opens nothing until one is approved.`),
    }
  }
  const how = (language: 'it' | 'en') => frequencyText(frequency ?? 'EVERY_LOT', plan.approved?.frequencyValue ?? null, language)
  return {
    kind,
    does: w(`${RECORD_KIND_WORDS[kind].it} ${plan.code} v${plan.approved.number} al primo rapporto del pacco · ${how('it')}`, `${RECORD_KIND_WORDS[kind].en} ${plan.code} v${plan.approved.number} at the bundle's first report · ${how('en')}`),
    warning: null,
  }
}

/** Why a checkpoint opened nothing for a bundle, beyond the inspection rules' own reasons (ALREADY_OPEN …). */
export const CHECKPOINT_SKIPS = ['NOT_FOR_CELL', 'OTHER_COMPANY', 'NOT_A_CHECKPOINT_PLAN'] as const
export type CheckpointSkip = (typeof CHECKPOINT_SKIPS)[number]

export function checkpointSkipWords(reason: CheckpointSkip, facts: { readonly subject: string; readonly plan: string }): Words {
  switch (reason) {
    case 'NOT_FOR_CELL':
      return w(`${facts.subject}: la fase non vale per la taglia o la variante del pacco; nessun controllo ${facts.plan}.`, `${facts.subject}: the step is not for the bundle's size or colourway; no ${facts.plan} check.`)
    case 'OTHER_COMPANY':
      return w(`${facts.subject}: il piano ${facts.plan} è di un'altra azienda dell'ordine di lavoro; nessun controllo aperto.`, `${facts.subject}: plan ${facts.plan} is another company's than the work order's; no check opened.`)
    case 'NOT_A_CHECKPOINT_PLAN':
      return w(`${facts.subject}: il piano ${facts.plan} non controlla il lavoro a una fase; nessun controllo aperto.`, `${facts.subject}: plan ${facts.plan} does not check the work at a step; no check opened.`)
    default:
      return w(String(reason), String(reason))
  }
}

// ---- effectivity (PRD-124) -------------------------------------------------------------------------------------------------

/** A revision's days as stored. */
export interface RevisionDays {
  readonly id: string
  readonly revision: number
  readonly status: 'DRAFT' | 'RELEASED' | 'OBSOLETE'
  /** Planned on a draft, or set at its release. */
  readonly effectiveFrom: BusinessDate | null
  /** The first day it no longer applies. */
  readonly effectiveTo: BusinessDate | null
  /** Its release day in Europe/Rome (null: never released). */
  readonly releasedOn: BusinessDate | null
}

export const DAYS_FROM = ['RELEASE', 'RELEASED_BEFORE'] as const
export type DaysFrom = (typeof DAYS_FROM)[number]

export interface EffectiveDays {
  readonly revision: RevisionDays
  /** First day it applies to new work orders; null: never released. */
  readonly from: BusinessDate | null
  /** First day it no longer applies (its own end, else the next release's day); null: it still applies. */
  readonly to: BusinessDate | null
  /** RELEASE: its own effective day; RELEASED_BEFORE: released before effective days were kept (its release day). */
  readonly fromSource: DaysFrom | null
}

/** Each revision's days, by revision number. */
export function effectiveDays(revisions: readonly RevisionDays[]): EffectiveDays[] {
  const ordered = [...revisions].sort((a, b) => a.revision - b.revision)
  const fromOf = (revision: RevisionDays): BusinessDate | null => (revision.releasedOn === null ? null : (revision.effectiveFrom ?? revision.releasedOn))
  return ordered.map((revision, index) => {
    const from = fromOf(revision)
    const next = ordered.slice(index + 1).find((later) => fromOf(later) !== null)
    // An obsolete revision with no end of its own ends where the next release begins; withdrawn with none recorded and no
    // later release, it ends where it began (it applies to no new work order).
    const end = from === null ? null : (revision.effectiveTo ?? (revision.status === 'RELEASED' ? null : next ? fromOf(next) : from))
    // Never before its first day (a later revision released before this one's planned first day: it never applied).
    const to = end !== null && from !== null && end < from ? from : end
    return { revision, from, to, fromSource: from === null ? null : revision.effectiveFrom === null ? 'RELEASED_BEFORE' : 'RELEASE' }
  })
}

/** The revision whose routing applied to new work orders on that day (a revision replaced on its first day never did). */
export function revisionOn(days: readonly EffectiveDays[], day: BusinessDate): EffectiveDays | null {
  const applying = days.filter((entry) => entry.from !== null && entry.from <= day && (entry.to === null || day < entry.to))
  return applying.sort((a, b) => b.revision.revision - a.revision.revision)[0] ?? null
}

/**
 * The last-day mark a released revision gets when it is replaced or withdrawn on `day`: the day itself, when that is after
 * the day it began to apply (the database keeps a revision's days in order); null when it is replaced on its first day.
 */
export function endOfDays(previous: Pick<RevisionDays, 'effectiveFrom' | 'releasedOn' | 'effectiveTo'>, day: BusinessDate): BusinessDate | null {
  if (previous.effectiveTo !== null) return null
  const from = previous.effectiveFrom ?? previous.releasedOn
  return from === null || day > from ? day : null
}

/** A revision takes effect on the day it is released: a draft planned for another day is refused at release, in words. */
export function releaseDayRefusal(revision: number, planned: BusinessDate | null, today: BusinessDate): string | null {
  if (planned === null || planned === today) return null
  return `Revision ${revision} is planned to take effect on ${planned}; a revision takes effect on the day it is released (${today}). Release it on that day, or clear the planned day.`
}

/** "Revision 4 applies to new work orders since 2026-11-09; 3 work orders made before keep revision 3's routing." */
export function effectivityWords(current: EffectiveDays | null, keeping: readonly { readonly revision: number; readonly workOrders: number }[]): Words {
  const kept = keeping.filter((entry) => entry.workOrders > 0)
  const keptIt = kept.map((entry) => `${entry.workOrders} ${entry.workOrders === 1 ? 'ordine di lavoro fatto prima tiene' : 'ordini di lavoro fatti prima tengono'} il ciclo della revisione ${entry.revision}`).join('; ')
  const keptEn = kept.map((entry) => `${entry.workOrders} work ${entry.workOrders === 1 ? 'order made before keeps' : 'orders made before keep'} revision ${entry.revision}'s routing`).join('; ')
  if (!current || current.from === null) {
    return w(`Nessuna revisione vale per i nuovi ordini di lavoro.${keptIt ? ` ${keptIt}.` : ''}`, `No revision applies to new work orders.${keptEn ? ` ${keptEn}.` : ''}`)
  }
  return w(
    `La revisione ${current.revision.revision} vale per i nuovi ordini di lavoro dal ${current.from}.${keptIt ? ` ${keptIt}.` : ''}`,
    `Revision ${current.revision.revision} applies to new work orders since ${current.from}.${keptEn ? ` ${keptEn}.` : ''}`,
  )
}
