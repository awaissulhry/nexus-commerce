/**
 * Google Ads programme 2, G14a (2026-10-16) — reusable audiences (Google's Audience: segments, age, gender, household
 * income, parental status and user lists left out, layered into one audience a Demand Gen ad group targets and a
 * Performance Max asset group takes as a signal): pure builders. No call here.
 *
 * Google's rules, checked 2026-10-16 with curl (reference/rpc/v25/Audience, AudienceOperation, AudienceDimension,
 * AudienceExclusionDimension, ExclusionSegment, AudienceSegmentDimension, AudienceSegment, UserListSegment,
 * UserInterestSegment, LifeEventSegment, DetailedDemographicSegment, CustomAudienceSegment, AgeDimension, AgeSegment,
 * GenderDimension, HouseholdIncomeDimension, ParentalStatusDimension, GenderTypeEnum, IncomeRangeTypeEnum,
 * ParentalStatusTypeEnum, AudienceScopeEnum, AudienceStatusEnum) and the guide docs/remarketing/audiences:
 *   - AudienceOperation has create and update (+ update_mask) ONLY: Google has no way to remove an Audience. A new one
 *     is never undone (it stays, used by nothing).
 *   - name: unique across the account's audiences, 1–255 characters, required with scope CUSTOMER (the default), "Cannot
 *     be set or updated when scope is ASSET_GROUP". status and id are Output only.
 *   - dimensions[]: one of each type (TOO_MANY_DIMENSIONS_OF_SAME_TYPE): audience_segments (segments[]: user_list |
 *     user_interest | life_event | detailed_demographic | custom_audience — "Users are included if they belong to at least
 *     one segment"; DUPLICATE_AUDIENCE_SEGMENT), age (age_ranges[] AgeSegment: min 18, 25, 35, 45, 55 or 65; max, if any,
 *     above min: 24, 34, 44, 54 or 64; include_undetermined), gender (genders[] FEMALE | MALE, include_undetermined),
 *     household_income (income_ranges[] INCOME_RANGE_0_50 … INCOME_RANGE_90_UP, include_undetermined), parental_status
 *     (parental_statuses[] PARENT | NOT_A_PARENT, include_undetermined). exclusion_dimension: user lists only
 *     (DIMENSION_INVALID otherwise). A repeated field in the update mask is written whole: Nexus sends every dimension.
 *   - Resource names: customers/{c}/userLists/{id}, userInterests/{id}, lifeEvents/{id}, detailedDemographics/{id},
 *     customAudiences/{id} (fields/v25/<resource> resource_name).
 *
 * Money: an audience spends nothing; the Demand Gen ad groups that target it and the Performance Max asset groups that
 * take it as a signal do. A change that lets it hold more people (a segment added, a demographic widened or dropped, an
 * exclusion taken off) is SPENDS MONEY when one of them serves (change-audience-uses.ts).
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import { narrowLine, placeKeys, placesOf, widenLines, type UseContext } from './change-audience-uses.js'
import {
  definitionJson, GENDERS, INCOMES, PARENTAL, segmentKey,
  type AgeRange, type AudienceDefinition, type DemographicPart, type LiveReusableAudience, type SegmentRef,
} from './live-goals-audiences.js'
import type { GoogleMutateOperation } from './write-client.js'

export const AGE_MINS = [18, 25, 35, 45, 55, 65] as const
export const AGE_MAXES = [24, 34, 44, 54, 64] as const
export const AUDIENCE_NAME_MAX = 255

type Part<T extends string> = { values: T[]; includeUndetermined?: boolean } | null
/** The composition a request gives; a part left out stays as it is (change) or is not there (create); null removes it. */
export interface DefinitionAsk {
  segments?: SegmentRef[]
  ages?: { ranges: AgeRange[]; includeUndetermined?: boolean } | null
  genders?: Part<typeof GENDERS[number]>
  incomes?: Part<typeof INCOMES[number]>
  parental?: Part<typeof PARENTAL[number]>
  excludeUserLists?: string[]
}
export interface ReusableAudienceRequest {
  create?: Array<{ name: string; description?: string } & DefinitionAsk>
  change?: Array<{ audienceId: string; name?: string; description?: string } & DefinitionAsk>
}

export interface ReusableAudienceFields { audienceId: string; name?: string | null; description?: string | null; definition?: AudienceDefinition }
export interface ReusableAudienceRecord {
  audiences: ReusableAudienceFields[]
  created: Array<{ audienceId: string; name: string }>
}

export const NEW_AUDIENCE = (n: number) => `new-audience-${n}`

export interface ReusableAudienceLive extends UseContext {
  /** The account's reusable audiences (enabled). */
  audiences: LiveReusableAudience[]
  /** The names of the segments a request names, by `KIND|id`; a missing one is unknown to Google. */
  segmentNames: Record<string, string | null>
}

const SEGMENT_WORD: Record<SegmentRef['kind'], string> = {
  USER_LIST: 'your data segment', USER_INTEREST: 'interest segment', CUSTOM_AUDIENCE: 'custom segment', LIFE_EVENT: 'life event', DETAILED_DEMOGRAPHIC: 'detailed demographic',
}

/** One canonical text of a definition (to compare two). */
export const definitionKey = (d: AudienceDefinition): string => JSON.stringify({
  s: d.segments.map(segmentKey).sort(),
  a: d.ages ? { r: d.ages.ranges.map((r) => `${r.min}-${r.max ?? ''}`).sort(), u: d.ages.includeUndetermined } : null,
  g: d.genders ? { v: [...d.genders.values].sort(), u: d.genders.includeUndetermined } : null,
  i: d.incomes ? { v: [...d.incomes.values].sort(), u: d.incomes.includeUndetermined } : null,
  p: d.parental ? { v: [...d.parental.values].sort(), u: d.parental.includeUndetermined } : null,
  x: [...d.excludeUserLists].sort(),
  o: d.other,
})

const isProblem = (v: unknown): v is { problem: string } => !!v && typeof v === 'object' && 'problem' in v

function partOf<T extends string>(ask: Part<T> | undefined, now: DemographicPart<T> | null, what: string): DemographicPart<T> | null | { problem: string } {
  if (ask === undefined) return now
  if (ask === null) return null
  const values = [...new Set(ask.values)].sort() as T[]
  const includeUndetermined = ask.includeUndetermined === true
  if (!values.length && !includeUndetermined) return { problem: `${what} names no value (null leaves the dimension out)` }
  return { values, includeUndetermined }
}

/** The definition a request makes (create: from nothing; change: from what is there). */
export function definitionFrom(ask: DefinitionAsk, now: AudienceDefinition | null): AudienceDefinition | { problem: string } {
  const base: AudienceDefinition = now ? structuredClone(now) : { segments: [], ages: null, genders: null, incomes: null, parental: null, excludeUserLists: [], other: [] }
  if (ask.segments !== undefined) {
    const seen = new Map<string, SegmentRef>()
    for (const s of ask.segments) seen.set(segmentKey(s), { kind: s.kind, id: s.id.trim() })
    base.segments = [...seen.values()].sort((a, b) => segmentKey(a).localeCompare(segmentKey(b)))
  }
  if (ask.ages !== undefined) {
    if (ask.ages === null) base.ages = null
    else {
      const ranges = new Map<string, AgeRange>()
      for (const r of ask.ages.ranges) {
        if (!(AGE_MINS as readonly number[]).includes(r.min)) return { problem: `an age range starts at ${r.min}: Google takes 18, 25, 35, 45, 55 or 65` }
        if (r.max !== null && r.max !== undefined && (!(AGE_MAXES as readonly number[]).includes(r.max) || r.max <= r.min)) return { problem: `an age range ends at ${r.max}: Google takes 24, 34, 44, 54 or 64, above where it starts (none: no upper end)` }
        ranges.set(`${r.min}-${r.max ?? ''}`, { min: r.min, max: r.max ?? null })
      }
      if (!ranges.size && ask.ages.includeUndetermined !== true) return { problem: 'the age dimension names no range (null leaves it out)' }
      base.ages = { ranges: [...ranges.values()].sort((a, b) => a.min - b.min), includeUndetermined: ask.ages.includeUndetermined === true }
    }
  }
  const genders = partOf(ask.genders, base.genders, 'the gender dimension')
  if (isProblem(genders)) return genders
  base.genders = genders
  const incomes = partOf(ask.incomes, base.incomes, 'the household income dimension')
  if (isProblem(incomes)) return incomes
  base.incomes = incomes
  const parental = partOf(ask.parental, base.parental, 'the parental status dimension')
  if (isProblem(parental)) return parental
  base.parental = parental
  if (ask.excludeUserLists !== undefined) base.excludeUserLists = [...new Set(ask.excludeUserLists.map((id) => id.trim()))].sort()
  return base
}

/** Why a definition lets the audience hold more people than before (empty: it does not). */
export function widenReasons(was: AudienceDefinition, now: AudienceDefinition): string[] {
  const out: string[] = []
  const had = new Set(was.segments.map(segmentKey))
  const added = now.segments.filter((s) => !had.has(segmentKey(s)))
  if (was.segments.length && !now.segments.length) out.push('drops its segments (anyone, by its other dimensions)')
  else if (added.length && was.segments.length) out.push(`gets ${plural(added.length, 'more segment')}`)
  const part = <T extends string>(w: DemographicPart<T> | null, n: DemographicPart<T> | null, word: string) => {
    if (w && !n) out.push(`drops its ${word} dimension (every ${word})`)
    else if (w && n && (n.values.some((v) => !w.values.includes(v)) || (n.includeUndetermined && !w.includeUndetermined))) out.push(`takes in more ${word} groups`)
  }
  if (was.ages && !now.ages) out.push('drops its age dimension (every age)')
  else if (was.ages && now.ages) {
    const covers = (r: AgeRange, age: number) => age >= r.min && (r.max === null || age <= r.max)
    const wider = [18, 25, 35, 45, 55, 65].some((age) => now.ages!.ranges.some((r) => covers(r, age)) && !was.ages!.ranges.some((r) => covers(r, age)))
    if (wider || (now.ages.includeUndetermined && !was.ages.includeUndetermined)) out.push('takes in more ages')
  }
  part(was.genders, now.genders, 'gender')
  part(was.incomes, now.incomes, 'household income')
  part(was.parental, now.parental, 'parental status')
  const lifted = was.excludeUserLists.filter((id) => !now.excludeUserLists.includes(id))
  if (lifted.length) out.push(`no longer leaves out ${plural(lifted.length, 'user list')}`)
  return out
}

const definitionWords = (d: AudienceDefinition): string => [
  d.segments.length ? plural(d.segments.length, 'segment') : '',
  d.ages ? `ages ${d.ages.ranges.map((r) => `${r.min}${r.max ? `–${r.max}` : '+'}`).join(', ')}${d.ages.includeUndetermined ? ' (+ unknown)' : ''}` : '',
  d.genders ? `${d.genders.values.join('/') || 'no'} gender${d.genders.includeUndetermined ? ' (+ unknown)' : ''}` : '',
  d.incomes ? `${plural(d.incomes.values.length, 'income range')}${d.incomes.includeUndetermined ? ' (+ unknown)' : ''}` : '',
  d.parental ? `${d.parental.values.join('/') || 'no'} parental${d.parental.includeUndetermined ? ' (+ unknown)' : ''}` : '',
  d.excludeUserLists.length ? `leaves out ${plural(d.excludeUserLists.length, 'user list')}` : '',
].filter(Boolean).join('; ') || 'everyone'

export function reusableAudienceDraft(customer: string, request: ReusableAudienceRequest, live: ReusableAudienceLive): GoogleChangeDraft | { refusal: string } {
  const creates = request.create ?? []
  const changes = request.change ?? []
  if (!creates.length && !changes.length) return { refusal: 'Say what to change: create or change. (Google has no way to remove a reusable audience.)' }
  const byId = new Map(live.audiences.map((a) => [a.audienceId, a]))
  const taken = (name: string, except?: string) => live.audiences.some((a) => a.audienceId !== except && (a.name ?? '').trim().toLowerCase() === name.trim().toLowerCase())
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: ReusableAudienceRecord = { audiences: [], created: [] }
  const after: ReusableAudienceRecord = { audiences: [], created: [] }
  const newNames = new Set<string>()
  const unknown = (d: AudienceDefinition): string | null => {
    for (const s of d.segments) if (!(segmentKey(s) in live.segmentNames)) return `${SEGMENT_WORD[s.kind]} ${s.id} is not one Google knows for this account (google-ads-live view lookup lists them)`
    for (const id of d.excludeUserLists) if (!(segmentKey({ kind: 'USER_LIST', id }) in live.segmentNames)) return `user list ${id} is not one Google knows for this account`
    return null
  }

  for (const [i, c] of creates.entries()) {
    const name = c.name.trim()
    const what = `New audience "${name}"`
    if (!name || name.length > AUDIENCE_NAME_MAX) return { refusal: `An audience's name is 1 to ${AUDIENCE_NAME_MAX} characters.` }
    if (taken(name) || newNames.has(name.toLowerCase())) return { refusal: `${what}: an audience with this name exists (Google keeps audience names unique).` }
    newNames.add(name.toLowerCase())
    const d = definitionFrom(c, null)
    if ('problem' in d) return { refusal: `${what}: ${d.problem}.` }
    const problem = unknown(d)
    if (problem) return { refusal: `${what}: ${problem}.` }
    if (!d.segments.length && !d.ages && !d.genders && !d.incomes && !d.parental) return { refusal: `${what}: name at least one segment or demographic (an audience of nothing is everyone).` }
    const { dimensions, exclusionDimension } = definitionJson(customer, d)
    operations.push({ audienceOperation: { create: { name, ...(c.description?.trim() ? { description: c.description.trim() } : {}), dimensions, ...(d.excludeUserLists.length ? { exclusionDimension } : {}) } } })
    after.created.push({ audienceId: NEW_AUDIENCE(i + 1), name })
    lines.push([`new audience: ${name}`, null, definitionWords(d)])
  }
  if (creates.length) {
    warnings.push('A new audience reaches nobody until a Demand Gen ad group targets it or a Performance Max asset group takes it as a signal (set-google-campaign-type, set-google-pmax): that is where it can spend.')
    warnings.push('Google has no way to remove an audience: undo cannot take a new one away (it stays, used by nothing).')
  }

  const seen = new Set<string>()
  for (const ch of changes) {
    const a = byId.get(ch.audienceId)
    if (!a) return { refusal: `Audience ${ch.audienceId} is not in the account (or is removed). google-ads-query "SELECT audience.id, audience.name, audience.scope FROM audience WHERE audience.status = 'ENABLED'" lists them.` }
    if (seen.has(a.audienceId)) return { refusal: `Audience ${a.audienceId} is named twice.` }
    seen.add(a.audienceId)
    const what = `Audience "${a.name ?? a.audienceId}"`
    const was: ReusableAudienceFields = { audienceId: a.audienceId }
    const now: ReusableAudienceFields = { audienceId: a.audienceId }
    const body: Record<string, unknown> = { resourceName: `${customer}/audiences/${a.audienceId}` }
    const mask: string[] = []
    if (ch.name !== undefined) {
      const name = ch.name.trim()
      if (a.scope === 'ASSET_GROUP') return { refusal: `${what} belongs to one asset group (scope ASSET_GROUP): Google does not let its name be set ("Cannot be set or updated when scope is ASSET_GROUP").` }
      if (!name || name.length > AUDIENCE_NAME_MAX) return { refusal: `${what}: a name is 1 to ${AUDIENCE_NAME_MAX} characters.` }
      if (taken(name, a.audienceId) || newNames.has(name.toLowerCase())) return { refusal: `${what}: another audience is called "${name}".` }
      if (name === a.name) skipped.push(`${what}: the name is already "${name}".`)
      else { was.name = a.name; now.name = name; body.name = name; mask.push('name'); lines.push([`${a.name}: name`, a.name, name]) }
    }
    if (ch.description !== undefined) {
      const description = ch.description.trim()
      if (description === (a.description ?? '')) skipped.push(`${what}: the description is already so.`)
      else { was.description = a.description; now.description = description; body.description = description; mask.push('description'); lines.push([`${a.name}: description`, a.description ?? '(none)', description || '(none)']) }
    }
    const touches = ch.segments !== undefined || ch.ages !== undefined || ch.genders !== undefined || ch.incomes !== undefined || ch.parental !== undefined || ch.excludeUserLists !== undefined
    if (touches) {
      const d = definitionFrom(ch, a.definition)
      if ('problem' in d) return { refusal: `${what}: ${d.problem}.` }
      const problem = unknown({ ...d, segments: d.segments.filter((s) => !a.definition.segments.some((x) => segmentKey(x) === segmentKey(s))), excludeUserLists: d.excludeUserLists.filter((id) => !a.definition.excludeUserLists.includes(id)) })
      if (problem) return { refusal: `${what}: ${problem}.` }
      if (!d.segments.length && !d.ages && !d.genders && !d.incomes && !d.parental && !d.other.length) return { refusal: `${what}: it would hold nothing (an audience of nothing is everyone). Keep a segment or a demographic.` }
      if (definitionKey(d) === definitionKey(a.definition)) skipped.push(`${what}: it is already made of exactly this.`)
      else {
        const { dimensions, exclusionDimension } = definitionJson(customer, d)
        body.dimensions = dimensions
        mask.push('dimensions')
        if (d.excludeUserLists.join(',') !== a.definition.excludeUserLists.join(',')) { body.exclusionDimension = exclusionDimension; mask.push('exclusion_dimension') }
        was.definition = a.definition
        now.definition = d
        lines.push([`${a.name}: made of`, definitionWords(a.definition), definitionWords(d)])
        const places = placesOf(live, 'AUDIENCE', a.audienceId).positive
        const reasons = widenReasons(a.definition, d)
        if (reasons.length) {
          const out = widenLines(what, reasons.join(', '), places)
          spends.push(...out.spends)
          warnings.push(...out.warnings)
        } else warnings.push(...narrowLine(what, 'holds fewer people', places))
      }
    }
    if (!mask.length) continue
    operations.push({ audienceOperation: { update: body, updateMask: mask.join(',') } })
    before.audiences.push(was)
    after.audiences.push(now)
  }

  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ') || 'every audience is already so.'}` }
  const { changes: table, more } = changeLines(lines)
  const parts = [after.created.length ? `make ${plural(after.created.length, 'audience')}` : '', after.audiences.length ? `change ${plural(after.audiences.length, 'audience')}` : ''].filter(Boolean)
  return {
    summary: `${parts.join(' and ').replace(/^./, (c) => c.toUpperCase())}.`,
    changes: table,
    totals: { created: after.created.length, changed: after.audiences.length, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      audiences: live.audiences.filter((a) => seen.has(a.audienceId)).map((a) => `${a.audienceId}:${a.name}:${a.description ?? ''}:${a.scope}:${definitionKey(a.definition)}`).sort(),
      names: creates.length || changes.some((c) => c.name !== undefined) ? live.audiences.map((a) => (a.name ?? '').toLowerCase()).sort() : [],
      uses: [...seen].sort().map((id) => `${id}:${placeKeys(placesOf(live, 'AUDIENCE', id)).join(',')}`),
    },
    before,
    after,
  }
}

/** After the run: the ids Google gave the audiences it made (audience_result, in create order — creates go first). */
export function reusableAudienceRecordAfterRun(after: ReusableAudienceRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): ReusableAudienceRecord {
  const made = responses.map((r) => r.audienceResult?.resourceName)
  const out = structuredClone(after)
  out.created = out.created.map((c, i) => {
    const name = made[i]
    return name ? { ...c, audienceId: name.slice(name.lastIndexOf('/') + 1) } : c
  })
  return out
}
