/**
 * ADS AUTONOMY W4-8 — a coverage set changed the way the Family Cockpit changes it (Claude's set-coverage-set), through
 * the cockpit's own service (ads-coverage-sets.service.ts):
 *
 *   seed        seedCoverageSet — top up the family's set from its measured Search Query Performance (POST
 *               /advertising/portfolios/:id/coverage-set/seed): new terms only, existing ones keep their edits; a new
 *               set is a draft, switched off. A seeded term has no target share, so the engine can only hold or lower
 *               its bid until one is set.
 *   edit-terms  updateCoverageTerm per term (PATCH /advertising/coverage-terms/:termId): lead ASIN, max CPC, target
 *               share, control (held out of the engine) and Active / Paused — the fields the cockpit's grid edits.
 *
 * The set's caps are tune-ad-engine (coverage-set) and switching it on or off is turn-up / turn-down-automation (A12):
 * not here. Nexus only: the coverage engine reads the set on its next run and moves bids itself, at its own level.
 *
 * Can it raise spend? The engine raises a term's bid only while the term is Active, not a control, and has a target
 * share (ads-coverage-engine.service.ts decideBidStep), up to its max CPC (the engine's default when none). So a change
 * raises when, after it, a term can climb where it could not, or to a higher target or ceiling.
 */
import prisma from '../../db.js'
import { DEFAULT_MAX_CPC_CENTS } from './ads-coverage-engine.service.js'

export const COVERAGE_OPS = ['seed', 'edit-terms'] as const
export type CoverageOp = (typeof COVERAGE_OPS)[number]
export const TERM_STATUSES = ['ACTIVE', 'PAUSED'] as const
/** The most terms one request edits (the tool contract bounds every list to 250). */
export const MAX_TERM_EDITS = 250

export interface TermEdit {
  termId: string
  leadAsin?: string | null
  status?: (typeof TERM_STATUSES)[number]
  maxCpcCents?: number | null
  targetSharePct?: number | null
  isControl?: boolean
}
export interface CoverageInput { op: CoverageOp; portfolioId?: string; setId?: string; terms?: TermEdit[] }

/** A term as a change record stores it (its undo puts these values back). */
export interface TermState { termId: string; term: string; leadAsin: string | null; status: string; maxCpcCents: number | null; targetSharePct: number | null; isControl: boolean }
export interface CoverageState { setId: string; name: string; terms: TermState[] }

const FIELDS = ['leadAsin', 'status', 'maxCpcCents', 'targetSharePct', 'isControl'] as const
type Field = (typeof FIELDS)[number]
const FIELD_WORDS: Record<Field, string> = { leadAsin: 'lead ASIN', status: 'status', maxCpcCents: 'max CPC (cents)', targetSharePct: 'target share %', isControl: 'control' }
const LINES_SHOWN = 20
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

type TermRow = { id: string; term: string; leadAsin: string | null; status: string; maxCpcCents: number | null; targetSharePct: unknown; isControl: boolean }
const stateOf = (t: TermRow): TermState => ({
  termId: t.id, term: t.term, leadAsin: t.leadAsin, status: t.status, maxCpcCents: t.maxCpcCents,
  targetSharePct: t.targetSharePct != null ? Number(t.targetSharePct) : null, isControl: t.isControl,
})

/** What the engine may do with a term: climb to a target share up to a ceiling, or only hold and lower. Pure. */
function climbOf(t: Pick<TermState, 'status' | 'isControl' | 'targetSharePct' | 'maxCpcCents'>): { target: number; ceiling: number } | null {
  if (t.status !== 'ACTIVE' || t.isControl || t.targetSharePct == null) return null
  return { target: t.targetSharePct, ceiling: t.maxCpcCents ?? DEFAULT_MAX_CPC_CENTS }
}

/**
 * ONE place decides which term edits raise (listed in raises; whether approving needs the approver's code is the
 * Owner's code rule, ads-code-rule.ts — set-coverage-set is a day-to-day door): an edit after which the engine may bid
 * a term higher than it could before. Pure.
 */
export function termRaise(before: TermState, after: TermState): string | null {
  const was = climbOf(before)
  const now = climbOf(after)
  if (!now) return null
  if (!was) {
    const why = before.status !== 'ACTIVE' ? 'it is active again' : before.isControl ? 'it is handed back to the engine' : 'it gets a target share'
    return `"${after.term}": ${why}, so the engine may raise its bid toward ${now.target} % share, up to ${now.ceiling} cents`
  }
  if (now.target > was.target) return `"${after.term}": target share ${was.target} → ${now.target} %, so the engine may raise its bid further`
  if (now.ceiling > was.ceiling) return `"${after.term}": max CPC ${was.ceiling} → ${now.ceiling} cents${after.maxCpcCents == null ? ' (the engine\'s default)' : ''}, so the engine may bid higher`
  return null
}

export interface CoverageLine { termId: string; term: string; field: string; from: unknown; to: unknown }

export interface CoveragePlan {
  action: 'set-coverage-set'
  op: CoverageOp
  set: { id: string | null; name: string; marketplace: string; enabled: boolean | null; portfolioId: string }
  engine: { mode: string; words: string }
  summary: string
  changes: CoverageLine[]
  moreChanges?: number
  totals: Record<string, number>
  raises: string[]
  /** The terms (ids) whose edit raises: each one's item in the strategy's facts is a raise. */
  raisedTerms: string[]
  warnings: string[]
  reach: { nexusOnly: true; note: string }
  effect: string
  /** Every term edited, from and to (all of them), or the seed's set and terms: a move of any is a different change. */
  basis: unknown
  before?: CoverageState
  after?: CoverageState
  /** seed: the terms it would add. */
  seedTerms?: string[]
}

/** The coverage engine's mode for this business, in words (it reads enabled sets only). */
async function engineWords(): Promise<{ mode: string; words: string }> {
  const { businessEngineMode } = await import('./ads-coverage-engine.service.js')
  const mode = await businessEngineMode()
  const words = mode === 'auto'
    ? 'The coverage engine is at Auto for this business: it moves the bids of an enabled set itself on its next run (daily)'
    : mode === 'observe'
      ? 'The coverage engine only observes for this business: it records the bids it would set and changes nothing at Amazon'
      : 'The coverage engine is off for this business: it reads no set'
  return { mode, words }
}

function unknownTerms(ids: string[]): string {
  return `${plural(ids.length, 'term')} ${ids.length === 1 ? 'is' : 'are'} not in this set (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''})`
}

/** A request decided: the plan, or why it is refused. Reads only. */
export async function planCoverageChange(input: CoverageInput): Promise<{ plan: CoveragePlan } | { error: string }> {
  const engine = await engineWords()
  if (input.op === 'seed') {
    const portfolioId = input.portfolioId?.trim()
    if (!portfolioId) return { error: 'Name the portfolio to seed (portfolioId: its Amazon portfolio id, as ad-campaigns and the cockpit show it).' }
    const { previewCoverageSeed } = await import('./ads-coverage-sets.service.js')
    let seed: Awaited<ReturnType<typeof previewCoverageSeed>>
    try { seed = await previewCoverageSeed({ portfolioId }) }
    catch (e) { return { error: `Not queued: ${(e as Error).message === 'portfolio has no campaigns with a marketplace' ? `portfolio ${portfolioId} not found in this business with a campaign in a market, so there is no family to seed` : (e as Error).message}.` } }
    if (seed.set && !seed.unmeasured && !seed.terms.length) return { error: `Nothing would change: "${seed.set.name}" already holds every term its measured Search Query Performance offers (${plural(seed.kept, 'term')}).` }
    if (seed.set && seed.unmeasured) return { error: `Nothing would change: the family has no measured Search Query Performance week, so a seed adds no term to "${seed.set.name}".` }
    const name = seed.set?.name ?? seed.newName
    const created = !seed.set
    const effect = `${created ? `Creates the coverage set "${name}" (${seed.marketplace}) as a draft, switched off, and ` : `Tops up the coverage set "${name}" (${seed.marketplace}): `}${seed.unmeasured ? 'adds no term yet (no measured Search Query Performance week)' : `adds ${plural(seed.terms.length, 'term')} from the family's measured Search Query Performance (at least 2,000 market impressions)`}${seed.set ? `; its ${plural(seed.kept, 'term')} keep their edits` : ''}. A new term has no target share: the engine only holds or lowers its bid until one is set. Nexus only.`
    const shown = seed.terms.slice(0, LINES_SHOWN)
    return {
      plan: {
        action: 'set-coverage-set', op: 'seed',
        set: { id: seed.set?.id ?? null, name, marketplace: seed.marketplace, enabled: seed.set ? seed.set.enabled : false, portfolioId },
        engine,
        summary: effect,
        changes: shown.map((term) => ({ termId: '(new)', term, field: 'term', from: null, to: 'ACTIVE, no target share' })),
        ...(seed.terms.length > LINES_SHOWN ? { moreChanges: seed.terms.length - LINES_SHOWN } : {}),
        totals: { termsAdded: seed.terms.length, termsKept: seed.kept, setCreated: created ? 1 : 0 },
        raises: [],
        raisedTerms: [],
        warnings: seed.set?.enabled ? [`"${name}" is switched on: the engine reads the new terms on its next run (it can only hold or lower their bids until a target share is set).`] : [],
        reach: { nexusOnly: true, note: `Nexus only: the set changes in Nexus. ${engine.words}.` },
        effect,
        basis: { set: seed.set?.id ?? null, terms: seed.terms },
        seedTerms: seed.terms,
      },
    }
  }

  const setId = input.setId?.trim()
  if (!setId) return { error: 'Name the coverage set (setId, from automation-detail A12 or the cockpit).' }
  const edits = input.terms ?? []
  if (!edits.length) return { error: 'Name the terms to edit (terms: [{ termId, … }]).' }
  if (edits.length > MAX_TERM_EDITS) return { error: `${edits.length} terms named: at most ${MAX_TERM_EDITS} in one request. Split them.` }
  const set = await prisma.keywordCoverageSet.findUnique({ where: { id: setId }, select: { id: true, name: true, marketplace: true, enabled: true, portfolioId: true, terms: true } })
  if (!set) return { error: `Coverage set ${setId} not found in this business (automation-detail A12 lists them).` }
  const byId = new Map((set.terms as TermRow[]).map((t) => [t.id, t]))
  const twice = edits.map((e) => e.termId).filter((id, i, all) => all.indexOf(id) !== i)
  if (twice.length) return { error: `Not queued: a term is named twice (${[...new Set(twice)].join(', ')}). Name each term once with every field it changes.` }
  const missing = edits.map((e) => e.termId).filter((id) => !byId.has(id))
  if (missing.length) return { error: `Not queued: ${unknownTerms(missing)}.` }
  const retired = edits.filter((e) => byId.get(e.termId)!.status === 'RETIRED')
  if (retired.length) return { error: `Not queued: ${plural(retired.length, 'term')} ${retired.length === 1 ? 'is' : 'are'} retired (${retired.slice(0, 3).map((e) => `"${byId.get(e.termId)!.term}"`).join(', ')}): the cockpit no longer shows ${retired.length === 1 ? 'it' : 'them'}, and they are not edited here.` }
  // A lead ASIN is one of the family's own (the cockpit offers only those).
  const leads = edits.filter((e) => typeof e.leadAsin === 'string').map((e) => e.leadAsin as string)
  if (leads.length) {
    const { familyIdentity } = await import('./ads-coverage-sets.service.js')
    const { asins } = await familyIdentity(set.portfolioId)
    const foreign = [...new Set(leads.filter((a) => !asins.includes(a)))]
    if (foreign.length) return { error: `Not queued: ${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not advertised by this family's campaigns: a lead ASIN is one of the family's own.` }
  }

  const lines: CoverageLine[] = []
  const raises: string[] = []
  const raisedTerms: string[] = []
  const beforeTerms: TermState[] = []
  const afterTerms: TermState[] = []
  for (const e of edits) {
    const before = stateOf(byId.get(e.termId)!)
    const after: TermState = { ...before }
    for (const field of FIELDS) {
      const value = e[field]
      if (value === undefined) continue
      ;(after as unknown as Record<string, unknown>)[field] = value
      if (before[field] !== value) lines.push({ termId: before.termId, term: before.term, field: FIELD_WORDS[field], from: before[field], to: value })
    }
    if (FIELDS.every((f) => before[f] === after[f])) continue
    beforeTerms.push(before)
    afterTerms.push(after)
    const raise = termRaise(before, after)
    if (raise) { raises.push(raise); raisedTerms.push(before.termId) }
  }
  if (!afterTerms.length) return { error: `Nothing would change: every term named already has these values.` }

  const warnings: string[] = []
  if (raises.length) warnings.push(`It can raise spend once the engine runs the set: ${raises.slice(0, 5).join('; ')}${raises.length > 5 ? `; and ${raises.length - 5} more` : ''}.`)
  if (!set.enabled) warnings.push(`"${set.name}" is switched off (a draft): the engine reads none of this until it is switched on (turn-up-automation A12).`)
  const effect = `Edits ${plural(afterTerms.length, 'term')} of the coverage set "${set.name}" (${set.marketplace}): ${plural(lines.length, 'value')} ${lines.length === 1 ? 'changes' : 'change'}. Nexus only: nothing is sent to Amazon by this change. ${engine.words}.`
  return {
    plan: {
      action: 'set-coverage-set', op: 'edit-terms',
      set: { id: set.id, name: set.name, marketplace: set.marketplace, enabled: set.enabled, portfolioId: set.portfolioId },
      engine,
      summary: effect,
      changes: lines.slice(0, LINES_SHOWN),
      ...(lines.length > LINES_SHOWN ? { moreChanges: lines.length - LINES_SHOWN } : {}),
      totals: { termsEdited: afterTerms.length, values: lines.length, raises: raises.length },
      raises,
      raisedTerms,
      warnings,
      reach: { nexusOnly: true, note: `Nexus only: the terms change in Nexus. ${engine.words}.` },
      effect,
      basis: { enabled: set.enabled, terms: beforeTerms.map((t, i) => ({ from: t, to: afterTerms[i] })) },
      before: { setId: set.id, name: set.name, terms: beforeTerms },
      after: { setId: set.id, name: set.name, terms: afterTerms },
    },
  }
}

/** The terms a change record names, as stored now (undo compares them with what the change wrote). */
export async function coverageStateNow(state: CoverageState): Promise<CoverageState | null> {
  const set = await prisma.keywordCoverageSet.findUnique({ where: { id: state.setId }, select: { id: true, name: true } })
  if (!set) return null
  const rows = await prisma.keywordCoverageTerm.findMany({ where: { setId: set.id, id: { in: state.terms.map((t) => t.termId) } } })
  const byId = new Map(rows.map((t) => [t.id, stateOf(t as TermRow)]))
  return { setId: set.id, name: set.name, terms: state.terms.map((t) => byId.get(t.termId) ?? { ...t, status: 'GONE' }) }
}

/**
 * Run an approved request: decided again on what is stored now, then written through the cockpit's own service. A seed
 * records the terms it added (its undo pauses them; a set it created stays, as a draft).
 */
export async function applyCoverageChange(input: CoverageInput, createdBy: string): Promise<{ plan: CoveragePlan; before: CoverageState | { seeded: true; setId: string | null; portfolioId: string }; after: CoverageState } | { error: string }> {
  const planned = await planCoverageChange(input)
  if ('error' in planned) return planned
  const { plan } = planned
  const svc = await import('./ads-coverage-sets.service.js')
  if (plan.op === 'seed') {
    const had = plan.set.id ? new Set((await prisma.keywordCoverageTerm.findMany({ where: { setId: plan.set.id }, select: { id: true } })).map((t) => t.id)) : new Set<string>()
    const out = await svc.seedCoverageSet({ portfolioId: plan.set.portfolioId, createdBy })
    const rows = await prisma.keywordCoverageTerm.findMany({ where: { setId: out.setId }, orderBy: { term: 'asc' } })
    const set = await prisma.keywordCoverageSet.findUniqueOrThrow({ where: { id: out.setId }, select: { name: true } })
    const added = rows.filter((t) => !had.has(t.id)).map((t) => stateOf(t as TermRow))
    return { plan, before: { seeded: true, setId: plan.set.id, portfolioId: plan.set.portfolioId }, after: { setId: out.setId, name: set.name, terms: added } }
  }
  for (const t of plan.after!.terms) {
    const was = plan.before!.terms.find((b) => b.termId === t.termId)!
    const patch: Record<string, unknown> = {}
    for (const field of FIELDS) if (t[field] !== was[field]) patch[field] = t[field]
    await svc.updateCoverageTerm({ termId: t.termId, patch: patch as never })
  }
  const now = await coverageStateNow(plan.after!)
  return { plan, before: plan.before!, after: now ?? plan.after! }
}
