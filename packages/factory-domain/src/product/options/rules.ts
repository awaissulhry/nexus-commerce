import type { Issue } from '../../core/errors'
import { Dec, type Decimal } from '../../tax/decimal'
import { decimalText } from '../units/units'

/**
 * Options and configuration rules (B-W2b-229; features PRD-081, PRD-206, PRD-207, PRD-208, PRD-211; design products.options,
 * SCR-114), pure. apps/factory-api's modules/product/options reads and writes through it; B-W2b-211's
 * …_bom_options_w2b_guards triggers stay the last word, and every one of their refusals is said here first, in words.
 *
 *   groups       an option group (perforation, a liner, name embroidery) is SINGLE (one value at most), MULTI or FREE_TEXT
 *                (every value takes a typed text); it takes minPicks to maxPicks values (null: no maximum); a style offers
 *                it with its own minimum and maximum (null: the group's), a place and a default value.
 *   values       a value of a group; with freeText the customer types a text of at most freeTextMaxLength characters that
 *                matches freeTextPattern when one is set (PRD-211). The pattern is read the way PostgreSQL's `~` reads it
 *                (found anywhere in the text: anchor it with ^ and $), so it must mean the same in both: no POSIX classes
 *                ([[:alpha:]]) and no \p{…}.
 *   rules        "the subject requires (or excludes) the other value", a BLOCK or a WARN with a message (PRD-207). The
 *                subject is one value of the rule's group or any value of it (`ANY_OPTION`). Shaped for the design system's
 *                RuleBuilder: the subject is one condition row (field `option`, operator `eq`, value: the value id or `*`),
 *                the requirement is the outcome (`ruleWords` is the preview).
 *   the check    `checkConfiguration` is THE check of a choice of options on a style: the values are offered and active,
 *                the picks per group within the style's minimum and maximum, free texts as their value wants, and every
 *                ACTIVE rule of the chosen values' groups. The configurator of W2b-5 calls it (through the API's
 *                checkStyleOptions); a BLOCK refuses the configuration, a WARN is read and accepted.
 *   effects      what a chosen value does (PRD-208, PRD-081): BOM lines added, replaced or left out, an operation added,
 *                minutes, the price (an amount or a percent; percents never compound: they add up, then apply once to the
 *                base price), "outside the certificate" (`summariseEffects`, `bomChanges`, `priceDeltaOf`). The cost delta
 *                of an option is W2b-6's (FIN-018).
 *
 * Words are { it, en }; the API's other sentences are English (as W1's).
 */

export type Words = Readonly<{ it: string; en: string }>
const w = (it: string, en: string): Words => Object.freeze({ it, en })

export const OPTION_GROUP_KINDS = ['SINGLE', 'MULTI', 'FREE_TEXT'] as const
export type OptionGroupKind = (typeof OPTION_GROUP_KINDS)[number]
export const OPTION_RULE_KINDS = ['REQUIRES', 'EXCLUDES'] as const
export type OptionRuleKind = (typeof OPTION_RULE_KINDS)[number]
export const OPTION_RULE_SEVERITIES = ['BLOCK', 'WARN'] as const
export type OptionRuleSeverity = (typeof OPTION_RULE_SEVERITIES)[number]
export const OPTION_EFFECT_KINDS = ['BOM_ADD', 'BOM_REPLACE', 'BOM_REMOVE', 'OPERATION_ADD', 'MINUTES', 'PRICE', 'CERTIFICATE'] as const
export type OptionEffectKind = (typeof OPTION_EFFECT_KINDS)[number]
/** The effects the effect routes write; PRICE is the value's price surcharge (its own route and permission). */
export const PART_EFFECT_KINDS = ['BOM_ADD', 'BOM_REPLACE', 'BOM_REMOVE', 'OPERATION_ADD', 'MINUTES', 'CERTIFICATE'] as const
export type PartEffectKind = (typeof PART_EFFECT_KINDS)[number]

/** The database's bounds (…_bom_options_w2b_guards) and the API's own. */
export const OPTION_LIMITS = Object.freeze({
  code: 60,
  name: 200,
  description: 2000,
  picks: 100,
  freeTextLength: 500,
  pattern: 200,
  note: 1000,
  message: 500,
  values: 200,
  rules: 100,
  effects: 30,
  sizes: 100,
  /** OptionEffect.minutes Decimal(10,3), qty Decimal(18,4), priceDelta Decimal(18,6), pricePct Decimal(7,4). */
  pctMin: -100,
  pctMax: 1000,
})

// ---- names --------------------------------------------------------------------------------------------------------------

export interface NameFacts {
  readonly name: string
  readonly nameI18n: Readonly<Record<string, string>> | null
}

/** The name in a language: its own words there, else the name. */
export const nameIn = (facts: NameFacts, language: 'it' | 'en'): string => facts.nameI18n?.[language]?.trim() || facts.name

// ---- groups and offers (PRD-206) ------------------------------------------------------------------------------------------

export interface Picks {
  readonly minPicks: number
  readonly maxPicks: number | null
}

/** A group's picks: minimum 0 to 100, maximum 1 to 100 and not below it (null: none); a SINGLE group at most 1 (and 0 or 1 at least). */
export function groupPicksProblems(kind: OptionGroupKind, picks: Picks): Issue[] {
  const issues: Issue[] = []
  const { minPicks, maxPicks } = picks
  if (!Number.isInteger(minPicks) || minPicks < 0 || minPicks > OPTION_LIMITS.picks) issues.push({ path: 'minPicks', message: `At least is 0 to ${OPTION_LIMITS.picks}.` })
  if (maxPicks !== null && (!Number.isInteger(maxPicks) || maxPicks < 1 || maxPicks > OPTION_LIMITS.picks)) issues.push({ path: 'maxPicks', message: `At most is 1 to ${OPTION_LIMITS.picks}, or none.` })
  else if (maxPicks !== null && maxPicks < minPicks) issues.push({ path: 'maxPicks', message: `At most (${maxPicks}) is not below at least (${minPicks}).` })
  if (kind === 'SINGLE') {
    if (maxPicks !== 1) issues.push({ path: 'maxPicks', message: 'A single-choice group takes 1 value at most: at most is 1.' })
    if (minPicks > 1) issues.push({ path: 'minPicks', message: 'A single-choice group takes 0 or 1 value at least.' })
  }
  return issues
}

/** The picks a group starts with when the person names none: a single choice 0 to 1, the others 0 to any. */
export const defaultPicks = (kind: OptionGroupKind): Picks => (kind === 'SINGLE' ? { minPicks: 0, maxPicks: 1 } : { minPicks: 0, maxPicks: null })

export interface OfferPicks {
  readonly minPicks: number | null
  readonly maxPicks: number | null
}

/** What a style asks of a group: its own minimum and maximum, else the group's. */
export const effectivePicks = (group: Picks, offer: OfferPicks): Picks => ({ minPicks: offer.minPicks ?? group.minPicks, maxPicks: offer.maxPicks ?? group.maxPicks })

/**
 * A style's own picks (null: the group's): minimum 0 to 100, maximum 1 to 100 and not below the minimum, at most 1 each for a
 * SINGLE group (the database's rules), and what the style asks in the end not contradicting itself (the API's).
 */
export function offerPicksProblems(kind: OptionGroupKind, group: Picks, offer: OfferPicks): Issue[] {
  const issues: Issue[] = []
  if (offer.minPicks !== null && (!Number.isInteger(offer.minPicks) || offer.minPicks < 0 || offer.minPicks > OPTION_LIMITS.picks)) issues.push({ path: 'minPicks', message: `At least is 0 to ${OPTION_LIMITS.picks}, or the group's.` })
  if (offer.maxPicks !== null && (!Number.isInteger(offer.maxPicks) || offer.maxPicks < 1 || offer.maxPicks > OPTION_LIMITS.picks)) issues.push({ path: 'maxPicks', message: `At most is 1 to ${OPTION_LIMITS.picks}, or the group's.` })
  if (kind === 'SINGLE' && ((offer.maxPicks ?? 1) > 1 || (offer.minPicks ?? 0) > 1)) issues.push({ path: offer.maxPicks !== null && offer.maxPicks > 1 ? 'maxPicks' : 'minPicks', message: 'A single-choice group takes 1 value at most.' })
  if (issues.length > 0) return issues
  const { minPicks, maxPicks } = effectivePicks(group, offer)
  if (maxPicks !== null && maxPicks < minPicks) issues.push({ path: offer.maxPicks !== null ? 'maxPicks' : 'minPicks', message: `The style would ask at least ${minPicks} and at most ${maxPicks} values of the group.` })
  return issues
}

/** "0 to 1", "1 to any" — what the grid's Min–max column and the configurator say. */
export const picksWords = (picks: Picks): Words => w(`${picks.minPicks}–${picks.maxPicks ?? 'qualsiasi'}`, `${picks.minPicks}–${picks.maxPicks ?? 'any'}`)

// ---- values and free texts (PRD-206, PRD-211) -----------------------------------------------------------------------------

export interface FreeTextRule {
  readonly freeText: boolean
  readonly freeTextMaxLength: number | null
  readonly freeTextPattern: string | null
}

/** Why a pattern cannot be a value's free-text rule (null: it can). PostgreSQL also reads it at the write. */
export function patternProblem(pattern: string): string | null {
  if (pattern.length < 1 || pattern.length > OPTION_LIMITS.pattern) return `A pattern is 1 to ${OPTION_LIMITS.pattern} characters.`
  if (/\[\[?:[a-z]+:\]/.test(pattern)) return 'Write the characters themselves ([A-Za-z]), not a class like [[:alpha:]]: the pattern must mean the same in every check.'
  if (/\\[pP]\{/.test(pattern)) return 'A pattern takes no \\p{…} class: write the characters themselves.'
  try {
    new RegExp(pattern, 'u')
  } catch {
    return 'This is not a regular expression (check the brackets and the backslashes).'
  }
  return null
}

/**
 * A value's free-text rule against its group: a FREE_TEXT group's values take a text; a value with freeText has a maximum
 * length of 1 to 500 and maybe a pattern; one without has neither.
 */
export function freeTextRuleProblems(rule: FreeTextRule, groupKind: OptionGroupKind): Issue[] {
  const issues: Issue[] = []
  if (groupKind === 'FREE_TEXT' && !rule.freeText) issues.push({ path: 'freeText', message: 'Every value of a free-text group takes a typed text.' })
  if (rule.freeText) {
    if (rule.freeTextMaxLength === null || !Number.isInteger(rule.freeTextMaxLength) || rule.freeTextMaxLength < 1 || rule.freeTextMaxLength > OPTION_LIMITS.freeTextLength) {
      issues.push({ path: 'freeTextMaxLength', message: `A typed text is 1 to ${OPTION_LIMITS.freeTextLength} characters at most: say how many.` })
    }
    if (rule.freeTextPattern !== null) {
      const problem = patternProblem(rule.freeTextPattern)
      if (problem) issues.push({ path: 'freeTextPattern', message: problem })
    }
  } else {
    if (rule.freeTextMaxLength !== null) issues.push({ path: 'freeTextMaxLength', message: 'A length only for a value that takes a typed text.' })
    if (rule.freeTextPattern !== null) issues.push({ path: 'freeTextPattern', message: 'A pattern only for a value that takes a typed text.' })
  }
  return issues
}

/** A group's kind changed: FREE_TEXT only when every value takes a text; SINGLE only when no style asks more than one. */
export function kindChangeProblem(to: OptionGroupKind, facts: { readonly valuesWithoutText: number; readonly offersAskingMore: readonly string[] }): string | null {
  if (to === 'FREE_TEXT' && facts.valuesWithoutText > 0) return `${facts.valuesWithoutText} value(s) of the group take no typed text: give each a text rule first, or keep the kind.`
  if (to === 'SINGLE' && facts.offersAskingMore.length > 0) return `Style(s) ${facts.offersAskingMore.join(', ')} ask more than one value of the group: change their picks first.`
  return null
}

const CONTROL = /[\u0000-\u001f\u007f]/u

/** What is wrong with a typed text for a value (null: nothing). Lengths count characters, as PostgreSQL does. */
export function freeTextProblem(rule: FreeTextRule & { readonly code: string }, text: string | null | undefined): Words | null {
  const typed = text ?? ''
  if (!rule.freeText) return typed === '' ? null : w(`L'opzione ${rule.code} non prende un testo.`, `Option ${rule.code} takes no typed text.`)
  if (typed.trim() === '') return w(`L'opzione ${rule.code} vuole un testo.`, `Option ${rule.code} needs a typed text.`)
  if (CONTROL.test(typed)) return w(`Il testo di ${rule.code} ha caratteri non stampabili.`, `The text of ${rule.code} has characters that do not print.`)
  const length = [...typed].length
  if (rule.freeTextMaxLength !== null && length > rule.freeTextMaxLength) {
    return w(`Il testo di ${rule.code} è di ${length} caratteri: al massimo ${rule.freeTextMaxLength}.`, `The text of ${rule.code} is ${length} characters: ${rule.freeTextMaxLength} at most.`)
  }
  if (rule.freeTextPattern !== null) {
    let matches = false
    try {
      matches = new RegExp(rule.freeTextPattern, 'u').test(typed)
    } catch {
      matches = false
    }
    if (!matches) return w(`Il testo di ${rule.code} non è nella forma voluta (${rule.freeTextPattern}).`, `The text of ${rule.code} is not in the form it wants (${rule.freeTextPattern}).`)
  }
  return null
}

// ---- rules (PRD-207) ------------------------------------------------------------------------------------------------------

/** The RuleBuilder row a rule's subject is: field `option`, operator `eq`, the value id or ANY_OPTION. */
export const RULE_SUBJECT_FIELD = 'option'
export const ANY_OPTION = '*'

export interface RuleDraftRow {
  readonly id: string
  readonly field: string | null
  readonly operator: string | null
  readonly value: string | readonly string[] | null
}

/** The design system's RuleDraft (packages/ui patterns/RuleBuilder ruleBuilderModel), as the API reads and answers it. */
export interface RuleDraft {
  readonly combinator: 'and' | 'or'
  readonly rows: readonly RuleDraftRow[]
}

/** The rule's subject as the RuleBuilder draws it. */
export const ruleDraftOf = (valueId: string | null): RuleDraft => ({ combinator: 'and', rows: [{ id: 'subject', field: RULE_SUBJECT_FIELD, operator: 'eq', value: valueId ?? ANY_OPTION }] })

/** The subject a RuleBuilder draft names: one row "the option is <value>" (or any option of the group); else the problem. */
export function subjectOfDraft(draft: RuleDraft): { readonly ok: true; readonly valueId: string | null } | { readonly ok: false; readonly issue: Issue } {
  if (draft.rows.length !== 1) return { ok: false, issue: { path: 'when/rows', message: 'A rule is about one option of the group, or any option of it: one condition.' } }
  const [row] = draft.rows
  if (row!.field !== RULE_SUBJECT_FIELD) return { ok: false, issue: { path: 'when/rows/0/field', message: `The condition is about the option chosen ("${RULE_SUBJECT_FIELD}").` } }
  if (row!.operator !== 'eq') return { ok: false, issue: { path: 'when/rows/0/operator', message: 'The condition reads "the option is …": one option (several options are several rules).' } }
  if (typeof row!.value !== 'string' || row!.value === '') return { ok: false, issue: { path: 'when/rows/0/value', message: 'Pick the option the rule is about, or any option of the group.' } }
  return { ok: true, valueId: row!.value === ANY_OPTION ? null : row!.value }
}

export interface RuleFacts {
  readonly id: string
  readonly groupId: string
  readonly valueId: string | null
  readonly kind: OptionRuleKind
  readonly otherValueId: string
  readonly severity: OptionRuleSeverity
  readonly messageI18n: Readonly<Record<string, string>> | null
}

/** A value as a rule's words name it. */
export interface ValueNameFacts extends NameFacts {
  readonly id: string
  readonly code: string
  readonly groupId: string
  readonly group: NameFacts & { readonly code: string }
}

const subjectIn = (rule: Pick<RuleFacts, 'valueId' | 'groupId'>, nameOf: (valueId: string) => ValueNameFacts | undefined, groupOf: (groupId: string) => (NameFacts & { readonly code: string }) | undefined, language: 'it' | 'en'): string => {
  if (rule.valueId !== null) {
    const value = nameOf(rule.valueId)
    return value ? nameIn(value, language) : '?'
  }
  const group = groupOf(rule.groupId)
  const name = group ? nameIn(group, language) : '?'
  return language === 'it' ? `Qualsiasi opzione di ${name}` : `Any option of ${name}`
}

/** The rule in words, its RuleBuilder preview: "Full perforation excludes Thermal liner — block". */
export function ruleWords(rule: Pick<RuleFacts, 'valueId' | 'groupId' | 'kind' | 'otherValueId' | 'severity'>, nameOf: (valueId: string) => ValueNameFacts | undefined, groupOf: (groupId: string) => (NameFacts & { readonly code: string }) | undefined): Words {
  const other = nameOf(rule.otherValueId)
  const verb = { REQUIRES: ['richiede', 'requires'], EXCLUDES: ['esclude', 'excludes'] }[rule.kind]
  const outcome = { BLOCK: ['blocca', 'block'], WARN: ['avviso', 'warning'] }[rule.severity]
  return w(
    `${subjectIn(rule, nameOf, groupOf, 'it')} ${verb[0]} ${other ? nameIn(other, 'it') : '?'} — ${outcome[0]}`,
    `${subjectIn(rule, nameOf, groupOf, 'en')} ${verb[1]} ${other ? nameIn(other, 'en') : '?'} — ${outcome[1]}`,
  )
}

/** What the person reads when the rule is broken: its message (each language, else the other), else the API's words. */
export function brokenWords(rule: RuleFacts, nameOf: (valueId: string) => ValueNameFacts | undefined, groupOf: (groupId: string) => (NameFacts & { readonly code: string }) | undefined): Words {
  const own = rule.messageI18n
  const it = own?.['it']?.trim() || own?.['en']?.trim()
  const en = own?.['en']?.trim() || own?.['it']?.trim()
  if (it && en) return w(it, en)
  const other = nameOf(rule.otherValueId)
  const subject = (language: 'it' | 'en') => subjectIn(rule, nameOf, groupOf, language)
  const otherName = (language: 'it' | 'en') => (other ? nameIn(other, language) : '?')
  return rule.kind === 'REQUIRES'
    ? w(`${subject('it')} vuole anche ${otherName('it')}: sceglila.`, `${subject('en')} needs ${otherName('en')} too: choose it.`)
    : w(`${subject('it')} e ${otherName('it')} non vanno insieme.`, `${subject('en')} and ${otherName('en')} are never chosen together.`)
}

/** What a rule's checks need about a value it names. */
export interface RuleValueFacts {
  readonly id: string
  readonly code: string
  readonly groupId: string
  readonly status: 'ACTIVE' | 'ARCHIVED'
  /** The company of the value's group (null: tenant-wide). */
  readonly companyId: string | null
}

export interface PlannedRule {
  readonly id: string | null
  readonly valueId: string | null
  readonly kind: OptionRuleKind
  readonly otherValueId: string
  readonly severity: OptionRuleSeverity
}

/**
 * A group's rules as a set (the Rules tab's EditModeBar saves them at once): each subject a value of the group (or any), the
 * other value another value, ACTIVE when newly named, of the group's company or tenant-wide (a tenant-wide group's:
 * tenant-wide), a rule about the whole group naming a value of another group; no rule twice, no subject both requiring and
 * excluding the same value. `before` = the ids of the rules saved now, with their subject and other value (a value they
 * already name may be archived since: it stays).
 */
export function rulesProblems(
  group: { readonly id: string; readonly companyId: string | null },
  rules: readonly PlannedRule[],
  valueOf: (valueId: string) => RuleValueFacts | undefined,
  before: ReadonlyMap<string, { readonly valueId: string | null; readonly otherValueId: string }>,
): Issue[] {
  const issues: Issue[] = []
  const seen = new Map<string, number>()
  const ids = new Set<string>()
  rules.forEach((rule, index) => {
    const at = (field: string) => `rules/${index}/${field}`
    const was = rule.id === null ? undefined : before.get(rule.id)
    if (rule.id !== null) {
      if (ids.has(rule.id)) issues.push({ path: at('id'), message: 'This rule is named twice.' })
      else if (!was) issues.push({ path: at('id'), message: 'Not a rule of this group (leave the id out for a new rule).' })
      ids.add(rule.id)
    }
    if (rule.valueId !== null) {
      const subject = valueOf(rule.valueId)
      if (!subject || subject.groupId !== group.id) issues.push({ path: at('when/rows/0/value'), message: 'Not an option of this group.' })
      else if (subject.status === 'ARCHIVED' && was?.valueId !== rule.valueId) issues.push({ path: at('when/rows/0/value'), message: `Option ${subject.code} is archived.` })
    }
    const other = valueOf(rule.otherValueId)
    if (!other) issues.push({ path: at('otherValueId'), message: 'No such option.' })
    else {
      if (rule.valueId === rule.otherValueId) issues.push({ path: at('otherValueId'), message: 'A rule is about one option and another, not the same.' })
      else if (rule.valueId === null && other.groupId === group.id) issues.push({ path: at('otherValueId'), message: 'A rule about any option of the group names an option of another group.' })
      if (was?.otherValueId !== rule.otherValueId) {
        if (other.status === 'ARCHIVED') issues.push({ path: at('otherValueId'), message: `Option ${other.code} is archived.` })
        else if (other.companyId !== null && other.companyId !== group.companyId) issues.push({ path: at('otherValueId'), message: `Option ${other.code} belongs to another company (an option of the group's company or of every company).` })
      }
    }
    const key = `${rule.valueId ?? ANY_OPTION}|${rule.kind}|${rule.otherValueId}`
    if (seen.has(key)) issues.push({ path: at('otherValueId'), message: `The same rule as rule ${seen.get(key)! + 1}.` })
    else seen.set(key, index)
    const opposite = `${rule.valueId ?? ANY_OPTION}|${rule.kind === 'REQUIRES' ? 'EXCLUDES' : 'REQUIRES'}|${rule.otherValueId}`
    if (seen.has(opposite) && seen.get(opposite) !== index) issues.push({ path: at('kind'), message: `Rule ${seen.get(opposite)! + 1} says the opposite about the same options.` })
  })
  if (rules.length > OPTION_LIMITS.rules) issues.push({ path: 'rules', message: `At most ${OPTION_LIMITS.rules} rules per group.` })
  return issues
}

// ---- THE check of a configuration (PRD-206, PRD-207, PRD-211) -------------------------------------------------------------

export interface CheckValue extends FreeTextRule, NameFacts {
  readonly id: string
  readonly code: string
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

/** A group a style offers (ACTIVE), as the check reads it: what the style asks of it and its values. */
export interface CheckOffer extends NameFacts {
  readonly groupId: string
  readonly code: string
  readonly kind: OptionGroupKind
  readonly picks: Picks
  readonly defaultValueId: string | null
  readonly values: readonly CheckValue[]
}

export interface ChosenPick {
  readonly valueId: string
  /** The typed text of a free-text value. */
  readonly text?: string | null | undefined
}

export const CHECK_CODES = ['NOT_OFFERED', 'ARCHIVED', 'TWICE', 'TOO_FEW', 'TOO_MANY', 'TEXT', 'REQUIRES', 'EXCLUDES'] as const
export type CheckCode = (typeof CHECK_CODES)[number]

export interface CheckFinding {
  readonly code: CheckCode
  readonly severity: OptionRuleSeverity
  /** picks/<i> (a pick), groups/<groupId> (a group's count), rules/<ruleId> (a rule). */
  readonly path: string
  readonly groupId: string | null
  readonly valueId: string | null
  readonly ruleId: string | null
  readonly message: Words
}

export interface ChosenValue {
  readonly valueId: string
  readonly groupId: string
  readonly text: string | null
  /** Taken from the style's default (nothing of the group was chosen). */
  readonly byDefault: boolean
}

export interface ConfigurationCheck {
  /** No BLOCK: the configuration may be taken (its warnings read). */
  readonly ok: boolean
  readonly blocks: readonly CheckFinding[]
  readonly warnings: readonly CheckFinding[]
  readonly chosen: readonly ChosenValue[]
}

export interface CheckInput {
  readonly offers: readonly CheckOffer[]
  /** The ACTIVE rules of the offered groups (a rule lives on its subject's group). */
  readonly rules: readonly RuleFacts[]
  readonly picks: readonly ChosenPick[]
  /** A group nothing was chosen of takes the style's default value (default true). */
  readonly useDefaults?: boolean
  /** Names of values a rule names outside the offered groups (for the words). */
  readonly otherValues?: readonly ValueNameFacts[]
}

/** THE check of a choice of options on a style (B-W2b-229 for W2b-5's configurator): every finding in words. */
export function checkConfiguration(input: CheckInput): ConfigurationCheck {
  const findings: CheckFinding[] = []
  const valueById = new Map<string, { offer: CheckOffer; value: CheckValue }>()
  for (const offer of input.offers) for (const value of offer.values) valueById.set(value.id, { offer, value })
  const names = new Map<string, ValueNameFacts>()
  for (const offer of input.offers) for (const value of offer.values) names.set(value.id, { id: value.id, code: value.code, name: value.name, nameI18n: value.nameI18n, groupId: offer.groupId, group: { code: offer.code, name: offer.name, nameI18n: offer.nameI18n } })
  for (const value of input.otherValues ?? []) if (!names.has(value.id)) names.set(value.id, value)
  const groups = new Map(input.offers.map((offer) => [offer.groupId, { code: offer.code, name: offer.name, nameI18n: offer.nameI18n }]))
  const nameOf = (valueId: string) => names.get(valueId)
  const groupOf = (groupId: string) => groups.get(groupId) ?? [...names.values()].find((value) => value.groupId === groupId)?.group

  const chosen: ChosenValue[] = []
  const block = (finding: Omit<CheckFinding, 'severity'>) => findings.push({ ...finding, severity: 'BLOCK' })
  input.picks.forEach((pick, index) => {
    const path = `picks/${index}`
    const found = valueById.get(pick.valueId)
    if (!found) {
      block({ code: 'NOT_OFFERED', path, groupId: null, valueId: pick.valueId, ruleId: null, message: w("Quest'opzione non è offerta su questo articolo.", 'This option is not offered on this style.') })
      return
    }
    const { offer, value } = found
    if (value.status !== 'ACTIVE') {
      block({ code: 'ARCHIVED', path, groupId: offer.groupId, valueId: value.id, ruleId: null, message: w(`L'opzione ${value.code} è archiviata.`, `Option ${value.code} is archived.`) })
      return
    }
    if (chosen.some((entry) => entry.valueId === value.id)) {
      block({ code: 'TWICE', path, groupId: offer.groupId, valueId: value.id, ruleId: null, message: w(`L'opzione ${value.code} è scelta due volte.`, `Option ${value.code} is chosen twice.`) })
      return
    }
    const text = freeTextProblem(value, pick.text)
    if (text) block({ code: 'TEXT', path, groupId: offer.groupId, valueId: value.id, ruleId: null, message: text })
    chosen.push({ valueId: value.id, groupId: offer.groupId, text: value.freeText ? (pick.text ?? null) : null, byDefault: false })
  })

  if (input.useDefaults ?? true) {
    for (const offer of input.offers) {
      if (offer.defaultValueId === null || chosen.some((entry) => entry.groupId === offer.groupId)) continue
      const value = offer.values.find((entry) => entry.id === offer.defaultValueId)
      // A default that is archived, or that wants a typed text, is not taken by itself.
      if (!value || value.status !== 'ACTIVE' || value.freeText) continue
      chosen.push({ valueId: value.id, groupId: offer.groupId, text: null, byDefault: true })
    }
  }

  for (const offer of input.offers) {
    const count = chosen.filter((entry) => entry.groupId === offer.groupId).length
    const path = `groups/${offer.groupId}`
    const it = nameIn(offer, 'it')
    const en = nameIn(offer, 'en')
    if (count < offer.picks.minPicks) {
      block({ code: 'TOO_FEW', path, groupId: offer.groupId, valueId: null, ruleId: null, message: w(`${it}: scegli almeno ${offer.picks.minPicks} opzioni (ne hai ${count}).`, `${en}: choose at least ${offer.picks.minPicks} option(s) (${count} chosen).`) })
    }
    if (offer.picks.maxPicks !== null && count > offer.picks.maxPicks) {
      block({ code: 'TOO_MANY', path, groupId: offer.groupId, valueId: null, ruleId: null, message: w(`${it}: al massimo ${offer.picks.maxPicks} opzioni (ne hai ${count}).`, `${en}: ${offer.picks.maxPicks} option(s) at most (${count} chosen).`) })
    }
  }

  const chosenValues = new Set(chosen.map((entry) => entry.valueId))
  const chosenGroups = new Set(chosen.map((entry) => entry.groupId))
  for (const rule of input.rules) {
    const applies = rule.valueId === null ? chosenGroups.has(rule.groupId) : chosenValues.has(rule.valueId)
    if (!applies) continue
    const broken = rule.kind === 'REQUIRES' ? !chosenValues.has(rule.otherValueId) : chosenValues.has(rule.otherValueId)
    if (!broken) continue
    findings.push({ code: rule.kind, severity: rule.severity, path: `rules/${rule.id}`, groupId: rule.groupId, valueId: rule.valueId, ruleId: rule.id, message: brokenWords(rule, nameOf, groupOf) })
  }

  const blocks = findings.filter((finding) => finding.severity === 'BLOCK')
  return { ok: blocks.length === 0, blocks, warnings: findings.filter((finding) => finding.severity === 'WARN'), chosen }
}

// ---- effects (PRD-208, PRD-081) -------------------------------------------------------------------------------------------

/** An effect as the summary reads it (decimals as plain strings). */
export interface EffectFacts {
  readonly id: string
  readonly valueId: string
  readonly kind: OptionEffectKind
  readonly itemId: string | null
  readonly itemColourId: string | null
  readonly targetItemId: string | null
  readonly qty: string | null
  readonly uom: string | null
  readonly sizeQuantities: Readonly<Record<string, string>> | null
  readonly section: string | null
  readonly operationId: string | null
  readonly minutes: string | null
  readonly priceDelta: string | null
  readonly currency: string | null
  readonly pricePct: string | null
  readonly note: string | null
}

export type EffectInput = Omit<EffectFacts, 'id' | 'valueId'>

const isPositiveDecimal = (value: string | null): boolean => value !== null && /^\d+(\.\d+)?$/.test(value) && new Dec(value).gt(0)
const isDecimal = (value: string | null): boolean => value !== null && /^-?\d+(\.\d+)?$/.test(value)
const fits = (value: string, integers: number, decimals: number): boolean => {
  const [whole = '', fraction = ''] = value.replace(/^-/, '').split('.')
  return whole.replace(/^0+(?=\d)/, '').length <= integers && fraction.length <= decimals
}

/**
 * Each kind fills exactly its columns (the database's OptionEffect_check, said in words): BOM_ADD a material (+ colour), a
 * unit, a quantity above 0 and/or quantities per size, a section; BOM_REPLACE the material put in (+ colour) for another
 * target material, a quantity with its unit or neither; BOM_REMOVE the target; OPERATION_ADD an operation, minutes above 0
 * or none; MINUTES minutes not 0, at an operation or the garment; PRICE an amount not 0 in its currency XOR a percent from
 * -100 to 1000, not 0; CERTIFICATE the note (what the certificate no longer covers). A colour only with a material; the
 * note 1 to 1000 characters. `sizes`: the codes a BOM_ADD's quantities per size may name (the style's range; null: not
 * checked, the library's effect serves every style).
 */
export function effectProblems(effect: EffectInput & { readonly kind: OptionEffectKind }, sizes: readonly string[] | null = null): Issue[] {
  const issues: Issue[] = []
  const k = effect.kind
  const not = (field: keyof EffectInput, why: string) => issues.push({ path: field, message: why })
  const only = (fields: readonly (keyof EffectInput)[]) => {
    const all: (keyof EffectInput)[] = ['itemId', 'itemColourId', 'targetItemId', 'qty', 'uom', 'sizeQuantities', 'section', 'operationId', 'minutes', 'priceDelta', 'currency', 'pricePct']
    for (const field of all) if (!fields.includes(field) && effect[field] !== null) not(field, `An effect of kind ${k} takes no ${field}.`)
  }
  if (effect.itemColourId !== null && effect.itemId === null) not('itemColourId', 'A colour only with a material.')
  if (effect.note !== null && (effect.note.trim() === '' || effect.note.length > OPTION_LIMITS.note)) not('note', `A note is 1 to ${OPTION_LIMITS.note} characters.`)
  switch (k) {
    case 'BOM_ADD': {
      only(['itemId', 'itemColourId', 'qty', 'uom', 'sizeQuantities', 'section'])
      if (effect.itemId === null) not('itemId', 'Name the material the option adds.')
      if (effect.uom === null) not('uom', 'Name the unit of the quantity.')
      if (effect.qty === null && effect.sizeQuantities === null) not('qty', 'Give the quantity per garment, or per size.')
      if (effect.qty !== null && (!isPositiveDecimal(effect.qty) || !fits(effect.qty, 14, 4))) not('qty', 'A quantity above 0, with at most 4 decimals.')
      if (effect.sizeQuantities !== null) {
        const entries = Object.entries(effect.sizeQuantities)
        if (entries.length < 1 || entries.length > OPTION_LIMITS.sizes) not('sizeQuantities', `Quantities for 1 to ${OPTION_LIMITS.sizes} sizes.`)
        for (const [size, qty] of entries) {
          if (!/^\S{1,40}$/.test(size)) issues.push({ path: `sizeQuantities/${size}`, message: 'A size code has no spaces (1 to 40 characters).' })
          else if (sizes !== null && !sizes.includes(size)) issues.push({ path: `sizeQuantities/${size}`, message: `Size ${size} is not in the style's range (${sizes.join(', ')}).` })
          if (!isPositiveDecimal(qty) || !fits(qty, 14, 4)) issues.push({ path: `sizeQuantities/${size}`, message: 'A quantity above 0, with at most 4 decimals.' })
        }
      }
      break
    }
    case 'BOM_REPLACE':
      only(['itemId', 'itemColourId', 'targetItemId', 'qty', 'uom'])
      if (effect.itemId === null) not('itemId', 'Name the material the option puts in.')
      if (effect.targetItemId === null) not('targetItemId', 'Name the material of the style it replaces.')
      if (effect.itemId !== null && effect.itemId === effect.targetItemId) not('itemId', 'It puts in another material than the one it replaces.')
      if ((effect.qty === null) !== (effect.uom === null)) not(effect.qty === null ? 'qty' : 'uom', "A new quantity with its unit, or neither (the replaced line's).")
      if (effect.qty !== null && (!isPositiveDecimal(effect.qty) || !fits(effect.qty, 14, 4))) not('qty', 'A quantity above 0, with at most 4 decimals.')
      break
    case 'BOM_REMOVE':
      only(['targetItemId'])
      if (effect.targetItemId === null) not('targetItemId', 'Name the material of the style it leaves out.')
      break
    case 'OPERATION_ADD':
      only(['operationId', 'minutes'])
      if (effect.operationId === null) not('operationId', 'Name the operation the option adds.')
      if (effect.minutes !== null && (!isPositiveDecimal(effect.minutes) || !fits(effect.minutes, 7, 3))) not('minutes', "Minutes above 0, with at most 3 decimals (or none: the operation's standard minutes).")
      break
    case 'MINUTES':
      only(['operationId', 'minutes'])
      if (effect.minutes === null || !isDecimal(effect.minutes) || new Dec(effect.minutes).isZero() || !fits(effect.minutes, 7, 3)) not('minutes', 'Minutes added (above 0) or taken away (below 0), not 0, with at most 3 decimals.')
      break
    case 'PRICE':
      only(['priceDelta', 'currency', 'pricePct'])
      if ((effect.priceDelta === null) === (effect.pricePct === null)) not('priceDelta', 'An amount in a currency, or a percent of the price: exactly one.')
      if (effect.priceDelta !== null) {
        if (!isDecimal(effect.priceDelta) || new Dec(effect.priceDelta).isZero() || !fits(effect.priceDelta, 12, 6)) not('priceDelta', 'An amount added (above 0) or taken away (below 0), not 0, with at most 6 decimals.')
        if (effect.currency === null || !/^[A-Z]{3}$/.test(effect.currency)) not('currency', 'The currency of the amount (ISO 4217: EUR).')
      } else if (effect.currency !== null) not('currency', 'A currency only with an amount.')
      if (effect.pricePct !== null && (!isDecimal(effect.pricePct) || new Dec(effect.pricePct).isZero() || new Dec(effect.pricePct).lt(OPTION_LIMITS.pctMin) || new Dec(effect.pricePct).gt(OPTION_LIMITS.pctMax) || !fits(effect.pricePct, 3, 4))) {
        not('pricePct', `A percent from ${OPTION_LIMITS.pctMin} to ${OPTION_LIMITS.pctMax}, not 0, with at most 4 decimals.`)
      }
      break
    case 'CERTIFICATE':
      only([])
      if (effect.note === null) not('note', 'Say what the certificate no longer covers.')
      break
  }
  return issues
}

/** An effect in words for the grid and the check. A price effect never says its amount here (that is money: its own field). */
export function effectWords(effect: Pick<EffectFacts, 'kind' | 'qty' | 'uom' | 'sizeQuantities' | 'section' | 'minutes' | 'note'>, codes: { readonly item?: string | null; readonly target?: string | null; readonly operation?: string | null }): Words {
  const qty = effect.qty !== null ? `${decimalText(effect.qty)} ${effect.uom ?? ''}`.trim() : effect.sizeQuantities !== null ? (effect.uom ?? '') : ''
  const perSize = effect.sizeQuantities !== null ? Object.keys(effect.sizeQuantities).length : 0
  switch (effect.kind) {
    case 'BOM_ADD':
      return w(
        `Aggiunge ${codes.item ?? '?'}${qty ? ` ${qty}` : ''}${perSize ? ` (per ${perSize} taglie)` : ''}${effect.section ? ` · ${effect.section}` : ''}`,
        `Adds ${codes.item ?? '?'}${qty ? ` ${qty}` : ''}${perSize ? ` (for ${perSize} sizes)` : ''}${effect.section ? ` · ${effect.section}` : ''}`,
      )
    case 'BOM_REPLACE':
      return w(`Mette ${codes.item ?? '?'} al posto di ${codes.target ?? '?'}${qty ? ` (${qty})` : ''}`, `Puts ${codes.item ?? '?'} in place of ${codes.target ?? '?'}${qty ? ` (${qty})` : ''}`)
    case 'BOM_REMOVE':
      return w(`Toglie ${codes.target ?? '?'}`, `Leaves out ${codes.target ?? '?'}`)
    case 'OPERATION_ADD':
      return w(
        `Aggiunge l'operazione ${codes.operation ?? '?'}${effect.minutes ? ` (${decimalText(effect.minutes)} min)` : ' (minuti standard)'}`,
        `Adds operation ${codes.operation ?? '?'}${effect.minutes ? ` (${decimalText(effect.minutes)} min)` : ' (standard minutes)'}`,
      )
    case 'MINUTES': {
      const minutes = effect.minutes === null ? '?' : new Dec(effect.minutes).gt(0) ? `+${decimalText(effect.minutes)}` : decimalText(effect.minutes)
      return w(`${minutes} min${codes.operation ? ` a ${codes.operation}` : ' sul capo'}`, `${minutes} min${codes.operation ? ` at ${codes.operation}` : ' on the garment'}`)
    }
    case 'PRICE':
      return w('Cambia il prezzo', 'Moves the price')
    case 'CERTIFICATE':
      return w(`Fuori certificato: ${effect.note ?? ''}`.trim(), `Outside the certificate: ${effect.note ?? ''}`.trim())
  }
}

export interface EffectsSummary {
  readonly added: readonly EffectFacts[]
  readonly replaced: readonly EffectFacts[]
  readonly removed: readonly EffectFacts[]
  readonly operations: readonly EffectFacts[]
  readonly minutes: readonly EffectFacts[]
  /** MINUTES and OPERATION_ADD with minutes, added up (an operation added with its standard minutes is not counted here). */
  readonly minutesAdded: string
  /** Operations added at their standard minutes (the caller adds the operation's SMV). */
  readonly operationsAtStandard: number
  /** The amounts per currency, added up, and the percents, added up (never compounded). */
  readonly price: { readonly byCurrency: readonly { readonly currency: string; readonly delta: string }[]; readonly percent: string | null } | null
  /** A chosen value takes the garment outside its certificate: the quote warns before it is sold. */
  readonly outsideCertificate: boolean
  readonly certificateNotes: readonly { readonly valueId: string; readonly note: string }[]
  /** Two chosen values change the same material (replace or leave out): which wins is unclear. */
  readonly clashes: readonly { readonly targetItemId: string; readonly effectIds: readonly string[] }[]
}

/** What the chosen values do, added up (the library's effects; a style's own option lines are its BOM's, `bomChanges`). */
export function summariseEffects(chosen: ReadonlySet<string>, effects: readonly EffectFacts[]): EffectsSummary {
  const mine = effects.filter((effect) => chosen.has(effect.valueId))
  const of = (kind: OptionEffectKind) => mine.filter((effect) => effect.kind === kind)
  let minutes: Decimal = new Dec(0)
  let atStandard = 0
  for (const effect of mine) {
    if (effect.kind === 'MINUTES' && effect.minutes !== null) minutes = minutes.plus(effect.minutes)
    if (effect.kind === 'OPERATION_ADD') {
      if (effect.minutes !== null) minutes = minutes.plus(effect.minutes)
      else atStandard++
    }
  }
  const byCurrency = new Map<string, Decimal>()
  let percent: Decimal | null = null
  for (const effect of of('PRICE')) {
    if (effect.priceDelta !== null && effect.currency !== null) byCurrency.set(effect.currency, (byCurrency.get(effect.currency) ?? new Dec(0)).plus(effect.priceDelta))
    if (effect.pricePct !== null) percent = (percent ?? new Dec(0)).plus(effect.pricePct)
  }
  const targets = new Map<string, string[]>()
  for (const effect of mine) if ((effect.kind === 'BOM_REPLACE' || effect.kind === 'BOM_REMOVE') && effect.targetItemId !== null) targets.set(effect.targetItemId, [...(targets.get(effect.targetItemId) ?? []), effect.id])
  const priced = byCurrency.size > 0 || percent !== null
  return {
    added: of('BOM_ADD'),
    replaced: of('BOM_REPLACE'),
    removed: of('BOM_REMOVE'),
    operations: of('OPERATION_ADD'),
    minutes: of('MINUTES'),
    minutesAdded: decimalText(minutes),
    operationsAtStandard: atStandard,
    price: priced
      ? { byCurrency: [...byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, delta]) => ({ currency, delta: decimalText(delta) })), percent: percent === null ? null : decimalText(percent) }
      : null,
    outsideCertificate: of('CERTIFICATE').length > 0,
    certificateNotes: of('CERTIFICATE').map((effect) => ({ valueId: effect.valueId, note: effect.note ?? '' })),
    clashes: [...targets.entries()].filter(([, ids]) => ids.length > 1).map(([targetItemId, effectIds]) => ({ targetItemId, effectIds })),
  }
}

/**
 * What the options add to a base price in one currency: the amounts of that currency plus the sum of the percents applied
 * once to the base (percents never compound). An amount in another currency cannot be added: said, never converted.
 */
export function priceDeltaOf(base: string, currency: string, price: EffectsSummary['price']): { readonly ok: true; readonly delta: string } | { readonly ok: false; readonly message: Words } {
  if (price === null) return { ok: true, delta: '0' }
  const other = price.byCurrency.find((entry) => entry.currency !== currency)
  if (other) return { ok: false, message: w(`Un supplemento è in ${other.currency}, il prezzo in ${currency}: non si converte da solo.`, `A surcharge is in ${other.currency}, the price in ${currency}: it is not converted by itself.`) }
  const amounts = price.byCurrency.reduce((sum, entry) => sum.plus(entry.delta), new Dec(0))
  const fromPercent = price.percent === null ? new Dec(0) : new Dec(base).times(price.percent).dividedBy(100)
  return { ok: true, delta: decimalText(amounts.plus(fromPercent)) }
}

/** A line of a revision as the BOM changes read it. */
export interface ChangeLine {
  readonly id: string
  readonly seq: number
  readonly itemId: string
  readonly optionValueId: string | null
}

export interface BomChanges {
  /** The revision's lines only for an option: taken (chosen) or left out. */
  readonly optionLinesTaken: readonly string[]
  readonly optionLinesLeftOut: readonly string[]
  /** Lines of the target material left out (BOM_REMOVE) or given another material (BOM_REPLACE). */
  readonly removed: readonly { readonly lineId: string; readonly seq: number; readonly effectId: string }[]
  readonly replaced: readonly { readonly lineId: string; readonly seq: number; readonly effectId: string; readonly itemId: string }[]
  readonly added: readonly EffectFacts[]
  /** A replace or remove whose target material is on no line the garment takes. */
  readonly targetsMissing: readonly { readonly effectId: string; readonly targetItemId: string }[]
  /** A material both a chosen option line and a chosen BOM_ADD of the same value put in (defined twice). */
  readonly definedTwice: readonly { readonly effectId: string; readonly lineId: string; readonly itemId: string }[]
}

/** What the chosen values do to one revision's lines (PRD-081 option lines and PRD-208's BOM effects together). */
export function bomChanges(lines: readonly ChangeLine[], chosen: ReadonlySet<string>, effects: readonly EffectFacts[]): BomChanges {
  const sorted = [...lines].sort((a, b) => a.seq - b.seq)
  const taken = sorted.filter((line) => line.optionValueId === null || chosen.has(line.optionValueId))
  const mine = effects.filter((effect) => chosen.has(effect.valueId))
  const removed: { lineId: string; seq: number; effectId: string }[] = []
  const replaced: { lineId: string; seq: number; effectId: string; itemId: string }[] = []
  const targetsMissing: { effectId: string; targetItemId: string }[] = []
  for (const effect of mine) {
    if ((effect.kind !== 'BOM_REMOVE' && effect.kind !== 'BOM_REPLACE') || effect.targetItemId === null) continue
    const hit = taken.filter((line) => line.itemId === effect.targetItemId)
    if (hit.length === 0) targetsMissing.push({ effectId: effect.id, targetItemId: effect.targetItemId })
    for (const line of hit) {
      if (effect.kind === 'BOM_REMOVE') removed.push({ lineId: line.id, seq: line.seq, effectId: effect.id })
      else replaced.push({ lineId: line.id, seq: line.seq, effectId: effect.id, itemId: effect.itemId! })
    }
  }
  const added = mine.filter((effect) => effect.kind === 'BOM_ADD')
  const definedTwice = added.flatMap((effect) =>
    taken.filter((line) => line.optionValueId === effect.valueId && line.itemId === effect.itemId).map((line) => ({ effectId: effect.id, lineId: line.id, itemId: line.itemId })),
  )
  return {
    optionLinesTaken: taken.filter((line) => line.optionValueId !== null).map((line) => line.id),
    optionLinesLeftOut: sorted.filter((line) => line.optionValueId !== null && !chosen.has(line.optionValueId)).map((line) => line.id),
    removed,
    replaced,
    added,
    targetsMissing,
    definedTwice,
  }
}
