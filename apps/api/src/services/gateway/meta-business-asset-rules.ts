/**
 * Meta step 43 (2026-10-26) — create-meta-backed-account's writes on the write allow-list: ONE rule per kind of backed
 * account, each with its EXACT path and no body, and its own kind of object (MetaBusinessAssetKind), so it matches only a
 * call of this tool. The gateway then sends the write to meta-business-asset-owner.ts, which confirms the object is the
 * business's CHOSEN Page or Instagram account before anything is sent. (Invoice groups are the Owner's steps in Meta's
 * screens — D1, set-meta-billing is a read-only guide — so no billing write is on the allow-list.)
 *
 * Import rule (step 34's, lane C4): this file imports no VALUE from meta-settings-rules.ts or meta-calls.ts (their sleeping
 * import cycle): only types.
 *
 * Checked 2026-10-26 (marketing/meta-ads/change-business-assets.ts has the sources): BM-051 POST
 * /{page_id}/page_backed_instagram_accounts — no parameters (the Instagram ads guide's curl sends only the token); CR-228 POST
 * /{ig_user_id}/instagram_backed_threads_user and CR-230 POST /{page_id}/page_backed_threads_accounts — no parameters
 * (Threads ads guide). Each answers the new id, or the existing one. No rule takes execution_options: Meta documents
 * validate_only on none of these edges.
 */
import type { MetaWriteRule } from './meta-calls.js'

/**
 * Step 43 — what only create-meta-backed-account names: the chosen Page (`backedpage`) or Instagram account
 * (`backedinstagram`) a backed account is made for. Own kinds: no other tool's call on the same edge matches these rules.
 */
export type MetaBusinessAssetKind = 'backedpage' | 'backedinstagram'
export const META_BUSINESS_ASSET_KINDS: ReadonlySet<string> = new Set<MetaBusinessAssetKind>(['backedpage', 'backedinstagram'])
/** Step 43 — the edges these creates post to. */
export type MetaBusinessAssetEdge = 'page_backed_instagram_accounts' | 'instagram_backed_threads_user' | 'page_backed_threads_accounts'

const NODE_EDGE = (edge: string) => new RegExp(`^[1-9]\\d{0,19}\\/${edge}$`)

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
]

/** Is this the name of a step-43 rule (the gateway sends such a write to meta-business-asset-owner.ts)? */
export const isMetaBusinessAssetRule = (name: string): boolean => META_BUSINESS_ASSET_WRITE_RULES.some((rule) => rule.name === name)
