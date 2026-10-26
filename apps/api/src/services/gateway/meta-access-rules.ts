/**
 * Meta step 41 (2026-10-25) — people and partner access on the write allow-list: what set-meta-user-access and
 * set-meta-partner-access send, ONE rule per kind of change and asset, each with its EXACT keys and every value judged
 * (task lists in Nexus's one spelling: meta/meta-access-lists.ts). Each rule names its own kind of object (MetaAccessKind,
 * below), so it matches only a call of these two tools; the gateway then sends the write to meta-access-owner.ts, which
 * confirms the object is the business's CHOSEN ad account, Page or Instagram account (owned by the chosen ad account's
 * portfolio) or that portfolio itself, and every id in the body: never Nexus's own system user, a person of that portfolio,
 * the last admin kept, a partner that is no other Nexus business and not the portfolio itself — before anything is sent.
 *
 * Import rule (step 34's, lane C4): this file imports no VALUE from meta-settings-rules.ts or meta-calls.ts (their sleeping
 * import cycle): only types and the leaf lists of meta/meta-access-lists.ts.
 *
 * Checked 2026-10-25 (curl ≥ 3 s apart; developers.facebook.com/documentation/ads-commerce/marketing-api/reference/<page>.md,
 * developers.facebook.com/docs/graph-api/reference/page/{assigned_users,agencies}/, the business-asset-management guides
 * ad-accounts, pages, instagram-accounts; Meta's Python Business SDK main, facebook_business/adobjects/{adaccount,page,
 * instagrambusinessasset,business}.py):
 *   - AA-056 POST /act_{id}/assigned_users user [required] + tasks ("Updating"; read-after-write; 100, 200, 2620); AA-057
 *     DELETE /act_{id}/assigned_users user [required] (100, 3919, 190) → {success}. The guide's curl sends both as form
 *     fields (`-X DELETE -F "user=…"`), as Nexus does.
 *   - BM-038 / BM-039 POST /{page_id}/assigned_users user [required] + tasks / DELETE user [required] → {success} (100,
 *     200, 368). `business` is the Pages GUIDE's only ("the id of the business that owns the page"): not in the v26 reference,
 *     not in the SDK (Page.create_assigned_user takes tasks and user) — sent as the guide does; LIVE-PROBES ST41-05 settles it.
 *   - BM-040 POST / DELETE /{instagram_business_asset_id}/assigned_users (v26 reference: POST tasks + user, DELETE user;
 *     `business` = the owner is the instagram-accounts GUIDE's only, as for the Page). The business ASSET id, never the IG
 *     user id.
 *   - AA-058 POST /act_{id}/agencies business + permitted_tasks: Meta names the route on its v26 reference pages
 *     (business/client_ad_accounts, ads-pixel/shared_accounts) but its Creating section is EMPTY — the parameters are SDK
 *     create_agency's only (RECHECK AA-058 STILL-UNVERIFIED: Meta's answer decides, LIVE-PROBES ST41-03); AA-059 DELETE
 *     /act_{id}/agencies business [required] → {success} (documented). An ad account takes only Meta's task combinations
 *     (100 / 1752129: meta/meta-access-lists.ts META_AD_ACCOUNT_TASK_SETS), on people and partners alike.
 *   - BM-046 POST /{page_id}/agencies business [required] + permitted_tasks (documented "Creating"; 3989 "duplicated asset",
 *     3946 "Asset already belongs to this Business Manager", 80001); DELETE /{page_id}/agencies: the reference says "You
 *     can't perform this operation", the SDK has delete_agencies (business): built for undo, Meta's answer decides (ST41-04).
 *   - BM-050 DELETE /{instagram_business_asset_id}/agencies business [required]; POST business + permitted_tasks (both
 *     [required]) — both documented on v26 reference/instagram-business-asset/agencies (review B-F1).
 *   - Every DELETE carries its keys as a form body (Meta's guides: `-X DELETE -F "user=…"`); Meta's SDK puts a DELETE's on the
 *     query. If LIVE-PROBE CA34-03 shows Meta ignores the body on an agencies DELETE, these rules become `inQuery` (B-F10).
 *   - BM-054 DELETE /{business_id}/agencies business [required] ("The agency's business") and DELETE
 *     /{business_id}/clients business [required] ("The client's business") → {success}: ends the WHOLE relationship.
 *   - Owner option 1 (2026-10-26) — a dataset (pixel) of the chosen ad account its portfolio owns: SG-024 POST
 *     /{pixel_id}/assigned_users user + tasks ⊂ AA_ANALYZE, ADVERTISE, ANALYZE, EDIT, UPLOAD (SDK AdsPixel.create_assigned_user,
 *     Meta's Ads CLI `dataset assign-user`; the reference's Creating says "can't perform": Meta's answer decides) and NO
 *     removal (no DELETE on the reference, the SDK or the CLI: no rule); SG-021 POST /{pixel_id}/agencies business +
 *     permitted_tasks ⊂ ADVERTISE, ANALYZE, EDIT, UPLOAD (Pixel Agency Sharing guide, both required; "{success: true}" or
 *     with "pending_request_id" while the partner has not accepted); SG-022 DELETE /{pixel_id}/agencies?business=… — on the
 *     QUERY, as the guide sends it (`inQuery`); SG-014 POST /{pixel_id} server_events_business_ids (array<numeric string>,
 *     reference ads-pixel "Updating": the WHOLE list; read GET /{pixel_id}/server_events_permitted_business).
 * No rule takes execution_options: Meta documents validate_only on none of these edges.
 */
import type { MetaWriteRule } from './meta-calls.js'
import { metaBusinessIdListProblem, metaTaskListProblem, type MetaAccessAsset } from '../meta/meta-access-lists.js'

type Params = ReadonlyMap<string, string>
type Judge = (value: string, params: Params) => string | null

/**
 * Step 41 — what only the access tools name: the chosen ad account (`act_<id>`), the chosen Page, the chosen Instagram
 * account's business asset, and the chosen ad account's business portfolio (a relationship's end). Own kinds, so these
 * rules never match another tool's call on the same edge (a catalog's or a block list's people and partners).
 */
export type MetaAccessKind = 'accessadaccount' | 'accesspage' | 'accessinstagram' | 'accessportfolio' | 'accesspixel'
export const META_ACCESS_KINDS: ReadonlySet<string> = new Set<MetaAccessKind>(['accessadaccount', 'accesspage', 'accessinstagram', 'accessportfolio', 'accesspixel'])
/** Step 41 — the edges these changes post to or delete on (`assigned_users`, `agencies`; a relationship's `clients`). */
export type MetaAccessEdge = 'assigned_users' | 'agencies' | 'clients'

/** The kind of object each asset is named with. */
export const META_ACCESS_KIND_OF: Readonly<Record<MetaAccessAsset, MetaAccessKind>> = { 'ad-account': 'accessadaccount', page: 'accesspage', instagram: 'accessinstagram', pixel: 'accesspixel' }

const ACT_EDGE = (edge: string) => new RegExp(`^act_[1-9]\\d{0,24}\\/${edge}$`)
const NODE_EDGE = (edge: string) => new RegExp(`^[1-9]\\d{0,19}\\/${edge}$`)
const DIGITS = /^[1-9]\d{0,19}$/

const digits = (what: string): Judge => (value) => (DIGITS.test(value) ? null : `${what} is a Meta id (digits, no leading zero)`)
const tasksOf = (asset: MetaAccessAsset, key: string, who: 'person' | 'partner' = 'person'): Judge => (value) => metaTaskListProblem(value, asset, key, who)

/** Each key's judge; a key without one is not of this change. */
function judged(judges: Record<string, Judge>) {
  return (params: Params): string | null => {
    for (const [key, value] of params) {
      const judge = judges[key]
      if (!judge) return `${key} is not a key of this change`
      const problem = judge(value, params)
      if (problem) return problem
    }
    return null
  }
}

const PATHS: Readonly<Record<MetaAccessAsset, (edge: string) => RegExp>> = { 'ad-account': ACT_EDGE, page: NODE_EDGE, instagram: NODE_EDGE, pixel: NODE_EDGE }

/**
 * The person rules of one asset: give / change tasks (POST), take off (DELETE — never on a dataset: Meta has none). The
 * Page and Instagram asset name their owner (their guides' `business`); the ad account and a dataset do not.
 */
function userRules(asset: MetaAccessAsset): MetaWriteRule[] {
  const kind = META_ACCESS_KIND_OF[asset]
  const owner = asset === 'page' || asset === 'instagram'
  const set: MetaWriteRule = {
    // AA-056 / BM-038 / BM-040 / SG-024 — the same call adds a person and changes their tasks.
    name: `access.${kind}.user.set`,
    method: 'POST',
    path: PATHS[asset]('assigned_users'),
    kinds: [kind],
    required: owner ? ['user', 'tasks', 'business'] : ['user', 'tasks'],
    optional: [],
    values: judged({ user: digits('user'), tasks: tasksOf(asset, 'tasks'), ...(owner ? { business: digits('business') } : {}) }),
    budget: false,
  }
  if (asset === 'pixel') return [set]
  return [
    set,
    {
      // AA-057 / BM-039 / BM-040 — take a person or system user off (never Nexus's own: meta-access-owner.ts).
      name: `access.${kind}.user.remove`,
      method: 'DELETE',
      path: PATHS[asset]('assigned_users'),
      kinds: [kind],
      required: ['user'],
      optional: [],
      values: judged({ user: digits('user') }),
      budget: false,
    },
  ]
}

/** The partner rules of one asset: share it with a partner portfolio (POST), take the partner off (DELETE). */
function partnerRules(asset: MetaAccessAsset): MetaWriteRule[] {
  const kind = META_ACCESS_KIND_OF[asset]
  return [
    {
      // AA-058 (route named, parameters SDK only) / BM-046 and the Instagram asset's (documented) — Nexus ALWAYS sends the tasks.
      name: `access.${kind}.partner.share`,
      method: 'POST',
      path: PATHS[asset]('agencies'),
      kinds: [kind],
      required: ['business', 'permitted_tasks'],
      optional: [],
      values: judged({ business: digits('business'), permitted_tasks: tasksOf(asset, 'permitted_tasks', 'partner') }),
      budget: false,
    },
    {
      // AA-059 (documented) / the Page's (SDK only) / BM-050 / SG-022 — a partner the asset is shared with now. A dataset's
      // goes on the QUERY (the Pixel Agency Sharing guide: `DELETE <adspixel>/agencies?business=<agency_business_id>`).
      name: `access.${kind}.partner.remove`,
      method: 'DELETE',
      path: PATHS[asset]('agencies'),
      kinds: [kind],
      required: ['business'],
      optional: [],
      values: judged({ business: digits('business') }),
      budget: false,
      ...(asset === 'pixel' ? { inQuery: true as const } : {}),
    },
  ]
}

/** Step 41 — set-meta-user-access and set-meta-partner-access on the write allow-list. */
export const META_ACCESS_WRITE_RULES: readonly MetaWriteRule[] = [
  ...userRules('ad-account'), ...userRules('page'), ...userRules('instagram'),
  ...partnerRules('ad-account'), ...partnerRules('page'), ...partnerRules('instagram'),
  // BM-054 — end the portfolio's WHOLE relationship with an agency (it loses every asset shared) or with a client (this
  // portfolio loses every asset that client shared with it). One-way: the partner asks or shares again.
  { name: 'access.portfolio.agency.end', method: 'DELETE', path: NODE_EDGE('agencies'), kinds: ['accessportfolio'], required: ['business'], optional: [], values: judged({ business: digits('business') }), budget: false },
  { name: 'access.portfolio.client.end', method: 'DELETE', path: NODE_EDGE('clients'), kinds: ['accessportfolio'], required: ['business'], optional: [], values: judged({ business: digits('business') }), budget: false },
  // Owner option 1 — a dataset's people (set only) and partners, and SG-014 its server-event businesses (the WHOLE list).
  ...userRules('pixel'), ...partnerRules('pixel'),
  { name: 'access.accesspixel.server_events', method: 'POST', path: /^[1-9]\d{0,19}$/, kinds: ['accesspixel'], required: ['server_events_business_ids'], optional: [], values: judged({ server_events_business_ids: (value) => metaBusinessIdListProblem(value, 'server_events_business_ids') }), budget: false },
]

/** Is this the name of a step-41 rule (the gateway sends such a write to meta-access-owner.ts)? */
export const isMetaAccessRule = (name: string): boolean => META_ACCESS_WRITE_RULES.some((rule) => rule.name === name)
