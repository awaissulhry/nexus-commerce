import type { BusinessDate } from '../../core/time'
import {
  DECLARATION_OF_RULE,
  limitWords,
  SUBSTANCE_LIMITS,
  TEST_OF_RULE,
  type DeclarationKind,
  type EvidenceKind,
  type LimitBound,
  type RuleCode,
  type RuleSource,
  type SubstanceStatus,
  type SubstanceTest,
  type SubstanceUnit,
} from './rules'

/**
 * The evaluator (B-W2b-250; PRD-320 … PRD-326, PRD-329): ONE pure function over the seeded rules that says, per material
 * (and per style that uses it), which rule applies, what evidence it needs and whether that evidence is there and passes;
 * and the material's SVHC answer above 0.1 % w/w per article (REACH art. 33). The API reads the facts (rules with their
 * substances, the material, the styles whose current BOM names it, the markets sold to, the material's lab results and
 * its suppliers' declarations) and writes what this answers into the material's compliance profile in one update.
 *
 * A rule applies when it is ACTIVE and switched on, the material's kind is one of its kinds (none: every kind), not a
 * natural leather part under an exemptNaturalLeather rule (entry 72), a market sold to is one of its markets (none: every
 * market; "US" covers "US-CA"), and at least one style that uses the material passes its other tests: of the rule's
 * company (a tenant-wide rule: every company), of one of its product types (none: every type), of the brand whose RSL it
 * is (a CUSTOMER rule), and not PPE under an exemptPpe rule (a style in scope of Reg. (EU) 2016/425). A material no
 * current BOM names is judged alone: a product-type or brand rule waits until a style uses it.
 *
 * What proves it (the rule's evidence): TEST, a lab test of its own (CR_VI, AZO, NICKEL, PAH, DMFU, NPE, PFAS: the
 * material's newest current LabResult of that test); DECLARATION, the supplier's declaration of the rule's kind (nickel,
 * Cr VI and PFAS their own; an RSL declaration otherwise) ACCEPTED and in force; EITHER, one of them. A rule with no test
 * of its own (CMR, our own) is proved by a declaration. A failing newest test, or the newest in-force declaration stating
 * a restricted substance above the limit, FAILS the rule whatever its evidence says: the material is BLOCKED. A rule with
 * nothing that proves it is MISSING; one or more MISSING, or an SVHC answer missing or of an older Candidate List, leave the
 * material INCOMPLETE; else it is COMPLETE.
 */

export type RuleStatus = 'MET' | 'FAILED' | 'MISSING' | 'NOT_APPLICABLE'
export const NOT_APPLICABLE_WHY = ['ARCHIVED', 'SWITCHED_OFF', 'MATERIAL_KIND', 'EXEMPT_NATURAL_LEATHER', 'MARKET', 'OTHER_COMPANY', 'PRODUCT_TYPE', 'BRAND', 'EXEMPT_PPE'] as const
export type NotApplicableWhy = (typeof NOT_APPLICABLE_WHY)[number]
export type ProfileState = 'INCOMPLETE' | 'COMPLETE' | 'BLOCKED'

export interface RuleFacts {
  readonly id: string
  readonly key: string
  readonly code: RuleCode
  readonly name: string
  readonly companyId: string | null
  readonly substanceId: string | null
  readonly substanceGroup: string | null
  readonly materialKinds: readonly string[]
  readonly productTypes: readonly string[]
  readonly marketCodes: readonly string[]
  readonly limitValue: string | null
  readonly limitUnit: SubstanceUnit | null
  readonly limitBound: LimitBound | null
  readonly testMethod: string | null
  readonly evidence: EvidenceKind
  readonly exemptPpe: boolean
  readonly exemptNaturalLeather: boolean
  readonly source: RuleSource
  readonly customerPartyId: string | null
  readonly legalReference: string
  readonly switchedOn: boolean
  readonly offReason: string | null
  readonly status: SubstanceStatus
  /** The substances it restricts: its own, or the ACTIVE substances of its group. */
  readonly substanceIds: readonly string[]
}

export interface MaterialFacts {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
  readonly companyId: string | null
}

/** A style whose current BOM (a DRAFT or RELEASED revision) names the material, on a line or as an alternate. */
export interface StyleUse {
  readonly styleId: string
  readonly code: string
  readonly productType: string
  readonly ppeCategory: string
  readonly brandPartyId: string | null
  readonly companyId: string | null
}

/** A current lab result of the material (one no other result supersedes). */
export interface TestFact {
  readonly resultId: string
  readonly lotId: string
  readonly test: SubstanceTest
  readonly verdict: 'PASS' | 'FAIL'
  readonly testedOn: BusinessDate
  /** When it was recorded (ISO), the tie-break of one day. */
  readonly recordedAt: string
}

export interface DeclarationLineFact {
  readonly contains: boolean | null
  readonly aboveThreshold: boolean | null
  readonly substanceId: string | null
  readonly substanceName: string | null
}

/** A declaration request with at least one line about the material (its lines for the material only). */
export interface DeclarationFact {
  readonly requestId: string
  readonly number: string
  readonly kind: DeclarationKind
  readonly status: 'SENT' | 'ANSWERED' | 'ACCEPTED' | 'REFUSED' | 'OVERDUE' | 'CANCELLED'
  readonly dueOn: BusinessDate
  readonly validTo: BusinessDate | null
  readonly decidedAt: string | null
  /** REACH_SVHC: the Candidate List version asked about and the one the answer states. */
  readonly svhcListVersionId: string | null
  readonly answeredListVersionId: string | null
  readonly lines: readonly DeclarationLineFact[]
}

export interface ListVersionFact {
  readonly id: string
  readonly publishedOn: BusinessDate
  readonly entryCount: number
}

/** The SVHC answer the profile holds now (the roll-up keeps it when no accepted declaration says otherwise). */
export interface SavedSvhc {
  readonly aboveThreshold: boolean | null
  readonly listVersionId: string | null
  readonly substanceIds: readonly string[]
}

export interface EvaluationInput {
  readonly material: MaterialFacts
  readonly uses: readonly StyleUse[]
  /** The market codes sold to (the switched-on markets, or the one asked). */
  readonly markets: readonly string[]
  readonly rules: readonly RuleFacts[]
  readonly tests: readonly TestFact[]
  readonly declarations: readonly DeclarationFact[]
  readonly listVersions: readonly ListVersionFact[]
  /** The ids of the substances on the SVHC Candidate List (an SVHC answer names only those). */
  readonly svhcSubstanceIds: ReadonlySet<string>
  readonly saved: SavedSvhc | null
  readonly today: BusinessDate
}

export type Proof =
  | { readonly kind: 'TEST'; readonly resultId: string; readonly lotId: string; readonly test: SubstanceTest; readonly verdict: 'PASS' | 'FAIL'; readonly testedOn: BusinessDate }
  | { readonly kind: 'DECLARATION'; readonly requestId: string; readonly number: string; readonly declaration: DeclarationKind; readonly validTo: BusinessDate | null }

export interface RuleVerdict {
  readonly ruleId: string
  readonly key: string
  readonly code: RuleCode
  readonly name: string
  readonly legalReference: string
  /** "at most 30 mg/kg". */
  readonly limit: string
  readonly status: RuleStatus
  readonly why: NotApplicableWhy | null
  /** The styles (of those using the material) where it applies. */
  readonly styleIds: readonly string[]
  readonly evidence: EvidenceKind
  /** What proves it: the lab test (null: none of its own) and the declaration a supplier is asked for (null: a test only). */
  readonly needs: { readonly test: SubstanceTest | null; readonly declaration: DeclarationKind | null }
  readonly metBy: 'TEST' | 'DECLARATION' | null
  readonly proof: Proof | null
  /** A declaration of its kind asked and not decided yet. */
  readonly asked: { readonly requestId: string; readonly number: string; readonly dueOn: BusinessDate; readonly status: string } | null
  readonly words: string
}

export interface SvhcAnswer {
  /** true: an SVHC above 0.1 % w/w; false: none; null: not known. */
  readonly aboveThreshold: boolean | null
  readonly substanceIds: readonly string[]
  /** SVHCs a supplier named above 0.1 % that are not on our list (add them to the list). */
  readonly unnamed: readonly string[]
  readonly listVersion: ListVersionFact | null
  readonly newestVersion: ListVersionFact | null
  /** Judged against the newest Candidate List version. */
  readonly current: boolean
  /** Entries the list grew by since the answer's version (null: current, or no answer). */
  readonly grewBy: number | null
  /** DECLARATION: the newest accepted REACH_SVHC declaration; PROFILE: the profile's own answer; NONE. */
  readonly source: 'DECLARATION' | 'PROFILE' | 'NONE'
  readonly request: { readonly requestId: string; readonly number: string } | null
  readonly asked: { readonly requestId: string; readonly number: string; readonly dueOn: BusinessDate; readonly status: string } | null
}

export interface MaterialEvaluation {
  readonly materialId: string
  /** Applicable rules first (failed, missing, met), then the others. */
  readonly rules: readonly RuleVerdict[]
  readonly applicableRuleIds: readonly string[]
  readonly testsNeeded: readonly SubstanceTest[]
  readonly declarationsNeeded: readonly DeclarationKind[]
  readonly svhc: SvhcAnswer
  readonly state: ProfileState
  readonly stateReason: string | null
}

const TEST_ORDER: readonly SubstanceTest[] = ['CR_VI', 'AZO', 'NICKEL', 'PAH', 'DMFU', 'NPE', 'PFAS']
const DECLARATION_ORDER: readonly DeclarationKind[] = ['REACH_SVHC', 'RSL', 'PFAS', 'NICKEL', 'CR6', 'OTHER']
const OPEN = new Set(['SENT', 'OVERDUE', 'ANSWERED'])

/** Does a market sold to fall under one of the rule's market codes ("US" covers "US-CA")? */
export const marketCovered = (ruleCode: string, market: string): boolean => market === ruleCode || market.startsWith(`${ruleCode}-`)

const PPE = (use: StyleUse): boolean => use.ppeCategory !== 'NOT_PPE'

/** The checks a style must pass, in order; the first one failed is the reason. */
const STYLE_CHECKS: readonly [NotApplicableWhy, (rule: RuleFacts, use: StyleUse | null, material: MaterialFacts) => boolean][] = [
  ['OTHER_COMPANY', (rule, use, material) => rule.companyId === null || rule.companyId === (use ? use.companyId : material.companyId)],
  ['PRODUCT_TYPE', (rule, use) => rule.productTypes.length === 0 || (use !== null && rule.productTypes.includes(use.productType))],
  ['BRAND', (rule, use) => rule.source !== 'CUSTOMER' || (use !== null && use.brandPartyId === rule.customerPartyId)],
  ['EXEMPT_PPE', (rule, use) => !rule.exemptPpe || use === null || !PPE(use)],
]

/** Whether a rule applies to the material (and in which styles), or why not. */
export function applicability(rule: RuleFacts, input: Pick<EvaluationInput, 'material' | 'uses' | 'markets'>): { readonly why: NotApplicableWhy | null; readonly styleIds: readonly string[] } {
  if (rule.status !== 'ACTIVE') return { why: 'ARCHIVED', styleIds: [] }
  if (!rule.switchedOn) return { why: 'SWITCHED_OFF', styleIds: [] }
  if (rule.materialKinds.length > 0 && !rule.materialKinds.includes(input.material.kind)) return { why: 'MATERIAL_KIND', styleIds: [] }
  if (rule.exemptNaturalLeather && input.material.kind === 'LEATHER') return { why: 'EXEMPT_NATURAL_LEATHER', styleIds: [] }
  if (rule.marketCodes.length > 0 && !input.markets.some((market) => rule.marketCodes.some((code) => marketCovered(code, market)))) return { why: 'MARKET', styleIds: [] }
  const contexts: (StyleUse | null)[] = input.uses.length > 0 ? [...input.uses] : [null]
  const styleIds: string[] = []
  let furthest = -1
  for (const use of contexts) {
    const failed = STYLE_CHECKS.findIndex(([, passes]) => !passes(rule, use, input.material))
    if (failed === -1) {
      if (use) styleIds.push(use.styleId)
      else return { why: null, styleIds: [] }
    } else furthest = Math.max(furthest, failed)
  }
  if (styleIds.length > 0) return { why: null, styleIds }
  return { why: STYLE_CHECKS[furthest]![0], styleIds: [] }
}

const newestTest = (tests: readonly TestFact[], test: SubstanceTest): TestFact | null =>
  [...tests].filter((fact) => fact.test === test).sort((a, b) => (a.testedOn === b.testedOn ? b.recordedAt.localeCompare(a.recordedAt) : b.testedOn.localeCompare(a.testedOn)))[0] ?? null

const inForce = (fact: DeclarationFact, today: BusinessDate): boolean => fact.status === 'ACCEPTED' && (fact.validTo === null || fact.validTo >= today)
const byDecided = (a: DeclarationFact, b: DeclarationFact): number => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '') || b.number.localeCompare(a.number)

/** Does a line stating "above the threshold" speak of this rule? A kind of its own (nickel, Cr VI, PFAS) always; an RSL line when it names one of the rule's substances. */
const lineAbout = (rule: RuleFacts, kind: DeclarationKind, line: DeclarationLineFact): boolean =>
  kind !== 'RSL' || (line.substanceId !== null && rule.substanceIds.includes(line.substanceId))

const NOT_APPLICABLE_WORDS = (rule: RuleFacts, why: NotApplicableWhy, input: Pick<EvaluationInput, 'material' | 'uses' | 'markets'>): string => {
  switch (why) {
    case 'ARCHIVED':
      return 'Archived: no longer applied.'
    case 'SWITCHED_OFF':
      return `Switched off${rule.offReason ? `: ${rule.offReason}` : '.'}`
    case 'MATERIAL_KIND':
      return `Not for a ${input.material.kind} material (it applies to ${rule.materialKinds.join(', ')}).`
    case 'EXEMPT_NATURAL_LEATHER':
      return 'Exempt: a part made only of natural leather, fur or hide.'
    case 'MARKET':
      return `Applies to sales in ${rule.marketCodes.join(', ')}; ${input.markets.length > 0 ? `sold in ${input.markets.join(', ')}` : 'no market is switched on'}.`
    case 'OTHER_COMPANY':
      return "Another company's rule."
    case 'PRODUCT_TYPE':
      return input.uses.length > 0 ? `Applies to ${rule.productTypes.join(', ')} styles; no such style uses this material.` : `Not used in a style yet; it applies to ${rule.productTypes.join(', ')} styles.`
    case 'BRAND':
      return input.uses.length > 0 ? "A brand's RSL: no style of that brand uses this material." : "A brand's RSL: not used in a style of that brand yet."
    case 'EXEMPT_PPE':
      return 'Exempt: every style that uses it is PPE in scope of Reg. (EU) 2016/425.'
  }
}

const neededWords = (needs: RuleVerdict['needs']): string =>
  needs.test && needs.declaration ? `a supplier's ${needs.declaration} declaration or a passing ${needs.test} test` : needs.test ? `a passing ${needs.test} test` : `a supplier's ${needs.declaration} declaration`

/** One rule's verdict for the material. */
export function judgeRule(rule: RuleFacts, input: EvaluationInput): RuleVerdict {
  const test = TEST_OF_RULE[rule.code]
  const kind = DECLARATION_OF_RULE[rule.code]
  const acceptsTest = rule.evidence !== 'DECLARATION' && test !== null
  const acceptsDeclaration = rule.evidence !== 'TEST' || test === null
  const needs = { test: acceptsTest ? test : null, declaration: acceptsDeclaration ? kind : null }
  const { why, styleIds } = applicability(rule, input)
  const base = { ruleId: rule.id, key: rule.key, code: rule.code, name: rule.name, legalReference: rule.legalReference, limit: limitWords(rule.limitValue, rule.limitUnit, rule.limitBound), evidence: rule.evidence, needs, styleIds }
  const ofKind = input.declarations.filter((fact) => fact.kind === kind)
  const openOne = [...ofKind].filter((fact) => OPEN.has(fact.status)).sort((a, b) => b.dueOn.localeCompare(a.dueOn))[0]
  const asked = openOne ? { requestId: openOne.requestId, number: openOne.number, dueOn: openOne.dueOn, status: openOne.status } : null
  if (why) return { ...base, status: 'NOT_APPLICABLE', why, metBy: null, proof: null, asked: null, words: NOT_APPLICABLE_WORDS(rule, why, input) }

  const latest = test ? newestTest(input.tests, test) : null
  const declaration = ofKind.filter((fact) => inForce(fact, input.today)).sort(byDecided)[0] ?? null
  const testProof = (fact: TestFact): Proof => ({ kind: 'TEST', resultId: fact.resultId, lotId: fact.lotId, test: fact.test, verdict: fact.verdict, testedOn: fact.testedOn })
  const declarationProof = (fact: DeclarationFact): Proof => ({ kind: 'DECLARATION', requestId: fact.requestId, number: fact.number, declaration: fact.kind, validTo: fact.validTo })
  if (latest?.verdict === 'FAIL') {
    return { ...base, status: 'FAILED', why: null, metBy: 'TEST', proof: testProof(latest), asked, words: `Failed: the ${latest.test} test of ${latest.testedOn} is not within the limit (${base.limit}).` }
  }
  const above = declaration?.lines.find((line) => line.contains === true && line.aboveThreshold === true && lineAbout(rule, kind, line))
  if (declaration && above) {
    return { ...base, status: 'FAILED', why: null, metBy: 'DECLARATION', proof: declarationProof(declaration), asked, words: `Failed: declaration ${declaration.number} states ${above.substanceName ?? 'a restricted substance'} above the limit (${base.limit}).` }
  }
  if (acceptsTest && latest?.verdict === 'PASS') {
    return { ...base, status: 'MET', why: null, metBy: 'TEST', proof: testProof(latest), asked, words: `Met by a passing ${latest.test} test of ${latest.testedOn}.` }
  }
  if (acceptsDeclaration && declaration) {
    return { ...base, status: 'MET', why: null, metBy: 'DECLARATION', proof: declarationProof(declaration), asked, words: `Met by declaration ${declaration.number}${declaration.validTo ? `, valid to ${declaration.validTo}` : ''}.` }
  }
  const expired = ofKind.filter((fact) => fact.status === 'ACCEPTED' && fact.validTo !== null && fact.validTo < input.today).sort(byDecided)[0]
  const refused = ofKind.filter((fact) => fact.status === 'REFUSED').sort(byDecided)[0]
  const context = asked
    ? ` Asked in ${asked.number}, due ${asked.dueOn}${asked.status === 'OVERDUE' ? ' (overdue)' : asked.status === 'ANSWERED' ? ' (answered, to decide)' : ''}.`
    : expired
      ? ` ${expired.number} expired on ${expired.validTo}.`
      : refused
        ? ` ${refused.number} was refused.`
        : ''
  return { ...base, status: 'MISSING', why: null, metBy: null, proof: null, asked, words: `Missing: ${neededWords(needs)}.${context}` }
}

const versionOf = (fact: DeclarationFact): string | null => fact.answeredListVersionId ?? fact.svhcListVersionId

/** The material's SVHC answer above 0.1 % w/w per article (REACH art. 33; PRD-326). */
export function svhcAnswer(input: Pick<EvaluationInput, 'declarations' | 'listVersions' | 'svhcSubstanceIds' | 'saved' | 'today'>): SvhcAnswer {
  const versions = new Map(input.listVersions.map((version) => [version.id, version]))
  const newestVersion = [...input.listVersions].sort((a, b) => b.publishedOn.localeCompare(a.publishedOn))[0] ?? null
  const svhc = input.declarations.filter((fact) => fact.kind === 'REACH_SVHC')
  const openOne = svhc.filter((fact) => OPEN.has(fact.status)).sort((a, b) => b.dueOn.localeCompare(a.dueOn))[0]
  const asked = openOne ? { requestId: openOne.requestId, number: openOne.number, dueOn: openOne.dueOn, status: openOne.status } : null
  const published = (fact: DeclarationFact): string => {
    const id = versionOf(fact)
    return (id ? versions.get(id)?.publishedOn : undefined) ?? ''
  }
  const accepted = svhc.filter((fact) => inForce(fact, input.today)).sort((a, b) => published(b).localeCompare(published(a)) || byDecided(a, b))
  const judged = (listVersion: ListVersionFact | null) => {
    const current = listVersion !== null && newestVersion !== null && listVersion.id === newestVersion.id
    return { newestVersion, current, grewBy: listVersion && newestVersion && !current ? newestVersion.entryCount - listVersion.entryCount : null }
  }
  const newest = accepted[0]
  if (newest) {
    const above = newest.lines.filter((line) => line.contains === true && line.aboveThreshold === true)
    const substanceIds = [...new Set(above.flatMap((line) => (line.substanceId && input.svhcSubstanceIds.has(line.substanceId) ? [line.substanceId] : [])))].sort()
    const unnamed = above.filter((line) => !line.substanceId || !input.svhcSubstanceIds.has(line.substanceId)).map((line) => line.substanceName ?? 'a substance with no name')
    const listVersion = versions.get(versionOf(newest) ?? '') ?? null
    return {
      aboveThreshold: above.length === 0 ? false : substanceIds.length > 0 ? true : null,
      substanceIds,
      unnamed,
      listVersion,
      ...judged(listVersion),
      source: 'DECLARATION',
      request: { requestId: newest.requestId, number: newest.number },
      asked,
    }
  }
  if (input.saved && input.saved.aboveThreshold !== null) {
    const listVersion = versions.get(input.saved.listVersionId ?? '') ?? null
    return { aboveThreshold: input.saved.aboveThreshold, substanceIds: [...input.saved.substanceIds].sort(), unnamed: [], listVersion, ...judged(listVersion), source: 'PROFILE', request: null, asked }
  }
  return { aboveThreshold: null, substanceIds: [], unnamed: [], listVersion: null, newestVersion, current: false, grewBy: null, source: 'NONE', request: null, asked }
}

const RANK: Readonly<Record<RuleStatus, number>> = { FAILED: 0, MISSING: 1, MET: 2, NOT_APPLICABLE: 3 }

const clip = (words: string): string => (words.length <= SUBSTANCE_LIMITS.note ? words : `${words.slice(0, SUBSTANCE_LIMITS.note - 1)}…`)

/** What the SVHC answer still lacks, in words (null: nothing). */
function svhcGap(svhc: SvhcAnswer): string | null {
  if (svhc.unnamed.length > 0 && svhc.aboveThreshold === null) return `SVHC: the declaration names ${svhc.unnamed.join(', ')} above 0.1 % w/w, not on the substance list: add it.`
  if (svhc.aboveThreshold === null) return `SVHC: no answer above 0.1 % w/w yet${svhc.asked ? ` (asked in ${svhc.asked.number}, due ${svhc.asked.dueOn})` : ''}.`
  if (!svhc.current && svhc.newestVersion) {
    return `SVHC: answered against the list of ${svhc.listVersion?.publishedOn ?? 'an unknown day'}; the Candidate List of ${svhc.newestVersion.publishedOn} is longer${svhc.grewBy !== null && svhc.grewBy > 0 ? ` by ${svhc.grewBy}` : ''}: ask again.`
  }
  return null
}

/** The whole evaluation of one material: every rule's verdict, what it needs, its SVHC answer and its state. */
export function evaluateMaterial(input: EvaluationInput): MaterialEvaluation {
  const verdicts = input.rules.map((rule) => judgeRule(rule, input)).sort((a, b) => RANK[a.status] - RANK[b.status] || a.key.localeCompare(b.key))
  const applicable = verdicts.filter((verdict) => verdict.status !== 'NOT_APPLICABLE')
  const tests = new Set<SubstanceTest>()
  const declarations = new Set<DeclarationKind>(['REACH_SVHC'])
  for (const verdict of applicable) {
    if (verdict.evidence === 'TEST' && verdict.needs.test) tests.add(verdict.needs.test)
    if (verdict.needs.declaration) declarations.add(verdict.needs.declaration)
  }
  const svhc = svhcAnswer(input)
  const failed = applicable.filter((verdict) => verdict.status === 'FAILED')
  const missing = applicable.filter((verdict) => verdict.status === 'MISSING')
  const gap = svhcGap(svhc)
  let state: ProfileState
  let stateReason: string | null
  if (failed.length > 0) {
    state = 'BLOCKED'
    stateReason = clip(failed.map((verdict) => `${verdict.legalReference}: ${verdict.words}`).join(' '))
  } else if (missing.length > 0 || gap) {
    state = 'INCOMPLETE'
    stateReason = clip([...missing.map((verdict) => `${verdict.legalReference}: ${verdict.words}`), ...(gap ? [gap] : [])].join(' '))
  } else {
    state = 'COMPLETE'
    stateReason = null
  }
  return {
    materialId: input.material.id,
    rules: verdicts,
    applicableRuleIds: applicable.map((verdict) => verdict.ruleId),
    testsNeeded: TEST_ORDER.filter((test) => tests.has(test)),
    declarationsNeeded: DECLARATION_ORDER.filter((kind) => declarations.has(kind)),
    svhc,
    state,
    stateReason,
  }
}

// ---- the style's SVHC roll-up per component (PRD-326) ----------------------------------------------------------------

export interface ComponentAnswer {
  readonly materialId: string
  readonly svhc: SvhcAnswer
}

export interface StyleRollUp {
  /** REACH art. 33: YES, a component holds an SVHC above 0.1 % w/w (inform every recipient, the consumer within 45 days on request); NO, every component answered none against the newest list; UNKNOWN otherwise. */
  readonly article33: 'YES' | 'NO' | 'UNKNOWN'
  /** The SVHCs above 0.1 % in any component, once each. */
  readonly substanceIds: readonly string[]
  readonly above: number
  readonly none: number
  readonly unknown: number
  /** Answered against an older Candidate List: to ask again. */
  readonly stale: number
}

/** The style's roll-up over its components (each a material of a BOM line or an alternate), once per material. */
export function styleRollUp(components: readonly ComponentAnswer[]): StyleRollUp {
  const once = [...new Map(components.map((component) => [component.materialId, component.svhc])).values()]
  const above = once.filter((answer) => answer.aboveThreshold === true)
  const none = once.filter((answer) => answer.aboveThreshold === false)
  const unknown = once.filter((answer) => answer.aboveThreshold === null)
  const stale = once.filter((answer) => answer.aboveThreshold !== null && !answer.current)
  return {
    article33: above.length > 0 ? 'YES' : once.length > 0 && unknown.length === 0 && stale.length === 0 ? 'NO' : 'UNKNOWN',
    substanceIds: [...new Set(above.flatMap((answer) => answer.substanceIds))].sort(),
    above: above.length,
    none: none.length,
    unknown: unknown.length,
    stale: stale.length,
  }
}
