import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { InspectionLevel } from '@nexus/factory-domain/quality/aql/iso2859'
import { resolveProfile, SOURCE_WORDS, type ChainAnswer } from '@nexus/factory-domain/quality/aql/profiles'
import { aqlWords, levelText, samplingPlan, type SamplingPlanResult } from '@nexus/factory-domain/quality/aql/sampling'
import { QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import type { CommandCaller } from '../../../core/command'
import { readCells } from '../../production/serials/store'
import { finalWorkOrder } from '../final/access'
import type { AqlResult } from '@nexus/factory-domain/quality/aql/result'
import type { ChainView, PlanView, ResultView } from './contract'
import { mayView, officeOf, PROFILE_COLUMNS, type ProfileRow, type Reader } from './store'

/**
 * Which AQL profile applies, and the plan it gives (B-W2b-93; QHS-020, QHS-021; design quality.inspections aql-profile
 * "Source chain: style override › customer profile › company default"). THE place the chain is read: the AQL routes, and
 * the steps that open inspections from a profile (B-W2b-97 final by plan, B-W2b-98 incoming, B-W2b-99 in-process) call
 * `aqlPlanFor` inside their own command and copy the plan onto the record (aqlProfileId, codeLetter, sampleSize,
 * inspectionLevel as text, aqlMajor, aqlMinor, acceptMajor, acceptMinor).
 *
 *   GET /quality/aql/resolve?companyId&customerId&styleId          office, quality.aql.view over the company
 *   GET /quality/aql/work-orders/:workOrderId/plan?lotSize&profileId office and the site's bench, quality.inspections.view:
 *                                                                  the plan to open a final inspection with
 */

export interface ChainFacts {
  readonly companyId: string
  /** The inspection's plan version, if any: its own profile comes first; a FIXED sample has no AQL profile. */
  readonly planVersionId?: string | null | undefined
  readonly styleId: string | null
  readonly customerIds: readonly string[]
}

export interface ChainRead {
  readonly answer: ChainAnswer
  readonly profiles: ReadonlyMap<string, ProfileRow>
  /** The plan version samples a fixed number of units (no AQL profile applies). */
  readonly fixedSample: boolean
}

/** The chain for a company, a style and the customers, read as the caller (office or the site's floor). */
export async function readChain(db: Reader, facts: ChainFacts): Promise<ChainRead> {
  const rows = await db.aqlProfile.findMany({ where: { companyId: facts.companyId }, select: PROFILE_COLUMNS })
  const customerIds = [...new Set(facts.customerIds)]
  const assignments = await db.aqlProfileAssignment.findMany({
    where: {
      companyId: facts.companyId,
      active: true,
      AND: [{ OR: [{ customerId: null }, ...(customerIds.length ? [{ customerId: { in: customerIds } }] : [])] }, { OR: [{ styleId: null }, ...(facts.styleId ? [{ styleId: facts.styleId }] : [])] }],
    },
    select: { id: true, profileId: true, customerId: true, styleId: true, active: true },
  })
  let planProfileId: string | null = null
  let fixedSample = false
  if (facts.planVersionId) {
    const version = await db.inspectionPlanVersion.findUnique({ where: { id: facts.planVersionId }, select: { samplingMethod: true, aqlProfileId: true } })
    fixedSample = version?.samplingMethod === 'FIXED'
    planProfileId = version?.samplingMethod === 'AQL_PROFILE' ? version.aqlProfileId : null
  }
  const answer = resolveProfile({ planProfileId, styleId: facts.styleId, customerIds }, rows, assignments)
  return { answer, profiles: new Map(rows.map((row) => [row.id, row])), fixedSample }
}

export function chainView(read: ChainRead): ChainView {
  const { answer, profiles } = read
  const profile = answer.profileId ? profiles.get(answer.profileId)! : null
  return {
    profile: profile ? { id: profile.id, code: profile.code, name: profile.name, inspectionLevel: profile.inspectionLevel as InspectionLevel, aqlMajor: aqlWords(profile.aqlMajor.toString()), aqlMinor: aqlWords(profile.aqlMinor.toString()) } : null,
    source: answer.source,
    sourceWords: { ...SOURCE_WORDS[answer.source] },
    steps: answer.steps.map((step) => ({ source: step.source, profileId: step.profileId, profileCode: step.profileId ? (profiles.get(step.profileId)?.code ?? null) : null, assignmentId: step.assignmentId, skipped: step.skipped })),
    words: answer.words,
  }
}

/** The plan of a profile for a lot (Table 1 + Table 2-A). */
export function planOfProfile(profile: Pick<ProfileRow, 'inspectionLevel' | 'aqlMajor' | 'aqlMinor'>, lotSize: number): SamplingPlanResult {
  return samplingPlan({ lotSize, level: profile.inspectionLevel as InspectionLevel, aqlMajor: profile.aqlMajor.toString(), aqlMinor: profile.aqlMinor.toString() })
}

export function planView(plan: SamplingPlanResult): PlanView {
  return {
    lotSize: plan.lotSize,
    level: plan.level,
    levelText: levelText(plan.level),
    codeLetter: plan.codeLetter,
    sampleSize: plan.sampleSize,
    hundredPercent: plan.hundredPercent,
    samplesDiffer: plan.samplesDiffer,
    classes: plan.classes.map((entry) => ({ ...entry })),
    words: plan.words,
    classWords: [...plan.classWords],
  }
}

/** The automatic result as the contract carries it (QHS-013). */
export function resultView(result: AqlResult): ResultView {
  return { ...result, classes: result.classes.map((entry) => ({ ...entry })), reasons: [...result.reasons], blockers: [...result.blockers], progress: result.progress ? { ...result.progress } : null }
}

export interface AqlPlanAsk extends ChainFacts {
  readonly lotSize: number
  /** A profile a person names instead of the chain's (the caller asks for the reason). */
  readonly profileId?: string | null | undefined
  /** Where a refusal of the named profile points ("body/profileId", "query/profileId"). */
  readonly at?: string | undefined
}

export interface AqlPlanAnswer {
  readonly chain: ChainRead
  /** The profile the plan is made from, or null (no profile applies and none was named). */
  readonly profile: ProfileRow | null
  /** The profile was named, and differs from the chain's. */
  readonly named: boolean
  readonly plan: SamplingPlanResult | null
}

/**
 * The plan for a lot (THE function for B-W2b-97, -98, -99): the chain's profile, or the one named (of the same company,
 * in use: 400 in words otherwise), and its plan. `named` tells the caller a reason is due.
 */
export async function aqlPlanFor(db: Reader, ask: AqlPlanAsk): Promise<AqlPlanAnswer> {
  const chain = await readChain(db, ask)
  let profile: ProfileRow | null = chain.answer.profileId ? chain.profiles.get(chain.answer.profileId)! : null
  let named = false
  if (ask.profileId) {
    const path = ask.at ?? 'profileId'
    const asked = isUuid(ask.profileId) ? (chain.profiles.get(ask.profileId) ?? null) : null
    if (!asked) throw new ValidationError("Not an AQL profile of the work's company.", [{ path, message: "Not an AQL profile of the work's company." }])
    if (!asked.active) throw new ValidationError(`${asked.code} is retired: name a profile in use.`, [{ path, message: `${asked.code} is retired: name a profile in use.` }])
    named = asked.id !== profile?.id
    profile = asked
  }
  return { chain, profile, named, plan: profile && !chain.fixedSample ? planOfProfile(profile, ask.lotSize) : null }
}

// ---- routes ---------------------------------------------------------------------------------------------------------

/** GET /quality/aql/resolve */
export async function resolveRoute(caller: CommandCaller, query: { readonly companyId: string; readonly customerId?: string | undefined; readonly styleId?: string | undefined }): Promise<{ chain: ChainView }> {
  const context = officeOf(caller)
  if (!mayView(context, query.companyId)) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => ({ chain: chainView(await readChain(client, { companyId: query.companyId, styleId: query.styleId ?? null, customerIds: query.customerId ? [query.customerId] : [] })) }))
}

/** The customers a work order's goods are for (its cells' sales order lines' parties). */
export async function customersOf(db: Reader, workOrderId: string): Promise<string[]> {
  return [...new Set((await readCells(db, workOrderId)).map((cell) => cell.partyId))]
}

/** GET /quality/aql/work-orders/:workOrderId/plan */
export async function workOrderPlan(caller: CommandCaller, workOrderId: string, query: { readonly lotSize: number; readonly profileId?: string | undefined }) {
  const header = await finalWorkOrder(caller, workOrderId, QUALITY_INSPECTIONS_VIEW)
  return caller.withClient(async (client) => {
    const answer = await aqlPlanFor(client, { companyId: header.companyId, styleId: header.styleId, customerIds: await customersOf(client, header.id), lotSize: query.lotSize, profileId: query.profileId ?? null, at: 'query/profileId' })
    return { workOrderId: header.id, number: header.number, chain: chainView(answer.chain), profileId: answer.profile?.id ?? null, named: answer.named, plan: answer.plan ? planView(answer.plan) : null }
  })
}
