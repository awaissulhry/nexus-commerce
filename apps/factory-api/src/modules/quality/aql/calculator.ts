import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { InspectionLevel } from '@nexus/factory-domain/quality/aql/iso2859'
import { aqlResult } from '@nexus/factory-domain/quality/aql/result'
import { aqlWords, levelOf, samplingPlan, samplingProblems } from '@nexus/factory-domain/quality/aql/sampling'
import type { CommandCaller } from '../../../core/command'
import { planView, resultView } from './chain'
import { mayView, officeOf, readProfile } from './store'

/**
 * The AQL calculator (B-W2b-93; QHS-020; design quality.plans pl-calc "Try lot size and level → code letter, sample and
 * Ac/Re. Inputs: lot size, level, profile. Output: AqlSummary in words. Read-only tool; nothing saves."). With what was
 * found so far (and how many were inspected), it also says the result as the bench's counter would (QHS-013).
 *
 *   GET /quality/aql/calculate?lotSize&(profileId | level&aqlMajor&aqlMinor)[&critical&major&minor&inspected]
 *
 * A typed level or AQL wins over the profile's. Refusals in words at `query/<field>`.
 */

export interface CalculateQuery {
  readonly lotSize: number
  readonly profileId?: string | undefined
  readonly level?: string | undefined
  readonly aqlMajor?: string | undefined
  readonly aqlMinor?: string | undefined
  readonly critical?: number | undefined
  readonly major?: number | undefined
  readonly minor?: number | undefined
  readonly inspected?: number | undefined
}

export async function calculate(caller: CommandCaller, query: CalculateQuery) {
  const context = officeOf(caller)
  const profile = query.profileId ? await caller.withClient((client) => readProfile(client, query.profileId!)) : null
  if (query.profileId && (!profile || !mayView(context, profile.companyId))) throw new NotFoundError('AQL profile not found.')
  const level = query.level !== undefined ? (levelOf(query.level) ?? query.level) : (profile?.inspectionLevel ?? '')
  const aqlMajor = query.aqlMajor ?? (profile ? aqlWords(profile.aqlMajor.toString()) : '')
  const aqlMinor = query.aqlMinor ?? (profile ? aqlWords(profile.aqlMinor.toString()) : '')
  const problems = samplingProblems({ lotSize: query.lotSize, level, aqlMajor, aqlMinor }).map((problem) => ({ path: `query/${problem.path}`, message: problem.message }))
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The calculator needs a lot size, a level and two AQLs of ISO 2859-1 (or a profile).', problems)
  const plan = samplingPlan({ lotSize: query.lotSize, level: level as InspectionLevel, aqlMajor, aqlMinor })
  const counted = [query.critical, query.major, query.minor, query.inspected].some((value) => value !== undefined)
  const found = { CRITICAL: query.critical ?? 0, MAJOR: query.major ?? 0, MINOR: query.minor ?? 0 }
  const result = counted
    ? aqlResult({ sampleSize: plan.sampleSize, inspected: query.inspected ?? null, classes: plan.classes.map((entry) => ({ defectClass: entry.defectClass, aql: entry.aql, accept: entry.accept, found: found[entry.defectClass] })) })
    : null
  return {
    profile: profile ? { id: profile.id, code: profile.code, name: profile.name } : null,
    plan: planView(plan),
    result: result ? resultView(result) : null,
  }
}
