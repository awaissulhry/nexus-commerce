import { baseSizeRuleProblems, limitsProblems, MTM_LIMITS, RULE_KINDS, RULE_SEVERITIES, rulesProblems, TIES, type BaseSizeRule, type PointLimits, type RuleFields, type RuleKind, type RuleSeverity, type Tie } from '@nexus/factory-domain/product/mtm-rules/rules'
import type { PutRulesBody } from '@nexus/factory-domain/product/mtm-rules/contracts'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { MtmRule, RulesPoint, TemplateRules } from '../api'
import type { Phrase, TemplateCan } from '../model'

/**
 * The rule editor of a measurement template (B-W2b-371, XF2:05; B-W2b-248's made-to-measure rules, typed, not only shown), pure:
 * the rules as typed (each: its code, kind ORDER | RATIO | RANGE, the point and the other point, its bounds, Blocks / Warns, its
 * words in Italian and English, kept or archived), the base size rule (the points that decide, the tie), each point's inspection
 * tolerance and alteration limits; what each field lacks (the domain's own write checks: rulesProblems, baseSizeRuleProblems,
 * limitsProblems — said from their paths in this part's words, never their English); the body of ONE PUT (the whole rule list, by
 * code: kept, changed, added; left out = removed). Editing is open while made-to-measure is off: that is when the rules are made.
 */

export { MTM_LIMITS, RULE_KINDS, RULE_SEVERITIES, TIES }
export type { RuleKind, RuleSeverity, Tie }

export interface RuleDraft {
  /** The row's own key (a rule's id, or a new one): never sent. */
  readonly key: string
  readonly code: string
  readonly kind: RuleKind
  readonly pointCode: string
  readonly otherPointCode: string
  readonly minFactor: string
  readonly maxFactor: string
  readonly minValue: string
  readonly maxValue: string
  readonly severity: RuleSeverity
  readonly it: string
  readonly en: string
  readonly archived: boolean
}

export interface LimitDraft {
  readonly code: string
  readonly tolerance: string
  readonly alterationMinus: string
  readonly alterationPlus: string
}

export interface RulesDraft {
  readonly rules: readonly RuleDraft[]
  /** The points the base size is read from, the one that decides first first; none: no base size rule. */
  readonly basePoints: readonly string[]
  readonly tie: Tie
  readonly limits: readonly LimitDraft[]
}

const text = (value: string | null | undefined): string => value ?? ''
const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())
let nextKey = 0

export function ruleDraftOf(rule: MtmRule): RuleDraft {
  return {
    key: rule.id,
    code: rule.code,
    kind: rule.kind,
    pointCode: rule.pointCode,
    otherPointCode: text(rule.otherPointCode),
    minFactor: text(rule.minFactor),
    maxFactor: text(rule.maxFactor),
    minValue: text(rule.minValue),
    maxValue: text(rule.maxValue),
    severity: rule.severity,
    it: text(rule.messageI18n.it),
    en: text(rule.messageI18n.en),
    archived: rule.status === 'ARCHIVED',
  }
}

/** A new rule: an ORDER of the first two active points, Blocks. */
export function newRuleDraft(points: readonly RulesPoint[]): RuleDraft {
  const active = points.filter((point) => point.status === 'ACTIVE')
  return { key: `new-${++nextKey}`, code: '', kind: 'ORDER', pointCode: active[0]?.code ?? '', otherPointCode: active[1]?.code ?? '', minFactor: '', maxFactor: '', minValue: '', maxValue: '', severity: 'BLOCK', it: '', en: '', archived: false }
}

export function draftOf(rules: Pick<TemplateRules, 'rules' | 'template' | 'points'>): RulesDraft {
  return {
    rules: rules.rules.map(ruleDraftOf),
    basePoints: rules.template.baseSizeRule?.points ?? [],
    tie: rules.template.baseSizeRule?.tie ?? 'LARGER',
    limits: rules.points.filter((point) => point.status === 'ACTIVE').map((point) => ({ code: point.code, tolerance: text(point.tolerance), alterationMinus: text(point.alterationMinus), alterationPlus: text(point.alterationPlus) })),
  }
}

/** A kind's own fields only (an ORDER has no bound, a RATIO factors, a RANGE values and no other point). */
export function withKind(rule: RuleDraft, kind: RuleKind): RuleDraft {
  return {
    ...rule,
    kind,
    otherPointCode: kind === 'RANGE' ? '' : rule.otherPointCode,
    minFactor: kind === 'RATIO' ? rule.minFactor : '',
    maxFactor: kind === 'RATIO' ? rule.maxFactor : '',
    minValue: kind === 'RANGE' ? rule.minValue : '',
    maxValue: kind === 'RANGE' ? rule.maxValue : '',
  }
}

function fieldsOf(rule: RuleDraft): RuleFields {
  const words: Record<string, string> = {}
  if (rule.it.trim()) words.it = rule.it.trim()
  if (rule.en.trim()) words.en = rule.en.trim()
  return {
    code: rule.code.trim(),
    kind: rule.kind,
    pointCode: rule.pointCode,
    otherPointCode: rule.kind === 'RANGE' ? null : orNull(rule.otherPointCode),
    minFactor: rule.kind === 'RATIO' ? orNull(rule.minFactor) : null,
    maxFactor: rule.kind === 'RATIO' ? orNull(rule.maxFactor) : null,
    minValue: rule.kind === 'RANGE' ? orNull(rule.minValue) : null,
    maxValue: rule.kind === 'RANGE' ? orNull(rule.maxValue) : null,
    severity: rule.severity,
    messageI18n: words,
    status: rule.archived ? 'ARCHIVED' : 'ACTIVE',
  }
}

const baseRuleOf = (draft: RulesDraft): BaseSizeRule | null => (draft.basePoints.length === 0 ? null : { points: [...draft.basePoints], tie: draft.tie })
const limitsOf = (draft: RulesDraft): PointLimits[] => draft.limits.map((limit) => ({ code: limit.code, tolerance: orNull(limit.tolerance), alterationMinus: orNull(limit.alterationMinus), alterationPlus: orNull(limit.alterationPlus) }))

/** The body of ONE PUT …/mtm-rules at the template's version: every rule, the base size rule, every active point's limits. */
export function rulesBody(draft: RulesDraft, version: number): PutRulesBody {
  return { version, baseSizeRule: draft.basePoints.length === 0 ? null : { points: [...draft.basePoints], tie: draft.tie }, points: limitsOf(draft), rules: draft.rules.map(fieldsOf) }
}

/** The field a problem's path points at, said in words (`rules/2/minFactor` → rule 2's factor). */
export type FieldProblems = Readonly<Record<string, Phrase>>

const RULE_FIELD_WORDS: Readonly<Record<string, string>> = Object.freeze({
  code: 'rules.problem.code',
  messageI18n: 'rules.problem.words',
  pointCode: 'rules.problem.point',
  otherPointCode: 'rules.problem.other',
  minFactor: 'rules.problem.factor',
  maxFactor: 'rules.problem.factor',
  minValue: 'rules.problem.value',
  maxValue: 'rules.problem.value',
})

/** Each field's problem by `<rule key>/<field>`, `base` or `limit/<code>/<field>`, from the domain's own checks or the API's paths. */
export function problemsOf(paths: readonly string[], draft: RulesDraft): Record<string, Phrase> {
  const out: Record<string, Phrase> = {}
  for (const raw of paths) {
    const path = raw.replace(/^body\//, '')
    const rule = /^rules\/(\d+)(?:\/(\w+))?/.exec(path)
    if (rule) {
      const draftRule = draft.rules[Number(rule[1])]
      if (!draftRule) continue
      const field = rule[2] ?? 'kind'
      out[`${draftRule.key}/${field === 'maxFactor' ? 'minFactor' : field === 'maxValue' ? 'minValue' : field}`] ??= { key: RULE_FIELD_WORDS[field] ?? 'rules.problem.kind' }
      continue
    }
    if (path.startsWith('baseSizeRule')) {
      out.base ??= { key: 'rules.problem.base' }
      continue
    }
    const limit = /^points\/(\d+)\/(\w+)/.exec(path)
    if (limit) {
      const code = draft.limits[Number(limit[1])]?.code
      if (code) out[`limit/${code}/${limit[2]}`] ??= { key: 'rules.problem.limit' }
      continue
    }
    if (path === 'rules') out.rules ??= { key: 'rules.problem.tooMany', params: { max: MTM_LIMITS.rules } }
  }
  return out
}

/** What the draft lacks before a save (the domain's write checks), by field. */
export function draftProblems(draft: RulesDraft, points: readonly RulesPoint[]): Record<string, Phrase> {
  const template = points.map((point) => ({ id: point.id, code: point.code, name: point.name, uom: point.uom, status: point.status, alterationMinus: point.alterationMinus, alterationPlus: point.alterationPlus }))
  const issues = [...rulesProblems(draft.rules.map(fieldsOf), template), ...baseSizeRuleProblems(baseRuleOf(draft), template), ...limitsProblems(limitsOf(draft), template)]
  return problemsOf(
    issues.map((issue) => issue.path),
    draft,
  )
}

/** The changes against what is kept: rules added, changed or removed; the base size rule; limits. 0: nothing to save. */
export function changeCount(rules: Pick<TemplateRules, 'rules' | 'template' | 'points'>, draft: RulesDraft): number {
  const before = draftOf(rules)
  const byKey = new Map(before.rules.map((rule) => [rule.key, rule]))
  let count = 0
  for (const rule of draft.rules) {
    const was = byKey.get(rule.key)
    if (!was || JSON.stringify(fieldsOf(was)) !== JSON.stringify(fieldsOf(rule))) count++
  }
  count += before.rules.filter((rule) => !draft.rules.some((now) => now.key === rule.key)).length
  if (JSON.stringify(baseRuleOf(before)) !== JSON.stringify(baseRuleOf(draft))) count++
  count += draft.limits.filter((limit) => JSON.stringify(limitsOf({ ...draft, limits: [limit] })) !== JSON.stringify(limitsOf({ ...before, limits: before.limits.filter((was) => was.code === limit.code) }))).length
  return count
}

/** Why the editor cannot open (null: it can): the right, the template's state (the API's `editable`). */
export function editRulesHeld(rules: Pick<TemplateRules, 'editable' | 'template'>, can: TemplateCan): Phrase | null {
  if (!can.manage) return { key: 'rules.held.right' }
  if (rules.template.status !== 'ACTIVE') return { key: 'rules.held.archived' }
  if (!rules.editable) return { key: 'rules.held.notEditable' }
  return null
}

/** Why Save waits (null: it may go): a write running, nothing changed, a field to fix. */
export function saveRulesHeld(rules: Pick<TemplateRules, 'rules' | 'template' | 'points'>, draft: RulesDraft, busy: boolean, offline = false): Phrase | null {
  if (busy) return { key: 'rules.held.busy' }
  if (offline) return { key: 'rules.held.offline' }
  const problems = Object.keys(draftProblems(draft, rules.points)).length
  if (problems > 0) return { key: 'rules.held.fix', params: { count: problems } }
  if (changeCount(rules, draft) === 0) return { key: 'rules.held.nothing' }
  return null
}

/** A refused save: a moved version (read again), the fields it named, or the kind's words. */
export function saveRulesProblem(error: unknown, draft: RulesDraft): { notice: Phrase; fields: Record<string, Phrase>; reload: boolean } {
  if (!isApiError(error)) return { notice: { key: 'rules.problem.failed' }, fields: {}, reload: false }
  if (error.kind === 'conflict') return { notice: { key: 'rules.problem.stale' }, fields: {}, reload: true }
  const fields = problemsOf(
    error.issues.map((issue) => issuePath(issue).replace(/\./g, '/')),
    draft,
  )
  if (Object.keys(fields).length > 0) return { notice: { key: 'rules.held.fix', params: { count: Object.keys(fields).length } }, fields, reload: false }
  if (error.kind === 'forbidden') return { notice: { key: 'rules.held.right' }, fields: {}, reload: false }
  return { notice: { key: 'rules.problem.failed' }, fields: {}, reload: false }
}
