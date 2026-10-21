/**
 * Meta ads step 20 (2026-10-21) — what set-meta-targeting, set-meta-placements and set-meta-account-controls read LIVE
 * before they are built (GET only, through the gateway). Built on what is merged — never a copy:
 *   - one ad set with its whole targeting (Q7: targeting-merge.ts readAdSetTargeting) — only an ad set of the chosen ad
 *     account (account_id, and the two fields only an ad set has: services/meta/meta-kinds.ts), with its campaign's status,
 *     objective, special ad categories and Advantage+ state (step 18's read of advantage_state_info, live-settings.ts),
 *     its EU payer / beneficiary and, for placements, its limited spend on excluded placements (placement_soft_opt_out,
 *     placement-targeting.md "Retrieve limited spend settings": its own read, so a refusal never costs the ad set's read)
 *   - the ad account's controls (reference/ad-account/account_controls.md GET: AdAccountBusinessConstraints audience_controls,
 *     placement_controls, status; placement_controls_per_objective is SDK only and read on its own) — AS META HOLDS THEM:
 *     a POST replaces them whole, so a change sends them back with only the named parts changed
 * The account's EU defaults (live-create.ts liveDsaDefaults), whether a campaign delivers (live-brand-safety.ts
 * accountDelivering), the WhatsApp marketing messages state (live-create.ts liveWhatsAppMarketing) and the chosen Page
 * (live-create.ts liveChosenPage) are step 19's and 39's reads, used as they are.
 */
import { metaAdAccountId } from '../../cx/connectors/meta/discovery.js'
import { MetaReadError } from './errors.js'
import { MetaLiveRefusal } from './live.js'
import { CAMPAIGN_ADVANTAGE_FIELDS, fieldRefused } from './live-objects.js'
import { metaReadOne } from './read-client.js'
import { readAdSetTargeting } from './targeting-merge.js'
import type { MetaChangeAccount } from './change-account.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const strings = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null)

export interface TargetingCampaignState {
  id: string | null
  name: string | null
  status: string | null
  objective: string | null
  specialAdCategories: string[] | null
  /** advantage_state_info.advantage_state (ADVANTAGE_PLUS_SALES, …, DISABLED); null when Meta did not answer it. */
  advantageState: string | null
}

export interface TargetingAdSetState {
  id: string
  name: string | null
  /** Its own status (ACTIVE, PAUSED, …). */
  status: string | null
  optimizationGoal: string | null
  destinationType: string | null
  dsaPayor: string | null
  dsaBeneficiary: string | null
  campaign: TargetingCampaignState | null
  /** The live targeting spec, exactly as Meta answered it. */
  targeting: Row
  /** placement_soft_opt_out as Meta answered it (null: none set); `unread` with Meta's words when it refused the field. */
  softOptOut?: Row | null | { unread: string }
}

const ADSET_FIELDS = ['id', 'name', 'account_id', 'status', 'optimization_goal', 'billing_event', 'destination_type', 'dsa_payor', 'dsa_beneficiary', 'campaign{id,name,status,objective,special_ad_categories}']

/** One ad set of the chosen ad account with its whole live targeting — refused in words when it is not one. */
export async function liveTargetingAdSet(account: MetaChangeAccount, adSetId: string, opts: { softOptOut?: boolean } = {}): Promise<TargetingAdSetState> {
  let read
  try {
    read = await readAdSetTargeting(account.accountId, adSetId, ADSET_FIELDS, 'targeting.change.adSet')
  } catch (err) {
    if (err instanceof MetaReadError) {
      if (err.failure.origin === 'meta' && /nonexisting field/i.test(err.failure.sentence)) throw new MetaLiveRefusal(`${adSetId} is not an ad set of the chosen ad account (Meta does not know an ad set's own fields on it).`)
      throw new MetaLiveRefusal(`Nexus could not read ad set ${adSetId} (${err.failure.sentence}), so nothing was asked of Meta.`)
    }
    throw err
  }
  const node = read.node
  if (metaAdAccountId(node.account_id) !== account.adAccountId) throw new MetaLiveRefusal(`Ad set ${adSetId} does not belong to the ad account this business chose, so Nexus changes nothing on it.`)
  if (!text(node.optimization_goal) || !text(node.billing_event)) throw new MetaLiveRefusal(`${adSetId} is not an ad set of the chosen ad account.`)
  const c = obj(node.campaign)
  const campaignId = text(c?.id)
  let advantageState: string | null = null
  if (campaignId) {
    // Step 18 — advantage_state_info in a read of its own (some accounts are refused it: then it stays unknown).
    try {
      const adv = await metaReadOne({ connectionId: account.accountId }, { operation: 'targeting.change.campaignAdvantage', path: campaignId, query: { fields: CAMPAIGN_ADVANTAGE_FIELDS } })
      advantageState = text(obj((adv.body as Row).advantage_state_info)?.advantage_state)
    } catch (err) {
      if (!(err instanceof MetaReadError) || err.failure.authLost || err.failure.throttled) throw err
    }
  }
  const state: TargetingAdSetState = {
    id: adSetId,
    name: text(node.name),
    status: text(node.status),
    optimizationGoal: text(node.optimization_goal),
    destinationType: text(node.destination_type),
    dsaPayor: text(node.dsa_payor),
    dsaBeneficiary: text(node.dsa_beneficiary),
    campaign: c ? { id: campaignId, name: text(c.name), status: text(c.status), objective: text(c.objective), specialAdCategories: strings(c.special_ad_categories), advantageState } : null,
    targeting: read.targeting,
  }
  if (opts.softOptOut) state.softOptOut = await liveSoftOptOut(account, adSetId)
  return state
}

/** An ad set's placement_soft_opt_out (null: none), or `unread` with Meta's words when it refused the field. */
export async function liveSoftOptOut(account: MetaChangeAccount, adSetId: string): Promise<Row | null | { unread: string }> {
  try {
    const read = await metaReadOne({ connectionId: account.accountId }, { operation: 'targeting.change.softOptOut', path: adSetId, query: { fields: 'id,placement_soft_opt_out' } })
    return obj((read.body as Row).placement_soft_opt_out)
  } catch (err) {
    if (err instanceof MetaReadError && fieldRefused(err)) return { unread: err.failure.sentence }
    if (err instanceof MetaReadError) throw new MetaLiveRefusal(`Nexus could not read ad set ${adSetId}'s limited spend on excluded placements (${err.failure.sentence}), so nothing was asked of Meta.`)
    throw err
  }
}

export interface AccountControlsState {
  /** Whether the account has controls at all (Meta answered a row). */
  exists: boolean
  /** audience_controls and placement_controls exactly as Meta answered them (null: none). */
  audience: Row | null
  placement: Row | null
  status: string | null
  /** placement_controls_per_objective (SDK only): null when none, `unread` when Meta refused the field. */
  perObjective: unknown | null | { unread: string }
}

/** The ad account's controls as Meta holds them (one row: Meta keeps one set per account). */
export async function liveAccountControls(account: MetaChangeAccount): Promise<AccountControlsState> {
  const path = `act_${account.adAccountId}/account_controls`
  let body: Row
  try {
    body = (await metaReadOne({ connectionId: account.accountId }, { operation: 'accountControls.read', path, query: { fields: 'audience_controls,placement_controls,status' } })).body as Row
  } catch (err) {
    if (err instanceof MetaReadError) throw new MetaLiveRefusal(`Nexus could not read the ad account's controls (${err.failure.sentence}), so nothing was asked of Meta.`)
    throw err
  }
  const rows = Array.isArray(body.data) ? body.data.filter((r): r is Row => !!obj(r)) : []
  if (rows.length > 1) throw new MetaLiveRefusal('Meta answered more than one set of account controls: Nexus cannot tell which one a new POST replaces, so it changes none (Ads Manager › Advertising settings shows them).')
  const row = rows[0] ?? null
  let perObjective: AccountControlsState['perObjective'] = null
  if (row) {
    try {
      const extra = (await metaReadOne({ connectionId: account.accountId }, { operation: 'accountControls.readPerObjective', path, query: { fields: 'placement_controls_per_objective' } })).body as Row
      const first = Array.isArray(extra.data) ? obj(extra.data[0]) : null
      const v = first?.placement_controls_per_objective
      perObjective = v === undefined || v === null || (obj(v) && !Object.keys(obj(v)!).length) ? null : v
    } catch (err) {
      if (!(err instanceof MetaReadError)) throw err
      perObjective = { unread: err.failure.sentence }
    }
  }
  return { exists: !!row, audience: obj(row?.audience_controls), placement: obj(row?.placement_controls), status: text(row?.status), perObjective }
}
