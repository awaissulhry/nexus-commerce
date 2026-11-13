import { PRODUCT_TYPES, type ProductType } from '@nexus/factory-domain/product/styles/rules'
import type { TemplatePointBody } from '@nexus/factory-domain/sales/mtm/contracts'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { MtmRule, TemplateOption, TemplateRules, TemplateView } from './api'

/**
 * Measurement templates, pure (B-W1-17 on B-W2b-358/-248; design products.sizes sec:sizes.templates, pop:sizes.newTemplate,
 * the record "Measurement template"): who may do what, the list's address and per-row facts, New template's draft and its
 * body, the points' editor (one PUT of the whole list: kept by code, a point left out archived by the API), why a write is
 * held, the made-to-measure switch (GATE-MTM: built OFF per template, Owner 11-10; only product.mtm.switch starts it), the
 * rules read in their own words per language, and every refusal in this catalogue's words — never the API's English
 * (`rulesSummary`, `summary`, `refusal`, an issue's message). The views and containers use these; the test holds them.
 */

export const NS = 'products-mtm-templates'
export { PRODUCT_TYPES }
export type { ProductType }

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

export interface Notice extends Phrase {
  readonly tone: 'info' | 'success' | 'warning' | 'danger'
}

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

// ---- who may do what --------------------------------------------------------------------------------------------------

export interface TemplateCan {
  /** product.styles.view: the templates (the style library's read). */
  readonly view: boolean
  /** product.styles.manage: new template, its name, points, archive and restore. */
  readonly manage: boolean
  /** product.mtm.switch: start or stop made-to-measure for a template (the Owner's word, GATE-MTM). */
  readonly switch: boolean
}

export function templateCan(permissions: readonly string[]): TemplateCan {
  const held = new Set(permissions)
  return { view: held.has('product.styles.view'), manage: held.has('product.styles.manage'), switch: held.has('product.mtm.switch') }
}

// ---- addresses --------------------------------------------------------------------------------------------------------

export const listHref = (prefix: string): string => `${prefix}/products/sizes?view=templates`

export const RECORD_TABS = ['points', 'mtm', 'whereused'] as const
export type RecordTab = (typeof RECORD_TABS)[number]
export const tabOf = (value: string | null | undefined): RecordTab => ((RECORD_TABS as readonly string[]).includes(value ?? '') ? (value as RecordTab) : 'points')

export function recordHref(prefix: string, templateId: string, tab?: RecordTab): string {
  return `${prefix}/products/sizes/templates/${encodeURIComponent(templateId)}${tab && tab !== 'points' ? `?tab=${tab}` : ''}`
}

/** Sales › Made-to-measure with the template's riders (its garment type). */
export const ridersHref = (prefix: string, code: string): string => `${prefix}/sales/made-to-measure?garment=${encodeURIComponent(code)}`

// ---- reads and writes in words ------------------------------------------------------------------------------------------

export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'problem.unavailable'
  if (error.kind === 'forbidden' || error.kind === 'signed_out') return 'problem.forbidden'
  if (error.kind === 'not_found') return 'problem.notFound'
  if (error.kind === 'rate_limited') return 'problem.rateLimited'
  if (error.kind === 'unavailable') return 'problem.unavailable'
  if (error.kind === 'contract') return 'problem.contract'
  return 'problem.internal'
}

export interface WriteProblem {
  readonly key: string
  /** Read the template again (someone changed it meanwhile; never overwritten). */
  readonly reload: boolean
  /** The refused fields' paths without `body/` (`code`, `points/2/code`, `template/rules/0/pointCode`). */
  readonly paths: readonly string[]
}

/** A refused write in our words: a moved version reads again; the template's rules that still need a point; a taken code. */
export function writeProblem(error: unknown): WriteProblem {
  if (!isApiError(error)) return { key: 'problem.unavailable', reload: false, paths: [] }
  const paths = error.issues.map((issue) => issuePath(issue).replace(/^body[./]/, '').replace(/\./g, '/')).filter((path) => path !== '')
  if (paths.some((path) => path.startsWith('template/'))) return { key: 'problem.rulesNeedPoints', reload: false, paths }
  if (error.kind === 'conflict') {
    if (error.code === 'version_conflict' || paths.some((path) => path.split('/').includes('version'))) return { key: 'problem.moved', reload: true, paths }
    if (paths.includes('code') || /code/i.test(error.code)) return { key: 'problem.codeTaken', reload: false, paths }
    return { key: 'problem.state', reload: true, paths }
  }
  if (error.kind === 'invalid') return { key: paths.length > 0 ? 'problem.fields' : 'problem.invalid', reload: false, paths }
  if (error.kind === 'forbidden' || error.kind === 'signed_out') return { key: 'problem.forbiddenWrite', reload: false, paths }
  if (error.kind === 'not_found') return { key: 'problem.notFound', reload: true, paths }
  if (error.kind === 'rate_limited') return { key: 'problem.rateLimited', reload: false, paths }
  if (error.kind === 'unavailable') return { key: 'problem.unavailable', reload: false, paths }
  return { key: 'problem.internal', reload: false, paths }
}

// ---- the list ---------------------------------------------------------------------------------------------------------

/** The name in the reader's language (the template's words), else its default name. */
export const nameIn = (row: { name: string; nameI18n: Readonly<Record<string, string>> | null }, locale: string): string => row.nameI18n?.[locale]?.trim() || row.name

/** What one row's template page adds to the list: required points, styles measured / made to measure, rider profiles. */
export interface RowFacts {
  readonly required: number
  readonly styles: { readonly measured: number; readonly madeToMeasure: number }
  readonly profiles: number
}

export function rowFactsOf(template: Pick<TemplateView, 'points' | 'styles' | 'profiles'>): RowFacts {
  return { required: template.points.filter((point) => point.status === 'ACTIVE' && point.required).length, styles: { ...template.styles }, profiles: template.profiles }
}

/** At most this many rows' pages are read for their facts (a factory keeps a handful of templates). */
export const FACTS_LIMIT = 60

/** The list as a CSV file (the selected rows): code, name, product type, points, made-to-measure, status. */
export function templatesCsv(rows: readonly TemplateOption[], words: { header: readonly string[]; type: (type: string) => string; on: (on: boolean) => string; status: (status: string) => string; locale: string }): string {
  const line = (values: readonly (string | number)[]) => values.map((value) => (/[",\n;]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value))).join(',')
  return [line(words.header), ...rows.map((row) => line([row.code, nameIn(row, words.locale), words.type(row.productType), row.points, words.on(row.rulesOn), words.status(row.status)]))].join('\n')
}

// ---- New template (pop:sizes.newTemplate) -------------------------------------------------------------------------------

export const TEMPLATE_CODE = /^[A-Z][A-Z0-9_-]{0,39}$/
export const POINT_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/
const DECIMAL = /^\d{1,6}(?:\.\d{1,2})?$/

export interface NewTemplateDraft {
  /** null: every company's (tenant-wide master data). */
  readonly companyId: string | null
  /** The garment type ("JACKET"): fixed once a rider is measured for it. */
  readonly code: string
  readonly name: string
  readonly productType: ProductType | ''
  /** Start blank (one first point) or from a copy of another template's points. */
  readonly start: 'blank' | 'copy'
  readonly copyFromId: string
  readonly firstCode: string
  readonly firstName: string
  readonly firstUom: 'CM' | 'MM'
}

export const emptyNewDraft = (companyId: string | null): NewTemplateDraft => ({ companyId, code: '', name: '', productType: '', start: 'blank', copyFromId: '', firstCode: '', firstName: '', firstUom: 'CM' })

/** The points a copy takes: the source's ACTIVE points in order (codes, names, units, ranges, required, how to). */
export function copyPointsOf(source: Pick<TemplateView, 'points'>): TemplatePointBody[] {
  return [...source.points].filter((point) => point.status === 'ACTIVE').sort((a, b) => a.seq - b.seq).map(bodyOfPoint)
}

function bodyOfPoint(point: TemplateView['points'][number]): TemplatePointBody {
  return {
    code: point.code,
    name: point.name,
    nameI18n: Object.keys(point.nameI18n).length > 0 ? { ...point.nameI18n } : null,
    uom: point.uom === 'MM' ? 'MM' : 'CM',
    minValue: point.minValue,
    maxValue: point.maxValue,
    required: point.required,
    howTo: point.howTo,
    pointOfMeasureId: point.pointOfMeasureId,
  }
}

/** Why Create is held (a phrase), or null. */
export function newTemplateHeld(draft: NewTemplateDraft, context: { can: TemplateCan; busy: boolean; taken: readonly string[]; copy: readonly TemplatePointBody[] | null | 'failed' }): Phrase | null {
  if (!context.can.manage) return phrase('held.noManage')
  if (context.busy) return phrase('held.busy')
  if (!TEMPLATE_CODE.test(draft.code.trim())) return phrase('new.held.code')
  if (context.taken.includes(draft.code.trim())) return phrase('new.held.taken', { code: draft.code.trim() })
  if (!draft.name.trim()) return phrase('new.held.name')
  if (!draft.productType) return phrase('new.held.type')
  if (draft.start === 'copy') {
    if (!draft.copyFromId) return phrase('new.held.copyFrom')
    if (context.copy === 'failed') return phrase('new.held.copyFailed')
    if (context.copy === null) return phrase('new.held.copyReading')
    if (context.copy.length === 0) return phrase('new.held.copyEmpty')
    return null
  }
  if (!POINT_CODE.test(draft.firstCode.trim())) return phrase('new.held.firstCode')
  if (!draft.firstName.trim()) return phrase('new.held.firstName')
  return null
}

export function newTemplateBody(draft: NewTemplateDraft, copy: readonly TemplatePointBody[] | null) {
  const points: TemplatePointBody[] =
    draft.start === 'copy' && copy ? [...copy] : [{ code: draft.firstCode.trim(), name: draft.firstName.trim(), nameI18n: null, uom: draft.firstUom, minValue: null, maxValue: null, required: true, howTo: null, pointOfMeasureId: null }]
  return { companyId: draft.companyId, code: draft.code.trim(), name: draft.name.trim(), nameI18n: null, productType: draft.productType as ProductType, instructions: null, points }
}

// ---- the points' editor ---------------------------------------------------------------------------------------------

export interface PointDraft {
  /** Stable while editing (the point's id, or a new key). */
  readonly key: string
  readonly code: string
  readonly name: string
  readonly nameIt: string
  readonly nameEn: string
  readonly uom: 'CM' | 'MM'
  readonly min: string
  readonly max: string
  readonly required: boolean
  readonly howTo: string
  readonly pointOfMeasureId: string | null
  /** Not in the template yet (its code may still change; a kept point's code stays). */
  readonly isNew: boolean
}

/** The ACTIVE points in measuring order, as the editor holds them. */
export function draftsOf(template: Pick<TemplateView, 'points'>): PointDraft[] {
  return [...template.points]
    .filter((point) => point.status === 'ACTIVE')
    .sort((a, b) => a.seq - b.seq)
    .map((point) => ({
      key: point.id,
      code: point.code,
      name: point.name,
      nameIt: point.nameI18n.it ?? '',
      nameEn: point.nameI18n.en ?? '',
      uom: point.uom === 'MM' ? 'MM' : 'CM',
      min: point.minValue ?? '',
      max: point.maxValue ?? '',
      required: point.required,
      howTo: point.howTo ?? '',
      pointOfMeasureId: point.pointOfMeasureId,
      isNew: false,
    }))
}

let nextKey = 0
export const newPointDraft = (): PointDraft => ({ key: `new-${Date.now()}-${++nextKey}`, code: '', name: '', nameIt: '', nameEn: '', uom: 'CM', min: '', max: '', required: true, howTo: '', pointOfMeasureId: null, isNew: true })

/** An archived point put back in the list (the API makes it ACTIVE again, kept by its code). */
export function restoredDraft(point: TemplateView['points'][number]): PointDraft {
  return { ...draftsOf({ points: [{ ...point, status: 'ACTIVE' }] })[0]!, key: point.id }
}

const decimalText = (text: string): string => text.trim().replace(',', '.')

/** What is wrong with each point as typed (by key and field), the API's own rules first. */
export function pointProblems(drafts: readonly PointDraft[]): Record<string, Record<string, Phrase>> {
  const out: Record<string, Record<string, Phrase>> = {}
  const add = (key: string, field: string, problem: Phrase) => {
    out[key] = { ...(out[key] ?? {}), [field]: problem }
  }
  const seen = new Map<string, number>()
  for (const draft of drafts) seen.set(draft.code.trim(), (seen.get(draft.code.trim()) ?? 0) + 1)
  for (const draft of drafts) {
    const code = draft.code.trim()
    if (!POINT_CODE.test(code)) add(draft.key, 'code', phrase('point.problem.code'))
    else if ((seen.get(code) ?? 0) > 1) add(draft.key, 'code', phrase('point.problem.twice', { code }))
    if (!draft.name.trim()) add(draft.key, 'name', phrase('point.problem.name'))
    else if (draft.name.length > 200) add(draft.key, 'name', phrase('point.problem.tooLong', { max: 200 }))
    const min = decimalText(draft.min)
    const max = decimalText(draft.max)
    if (min && !DECIMAL.test(min)) add(draft.key, 'min', phrase('point.problem.number'))
    if (max && !DECIMAL.test(max)) add(draft.key, 'max', phrase('point.problem.number'))
    if (min && max && DECIMAL.test(min) && DECIMAL.test(max) && Number(min) > Number(max)) add(draft.key, 'max', phrase('point.problem.order'))
    if (draft.howTo.length > 2000) add(draft.key, 'howTo', phrase('point.problem.tooLong', { max: 2000 }))
  }
  return out
}

/** The points as the PUT sends them, in the editor's order. */
export function pointsBody(drafts: readonly PointDraft[]): TemplatePointBody[] {
  return drafts.map((draft) => {
    const words: Record<string, string> = {}
    if (draft.nameIt.trim()) words.it = draft.nameIt.trim()
    if (draft.nameEn.trim()) words.en = draft.nameEn.trim()
    return {
      code: draft.code.trim(),
      name: draft.name.trim(),
      nameI18n: Object.keys(words).length > 0 ? words : null,
      uom: draft.uom,
      minValue: decimalText(draft.min) || null,
      maxValue: decimalText(draft.max) || null,
      required: draft.required,
      howTo: draft.howTo.trim() || null,
      pointOfMeasureId: draft.pointOfMeasureId,
    }
  })
}

/** How many points change with Save (added, changed, moved, archived). */
export function changeCount(template: Pick<TemplateView, 'points'>, drafts: readonly PointDraft[]): number {
  const before = draftsOf(template)
  const now = pointsBody(drafts)
  const was = pointsBody(before)
  let count = 0
  now.forEach((point, index) => {
    const old = was.findIndex((entry) => entry.code === point.code)
    if (old === -1 || old !== index || JSON.stringify(was[old]) !== JSON.stringify(point)) count += 1
  })
  count += was.filter((point) => !now.some((entry) => entry.code === point.code)).length
  return count
}

/** The codes Save archives (left out of the list; kept on the template, no longer measured). */
export const archivedBySave = (template: Pick<TemplateView, 'points'>, drafts: readonly PointDraft[]): string[] =>
  draftsOf(template)
    .map((draft) => draft.code)
    .filter((code) => !drafts.some((draft) => draft.code.trim() === code))

/** Why the points cannot be edited at all (a phrase), or null. */
export function editHeld(template: Pick<TemplateView, 'status' | 'editable'>, can: TemplateCan): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (template.status === 'ARCHIVED') return phrase('held.archived')
  if (!template.editable) return phrase('held.notEditable')
  return null
}

/** Why Save is held while editing, or null. */
export function saveHeld(template: Pick<TemplateView, 'points'>, drafts: readonly PointDraft[], busy: boolean): Phrase | null {
  if (busy) return phrase('held.busy')
  if (drafts.length === 0) return phrase('edit.held.none')
  if (drafts.length > 60) return phrase('edit.held.tooMany', { max: 60 })
  const problems = pointProblems(drafts)
  const count = Object.keys(problems).length
  if (count > 0) return phrase('edit.held.problems', { count })
  if (changeCount(template, drafts) === 0) return phrase('edit.held.unchanged')
  return null
}

/** A refused save's field problems by point key (from `points/<index>/<field>` in the editor's order). */
export function refusedPoints(paths: readonly string[], drafts: readonly PointDraft[]): Record<string, Record<string, Phrase>> {
  const out: Record<string, Record<string, Phrase>> = {}
  for (const path of paths) {
    const match = /^points\/(\d+)\/(\w+)/.exec(path)
    if (!match) continue
    const draft = drafts[Number(match[1])]
    if (!draft) continue
    const field = match[2] === 'minValue' ? 'min' : match[2] === 'maxValue' ? 'max' : match[2] === 'pointOfMeasureId' ? 'code' : match[2]!
    out[draft.key] = { ...(out[draft.key] ?? {}), [field]: phrase('point.problem.refused') }
  }
  return out
}

// ---- archive, restore ---------------------------------------------------------------------------------------------------

export function archiveHeld(template: Pick<TemplateView, 'status' | 'rulesOn' | 'styles'>, can: TemplateCan): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (template.status === 'ARCHIVED') return phrase('held.alreadyArchived')
  if (template.rulesOn) return phrase('held.rulesOn')
  if (template.styles.measured > 0) return phrase('held.stylesUse', { count: template.styles.measured })
  return null
}

export const restoreHeld = (template: Pick<TemplateView, 'status'>, can: TemplateCan): Phrase | null => (!can.manage ? phrase('held.noManage') : template.status === 'ACTIVE' ? phrase('held.alreadyActive') : null)

export function renameHeld(template: Pick<TemplateView, 'status' | 'name'>, name: string, can: TemplateCan, busy: boolean): Phrase | null {
  if (!can.manage) return phrase('held.noManage')
  if (template.status === 'ARCHIVED') return phrase('held.archived')
  if (busy) return phrase('held.busy')
  if (!name.trim()) return phrase('new.held.name')
  if (name.trim() === template.name) return phrase('edit.held.unchanged')
  return null
}

// ---- made-to-measure (GATE-MTM) --------------------------------------------------------------------------------------------

/** Why the switch is held (a phrase), or null: only the Owner starts made-to-measure; an archived template is not started. */
export function switchHeld(rules: Pick<TemplateRules, 'template' | 'switchable'>, on: boolean, can: TemplateCan, busy: boolean): Phrase | null {
  if (!can.switch) return phrase('held.noSwitch')
  if (on && rules.template.status !== 'ACTIVE') return phrase('held.archivedOn')
  if (busy) return phrase('held.busy')
  if (!rules.switchable) return phrase('held.noSwitch')
  return null
}

export interface RulesFacts {
  readonly active: number
  readonly blocking: number
  readonly baseSizePoints: readonly string[]
  readonly tie: 'LARGER' | 'SMALLER' | null
  /** Points with an alteration limit (under or over the base size). */
  readonly limits: number
  /** Points with a made-to-measure inspection tolerance. */
  readonly tolerances: number
}

export function rulesFacts(rules: Pick<TemplateRules, 'rules' | 'template' | 'points'>): RulesFacts {
  const active = rules.rules.filter((rule) => rule.status === 'ACTIVE')
  return {
    active: active.length,
    blocking: active.filter((rule) => rule.severity === 'BLOCK').length,
    baseSizePoints: rules.template.baseSizeRule?.points ?? [],
    tie: rules.template.baseSizeRule?.tie ?? null,
    limits: rules.points.filter((point) => point.alterationMinus !== null || point.alterationPlus !== null).length,
    tolerances: rules.points.filter((point) => point.tolerance !== null).length,
  }
}

/** A rule's own words in the reader's language (the factory's words), else the other language, else its code. */
export const ruleWords = (rule: Pick<MtmRule, 'messageI18n' | 'code'>, locale: string): string => rule.messageI18n[locale]?.trim() || rule.messageI18n.it?.trim() || rule.messageI18n.en?.trim() || rule.code

/** The rule's bounds as figures ("0.80–1.20", "≥ 60"), or null. */
export function ruleBounds(rule: Pick<MtmRule, 'kind' | 'minFactor' | 'maxFactor' | 'minValue' | 'maxValue'>): string | null {
  const [min, max] = rule.kind === 'RATIO' ? [rule.minFactor, rule.maxFactor] : rule.kind === 'RANGE' ? [rule.minValue, rule.maxValue] : [null, null]
  if (min && max) return `${min}–${max}`
  if (min) return `≥ ${min}`
  if (max) return `≤ ${max}`
  return null
}

export const switchedNotice = (on: boolean, code: string): Notice => ({ key: on ? 'mtm.done.on' : 'mtm.done.off', tone: 'success', params: { code } })
