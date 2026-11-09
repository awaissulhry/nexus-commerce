import { STYLE_FIELDS, type StyleField } from '../styles/rules'

/**
 * A style's lifecycle and the edit rule of each state (B-W2b-221; features PRD-007, PRD-182; design products.settings
 * psettings.lifecycle "Per state: edit freely · needs a new revision · needs a change order · blocked"), pure. Beside W1's
 * record state `Style.status` (DRAFT, ACTIVE, ARCHIVED, which every W1 path reads), `Style.lifecycle` says where the style is
 * in its life:
 *
 *   CONCEPT → DEVELOPMENT → SAMPLING → APPROVED → IN_PRODUCTION → PHASE_OUT → DISCONTINUED
 *
 * one command per move (apps/factory-api modules/product/lifecycle). The moves (`LIFECYCLE_MOVES`):
 *   - forward before production: any later state up to APPROVED (a simple style needs no samples: "one style needs none");
 *   - IN_PRODUCTION only from APPROVED, and only with a RELEASED revision (the database holds the same: Style_w2b4_depth);
 *   - PHASE_OUT from IN_PRODUCTION; DISCONTINUED from every state (a dropped idea, a style taken off the range);
 *   - back, with the reason: DEVELOPMENT → CONCEPT, SAMPLING → DEVELOPMENT, APPROVED → DEVELOPMENT or SAMPLING (the sample
 *     failed), PHASE_OUT → IN_PRODUCTION (demand came back), DISCONTINUED → DEVELOPMENT (reworked) or IN_PRODUCTION (made
 *     again, with its released revision). A style in production never goes back to development: its spec changes through
 *     a new revision under its edit rule.
 * The replacing style (`Style.replacedById`) is named only while PHASE_OUT or DISCONTINUED; a move out of them clears it.
 *
 * The edit rule per state (factory-db ProductEditRule; the ProductSettings row of the style's company, then the tenant-wide
 * row, then `DEFAULT_EDIT_RULES`). Every product write asks it with the kind of write (`EDIT_KINDS`):
 *
 *   kind           FREE   NEW_REVISION        CHANGE_ORDER        BLOCKED
 *   DETAILS        yes    yes                 yes                 no      the style's words (name, names, description, season)
 *   SPEC           yes    with a draft open   with a draft open   no      every other field of the style, its colourways, type
 *   NEW_REVISION   yes    yes                 no (a change order) no      start or copy into a new draft revision
 *   DRAFT          yes    yes                 yes                 no      a write to an open draft (BOM, routing, pieces)
 *   RELEASE        yes    yes                 yes                 no      release a draft
 *
 * "With a draft open": the style's own fields that define what is made change only while a new revision is being prepared,
 * so the change goes out with it (W1 freezes the spec on the work order: a typo needs no change order). A released revision
 * never changes (W1's database guard). Change orders (B-W2b-212's schema) have no route yet: CHANGE_ORDER refuses a new
 * revision in words that say so.
 */

export const STYLE_LIFECYCLES = ['CONCEPT', 'DEVELOPMENT', 'SAMPLING', 'APPROVED', 'IN_PRODUCTION', 'PHASE_OUT', 'DISCONTINUED'] as const
export type StyleLifecycle = (typeof STYLE_LIFECYCLES)[number]

export const EDIT_RULES = ['FREE', 'NEW_REVISION', 'CHANGE_ORDER', 'BLOCKED'] as const
export type EditRule = (typeof EDIT_RULES)[number]

export const EDIT_KINDS = ['DETAILS', 'SPEC', 'NEW_REVISION', 'DRAFT', 'RELEASE'] as const
export type EditKind = (typeof EDIT_KINDS)[number]

/** Where a rule in force comes from: the company's row, the tenant-wide row, or the product module's default. */
export const RULE_SOURCES = ['COMPANY', 'TENANT', 'DEFAULT'] as const
export type RuleSource = (typeof RULE_SOURCES)[number]

/**
 * The rules with no setting anywhere: free until approved, then a change goes through a new revision (what W1 does with a
 * released revision), and nothing changes once discontinued. A factory sets its own in Product settings.
 */
export const DEFAULT_EDIT_RULES: Readonly<Record<StyleLifecycle, EditRule>> = Object.freeze({
  CONCEPT: 'FREE',
  DEVELOPMENT: 'FREE',
  SAMPLING: 'FREE',
  APPROVED: 'NEW_REVISION',
  IN_PRODUCTION: 'NEW_REVISION',
  PHASE_OUT: 'NEW_REVISION',
  DISCONTINUED: 'BLOCKED',
})

/** The ProductSettings column of each state's rule. */
export const EDIT_RULE_COLUMNS = Object.freeze({
  CONCEPT: 'editRuleConcept',
  DEVELOPMENT: 'editRuleDevelopment',
  SAMPLING: 'editRuleSampling',
  APPROVED: 'editRuleApproved',
  IN_PRODUCTION: 'editRuleInProduction',
  PHASE_OUT: 'editRulePhaseOut',
  DISCONTINUED: 'editRuleDiscontinued',
} as const satisfies Record<StyleLifecycle, string>)
export type EditRuleColumn = (typeof EDIT_RULE_COLUMNS)[StyleLifecycle]

/** A ProductSettings row as far as the edit rules go (null fields are not set on it). */
export type EditRuleRow = { readonly [Column in EditRuleColumn]?: EditRule | null }

/** The state in words, lower case ("in production"). */
export const LIFECYCLE_WORDS: Readonly<Record<StyleLifecycle, string>> = Object.freeze({
  CONCEPT: 'a concept',
  DEVELOPMENT: 'in development',
  SAMPLING: 'in sampling',
  APPROVED: 'approved',
  IN_PRODUCTION: 'in production',
  PHASE_OUT: 'being phased out',
  DISCONTINUED: 'discontinued',
})

export const EDIT_RULE_WORDS: Readonly<Record<EditRule, string>> = Object.freeze({
  FREE: 'edit freely',
  NEW_REVISION: 'needs a new revision',
  CHANGE_ORDER: 'needs a change order',
  BLOCKED: 'blocked',
})

// ---- the moves ----------------------------------------------------------------------------------------------------------

/** Every allowed move: a state → the states it may go to. */
export const LIFECYCLE_MOVES: Readonly<Record<StyleLifecycle, readonly StyleLifecycle[]>> = Object.freeze({
  CONCEPT: ['DEVELOPMENT', 'SAMPLING', 'APPROVED', 'DISCONTINUED'],
  DEVELOPMENT: ['CONCEPT', 'SAMPLING', 'APPROVED', 'DISCONTINUED'],
  SAMPLING: ['DEVELOPMENT', 'APPROVED', 'DISCONTINUED'],
  APPROVED: ['DEVELOPMENT', 'SAMPLING', 'IN_PRODUCTION', 'DISCONTINUED'],
  IN_PRODUCTION: ['PHASE_OUT', 'DISCONTINUED'],
  PHASE_OUT: ['IN_PRODUCTION', 'DISCONTINUED'],
  DISCONTINUED: ['DEVELOPMENT', 'IN_PRODUCTION'],
})

const order = (state: StyleLifecycle): number => STYLE_LIFECYCLES.indexOf(state)

/** A move back (to an earlier state) needs the reason. */
export const isBackward = (from: StyleLifecycle, to: StyleLifecycle): boolean => order(to) < order(from)

/** The states that may name the style that replaces it. */
export const REPLACEABLE_STATES: readonly StyleLifecycle[] = Object.freeze(['PHASE_OUT', 'DISCONTINUED'])
export const mayNameReplacement = (state: StyleLifecycle): boolean => REPLACEABLE_STATES.includes(state)

export const LIFECYCLE_REFUSALS = [
  'SAME_STATE',
  'MOVE_NOT_ALLOWED',
  'NEEDS_RELEASED_REVISION',
  'REASON_NEEDED',
  'STYLE_ARCHIVED',
  'REPLACEMENT_NOT_HERE',
  'REPLACEMENT_SELF',
  'REPLACEMENT_UNUSABLE',
  'REPLACEMENT_CIRCLE',
] as const
export type LifecycleRefusalCode = (typeof LIFECYCLE_REFUSALS)[number]
export interface LifecycleRefusal {
  readonly code: LifecycleRefusalCode
  readonly message: string
}

/** What a move's check reads. */
export interface MoveFacts {
  readonly code: string
  /** W1's record state. */
  readonly status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  readonly from: StyleLifecycle
  /** The style has a RELEASED revision. */
  readonly releasedRevision: boolean
  /** The reason given (trimmed; empty = none). */
  readonly reason?: string | null | undefined
}

/** Why the style may not move to `to` now, in words, or null. */
export function moveRefusal(facts: MoveFacts, to: StyleLifecycle): LifecycleRefusal | null {
  const { code, from } = facts
  if (facts.status === 'ARCHIVED') return { code: 'STYLE_ARCHIVED', message: `Style ${code} is archived: reactivate it before moving it through its lifecycle.` }
  if (from === to) return { code: 'SAME_STATE', message: `Style ${code} is already ${LIFECYCLE_WORDS[to]}.` }
  if (!LIFECYCLE_MOVES[from].includes(to)) {
    const allowed = LIFECYCLE_MOVES[from].map((state) => LIFECYCLE_WORDS[state]).join(', ')
    const why = to === 'IN_PRODUCTION' ? ' A style goes into production once it is approved.' : from === 'IN_PRODUCTION' ? ' A style in production changes through a new revision, not by going back.' : ''
    return { code: 'MOVE_NOT_ALLOWED', message: `Style ${code} is ${LIFECYCLE_WORDS[from]}: it can be moved to ${allowed}, not ${LIFECYCLE_WORDS[to]}.${why}` }
  }
  if (to === 'IN_PRODUCTION' && !facts.releasedRevision) {
    return { code: 'NEEDS_RELEASED_REVISION', message: `Style ${code} has no released revision: release its BOM and routing before it goes into production.` }
  }
  if (isBackward(from, to) && !facts.reason?.trim()) {
    return { code: 'REASON_NEEDED', message: `Moving style ${code} back from ${LIFECYCLE_WORDS[from]} to ${LIFECYCLE_WORDS[to]}: say why.` }
  }
  return null
}

/** What naming a replacing style reads. */
export interface ReplacementFacts {
  readonly code: string
  /** The state the style is in (or moves to). */
  readonly state: StyleLifecycle
  readonly styleId: string
  /** The style named, or null when it is cleared. */
  readonly replacement: {
    readonly id: string
    readonly code: string
    readonly status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
    readonly lifecycle: StyleLifecycle
    /** The replacing style may be made by the style's company (it is of that company, or tenant-wide). */
    readonly fitsCompany: boolean
    /** The styles the replacement is replaced by, in turn (its chain up), to find a circle. */
    readonly chain: readonly string[]
  } | null
}

/** Why the replacing style may not be named, in words, or null. Clearing it is always allowed. */
export function replacementRefusal(facts: ReplacementFacts): LifecycleRefusal | null {
  const { code, replacement } = facts
  if (replacement === null) return null
  if (!mayNameReplacement(facts.state)) {
    return { code: 'REPLACEMENT_NOT_HERE', message: `Style ${code} is ${LIFECYCLE_WORDS[facts.state]}: a replacing style is named once it is being phased out or discontinued.` }
  }
  if (replacement.id === facts.styleId) return { code: 'REPLACEMENT_SELF', message: `Style ${code} cannot replace itself.` }
  if (replacement.status === 'ARCHIVED' || replacement.lifecycle === 'DISCONTINUED' || !replacement.fitsCompany) {
    const why = !replacement.fitsCompany ? "belongs to another company than the style's" : replacement.status === 'ARCHIVED' ? 'is archived' : 'is discontinued'
    return { code: 'REPLACEMENT_UNUSABLE', message: `Style ${replacement.code} ${why}: it cannot replace ${code}.` }
  }
  if (replacement.chain.includes(facts.styleId)) return { code: 'REPLACEMENT_CIRCLE', message: `Style ${replacement.code} is itself replaced by ${code} (directly or through others): no circle of replacements.` }
  return null
}

// ---- the edit rule ------------------------------------------------------------------------------------------------------

/** The rule in force for a state: the company's row, then the tenant-wide row, then the default. */
export function editRuleFor(state: StyleLifecycle, company: EditRuleRow | null, tenant: EditRuleRow | null): { rule: EditRule; source: RuleSource } {
  const column = EDIT_RULE_COLUMNS[state]
  const own = company?.[column] ?? null
  if (own !== null) return { rule: own, source: 'COMPANY' }
  const wide = tenant?.[column] ?? null
  if (wide !== null) return { rule: wide, source: 'TENANT' }
  return { rule: DEFAULT_EDIT_RULES[state], source: 'DEFAULT' }
}

/** Every state's rule in force (the visible table of psettings.lifecycle). */
export function editRuleTable(company: EditRuleRow | null, tenant: EditRuleRow | null): { state: StyleLifecycle; rule: EditRule; source: RuleSource }[] {
  return STYLE_LIFECYCLES.map((state) => ({ state, ...editRuleFor(state, company, tenant) }))
}

/** The style's fields that are its words, not what is made: a typo in them needs no new revision. */
export const DETAIL_FIELDS: readonly StyleField[] = Object.freeze(['name', 'nameI18n', 'description', 'season'])

/** The kind of a change of the style's own fields: DETAILS when only its words change, else SPEC. */
export const editKindOfFields = (fields: readonly string[]): EditKind => (fields.every((field) => (DETAIL_FIELDS as readonly string[]).includes(field)) ? 'DETAILS' : 'SPEC')

/** Every style field that is spec (the rest of STYLE_FIELDS). */
export const SPEC_FIELDS: readonly StyleField[] = Object.freeze(STYLE_FIELDS.filter((field) => !DETAIL_FIELDS.includes(field)))

export const EDIT_REFUSALS = ['EDIT_BLOCKED', 'NEEDS_NEW_REVISION', 'NEEDS_CHANGE_ORDER'] as const
export type EditRefusalCode = (typeof EDIT_REFUSALS)[number]
export interface EditRefusal {
  readonly code: EditRefusalCode
  readonly message: string
}

/** What the edit rule's check reads about the style. */
export interface EditFacts {
  readonly code: string
  readonly lifecycle: StyleLifecycle
  /** The style has an open DRAFT revision (its number), or null. */
  readonly draftRevision: number | null
}

const WHAT: Readonly<Record<EditKind, string>> = Object.freeze({
  DETAILS: 'its name and description',
  SPEC: 'its spec',
  NEW_REVISION: 'a new revision',
  DRAFT: 'its draft revision',
  RELEASE: 'a release',
})

/**
 * Why `kind` of write is refused under the style's rule, in words, or null (the table in the head of this file). The words
 * say what to do: start a revision, ask an administrator, or move the style.
 */
export function editRefusal(rule: EditRule, kind: EditKind, facts: EditFacts): EditRefusal | null {
  const state = LIFECYCLE_WORDS[facts.lifecycle]
  if (rule === 'FREE') return null
  if (rule === 'BLOCKED') {
    return { code: 'EDIT_BLOCKED', message: `Style ${facts.code} is ${state}: nothing of it changes in this state (its edit rule is "blocked"). Move it to another state first.` }
  }
  if (kind === 'DETAILS' || kind === 'DRAFT' || kind === 'RELEASE') return null
  if (kind === 'SPEC') {
    if (facts.draftRevision !== null) return null
    return rule === 'NEW_REVISION'
      ? { code: 'NEEDS_NEW_REVISION', message: `Style ${facts.code} is ${state}: its spec changes only with a new revision. Start a new revision first; the change goes out with it.` }
      : { code: 'NEEDS_CHANGE_ORDER', message: `Style ${facts.code} is ${state}: its spec changes only through a change order approved by someone other than its author, with a new revision.` }
  }
  // NEW_REVISION
  if (rule === 'NEW_REVISION') return null
  return {
    code: 'NEEDS_CHANGE_ORDER',
    message: `Style ${facts.code} is ${state}: ${WHAT[kind]} needs a change order approved by someone other than its author, and change orders are not available yet. An administrator can set the rule of this state to "needs a new revision" in Product settings.`,
  }
}

/** What each kind of write may do now under the rule (the style's read shows it). */
export function editAllowance(rule: EditRule, facts: EditFacts): Record<EditKind, EditRefusal | null> {
  return Object.fromEntries(EDIT_KINDS.map((kind) => [kind, editRefusal(rule, kind, facts)])) as Record<EditKind, EditRefusal | null>
}
