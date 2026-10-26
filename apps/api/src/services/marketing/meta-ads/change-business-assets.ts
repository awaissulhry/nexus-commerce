/**
 * Meta ads step 43 (2026-10-26) — the business-asset change Nexus's OWN token may make (D1 keeps the admin-only acts in the
 * Owner's hands — business-assets-admin.ts, invoice groups included: Meta's help asks full control and finance access for
 * them). Pure: the draft from the request and the live state the tool reads (live-business-assets-change.ts). A Nexus change
 * (meta-ads-kit.ts): preview → approvalId → a person approves → it runs as that person; no undo (Meta has no delete).
 *
 *   create-meta-backed-account  a Page-backed Instagram account for the chosen Page (BM-051), an Instagram-backed Threads
 *                               account for the chosen Instagram account (CR-228), a Page-backed Threads account for the
 *                               chosen Page (CR-230) — identities ads may use; nobody can log in to them; no delete.
 *
 * Checked 2026-10-26 (plain curl ≥ 4 s apart; Meta's Python Business SDK main):
 *   - documentation/ads-commerce/instagram/ads-api/guides/pages-ig-account.md: POST /<PAGE_ID>/page_backed_instagram_accounts
 *     (no parameters) "returns an Instagram account ID on success. If a page already has a PBIA, the call returns the existing
 *     PBIA ID"; "you need to have at least an ADVERTISER role on this page. MANAGER or CONTENT_CREATOR also work"; read GET
 *     …/page_backed_instagram_accounts (empty when none); "You cannot login to this Instagram account to manage posts"; same
 *     name and picture as the Page, kept in step. No delete is documented.
 *   - documentation/ads-commerce/marketing-api/ad-creative/threads-ads.md: POST /<IG_USER_ID>/instagram_backed_threads_user
 *     and POST /<PAGE_ID>/page_backed_threads_accounts (no parameters), each returning the existing one if there is one; read
 *     GET /<IG_USER_ID>/instagram_backed_threads_user (threads_user_id) and GET /<PAGE_ID>?fields=page_backed_threads_account_id;
 *     the Page-backed one needs an ADVERTISER (MANAGER, CONTENT_CREATOR) role on the Page; "You should only use a Page-backed
 *     Threads account when you are using a Page-backed Instagram account for Instagram ads"; one of each per Instagram
 *     account / Page; no delete documented; "you cannot run ads on Threads if the Page-backed Instagram account from the same
 *     Page cannot run ads on Instagram"; ads with a Page-backed Threads account need "the `pages_read_engagement` permission
 *     … granted to the app".
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { MetaChangeResult } from './write-client.js'

// ── create-meta-backed-account (BM-051, CR-228, CR-230) ────────────────────────────────────────────────────────────

export const BACKED_KINDS = ['instagram-for-page', 'threads-for-instagram', 'threads-for-page'] as const
export type BackedKind = typeof BACKED_KINDS[number]

/** Where each kind is made and what it is called (its edge is spelled once, in backedDraft's request). */
export const BACKED: Readonly<Record<BackedKind, { on: 'page' | 'instagram'; what: string; row: string }>> = {
  'instagram-for-page': { on: 'page', what: 'a Page-backed Instagram account', row: 'BM-051' },
  'threads-for-instagram': { on: 'instagram', what: 'an Instagram-backed Threads account', row: 'CR-228' },
  'threads-for-page': { on: 'page', what: 'a Page-backed Threads account', row: 'CR-230' },
}

/** What the reads found for a backed account (live-business-assets-change.ts liveBacked). */
export interface BackedLive {
  kind: BackedKind
  /** The chosen Page or Instagram account it is made for (null: none chosen). */
  objectId: string | null
  /** The one that exists already (Meta makes one per Page / Instagram account), or Meta's refusal of the read. */
  existing: { id: string | null } | { refused: string }
  /** threads-for-page: the Page's Page-backed Instagram account (null: none; undefined: not read). */
  pageBackedInstagram?: string | null
  /** threads-for-instagram: a real Threads account linked to the Instagram account (null: none; undefined: not read). */
  linkedThreads?: string | null
  /** instagram-for-page: the Instagram account connected to the chosen Page (null: none; undefined: not read). */
  connectedInstagram?: string | null
}

export const BACKED_NO_UNDO = 'Meta documents no delete of a Page-backed Instagram account or of an Instagram- or Page-backed Threads account: once made it stays (nobody can log in to it, post or comment with it; it takes the Page\'s or account\'s name and picture).'
const BACKED_EXPLAIN: Readonly<Record<string, string>> = {
  10: 'Meta needs the system user to hold the Advertise task (or Create content, or Manage) on the chosen Page — Meta Business settings › Users › System users › Assign assets.',
  200: 'Meta needs the system user to hold the Advertise task (or Create content, or Manage) on the chosen Page — Meta Business settings › Users › System users › Assign assets.',
}

export function backedDraft(live: BackedLive): MetaChangeDraft | { refusal: string } {
  const spec = BACKED[live.kind]
  const where = spec.on === 'page' ? 'Page' : 'Instagram account'
  if (!live.objectId) return { refusal: `This business has chosen no ${spec.on === 'page' ? 'Facebook Page' : 'Instagram account'} (set-meta-connection asks for one), so there is nothing to make ${spec.what} for.` }
  if ('refused' in live.existing) return { refusal: `Nexus could not read whether the chosen ${where} has ${spec.what} already (${live.existing.refused}): Meta makes one only once and answers the existing one, so Nexus asks for nothing it cannot check.` }
  if (live.existing.id) return { refusal: `The chosen ${where} ${live.objectId} has ${spec.what} already (id ${live.existing.id}): Meta makes one per ${where} and would only answer that one, so there is nothing to make. Ads use it by that id.` }
  // Review N1 — a Page-backed Threads account runs no ad without the Page's Page-backed Instagram account, and it stays for
  // good: refused when the Page has none, or when Nexus cannot tell.
  if (live.kind === 'threads-for-page' && live.pageBackedInstagram === null) return { refusal: `The chosen Page ${live.objectId} has no Page-backed Instagram account, and Meta says "you cannot run ads on Threads if the Page-backed Instagram account from the same Page cannot run ads on Instagram": make that one first (kind instagram-for-page). A Page-backed Threads account cannot be deleted, so Nexus makes none that could run no ad.` }
  if (live.kind === 'threads-for-page' && live.pageBackedInstagram === undefined) return { refusal: `Nexus cannot tell whether the chosen Page ${live.objectId} has a Page-backed Instagram account (Meta did not answer the read), and a Page-backed Threads account runs no ad without one and cannot be deleted: Nexus makes none until it can read it.` }
  const warnings: string[] = [BACKED_NO_UNDO, 'Meta has no check for this change (validate_only is documented on campaign changes and creates of the ad account only).']
  if (live.kind === 'instagram-for-page') {
    warnings.push('Meta: ads use it as instagram_user_id with the chosen Page as page_id; any ad account Nexus reaches may use it, and a person with the Advertise task on the Page manages its ad comments in Ads Manager (it cannot post).')
    // Review N2 — the PBIA guide's restriction when the Page has a connected Instagram account.
    if (live.connectedInstagram) warnings.push(`The chosen Page has a connected Instagram account (${live.connectedInstagram}). Meta: "When you use an ad account not owned by a business via Business Manager, if a page has a page-connected Instagram account, you cannot use its PBIA to create ads. You must use that page-connected Instagram account. When you create ads for an ad account owned by a business, this restriction does not apply."`)
    if (live.connectedInstagram === undefined) warnings.push('Nexus could not read whether the chosen Page has a connected Instagram account: with one, Meta lets only an ad account a business owns run ads with the Page-backed account.')
  }
  if (live.kind === 'threads-for-page') {
    warnings.push('Meta: "You should only use a Page-backed Threads account when you are using a Page-backed Instagram account for Instagram ads", and Threads ads of it run only while that Page-backed Instagram account can run Instagram ads.')
    // Review N3.
    warnings.push('Meta: for ads with a Page-backed Threads account, "the `pages_read_engagement` permission is also required to be granted to the app" (and the Advertise task on the Page).')
  }
  if (live.kind === 'threads-for-instagram') {
    warnings.push('Meta: Threads ads of it run only while the Instagram account can run Instagram ads.')
    if (live.linkedThreads) warnings.push(`The Instagram account already has a linked Threads account (${live.linkedThreads}): Threads ads can use that one instead.`)
  }
  const label = `Make ${spec.what} for the chosen ${where} ${live.objectId}`
  const common = {
    step: 1, label, objectId: live.objectId, params: {},
    check: 'none' as const, raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
    operation: `assets.backed.${live.kind}`,
    // Meta's answer is the new account's id: nothing of it is read back (it has no status to read).
    skipReadBack: true as const,
    doneSentence: (result: MetaChangeResult) => `${label}: Meta made it${madeIdOf(result) ? ` (id ${madeIdOf(result)})` : ''}.`,
    explain: BACKED_EXPLAIN,
  }
  // Each edge spelled as itself (a request builder never computes its edge: meta-labels-writes test).
  const request: MetaChangeRequest = live.kind === 'instagram-for-page' ? { ...common, objectKind: 'backedpage', edge: 'page_backed_instagram_accounts' }
    : live.kind === 'threads-for-instagram' ? { ...common, objectKind: 'backedinstagram', edge: 'instagram_backed_threads_user' }
      : { ...common, objectKind: 'backedpage', edge: 'page_backed_threads_accounts' }
  const lines = changeLines([[spec.what, 'none', 'made by Meta (its id in the answer)']])
  return {
    summary: `${label[0].toUpperCase()}${label.slice(1)} (${spec.row}). Nothing spends: it is an identity ads may use.`,
    changes: lines.changes, totals: { made: 1 }, warnings, spendsMoney: [], skipped: [],
    requests: [request],
    stands: { kind: live.kind, objectId: live.objectId, existing: null, pageBackedInstagram: live.pageBackedInstagram ?? null, linkedThreads: live.linkedThreads ?? null },
    before: { kind: live.kind, objectId: live.objectId, madeId: null },
    after: { kind: live.kind, objectId: live.objectId, madeId: null },
  }
}

/** The id Meta answered for what it made (an id, or a Threads account's threads_user_id), digits only. */
export function madeIdOf(result: Pick<MetaChangeResult, 'node'>): string | null {
  const node = result.node ?? {}
  for (const key of ['id', 'threads_user_id']) {
    const v = node[key]
    if ((typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v))) return String(v)
  }
  return null
}
