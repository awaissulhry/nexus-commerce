/**
 * Meta ads Q7 (step 39, 2026-10-21; for lane C1's step 20 to REUSE, never a second one) — change an ad set's targeting
 * one key at a time. Meta's ad set update takes `targeting` only as the WHOLE spec (`POST /{adset_id} targeting=<JSON>`:
 * reference/ad-campaign.md "Updating" sends a whole spec; whether Meta merges a partial one is undocumented — facts F1
 * M4 "Full spec on update"), so a change of a few keys must send everything else exactly as Meta has it now:
 *
 *   readAdSetTargeting   ONE live read of the ad set (through the read client and the gateway): its `targeting` and the
 *                        fields the caller also needs; refused in words when Meta answers no targeting, or one holding a
 *                        number JavaScript cannot carry exactly (an id written as a number would be sent back changed)
 *   mergeTargeting       the spec to send: every top-level key as read, the named keys set (null = removed), Meta's
 *                        read-only `effective_…` keys left out; plus each named key's before → after and the one JSON
 *                        string sent (Nexus's canonical spelling, which the gateway's rule requires)
 *
 * The gateway does not trust the caller: for a rule with `targeting` keys (gateway/meta-calls.ts MetaWriteRule) it reads
 * the ad set's live targeting itself and refuses any other key that is not exactly Meta's (gateway/meta-brand-safety-
 * rules.ts targetingOutsideProblem). A step that adds targeting keys adds its own rule with its own key set and judges.
 * Every targeting change sends the ad set's ads back to Meta's review (best-practices.md "Ad changes triggering ad
 * reviews"): the caller's preview says so.
 */
import { holdsInexactNumber, isReadOnlyTargetingKey, sameJson } from '../../gateway/meta-brand-safety-rules.js'
import { MetaLiveRefusal } from './live.js'
import { metaReadOne } from './read-client.js'

export interface AdSetTargetingRead {
  /** The ad set as Meta answered it (the caller's fields and `targeting`). */
  node: Record<string, unknown>
  /** Its live targeting spec, exactly as Meta answered it. */
  targeting: Record<string, unknown>
}

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One live read of an ad set with its targeting (MetaReadError when Meta refuses; MetaLiveRefusal when it is unusable). */
export async function readAdSetTargeting(connectionId: string, adSetId: string, fields: readonly string[] = [], operation = 'targeting.read'): Promise<AdSetTargetingRead> {
  const asked = [...new Set([...fields.filter((f) => f !== 'targeting'), 'targeting'])].join(',')
  const { body } = await metaReadOne<Record<string, unknown>>({ connectionId }, { operation, path: adSetId, query: { fields: asked } })
  const targeting = body.targeting
  if (!plainObject(targeting)) throw new MetaLiveRefusal(`Meta answered no targeting for ad set ${adSetId}, so Nexus cannot change one part of it and keep the rest exactly as it is.`)
  if (holdsInexactNumber(targeting)) throw new MetaLiveRefusal(`Ad set ${adSetId}'s targeting holds a number Nexus cannot carry exactly, so Nexus does not send its targeting back (change it in Ads Manager).`)
  return { node: body, targeting }
}

export interface TargetingMerge {
  /** The whole spec to send. */
  spec: Record<string, unknown>
  /** The spec as the one JSON string sent (`targeting=` of the form body). */
  sent: string
  /** Each named key whose value moves: before → after (null: not set). */
  changed: Array<{ key: string; from: unknown; to: unknown }>
}

/**
 * The live spec with only the named top-level keys set (`null` removes one), read-only `effective_…` keys left out, every
 * other key exactly as read and in its place.
 */
export function mergeTargeting(live: Record<string, unknown>, set: Readonly<Record<string, unknown>>): TargetingMerge {
  for (const key of Object.keys(set)) if (isReadOnlyTargetingKey(key)) throw new MetaLiveRefusal(`targeting.${key} is read-only on Meta: Nexus never sends it.`)
  const spec: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(live)) {
    if (isReadOnlyTargetingKey(key)) continue
    if (Object.prototype.hasOwnProperty.call(set, key)) {
      if (set[key] !== null && set[key] !== undefined) spec[key] = set[key]
      continue
    }
    spec[key] = value
  }
  for (const [key, value] of Object.entries(set)) {
    if (!Object.prototype.hasOwnProperty.call(live, key) && value !== null && value !== undefined) spec[key] = value
  }
  const changed = Object.keys(set)
    .map((key) => ({ key, from: Object.prototype.hasOwnProperty.call(live, key) ? live[key] : null, to: set[key] ?? null }))
    .filter((c) => !sameJson(c.from, c.to))
  return { spec, sent: JSON.stringify(spec), changed }
}
