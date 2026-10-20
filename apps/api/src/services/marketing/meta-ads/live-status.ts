/**
 * Meta step 17 — the live state a status change stands on: each campaign, ad set or ad read from Meta now (GET through
 * the gateway), with the parents its spending depends on. Nothing here stores anything.
 *
 * One GET per object, with fields that only its kind has, so Meta itself confirms the kind (an id asked as the wrong kind
 * is answered "nonexisting field" — the item is then refused in words). Checked 2026-10-21 on
 * developers.facebook.com/documentation/ads-commerce/marketing-api/reference: ad-campaign-group.md (campaign: account_id,
 * objective, smart_promotion_type, status, effective_status), ad-campaign.md (ad set: campaign_id, end_time, campaign,
 * creative_sequence) and adgroup.md (ad: adset_id, adset, campaign). Meta's v26 removed the root `?ids=` read, so there is
 * no single read of several objects (facts F1 X6).
 */
import { metaAdAccountId } from '../../cx/connectors/meta/discovery.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'

export type MetaStatusKind = 'campaign' | 'adset' | 'ad'
export const META_STATUS_KINDS: readonly MetaStatusKind[] = ['campaign', 'adset', 'ad']

export interface MetaParentState { id: string; name: string | null; status: string | null; effectiveStatus: string | null }

export interface MetaStatusObject {
  kind: MetaStatusKind
  id: string
  name: string | null
  /** The ad account Meta says it belongs to (digits). */
  adAccountId: string | null
  /** The status set on it (ACTIVE, PAUSED, ARCHIVED, DELETED). */
  status: string | null
  /** What Meta makes of it with its parents (CAMPAIGN_PAUSED, ADSET_PAUSED, DISAPPROVED, …). */
  effectiveStatus: string | null
  /** A campaign: its objective and its legacy smart promotion type (AUTOMATED_SHOPPING_ADS = a legacy Advantage+ shopping campaign). */
  objective: string | null
  smartPromotionType: string | null
  /** An ad set: when it stops (ISO; null = no end). */
  endTime: string | null
  /** An ad set or an ad: its campaign. */
  campaign: MetaParentState | null
  /** An ad: its ad set, its end time and whether it shows its ads in a sequence (then Meta refuses a pause or archive). */
  adSet: (MetaParentState & { endTime: string | null; creativeSequence: boolean }) | null
}

/** Fields only that kind has (see the header): Meta's answer confirms the kind. */
export const STATUS_FIELDS: Readonly<Record<MetaStatusKind, string>> = {
  campaign: 'id,account_id,name,status,effective_status,objective,smart_promotion_type',
  adset: 'id,account_id,campaign_id,name,status,effective_status,end_time,campaign{id,name,status,effective_status}',
  ad: 'id,account_id,campaign_id,adset_id,name,status,effective_status,adset{id,name,status,effective_status,end_time,creative_sequence},campaign{id,name,status,effective_status}',
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v)) ? String(v) : null
const parentOf = (v: unknown): MetaParentState | null => {
  if (!v || typeof v !== 'object') return null
  const row = v as Record<string, unknown>
  const id = idOf(row.id)
  return id ? { id, name: text(row.name), status: text(row.status), effectiveStatus: text(row.effective_status) } : null
}

/** One object as Meta answered it. Pure. */
export function statusObjectOf(kind: MetaStatusKind, body: Record<string, unknown>): MetaStatusObject | null {
  const id = idOf(body.id)
  if (!id) return null
  const adSet = kind === 'ad' ? parentOf(body.adset) : null
  const rawSet = kind === 'ad' && body.adset && typeof body.adset === 'object' ? body.adset as Record<string, unknown> : null
  return {
    kind,
    id,
    name: text(body.name),
    adAccountId: metaAdAccountId(body.account_id),
    status: text(body.status),
    effectiveStatus: text(body.effective_status),
    objective: kind === 'campaign' ? text(body.objective) : null,
    smartPromotionType: kind === 'campaign' ? text(body.smart_promotion_type) : null,
    endTime: kind === 'adset' ? text(body.end_time) : null,
    campaign: kind === 'campaign' ? null : parentOf(body.campaign),
    adSet: adSet ? { ...adSet, endTime: text(rawSet?.end_time), creativeSequence: Array.isArray(rawSet?.creative_sequence) && rawSet!.creative_sequence.length > 0 } : null,
  }
}

export const KIND_WORD: Readonly<Record<MetaStatusKind, string>> = { campaign: 'campaign', adset: 'ad set', ad: 'ad' }
export const itemKey = (kind: string, id: string) => `${kind}:${id}`

/**
 * The live state of each item, read one by one from Meta. An item Meta does not answer for, answers as another kind, or
 * places in another ad account than the chosen one is a problem in words (never read further, never changed).
 */
export async function liveStatusObjects(
  target: { connectionId: string; adAccountId: string },
  items: ReadonlyArray<{ kind: MetaStatusKind; id: string }>,
): Promise<{ objects: Map<string, MetaStatusObject>; problems: string[] }> {
  const objects = new Map<string, MetaStatusObject>()
  const problems: string[] = []
  for (const item of items) {
    const key = itemKey(item.kind, item.id)
    if (objects.has(key)) continue
    const what = `${KIND_WORD[item.kind]} ${item.id}`
    try {
      const read = await metaReadOne({ connectionId: target.connectionId }, { operation: `status.read.${item.kind}`, path: item.id, query: { fields: STATUS_FIELDS[item.kind] } })
      const object = statusObjectOf(item.kind, read.body as Record<string, unknown>)
      if (!object) { problems.push(`Meta did not answer for ${what} as a ${KIND_WORD[item.kind]}.`); continue }
      if (object.adAccountId !== target.adAccountId) { problems.push(`${what} is not of the Meta ad account this business chose: Nexus changes nothing in another account.`); continue }
      objects.set(key, object)
    } catch (err) {
      if (!(err instanceof MetaReadError)) throw err
      const wrongKind = /nonexisting field/i.test(err.message)
      problems.push(wrongKind
        ? `${item.id} is not a ${KIND_WORD[item.kind]} (Meta: ${err.message}); name its kind as meta-ads-live shows it.`
        : `Nexus could not read ${what} from Meta: ${err.message}`)
      // A lost token or Meta's "slow down" ends the reading: the next items would get the same answer.
      if (err.failure.authLost || err.failure.throttled) break
    }
  }
  return { objects, problems }
}
