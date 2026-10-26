/**
 * Meta step 43 (2026-10-26) — create-meta-backed-account's and set-meta-billing's writes on the write allow-list: ONE rule
 * per change, each with its EXACT path, keys and judged values, and its own kind of object (MetaBusinessAssetKind), so it
 * matches only a call of these two tools. The gateway then sends the write to meta-business-asset-owner.ts, which confirms
 * with its own reads that the object is the business's CHOSEN Page or Instagram account, or a credit line / invoice group of
 * the chosen ad account's OWN portfolio (no other business in Nexus uses it), and that the ad account in the body is the
 * chosen one — before anything is sent.
 *
 * Import rule (step 34's, lane C4): this file imports no VALUE from meta-settings-rules.ts or meta-calls.ts (their sleeping
 * import cycle): only types and the leaf meta-write-text.ts.
 *
 * Checked 2026-10-26 (marketing/meta-ads/change-business-assets.ts has the sources):
 *   - BM-051 POST /{page_id}/page_backed_instagram_accounts — no parameters (the Instagram ads guide's curl sends only the
 *     token); CR-228 POST /{ig_user_id}/instagram_backed_threads_user and CR-230 POST /{page_id}/page_backed_threads_accounts
 *     — no parameters (Threads ads guide). Each answers the new id, or the existing one.
 *   - BM-903 POST /{extended_credit_id}/extended_credit_invoice_groups name (+ emails: never sent — Nexus takes no e-mail
 *     address), SDK only; BM-904 POST /{invoice_group_id} name (+ emails: never sent); BM-905 POST
 *     /{invoice_group_id}/ad_accounts ad_account_id (SDK only); BM-906 DELETE /{invoice_group_id}/ad_accounts ad_account_id
 *     [required]; BM-907 DELETE /{invoice_group_id} (no parameters). `ad_account_id` is sent as act_<id> (the ad account's
 *     own id: "The id of the ad account"); LIVE-PROBES MS43-… settles whether Meta also takes the bare digits.
 * No rule takes execution_options: Meta documents validate_only on none of these edges.
 */
import type { MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT } from './meta-write-text.js'

/**
 * Step 43 — what only create-meta-backed-account and set-meta-billing name: the chosen Page (`backedpage`) or Instagram
 * account (`backedinstagram`) a backed account is made for, a credit line a group is made on (`creditline`), an invoice
 * group (`invoicegroup`). Own kinds: no other tool's call on the same edge (a Page's, an ad account's) matches these rules.
 */
export type MetaBusinessAssetKind = 'backedpage' | 'backedinstagram' | 'creditline' | 'invoicegroup'
export const META_BUSINESS_ASSET_KINDS: ReadonlySet<string> = new Set<MetaBusinessAssetKind>(['backedpage', 'backedinstagram', 'creditline', 'invoicegroup'])
/** Step 43 — the edges these changes post to or delete on. */
export type MetaBusinessAssetEdge = 'page_backed_instagram_accounts' | 'instagram_backed_threads_user' | 'page_backed_threads_accounts' | 'extended_credit_invoice_groups' | 'ad_accounts'

type Params = ReadonlyMap<string, string>

const NODE = /^[1-9]\d{0,19}$/
const NODE_EDGE = (edge: string) => new RegExp(`^[1-9]\\d{0,19}\\/${edge}$`)
/** An invoice group's name: Meta documents no limit; Nexus sends at most 100 characters (the tool's own cap). */
export const META_INVOICE_GROUP_NAME_MAX = 100

function nameProblem(value: string): string | null {
  const length = [...value].length
  if (!length || value.trim() !== value) return 'name is a non-empty name with no space at either end'
  return length > META_INVOICE_GROUP_NAME_MAX ? `name is at most ${META_INVOICE_GROUP_NAME_MAX} characters` : null
}
const actId = (value: string): string | null => (/^act_[1-9]\d{0,24}$/.test(value) ? null : 'ad_account_id is the ad account\'s own id, act_ and its digits')

/** Each key's judge; a key without one is not of this change. */
function judged(judges: Record<string, (value: string) => string | null>) {
  return (params: Params): string | null => {
    for (const [key, value] of params) {
      const judge = judges[key]
      if (!judge) return `${key} is not a key of this change`
      const problem = judge(value)
      if (problem) return problem
    }
    return null
  }
}

/** A backed account's create: POST on the chosen Page's or Instagram account's own edge, with no body at all. */
const backed = (name: string, edge: MetaBusinessAssetEdge, kind: MetaBusinessAssetKind): MetaWriteRule => ({
  name, method: 'POST', path: NODE_EDGE(edge), kinds: [kind], required: [], optional: [], emptyBody: true, values: () => null, budget: false,
  // A create on an edge edits no object: Meta's one-edit-per-object gap does not hold it.
  edgeCall: true,
})

/** Step 43's rules on the write allow-list (meta-calls.ts writeRules). */
export const META_BUSINESS_ASSET_WRITE_RULES: readonly MetaWriteRule[] = [
  backed('assets.backed.instagramForPage', 'page_backed_instagram_accounts', 'backedpage'),
  backed('assets.backed.threadsForPage', 'page_backed_threads_accounts', 'backedpage'),
  backed('assets.backed.threadsForInstagram', 'instagram_backed_threads_user', 'backedinstagram'),
  {
    // BM-903 — a group on the portfolio's own credit line: its name only (never emails).
    name: 'billing.invoiceGroup.create', method: 'POST', path: NODE_EDGE('extended_credit_invoice_groups'), kinds: ['creditline'],
    required: ['name'], optional: [], text: { name: META_NAME_TEXT }, maxBody: 1000, values: judged({ name: nameProblem }), budget: false, edgeCall: true,
  },
  {
    // BM-904 — a group's name only (never emails).
    name: 'billing.invoiceGroup.rename', method: 'POST', path: NODE, kinds: ['invoicegroup'],
    required: ['name'], optional: [], text: { name: META_NAME_TEXT }, maxBody: 1000, values: judged({ name: nameProblem }), budget: false,
  },
  {
    // BM-905 — the chosen ad account billed on this group (meta-business-asset-owner.ts checks it is the chosen one).
    name: 'billing.invoiceGroup.addAccount', method: 'POST', path: NODE_EDGE('ad_accounts'), kinds: ['invoicegroup'],
    required: ['ad_account_id'], optional: [], values: judged({ ad_account_id: actId }), budget: false, edgeCall: true,
  },
  {
    // BM-906 — the chosen ad account taken out of this group (its key as a form body, as every Nexus DELETE with keys).
    name: 'billing.invoiceGroup.removeAccount', method: 'DELETE', path: NODE_EDGE('ad_accounts'), kinds: ['invoicegroup'],
    required: ['ad_account_id'], optional: [], values: judged({ ad_account_id: actId }), budget: false, edgeCall: true,
  },
  {
    // BM-907 — an EMPTY group of the portfolio's own credit line (explicit ask: confirmDelete; the owner check reads it empty).
    name: 'billing.invoiceGroup.delete', method: 'DELETE', path: NODE, kinds: ['invoicegroup'],
    required: [], optional: [], values: () => null, budget: false,
  },
]

/** Is this the name of a step-43 rule (the gateway sends such a write to meta-business-asset-owner.ts)? */
export const isMetaBusinessAssetRule = (name: string): boolean => META_BUSINESS_ASSET_WRITE_RULES.some((rule) => rule.name === name)
