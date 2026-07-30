/**
 * AX-VT.4 — launch verification: intended vs observed, per entity, per field.
 *
 * The original bug was not that a write failed. It was that every layer reported success and
 * nobody had ever compared the result to the request. The wizard checked
 * `if (!camp.externalCampaignId)` — it verified that a campaign EXISTED, never what it looked
 * like — so 11 campaigns sat outside their portfolio behind eleven green ticks.
 *
 * AX-VT.1 closed that for one field. This closes it for the shape of a launch: campaign
 * settings, ad-group bids, target bids and match types, and which ads actually exist. A launch
 * can now say "created AS SPECIFIED" instead of "created".
 *
 * Pure: no I/O, no Prisma, no Amazon. The service layer fetches both sides and calls in here,
 * which is what makes the interesting cases testable without a live account.
 *
 * Comparison deliberately reuses `normaliseForCompare` from drift.ts so "20" and "20.00", and
 * "ENABLED" and "enabled", never read as a mismatch — the same rule the drift detector uses.
 * One notion of "different" across the whole ads subsystem.
 */
import { normaliseForCompare } from './drift.js'

export type LaunchEntityType = 'CAMPAIGN' | 'AD_GROUP' | 'KEYWORD' | 'TARGET' | 'PRODUCT_AD'

/**
 * NOT_PUSHED and MISSING_ON_AMAZON are different failures with different fixes, and collapsing
 * them is what made the original bug hard to see:
 *
 *   NOT_PUSHED         we hold no external id — the create never happened (write gate closed,
 *                      campaign not allowlisted, or the create was rejected). Fix: push it.
 *   MISSING_ON_AMAZON  we hold an id and Amazon does not return the entity — it was deleted
 *                      on Amazon, or the id we stored is wrong. Fix: investigate, don't retry.
 */
export type LaunchVerdict = 'VERIFIED' | 'MISMATCH' | 'MISSING_ON_AMAZON' | 'NOT_PUSHED'

export interface FieldDelta { field: string; intended: string | null; observed: string | null }

export interface LaunchEntityResult {
  entityType: LaunchEntityType
  localId: string
  externalId: string | null
  label: string
  verdict: LaunchVerdict
  deltas: FieldDelta[]
}

export interface LaunchVerificationSummary {
  ok: boolean
  total: number
  verified: number
  mismatch: number
  missingOnAmazon: number
  notPushed: number
}

/** One local entity plus whatever Amazon returned for it (undefined = Amazon has no such id). */
export interface EntityPair {
  entityType: LaunchEntityType
  localId: string
  externalId: string | null
  label: string
  /** Fields we asked Amazon for, keyed by field name. */
  intended: Record<string, unknown>
  /**
   * What Amazon reports. `undefined` means the entity was absent from the read entirely — NOT
   * that its fields are empty. A field missing from a present entity is skipped rather than
   * called a mismatch, for the same reason drift skips it: a partial response must never look
   * like somebody blanking a value.
   */
  observed: Record<string, unknown> | undefined
}

/**
 * Compare one entity. A field is only compared when Amazon actually reported it AND we hold an
 * intended value — asymmetric on purpose, mirroring diffFields.
 *
 * `nullIsMeaningful` names the fields where Amazon reporting *nothing* is a real answer worth
 * flagging rather than a gap in the response. `portfolioId` is the reason this parameter exists:
 * null there means "in no portfolio", which is precisely the state that went unnoticed.
 */
export function verifyEntity(pair: EntityPair, nullIsMeaningful: readonly string[] = []): LaunchEntityResult {
  const base = {
    entityType: pair.entityType, localId: pair.localId,
    externalId: pair.externalId, label: pair.label,
  }
  if (!pair.externalId) return { ...base, verdict: 'NOT_PUSHED', deltas: [] }
  if (pair.observed === undefined) return { ...base, verdict: 'MISSING_ON_AMAZON', deltas: [] }

  const nullMeans = new Set(nullIsMeaningful)
  const deltas: FieldDelta[] = []
  for (const [field, rawIntended] of Object.entries(pair.intended)) {
    const intended = normaliseForCompare(rawIntended)
    if (intended == null) continue // we never specified it — nothing to hold Amazon to
    if (!(field in pair.observed)) continue // Amazon didn't report it
    const rawObserved = pair.observed[field]
    const observed = normaliseForCompare(rawObserved)
    if (observed == null) {
      if (!nullMeans.has(field) || rawObserved === undefined) continue
      deltas.push({ field, intended, observed: null })
      continue
    }
    if (intended !== observed) deltas.push({ field, intended, observed })
  }
  return { ...base, verdict: deltas.length ? 'MISMATCH' : 'VERIFIED', deltas }
}

export function summarise(results: LaunchEntityResult[]): LaunchVerificationSummary {
  const s: LaunchVerificationSummary = {
    ok: true, total: results.length, verified: 0, mismatch: 0, missingOnAmazon: 0, notPushed: 0,
  }
  for (const r of results) {
    if (r.verdict === 'VERIFIED') s.verified++
    else if (r.verdict === 'MISMATCH') s.mismatch++
    else if (r.verdict === 'MISSING_ON_AMAZON') s.missingOnAmazon++
    else s.notPushed++
  }
  s.ok = s.mismatch === 0 && s.missingOnAmazon === 0 && s.notPushed === 0
  return s
}

/**
 * Operator-facing wording. A receipt nobody can read is a receipt nobody checks, so each line
 * says what is wrong and whether it will fix itself.
 */
export function describeVerdict(r: LaunchEntityResult): string {
  const what = `${r.entityType.toLowerCase().replace('_', ' ')} "${r.label}"`
  switch (r.verdict) {
    case 'VERIFIED':
      return `${what} matches what was requested.`
    case 'MISMATCH':
      return `${what} exists on Amazon but ${r.deltas.map((d) => `${d.field} is ${d.observed ?? 'empty'}, not ${d.intended}`).join('; ')}.`
    case 'MISSING_ON_AMAZON':
      return `${what} has an Amazon id but Amazon does not return it — it was deleted there, or the stored id is wrong. This will not fix itself.`
    case 'NOT_PUSHED':
      return `${what} was saved locally but never reached Amazon — the write gate was closed or the create was rejected. It needs pushing.`
  }
}
