/**
 * Meta ads step 41 (2026-10-25) — people and partner access: Meta's task lists per asset, who counts as an ADMIN of an asset
 * and the last-admin floor. A leaf module (it imports nothing): the gateway's rules (gateway/meta-access-rules.ts), its
 * owner check (gateway/meta-access-owner.ts), the drafts (marketing/meta-ads/change-access.ts) and the tools take the SAME
 * lists and the SAME floor from here, so what a tool previews is what the gateway judges again before anything is sent.
 *
 * Checked 2026-10-25 (curl ≥ 3 s apart; developers.facebook.com/documentation/ads-commerce/marketing-api/reference/<page>.md,
 * developers.facebook.com/docs/graph-api/reference/page/<edge>/, the business-asset-management guides ad-accounts, pages
 * and instagram-accounts; Meta's Python Business SDK main, facebook_business/adobjects/{adaccount,page,
 * instagrambusinessasset,business,assigneduser}.py):
 *   - ad-account/assigned_users "Updating": tasks array<enum {MANAGE, ADVERTISE, ANALYZE, DRAFT, AA_ANALYZE}>, user [required]
 *     (business user or system user id); read-after-write; error 2620 "Invalid call to update account permissions". The
 *     guide's presets: Admin [MANAGE, ADVERTISE, ANALYZE] ("Manage all aspects of ad campaigns, reporting, billing and ad
 *     account permissions"), General [ADVERTISE, ANALYZE], Reporting [ANALYZE]. SDK AdAccount.Tasks = the same five.
 *   - page/assigned_users "Updating": tasks array<enum {…27 values below}>, user [required]; the Pages guide adds business
 *     ("The business id must be the id of the business that owns the page"); presets Admin [MANAGE, CREATE_CONTENT,
 *     MODERATE, ADVERTISE, ANALYZE], Editor, Moderator, Advertiser, Analyst. SDK Page.Tasks adds CASHIER_ROLE and MANAGE_JOBS
 *     (not on the v26 page: never sent).
 *   - Instagram business asset assigned_users (v26 reference/instagram-business-asset/assigned_users: POST tasks ⊂ CONTENT,
 *     MESSAGES, COMMUNITY_ACTIVITY, ADVERTISE, ANALYZE + user; DELETE user); `business` = the owner is the instagram-accounts
 *     guide's only (not the reference, not the SDK); SDK InstagramBusinessAsset.Tasks = the same five.
 *   - agencies (a partner portfolio's access): ad-account/agencies (the route is named on Meta's v26 reference pages
 *     business/client_ad_accounts and ads-pixel/shared_accounts; its parameters are the SDK's only: create_agency business,
 *     permitted_tasks ⊂ the ad account's five), page/agencies "Creating" (business [required], permitted_tasks ⊂ the Page's
 *     27), reference/instagram-business-asset/agencies "Creating" (business and permitted_tasks, both required, ⊂ its five).
 *   - error-reference: 100 / 1752129 "This Task Combination Is Not Supported" — an ad account takes only the combinations of
 *     the mapping (Admin, General, Reporting): META_AD_ACCOUNT_TASK_SETS (review B-F4).
 */

/** The ad account's tasks (reference/ad-account/assigned_users, SDK AdAccount.Tasks / PermittedTasks). */
export const META_AD_ACCOUNT_TASKS = ['MANAGE', 'ADVERTISE', 'ANALYZE', 'DRAFT', 'AA_ANALYZE'] as const
/**
 * Review B-F4 — the ONLY task lists Nexus sends for an ad account (sorted): Meta's mapping Admin [MANAGE, ADVERTISE,
 * ANALYZE], General [ADVERTISE, ANALYZE], Reporting [ANALYZE]; any other combination Meta refuses (100 / 1752129).
 */
export const META_AD_ACCOUNT_TASK_SETS: readonly (readonly string[])[] = [['ADVERTISE', 'ANALYZE', 'MANAGE'], ['ADVERTISE', 'ANALYZE'], ['ANALYZE']]
/** Meta answers "all unpacked" tasks: these come with a preset on an ad account (never asked by Nexus on their own). */
const UNPACKED_EXTRAS: ReadonlySet<string> = new Set(['DRAFT', 'AA_ANALYZE'])
/**
 * The ad account preset a task list is (as Meta reads it back, unpacked): the list without DRAFT and AA_ANALYZE must be
 * exactly one of META_AD_ACCOUNT_TASK_SETS. Null when it is none (undo then cannot give it back, said).
 */
export function metaAdAccountPreset(tasks: readonly string[]): string[] | null {
  const core = [...new Set(tasks.filter((t) => !UNPACKED_EXTRAS.has(t)))].sort()
  const set = META_AD_ACCOUNT_TASK_SETS.find((s) => s.length === core.length && s.every((t, i) => t === core[i]))
  return set ? [...set] : null
}
/** The Page's tasks exactly as the v26 reference/page/assigned_users "Updating" and page/agencies "Creating" list them. */
export const META_PAGE_TASKS = [
  'MANAGE', 'CREATE_CONTENT', 'MODERATE', 'MESSAGING', 'ADVERTISE', 'ANALYZE', 'MODERATE_COMMUNITY', 'PAGES_MESSAGING',
  'PAGES_MESSAGING_SUBSCRIPTIONS', 'READ_PAGE_MAILBOXES', 'VIEW_MONETIZATION_INSIGHTS', 'MANAGE_LEADS', 'PROFILE_PLUS_FULL_CONTROL',
  'PROFILE_PLUS_MANAGE', 'PROFILE_PLUS_FACEBOOK_ACCESS', 'PROFILE_PLUS_CREATE_CONTENT', 'PROFILE_PLUS_MODERATE',
  'PROFILE_PLUS_MODERATE_DELEGATE_COMMUNITY', 'PROFILE_PLUS_MESSAGING', 'PROFILE_PLUS_ADVERTISE', 'PROFILE_PLUS_ANALYZE',
  'PROFILE_PLUS_REVENUE', 'PROFILE_PLUS_MANAGE_LEADS', 'PROFILE_PLUS_CREATIVE_MANAGEMENT', 'PROFILE_PLUS_CREATOR_MANAGEMENT',
  'GLOBAL_STRUCTURE_MANAGEMENT', 'PROFILE_PLUS_GLOBAL_STRUCTURE_MANAGEMENT',
] as const
/** The Instagram business asset's tasks (instagram-accounts guide, SDK InstagramBusinessAsset.Tasks). */
export const META_INSTAGRAM_TASKS = ['CONTENT', 'MESSAGES', 'COMMUNITY_ACTIVITY', 'ADVERTISE', 'ANALYZE'] as const

/**
 * Owner option 1 (2026-10-26) — a dataset (pixel) of the chosen ad account, owned by its portfolio. Checked 2026-10-26
 * (Meta's v26 reference ads-pixel, ads-pixel/{assigned_users,agencies,server_events_permitted_business}; the Pixel Agency
 * Sharing guide; SDK adspixel.py): a person's tasks (AdsPixel.Tasks, create_assigned_user — the reference's Creating section
 * says "can't perform", the SDK and Meta's Ads CLI `dataset assign-user` have it; NO delete anywhere) and a partner's
 * (AdsPixel.PermittedTasks, create_agency / delete_agencies; the guide: EDIT "is currently limited").
 */
export const META_PIXEL_TASKS = ['AA_ANALYZE', 'ADVERTISE', 'ANALYZE', 'EDIT', 'UPLOAD'] as const
export const META_PIXEL_PARTNER_TASKS = ['ADVERTISE', 'ANALYZE', 'EDIT', 'UPLOAD'] as const

/**
 * The assets whose people and partners step 41 changes: the business's CHOSEN ad account, Page, Instagram account, and a
 * dataset (pixel) of the chosen ad account its portfolio owns.
 */
export const META_ACCESS_ASSETS = ['ad-account', 'page', 'instagram', 'pixel'] as const
export type MetaAccessAsset = typeof META_ACCESS_ASSETS[number]

/** A person's tasks per asset. */
export const META_ACCESS_TASKS: Readonly<Record<MetaAccessAsset, readonly string[]>> = {
  'ad-account': META_AD_ACCOUNT_TASKS,
  page: META_PAGE_TASKS,
  instagram: META_INSTAGRAM_TASKS,
  pixel: META_PIXEL_TASKS,
}
/** A partner portfolio's tasks per asset (the same as a person's, but a dataset's: no AA_ANALYZE). */
export const META_PARTNER_TASKS: Readonly<Record<MetaAccessAsset, readonly string[]>> = { ...META_ACCESS_TASKS, pixel: META_PIXEL_PARTNER_TASKS }

/** What each task lets someone do, in plain words (the preview names them). */
export const META_TASK_WORDS: Readonly<Record<string, string>> = {
  MANAGE: 'manage it fully (people, payment, settings)',
  ADVERTISE: 'create and edit ads that spend the account\'s money',
  ANALYZE: 'see results',
  DRAFT: 'draft ads',
  AA_ANALYZE: 'see advanced analytics',
  CREATE_CONTENT: 'post as the Page',
  MODERATE: 'answer and remove comments',
  MESSAGING: 'send messages as the Page',
  MODERATE_COMMUNITY: 'moderate the Page\'s community',
  MANAGE_LEADS: 'download leads',
  PROFILE_PLUS_FULL_CONTROL: 'full control of the Page (people and settings too)',
  CONTENT: 'post as the Instagram account',
  MESSAGES: 'answer direct messages',
  COMMUNITY_ACTIVITY: 'answer and remove comments',
  EDIT: 'manage the dataset and change its settings (Meta: limited for partners)',
  UPLOAD: 'upload conversion events to it',
}

/**
 * Who is an ADMIN of an asset, for the last-admin floor: the ad account — MANAGE ("ad account permissions" are its admin's);
 * the Page — MANAGE, or PROFILE_PLUS_FULL_CONTROL (the new Page experience's "full control"); the Instagram account — every
 * one of its five tasks (Meta has no MANAGE task there: full control is all of them).
 */
export function metaIsAssetAdmin(asset: MetaAccessAsset, tasks: readonly string[]): boolean {
  if (asset === 'ad-account') return tasks.includes('MANAGE')
  if (asset === 'page') return tasks.includes('MANAGE') || tasks.includes('PROFILE_PLUS_FULL_CONTROL')
  // A dataset: EDIT ("manage the dataset, change its settings") is its admin's.
  if (asset === 'pixel') return tasks.includes('EDIT')
  return META_INSTAGRAM_TASKS.every((t) => tasks.includes(t))
}

/** One person or system user assigned to the asset now (Meta's unpacked tasks). */
export interface MetaAssignee { id: string; tasks: readonly string[] }

/**
 * Review A-MF2 — may the target be an admin now, for the floor (one-sided, fail closed)? An admin by the rule above, OR a
 * task list Nexus cannot judge: empty (Meta did not say), or holding any task outside the asset's list (a spelling Nexus does
 * not know). For the OTHER people only the known rule counts (metaIsAssetAdmin): an unknown list never stands in for an admin.
 */
export function metaMayBeAssetAdmin(asset: MetaAccessAsset, tasks: readonly string[]): boolean {
  return !tasks.length || tasks.some((t) => !META_ACCESS_TASKS[asset].includes(t)) || metaIsAssetAdmin(asset, tasks)
}

/**
 * THE last-admin floor (the leader's hard floor for step 41: never remove or lower the last admin), refused before Meta is
 * called — at the preview, the re-check, the run and again in the gateway. A change of `target` to `after` (null: removed)
 * is refused when the target may be an admin of the asset now (metaMayBeAssetAdmin: unknown counts as admin), is no admin
 * after it, and no OTHER PERSON (`persons`: the business users of the asset's portfolio — never a system user, which cannot
 * sign in to Meta's screens) is an admin by the known rule. Nexus's own system user never counts (it is never changed by
 * these tools either). Null: the floor holds.
 */
export function metaLastAdminProblem(asset: MetaAccessAsset, assigned: readonly MetaAssignee[], persons: ReadonlySet<string>, target: string, after: readonly string[] | null): string | null {
  const now = assigned.find((a) => a.id === target)
  if (!now || !metaMayBeAssetAdmin(asset, now.tasks)) return null
  if (after && metaIsAssetAdmin(asset, after)) return null
  const others = assigned.filter((a) => a.id !== target && persons.has(a.id) && metaIsAssetAdmin(asset, a.tasks))
  if (others.length) return null
  const word = { 'ad-account': 'the ad account', page: 'the Facebook Page', instagram: 'the Instagram account', pixel: 'the dataset' }[asset]
  const rule = { 'ad-account': 'MANAGE', page: 'MANAGE or full control', instagram: 'every Instagram task', pixel: 'EDIT' }[asset]
  return `${target} is the last person who is an admin of ${word} (${rule}) among the people Meta lists on it: Nexus never removes or lowers the last admin (no one could then manage its people). Make another person an admin first, or a person does it in Meta Business settings if it is meant.`
}

/**
 * A task list in Nexus's ONE spelling: a JSON list of distinct strings of this asset's enum, sorted, at least one (Meta's
 * `-F "tasks=['MANAGE', …]"` form, written as JSON). Null when it is one; else why not.
 */
export function metaTaskListProblem(value: string, asset: MetaAccessAsset, what: string, who: 'person' | 'partner' = 'person'): string | null {
  let list: unknown
  try { list = JSON.parse(value) } catch { return `${what} is a JSON list of tasks` }
  const allowed = (who === 'partner' ? META_PARTNER_TASKS : META_ACCESS_TASKS)[asset]
  if (!Array.isArray(list) || !list.length || list.length > allowed.length) return `${what} is a JSON list of 1 to ${allowed.length} tasks`
  if (!list.every((t) => typeof t === 'string' && allowed.includes(t))) return `${what} holds only ${allowed.join(', ')}`
  const sorted = [...new Set(list as string[])].sort()
  if (JSON.stringify(sorted) !== value) return `${what} names each task once, sorted, as Nexus writes it (${JSON.stringify(sorted)})`
  // Review B-F4 — an ad account takes only Meta's three combinations (100 / 1752129 for any other).
  if (asset === 'ad-account' && !META_AD_ACCOUNT_TASK_SETS.some((s) => JSON.stringify(s) === value)) return `${what} on an ad account is one of Meta's combinations: ${META_AD_ACCOUNT_TASK_SETS.map((s) => JSON.stringify(s)).join(', ')}`
  return null
}

/** The keys an entry of a relationship's permission list may name its asset by (the shape is on no Meta page). */
const PERMISSION_ID_KEYS = ['id', 'account_id', 'page_id', 'catalog_id', 'app_id'] as const

/**
 * Review A-MF1 — the ids a relationship's permission list names (business/agencies | clients `…_permissions`, whose item
 * shape is on no Meta page: LIVE-PROBES ST41-06): each entry's own id. NULL (fail closed) when the list is missing, when
 * Meta says there is more of it (paging.next: re-review R-2), or when ANY entry has no id Nexus can read or names two
 * different ones — a relationship Nexus cannot read in full is never ended.
 */
export function metaPermissionIds(v: unknown): string[] | null {
  const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null)
  const wrapped = obj(v)
  if (wrapped && obj(wrapped.paging)?.next) return null
  const list = Array.isArray(v) ? v : Array.isArray(wrapped?.data) ? wrapped!.data as unknown[] : null
  if (!list) return null
  const digits = (raw: unknown): string | null => {
    const text = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim().replace(/^act_/, '') : ''
    return /^[1-9]\d{0,24}$/.test(text) ? text : null
  }
  const ids: string[] = []
  for (const entry of list) {
    const row = obj(entry)
    const named = row ? [...PERMISSION_ID_KEYS.map((k) => row[k]), obj(row.asset)?.id].filter((x) => x !== undefined && x !== null) : [entry]
    const found = new Set(named.map(digits))
    if (found.size !== 1 || found.has(null)) return null
    ids.push([...found][0]!)
  }
  return [...new Set(ids)].sort()
}

/** The tasks as Nexus sends them (distinct, sorted, JSON). */
export const metaTaskList = (tasks: readonly string[]): string => JSON.stringify([...new Set(tasks)].sort())

/**
 * Owner option 1 (SG-014) — a dataset's server-event businesses as Nexus sends them: the WHOLE list (Meta's
 * server_events_business_ids "array<numeric string>" replaces it), distinct Meta ids, sorted, as JSON; [] clears it.
 */
export const MAX_SERVER_EVENT_BUSINESSES = 50
export function metaBusinessIdListProblem(value: string, what: string): string | null {
  let list: unknown
  try { list = JSON.parse(value) } catch { return `${what} is a JSON list of business portfolio ids` }
  if (!Array.isArray(list) || list.length > MAX_SERVER_EVENT_BUSINESSES) return `${what} is a JSON list of at most ${MAX_SERVER_EVENT_BUSINESSES} business portfolio ids`
  if (!list.every((v) => typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v))) return `${what} names Meta ids as strings (digits, no leading zero)`
  const sorted = [...new Set(list as string[])].sort()
  return JSON.stringify(sorted) === value ? null : `${what} names each id once, sorted, as Nexus writes it (${JSON.stringify(sorted)})`
}
