/**
 * Meta step 40 (2026-10-21) — the chosen ad account's own settings as a CHANGE stands on them (set-meta-account-settings,
 * set-meta-spend-cap, set-meta-insights-features): read live through the gateway (GET only), raw as Meta sends them, so
 * the preview, the re-check, the run and undo compare the same values. Step 3's reads answer people (live-account.ts);
 * this is the change's own read of the same fields, and it reuses step 3 for the insights features (adAccountView) and
 * its agency-declaration field list; the tracking specs are read here in full (to MAX_TRACKING_SPECS + 1).
 *
 * Every read here asks account_status and disable_reason first: a change of a disabled, closing, closed or compromised ad
 * account is refused before anything is sent (change-account-settings.ts metaAccountChangeRefusal) — at the preview, at the
 * approval's re-check and again when the approved change runs (the kit builds it again from this read).
 */
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { graphSafe, metaChosenAccount, MetaLiveRefusal } from './live.js'
import { listPaged } from './paging.js'
import { adAccountView, AGENCY_DECLARATION_FIELDS } from './live-account.js'
import { MAX_TRACKING_SPECS, META_BUSINESS_INFO_KEYS } from '../../gateway/meta-account-settings-rules.js'
import type { MetaWriteTarget } from './write-client.js'

type Row = Record<string, unknown>

/** The account's fields a step-40 change reads (v26 Reading table of reference/ad-account; step 3 reads the same). */
export const ACCOUNT_CHANGE_FIELDS = [
  'id', 'account_status', 'disable_reason', 'currency', 'name', ...META_BUSINESS_INFO_KEYS, 'is_personal', 'tax_id_status',
  'default_dsa_payor', 'default_dsa_beneficiary', 'is_notifications_enabled', 'end_advertiser', 'media_agency', 'partner', 'spend_cap', 'amount_spent',
].join(',')

export interface LiveAccountState {
  adAccountId: string
  status: number | null
  disableReason: number | null
  currency: string | null
  name: string | null
  /** business_* → its value ('' / missing → null). */
  businessInfo: Record<string, string | null>
  /** Meta says the account is for business use (is_personal 0 and no personal tax status): only then is its address a business's. */
  businessUse: boolean
  dsa: { payor: string | null; beneficiary: string | null }
  notifications: boolean | null
  parties: { end_advertiser: string | null; media_agency: string | null; partner: string | null }
  /**
   * spend_cap / amount_spent exactly as Meta READS them (offset units, numeric strings). Fix round 1 (A-F1): spend_cap is
   * null ONLY when Meta did not send it; any value it sent stays visible as text — a number past 2^53 as `unsafe:<value>` —
   * so a cap Nexus cannot read is never mistaken for "no limit" (change-account-settings.ts refuses it).
   */
  spendCap: string | null
  amountSpent: string | null
  /** The chosen Facebook Page of this business's Meta connection (null: none chosen). */
  pageId: string | null
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
/** Meta's ids and amounts may come as numbers or strings: always the string. */
const idOrText = (v: unknown): string | null => (typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : text(v))
/** Fix round 1 (A-F1) — a value Meta sent, never dropped: a safe integer or text as it came; anything else marked unreadable. */
const sentValue = (v: unknown): string | null => {
  if (v === undefined || v === null) return null
  if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) : `unsafe:${String(v)}`
  return typeof v === 'string' ? v : `unreadable:${typeof v}`
}
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : num(v) === null ? null : num(v) !== 0)

/** The chosen ad account's own settings, raw. The target must be the business's chosen account (it always is: change-account.ts). */
export async function liveAccountState(target: MetaWriteTarget): Promise<LiveAccountState> {
  const chosen = await metaChosenAccount(target.connectionId)
  if (chosen.adAccountId !== target.adAccountId) throw new MetaLiveRefusal('The Meta ad account this business chose changed while Nexus read it: ask again.')
  const read = await metaReadOne({ connectionId: target.connectionId }, { operation: 'accountChange.read', path: `act_${target.adAccountId}`, query: { fields: ACCOUNT_CHANGE_FIELDS } })
  const b = (read.body ?? {}) as Row
  return {
    adAccountId: target.adAccountId,
    status: num(b.account_status),
    disableReason: num(b.disable_reason),
    currency: text(b.currency),
    name: text(b.name),
    businessInfo: Object.fromEntries(META_BUSINESS_INFO_KEYS.map((k) => [k, text(b[k])])),
    businessUse: flag(b.is_personal) === false && num(b.tax_id_status) !== 5,
    dsa: { payor: text(b.default_dsa_payor), beneficiary: text(b.default_dsa_beneficiary) },
    notifications: typeof b.is_notifications_enabled === 'boolean' ? b.is_notifications_enabled : null,
    parties: { end_advertiser: idOrText(b.end_advertiser), media_agency: idOrText(b.media_agency), partner: idOrText(b.partner) },
    spendCap: sentValue(b.spend_cap),
    amountSpent: idOrText(b.amount_spent),
    pageId: chosen.pageId,
  }
}

/** The agency declaration's sub-fields Nexus reads and writes (step 3's list; never client_email_address). */
const AGENCY_SUBFIELDS = AGENCY_DECLARATION_FIELDS.replace(/^agency_client_declaration\{|\}$/g, '').split(',')

/**
 * AA-048 — the account's agency declaration as Meta reads it ({key: value as a string}; Meta's 0 / 1 flags as "0" / "1"),
 * or why it could not be read (Meta answers it only to a Business Manager admin). An empty object: none declared.
 */
export async function liveAgencyDeclaration(target: MetaWriteTarget): Promise<{ declaration: Record<string, string> } | { notRead: string }> {
  try {
    const read = await metaReadOne({ connectionId: target.connectionId }, { operation: 'accountChange.agencyDeclaration', path: `act_${target.adAccountId}`, query: { fields: AGENCY_DECLARATION_FIELDS } })
    const d = ((read.body ?? {}) as Row).agency_client_declaration
    const declaration: Record<string, string> = {}
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const key of AGENCY_SUBFIELDS) {
        const v = (d as Row)[key]
        if (typeof v === 'boolean') declaration[key] = v ? '1' : '0'
        else if (typeof v === 'number' && Number.isFinite(v)) declaration[key] = String(v)
        else if (typeof v === 'string' && v !== '') declaration[key] = v
      }
    }
    return { declaration }
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return { notRead: `${err.message} (Meta answers the agency declaration only to a Business Manager admin.)` }
    throw err
  }
}

/**
 * AA-054 — the account-level tracking specs, as Meta reads them (GET act_<id>/tracking tracking_specs, the same edge and
 * field as step 3's view tracking). Last pass — read to one past the most a change sends (MAX_TRACKING_SPECS + 1), and
 * REFUSED when Meta holds more than that or says there are more: a change and its undo are never judged on part of the list
 * (step 3's view reads 10 for people; a change needs all of them).
 */
export async function liveTrackingSpecs(target: MetaWriteTarget): Promise<unknown[]> {
  const read = await listPaged(target.connectionId, 'accountChange.tracking', `act_${target.adAccountId}/tracking`, { fields: 'tracking_specs' }, MAX_TRACKING_SPECS + 1)
  if (read.more || read.rows.length > MAX_TRACKING_SPECS) {
    throw new MetaLiveRefusal(`The ad account holds more than ${MAX_TRACKING_SPECS} account-level tracking specs: Nexus changes them only when it can read the whole list (at most ${MAX_TRACKING_SPECS}). Change them in Ads Manager.`)
  }
  return read.rows.map((r) => (r.tracking_specs === undefined || r.tracking_specs === null ? null : graphSafe(r.tracking_specs))).filter((s) => s !== null)
}

/** IN-051 — one insights feature: offered on this account, switched on, from which day (step 3's view insights-features). */
export interface LiveInsightsFeature { name: string; offered: boolean | null; enabled: boolean | null; dataFrom: string | null }

export async function liveInsightsFeature(target: MetaWriteTarget, feature: string): Promise<LiveInsightsFeature> {
  const view = await adAccountView({ connectionId: target.connectionId, view: 'insights-features', feature }) as {
    features?: Array<{ name: string; type: string | null; enabled: boolean | null; dataFrom: string | null }>
    missing?: Array<{ part: string }>
  }
  const row = (view.features ?? []).find((f) => f.name === feature)
  const availableRead = !(view.missing ?? []).some((m) => m.part === 'available')
  const enabledRead = !(view.missing ?? []).some((m) => m.part === 'enabled')
  return {
    name: feature,
    // Step 3's view lists every feature list-features names and every one switched on: listed = offered (with or without
    // its feature_type); not listed while list-features was read = not offered; list-features not read: null.
    offered: availableRead ? row !== undefined : null,
    enabled: enabledRead ? row?.enabled === true : null,
    dataFrom: row?.dataFrom ?? null,
  }
}
