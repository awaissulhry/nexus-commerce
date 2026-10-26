/**
 * Meta step 41 (2026-10-25) — people and partner access as drafts (pure: the request and the live reads of
 * live-access-change.ts in, the draft — or a refusal in words — out):
 *   userAccessDraft     set-meta-user-access: give a person or system user of the portfolio tasks on the chosen ad account,
 *                       Page or Instagram account, change them, or take them off — AA-056, AA-057, BM-038, BM-039, BM-040
 *   partnerAccessDraft  set-meta-partner-access: share one of those assets with a partner portfolio, take a partner off it,
 *                       or end the portfolio's whole relationship with an agency or a client — AA-058, AA-059, BM-046,
 *                       BM-050, BM-054
 * Meta's rules each follows are in gateway/meta-access-rules.ts (checked there, with the pages and the SDK); the lists and
 * the last-admin floor in meta/meta-access-lists.ts; the gateway asks the same floors again (meta-access-owner.ts).
 *
 * The leader's hard floors, refused here before Meta is called (at the preview, the re-check and the run):
 *   - never remove or lower the LAST ADMIN of an asset (metaLastAdminProblem);
 *   - never Nexus's own system user's access (fewer tasks or none would cut Nexus off), and never take a partner off or end
 *     a relationship when Nexus's system user is not one of the portfolio's own (its access — and its app's, installed for
 *     it — may come through that partner);
 *   - never access for a person or business the person asking did not name: the person or partner is ALWAYS named by its id
 *     (never "everyone", never a list built by Nexus); a person is one of the portfolio's own; a partner is never the
 *     portfolio itself and never a portfolio another business in Nexus uses.
 * Fix round 1 — everything a floor stands on is read in full or the change is refused (fail closed): a relationship whose
 * ad accounts and Pages Meta does not list readably is never ended (A-MF1); a person whose tasks Nexus cannot judge counts as
 * an admin for the last-admin floor (A-MF2); a portfolio Nexus cannot tell is unshared counts as shared (A-N3).
 * Step 40's Nexus safety rule holds too: nothing is changed through an ad account Meta disabled, is reviewing for risk, is
 * closing or closed, or found compromised (change-account-settings.ts metaAccountChangeRefusal).
 *
 * Meta lets only the FULL Marketing API access tier manage people and partners through the API ("Limited access to Business
 * Manager and Catalog APIs. No Business Manager access to manage ad accounts, user permissions, and Pages":
 * marketing-api/get-started/authorization). The preview names the tier Meta's own answer named on the read just made; when
 * Meta refuses at the run, its words are passed on with what it needs (`explain`) — Nexus has no way around it.
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { metaAccountChangeRefusal } from './change-account-settings.js'
import type { AccessAccountState, AccessAssetNow, AssigneeNow, PartnerNow, RelationshipNow, ServerEventBusinessNow } from './live-access-change.js'
import { MAX_SERVER_EVENT_BUSINESSES, META_ACCESS_TASKS, META_AD_ACCOUNT_TASK_SETS, META_PARTNER_TASKS, META_TASK_WORDS, metaAdAccountPreset, metaIsAssetAdmin, metaLastAdminProblem, metaTaskList, type MetaAccessAsset } from '../../meta/meta-access-lists.js'
import { META_ACCESS_KIND_OF } from '../../gateway/meta-access-rules.js'
import { META_FULL_TIER } from '../../gateway/rate.js'

// ── shared ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What every access change stands on beside its own lists. */
export interface AccessCommonLive {
  state: AccessAccountState
  /** The chosen ad account's business portfolio (its owner), read now. */
  portfolioId: string
  /**
   * Another business in Nexus uses this portfolio (its link names it, or it chose one of the portfolio's own ad accounts:
   * review A-N3). Null: Nexus could not tell — counted as shared wherever it matters (fail closed).
   */
  portfolioShared: boolean | null
  /** Nexus's own system user (stored, else `me`); null: not known. */
  nexusSystemUserId: string | null
}

export const NO_META_CHECK = 'Meta documents no check (validate_only) on any of these edges: the preview is built from the live state, read again before it is sent.'

/** The tier Meta named, in words a person reads before approving (never a refusal: Meta's answer decides). */
export function tierWarning(tier: string | null): string {
  const needs = 'Meta lets only the FULL Marketing API access tier change people\'s and partners\' access through the API (Meta: the Limited tier has "No Business Manager access to manage ad accounts, user permissions, and Pages").'
  if (tier === META_FULL_TIER) return `${needs} Meta named this app's tier ${tier} (Full) on the read just made.`
  const upgrade = 'The Full tier comes after App Review: once the app made at least 500 Marketing API calls in 15 days with under 15 % errors over the last 500, the Owner presses Upgrade in the Meta App Dashboard › App Review › Permissions and Features. Nexus has no way around it.'
  return tier
    ? `${needs} Meta named this app's tier ${tier} (${tier === 'development_access' ? 'Limited' : 'not Full'}) on the read just made, so Meta will most likely refuse this change when it runs: its words are then passed on. ${upgrade}`
    : `${needs} Meta did not name this app's tier on the read just made: if it is still Limited, Meta refuses this change when it runs and its words are passed on. ${upgrade}`
}

/**
 * Meta's codes an access change may meet, in plain words (the kit adds them to the step's sentence by base code). Checked
 * 2026-10-25: ad-account/assigned_users (100, 200, 2620; DELETE 100, 3919, 190), page/agencies (200, 3989, 100, 368, 3946,
 * 80001), error-reference (100 / 1752129), business.md (415 two-factor), Graph error handling (3, 10, 368).
 */
export const ACCESS_EXPLAIN: Readonly<Record<string, string>> = {
  '3': 'Meta says capability or permissions issue: most likely the app is not yet at the Full Marketing API access tier (people and partner access need it, and business_management). The Owner upgrades the tier in the Meta App Dashboard; Nexus has no way around it.',
  '10': 'Meta says the app does not have permission for this action: it needs the Full Marketing API access tier and business_management, and a system user that may manage the asset. Nexus has no way around it.',
  '100': 'Meta says invalid parameter; with subcode 1752129 ("This Task Combination Is Not Supported") an ad account takes only Admin [MANAGE, ADVERTISE, ANALYZE], General [ADVERTISE, ANALYZE] or Reporting [ANALYZE].',
  '200': 'Meta says permissions error: people and partner access need the Full Marketing API access tier, business_management on the token and a system user that may manage this asset (MANAGE on it; to end a relationship Meta may require an admin of the portfolio). Nexus has no way around it; a person can do it in Meta Business settings.',
  '2620': 'Meta: "Invalid call to update account permissions" — the person may not be one Meta lets hold these tasks here (or the system user may not change them).',
  '3919': 'Meta: "There was an unexpected technical issue. Please try again." Nexus does not send it again by itself: ask again in a while.',
  '3989': 'Meta: "You are trying to assign a duplicated asset to this agency" — it is already shared with that partner.',
  '3946': 'Meta: "Asset already belongs to this Business Manager" — that portfolio owns it already.',
  '415': 'Meta asks for two-factor authentication for this change: a person with two-factor turned on does it in Meta Business settings.',
  '368': 'Meta says the action was deemed abusive or is not allowed (temporarily blocked): nothing was changed; wait and ask again later, and a person checks Account Quality in Meta Business Suite.',
}
/** Review B-F6 — a Page's access: Meta's reference reads it with a Page token of someone with MANAGE (pages_manage_metadata). */
export const ACCESS_EXPLAIN_PAGE: Readonly<Record<string, string>> = {
  ...ACCESS_EXPLAIN,
  '10': `${ACCESS_EXPLAIN['10']} On a Page Meta may also want pages_manage_metadata, or the Page's own token of someone with MANAGE on it (Nexus sends the system user's).`,
  '200': `${ACCESS_EXPLAIN['200']} On a Page Meta may also want pages_manage_metadata, or the Page's own token of someone with MANAGE on it (Nexus sends the system user's).`,
}

const sortedEq = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((t, i) => t === [...b].sort()[i])
const tasksWords = (tasks: readonly string[]) => (tasks.length ? tasks.map((t) => (META_TASK_WORDS[t] ? `${t} (${META_TASK_WORDS[t]})` : t)).join(', ') : 'none')
const shown = (tasks: readonly string[] | null) => (tasks === null ? 'no access' : tasks.length ? tasks.join(', ') : 'assigned, no task')
/** A partner's tasks as Meta listed them (null: Meta did not list them on this edge). */
const partnerTasks = (tasks: readonly string[] | null) => (tasks === null ? 'tasks not listed by Meta' : tasks.length ? tasks.join(', ') : 'no task')
const AD_ACCOUNT_SETS_WORDS = META_AD_ACCOUNT_TASK_SETS.map((s, i) => `${['Admin', 'General', 'Reporting'][i]} [${s.join(', ')}]`).join(', ')

/**
 * The tasks undo can send back for this list as Meta read it, or null (undo then refuses, and the preview says so): an ad
 * account's preset (Meta's unpacked DRAFT / AA_ANALYZE aside); on a Page or Instagram account the list itself when every
 * task is one Nexus sends. An empty list has none.
 */
export function metaUndoTasks(asset: MetaAccessAsset, tasks: readonly string[] | null, who: 'person' | 'partner' = 'person'): string[] | null {
  if (!tasks?.length) return null
  if (asset === 'ad-account') return metaAdAccountPreset(tasks)
  const allowed = (who === 'partner' ? META_PARTNER_TASKS : META_ACCESS_TASKS)[asset]
  return tasks.every((t) => allowed.includes(t)) ? [...new Set(tasks)].sort() : null
}

const ASSET_WORD: Readonly<Record<MetaAccessAsset, string>> = { 'ad-account': 'an ad account', page: 'a Page', instagram: 'an Instagram account', pixel: 'a dataset' }
/** Owner option 1 — Meta has no removal of a person from a dataset (no DELETE on ads-pixel/assigned_users anywhere). */
export const PIXEL_NO_REMOVE = 'Meta has no way to take a person\'s tasks on a dataset back by API (no delete on the dataset\'s assigned_users in its reference, its SDK or its Ads CLI): a person does it in Meta Business settings › Data sources › Datasets.'

/** The same tasks as asked (an ad account by its preset: Meta reads them back unpacked). */
const sameTasks = (asset: MetaAccessAsset, now: readonly string[], asked: readonly string[]) => (asset === 'ad-account' ? sortedEq(metaAdAccountPreset(now) ?? now, asked) : sortedEq(now, asked))

/** Why these tasks are not ones Nexus sends on this asset, or null. */
function tasksProblem(asset: AccessAssetNow, tasks: readonly string[], who: 'person' | 'partner'): string | null {
  const allowed = (who === 'partner' ? META_PARTNER_TASKS : META_ACCESS_TASKS)[asset.asset]
  if (!tasks.length) return who === 'person' ? `tasks lists what the person may do on ${asset.label} (${allowed.join(', ')}); to take every task away, use action remove.` : `permittedTasks lists what the partner may do on ${asset.label} (Nexus always sends them: ${allowed.join(', ')}).`
  const odd = tasks.filter((t) => !allowed.includes(t))
  if (odd.length) return `${odd.join(', ')} ${odd.length === 1 ? 'is no task' : 'are no tasks'} ${who === 'person' ? 'of' : 'a partner can hold on'} ${ASSET_WORD[asset.asset]} (${allowed.join(', ')}).`
  // Review B-F4 — an ad account takes only Meta's three combinations (100 / 1752129 for any other).
  if (asset.asset === 'ad-account' && !META_AD_ACCOUNT_TASK_SETS.some((s) => sortedEq(s, tasks))) return `An ad account takes only Meta's task combinations ${AD_ACCOUNT_SETS_WORDS} (any other: Meta's 100 / 1752129 "This Task Combination Is Not Supported").`
  return null
}

function draftOf(d: Pick<MetaChangeDraft, 'summary' | 'requests' | 'stands' | 'before' | 'after'> & Partial<MetaChangeDraft>): MetaChangeDraft {
  return { changes: {}, totals: {}, warnings: [], spendsMoney: [], skipped: [], ...d }
}

function accessRequest(label: string, objectId: string, asset: MetaAccessAsset | 'portfolio', params: Record<string, string>, extra: Pick<MetaChangeRequest, 'operation'> & Partial<MetaChangeRequest>): MetaChangeRequest {
  return {
    step: 1, label, kind: 'campaign', objectKind: asset === 'portfolio' ? 'accessportfolio' : META_ACCESS_KIND_OF[asset], objectId, params,
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: true, explain: asset === 'page' ? ACCESS_EXPLAIN_PAGE : ACCESS_EXPLAIN, ...extra,
  }
}

const PAGE_TOKEN_WARNING = 'A Page\'s people and partners go with the business\'s system-user token (Meta\'s reference reads them with a Page token of someone with MANAGE, and pages_manage_metadata): if Meta asks for a Page token, its words are passed on.'

// ── set-meta-user-access ────────────────────────────────────────────────────────────────────────────────────────────

export type UserAccessAction = 'set' | 'remove'
export interface UserAccessRequest { asset: MetaAccessAsset; action: UserAccessAction; personId: string; tasks?: string[] }

export interface UserAccessLive extends AccessCommonLive {
  asset: AccessAssetNow
  assigned: Map<string, AssigneeNow>
  assignedMore: boolean
  /** The portfolio's business users ('person') and system users. */
  people: Map<string, { name: string | null; kind: 'person' | 'system user' }>
  peopleMore: boolean
}

/** What a person's access change records, before and after (undo reads them). */
export interface UserAccessRecord {
  op: UserAccessAction
  asset: MetaAccessAsset
  nodeId: string
  personId: string
  /** On the asset (after: as the change left it), and their tasks then (Meta's unpacked list). */
  assigned: boolean
  tasks: string[] | null
  /** before only: what undo cannot put back, in words. */
  noUndo?: string[]
}

/** The ids of the portfolio's business users (people who sign in to Meta's screens). */
const personsOf = (live: Pick<UserAccessLive, 'people'>) => new Set([...live.people].filter(([, p]) => p.kind === 'person').map(([id]) => id))

export function userAccessDraft(request: UserAccessRequest, live: UserAccessLive): MetaChangeDraft | { refusal: string } {
  const refused = metaAccountChangeRefusal(live.state)
  if (refused) return { refusal: refused }
  const asset = live.asset
  if (!live.nexusSystemUserId) return { refusal: 'Nexus could not read which system user it is, so it changes no one\'s access.' }
  if (request.personId === live.nexusSystemUserId) return { refusal: `${request.personId} is Nexus's own system user: Nexus never changes its own access (fewer tasks or none would cut Nexus off). A person does that in Meta Business settings, if it is meant.` }
  if (live.assignedMore) return { refusal: `More people hold tasks on ${asset.label} than Nexus reads (500): change their access in Meta Business settings.` }
  const now = live.assigned.get(request.personId) ?? null
  const who = live.people.get(request.personId) ?? null
  const name = who?.name ?? now?.name ?? null
  const label = `${who?.kind ?? 'person'} ${name ? `"${name}" ` : ''}(${request.personId})`
  if (asset.asset === 'pixel' && request.action === 'remove') return { refusal: PIXEL_NO_REMOVE }
  let tasks: string[] | null = null
  if (request.action === 'set') {
    if (!who) {
      return { refusal: live.peopleMore
        ? 'The business portfolio has more people than Nexus reads (500): give access in Meta Business settings.'
        : `${request.personId} is not a person or system user of the ad account's business portfolio: Nexus gives access only to them (meta-account-access view people lists who is; inviting someone to the portfolio is its admin's step in Meta Business settings).` }
    }
    if (live.portfolioShared !== false && who.kind === 'system user') return { refusal: `${request.personId} is a system user, and another business in Nexus uses this business portfolio (or Nexus could not tell that none does): Nexus cannot tell whose system user it is, so it gives it no access.` }
    tasks = [...new Set(request.tasks ?? [])].sort()
    const problem = tasksProblem(asset, tasks, 'person')
    if (problem) return { refusal: problem }
    if (now && sameTasks(asset.asset, now.tasks, tasks)) return draftOf({ summary: 'Nothing to change', skipped: [`${label} holds exactly these tasks on ${asset.label} already.`], requests: [], stands: null, before: null, after: null })
  } else if (!now) {
    return { refusal: `${request.personId} holds no task on ${asset.label}: nothing to take off.` }
  }
  // Review A-N2 — a system user is changed only when Nexus's own is listed among the portfolio's system users (else the
  // two ids could be one system user Meta numbers twice, and Nexus would change its own access).
  const systemUser = who?.kind === 'system user' || (!who && !live.people.has(request.personId))
  if (systemUser && live.people.get(live.nexusSystemUserId)?.kind !== 'system user') {
    return { refusal: `Nexus's own system user is not listed among the business portfolio's system users, so Nexus cannot be sure ${request.personId} is not itself: it changes no system user's access here. A person does it in Meta Business settings, if it is meant.` }
  }
  const floor = metaLastAdminProblem(asset.asset, [...live.assigned.values()], personsOf(live), request.personId, tasks)
  if (floor) return { refusal: floor }

  const kind = META_ACCESS_KIND_OF[asset.asset]
  const params: Record<string, string> = request.action === 'set'
    ? { user: request.personId, tasks: metaTaskList(tasks!), ...(asset.asset === 'page' || asset.asset === 'instagram' ? { business: live.portfolioId } : {}) }
    : { user: request.personId }
  const summary = request.action === 'remove'
    ? `Take ${label} off ${asset.label}`
    : now ? `Change ${label} to ${tasks!.join(', ')} on ${asset.label}` : `Give ${label} ${tasks!.join(', ')} on ${asset.label}`
  const warnings: string[] = []
  if (tasks && metaIsAssetAdmin(asset.asset, tasks) && !(now && metaIsAssetAdmin(asset.asset, now.tasks))) {
    warnings.push(`This makes ${label} an ADMIN of ${asset.label}: they can then change its people${asset.asset === 'ad-account' ? ', payment methods and settings' : ' and settings'} — and take others' access away.`)
  }
  if (tasks?.includes('ADVERTISE') && !(now?.tasks ?? []).includes('ADVERTISE')) {
    warnings.push(asset.asset === 'ad-account'
      ? `ADVERTISE lets ${label} create and change ads of this ad account that spend its money (no budget limit of Nexus's applies to what they do in Meta).`
      : asset.asset === 'pixel' ? `ADVERTISE lets ${label} use this dataset in ads of the ad accounts they can use.`
        : `ADVERTISE lets ${label} run ads as ${asset.label} from the ad accounts they can use.`)
  }
  if (request.action === 'remove') warnings.push(`${label} loses ${asset.label} in Meta at once (their open Ads Manager or Business Suite sessions lose it too).`)
  if (asset.asset === 'page') warnings.push(PAGE_TOKEN_WARNING)
  if (asset.asset === 'instagram') warnings.push('People are set on the Instagram account\'s BUSINESS ASSET in the portfolio (Meta\'s instagram-accounts guide), never on the Instagram user.')
  warnings.push('Meta may ask for two-factor authentication on the business for this change (415): a person then does it in Meta Business settings.')
  warnings.push(tierWarning(live.state.tier), NO_META_CHECK)
  // Review A-N4 — the preview says when undo will refuse: tasks Nexus cannot send back as they are (none, an unknown task, an
  // ad account's list that is no preset).
  const noUndo: string[] = []
  if (now && !metaUndoTasks(asset.asset, now.tasks)) noUndo.push(`${label} now holds ${shown(now.tasks)}, which Nexus cannot send back as it is: undo of this change will refuse (a person sets it again in Meta Business settings).`)
  // Owner option 1 — a dataset: a person given tasks for the first time cannot be taken off again by API.
  if (asset.asset === 'pixel' && !now) noUndo.push('Meta has no way to take these tasks back by API — a person removes them in Meta Business settings › Data sources.')
  if (asset.asset === 'pixel') warnings.push('Meta documents giving a person tasks on a dataset in its SDK and Ads CLI only (its reference says the edge takes no change): Meta\'s answer decides (LIVE-PROBES ST41-07).')
  if (noUndo.length) warnings.push(`No undo: ${noUndo.join(' ')}`)
  const { changes } = changeLines([[`Access of ${label}`, now ? `${now.tasks.join(', ') || 'assigned, no task'}` : 'no access', request.action === 'set' ? tasksWords(tasks!) : 'no access']])
  const admins = [...live.assigned.values()].filter((a) => personsOf(live).has(a.id) && metaIsAssetAdmin(asset.asset, a.tasks)).map((a) => a.id).sort()
  return draftOf({
    summary,
    changes,
    totals: { people: 1, requests: 1 },
    warnings,
    requests: [accessRequest(summary, asset.nodeId, asset.asset, params, {
      operation: request.action === 'set' ? `access.${kind}.user.set` : `access.${kind}.user.remove`, edge: 'assigned_users',
      ...(request.action === 'remove' ? { method: 'DELETE' as const } : {}),
    })],
    stands: {
      account: { status: live.state.status, disableReason: live.state.disableReason }, portfolioId: live.portfolioId, portfolioShared: live.portfolioShared,
      asset: asset.asset, nodeId: asset.nodeId, personId: request.personId, kind: who?.kind ?? null, tasks: now?.tasks ?? null, admins, nexusSystemUserId: live.nexusSystemUserId,
    },
    before: { op: request.action, asset: asset.asset, nodeId: asset.nodeId, personId: request.personId, assigned: !!now, tasks: now?.tasks ?? null, ...(noUndo.length ? { noUndo } : {}) } satisfies UserAccessRecord,
    after: { op: request.action, asset: asset.asset, nodeId: asset.nodeId, personId: request.personId, assigned: request.action === 'set', tasks } satisfies UserAccessRecord,
  })
}

/**
 * A person's tasks after the change, as Meta read them right after: done when they hold every task asked and nothing Meta
 * would call an admin's that was not asked (Meta answers "all unpacked" tasks: DRAFT may come with ADVERTISE). Not listed
 * yet after a set, or still listed after a remove: Meta's list may not have caught up — said, the record keeps what was sent.
 */
export function userReadBack(asset: MetaAccessAsset, asked: readonly string[] | null, read: AssigneeNow | null): { moved: string[]; reads: string } {
  if (asked === null) return { moved: [], reads: read ? `still listed with ${shown(read.tasks)} right after (Meta's list may catch up later)` : 'no access' }
  if (!read) return { moved: [], reads: 'not listed yet right after (Meta\'s list may catch up later)' }
  const missing = asked.filter((t) => !read.tasks.includes(t))
  const extraAdmin = !metaIsAssetAdmin(asset, asked) && metaIsAssetAdmin(asset, read.tasks)
  return { moved: missing.length || extraAdmin ? ['tasks'] : [], reads: `tasks ${shown(read.tasks)}` }
}

// ── set-meta-partner-access ─────────────────────────────────────────────────────────────────────────────────────────

export type PartnerAccessAction = 'share' | 'remove' | 'end-relationship' | 'server-events'
export type MetaRelationship = 'agency' | 'client'
export interface PartnerAccessRequest { action: PartnerAccessAction; asset?: MetaAccessAsset; relationship?: MetaRelationship; partnerBusinessId: string; permittedTasks?: string[] }

export interface PartnerAccessLive extends AccessCommonLive {
  /** share / remove: the asset and the partners it is shared with now. */
  asset?: AccessAssetNow
  partners?: Map<string, PartnerNow>
  /** end-relationship: the portfolio's agencies or clients now, with what each relationship holds. */
  relationships?: Map<string, RelationshipNow>
  /** end-relationship: Meta refused some of the relationship's fields (the fallback's words): nothing is ended then. */
  sharesNote?: string | null
  listMore: boolean
  partnerTaken: boolean
  /** remove / end-relationship: the portfolio's system users (Nexus's own must be one of them). */
  systemUsers?: Set<string> | null
  /** end-relationship with a client: are the chosen Page and Instagram account the portfolio's own ('none': none chosen)? */
  chosenOwned?: { page: boolean | 'none'; instagram: boolean | 'none' }
  /** end-relationship: the relationship holds an ad account or Page another business in Nexus chose. */
  sharesTaken?: boolean
  /**
   * end-relationship with a client (review A-MF1): the Instagram accounts this portfolio holds as a client — none another
   * business in Nexus chose ('ok'), one it did ('taken'), or not readable in full ('unread'). Meta names no Instagram account
   * for a relationship, so all of them are looked at.
   */
  clientInstagram?: 'ok' | 'taken' | 'unread'
}

/** What a partner change records, before and after (undo reads them). */
export interface PartnerAccessRecord {
  op: PartnerAccessAction
  asset: MetaAccessAsset | 'portfolio'
  relationship?: MetaRelationship
  nodeId: string
  partnerId: string
  /** Shared (or in the relationship) — after: as the change left it — and the partner's tasks then. */
  shared: boolean
  tasks: string[] | null
  accessStatus?: string | null
  /** server-events (SG-014): the businesses allowed to send the dataset's server events (sorted ids). */
  businesses?: string[]
  noUndo?: string[]
}

/** Review B-F1 — what Meta documents only in its SDK, said in the preview (the Instagram asset's share and removal are documented). */
const SDK_ONLY: Readonly<Record<string, string>> = {
  'ad-account:share': 'Meta names this route on its v26 reference pages (business/client_ad_accounts, ads-pixel/shared_accounts: "use POST {ad_account}/agencies"), but its parameters are in its SDK only (AdAccount create_agency: business, permitted_tasks): Meta\'s answer decides (LIVE-PROBES ST41-03).',
  'page:remove': 'Meta\'s Page reference says the agencies edge has no delete ("You can\'t perform this operation on this endpoint"), while its SDK has one (Page delete_agencies): Meta\'s answer decides (LIVE-PROBES ST41-04); if Meta refuses, a person removes the partner in Meta Business settings › Partners.',
}

/** The relationship's share ids, sorted, for its basis (review A-SF3): what the person approved it would lose. */
const sharesBasis = (row: RelationshipNow) => (row.shares ? { adAccounts: row.shares.adAccounts, pages: row.shares.pages, catalogs: row.shares.catalogs, apps: row.shares.apps } : null)

export function partnerAccessDraft(request: PartnerAccessRequest, live: PartnerAccessLive): MetaChangeDraft | { refusal: string } {
  const refused = metaAccountChangeRefusal(live.state)
  if (refused) return { refusal: refused }
  const partnerId = request.partnerBusinessId
  if (partnerId === live.portfolioId) return { refusal: 'That is this business\'s own business portfolio: access is shared with (or taken from) a partner, never its owner.' }
  if (live.partnerTaken) return { refusal: `Business portfolio ${partnerId} is used by another business in Nexus: Nexus never changes what it shares with it or takes from it.` }
  if (live.listMore) return { refusal: 'There are more partners than Nexus reads (500): change this access in Meta Business settings › Partners.' }
  const nexusOwn = (): string | null => {
    if (!live.nexusSystemUserId) return 'Nexus could not read which system user it is, so it takes no partner off and ends no relationship.'
    if (!live.systemUsers) return 'Nexus could not read the business portfolio\'s system users in full, so it takes no partner off and ends no relationship.'
    return live.systemUsers.has(live.nexusSystemUserId) ? null
      : 'Nexus\'s own system user is not a system user of the ad account\'s business portfolio, so its access (and its Meta app\'s) may come through a partner: Nexus takes no partner off and ends no relationship that could cut Nexus off. A person does it in Meta Business settings › Partners, if it is meant.'
  }
  const tier = tierWarning(live.state.tier)
  const bySettings = 'A person does it in Meta Business settings › Partners, if it is meant.'

  if (request.action === 'end-relationship') {
    const relationship = request.relationship
    if (!relationship) return { refusal: 'Name the relationship to end: relationship agency (a partner this portfolio shares with) or client (a business that shares with this portfolio).' }
    if (live.portfolioShared !== false) return { refusal: `Another business in Nexus uses this business portfolio (or Nexus could not tell that none does): ending one of its relationships would cut that business's assets too, so Nexus ends none. ${bySettings}` }
    const row = live.relationships?.get(partnerId) ?? null
    if (!row) return { refusal: `Business portfolio ${partnerId} is not ${relationship === 'agency' ? 'an agency of' : 'a client of'} the ad account's business portfolio: nothing to end.` }
    const own = nexusOwn()
    if (own) return { refusal: own }
    // Review A-MF1 — fail closed: the ad accounts and Pages the relationship holds are listed by Meta and readable, or nothing ends.
    if (live.sharesNote || !row.shares || row.shares.adAccounts === null || row.shares.pages === null) {
      return { refusal: `Meta did not list the ad accounts and Pages this relationship holds in a form Nexus can read${live.sharesNote ? ` (${live.sharesNote})` : ''}, so Nexus cannot confirm ending it cuts no other business in Nexus: it ends none. ${bySettings}` }
    }
    if (live.sharesTaken !== false) return { refusal: `The relationship holds an ad account or Page another business in Nexus uses (or Nexus could not check): ending it could cut that business off, so Nexus ends none. ${bySettings}` }
    if (relationship === 'client') {
      if (live.chosenOwned?.page === false) return { refusal: `The chosen Facebook Page is not the business portfolio's own: ending a client relationship could take it away from Nexus. ${bySettings}` }
      if (live.chosenOwned?.instagram === false) return { refusal: `The chosen Instagram account is not the business portfolio's own: ending a client relationship could take it away from Nexus. ${bySettings}` }
      if (!live.chosenOwned) return { refusal: 'Nexus could not confirm the chosen Page and Instagram account are the portfolio\'s own, so it ends no client relationship.' }
      if (live.clientInstagram !== 'ok') {
        return { refusal: live.clientInstagram === 'taken'
          ? `This portfolio holds, as a client, an Instagram account another business in Nexus uses (Meta does not say which client it comes from): ending a client relationship could cut that business off, so Nexus ends none. ${bySettings}`
          : `Nexus could not read in full the Instagram accounts this portfolio holds as a client (Meta names none for a relationship), so it ends no client relationship. ${bySettings}` }
      }
    }
    const who = `business portfolio ${row.name ? `"${row.name}" ` : ''}(${partnerId})`
    const goes = ([['ad account', row.shares.adAccounts], ['Page', row.shares.pages], ['catalog', row.shares.catalogs], ['app', row.shares.apps]] as Array<[string, string[] | null]>)
      .map(([k, ids]) => (ids === null ? `${k}s: Meta did not say` : `${plural(ids.length, k)}${ids.length ? ` (${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', …' : ''})` : ''}`)).join('; ')
    const summary = relationship === 'agency' ? `End the relationship with agency ${who}: it loses EVERY asset this portfolio shares with it` : `End the relationship with client ${who}: this portfolio loses EVERY asset that client shares with it`
    return draftOf({
      summary,
      ...changeLinesOf([[`Relationship with ${who}`, relationship === 'agency' ? 'agency' : 'client', 'ended'], [relationship === 'agency' ? 'What it loses' : 'What this portfolio loses', goes, 'all of it']]),
      totals: { relationships: 1, requests: 1 },
      warnings: [
        `This ends the WHOLE ${relationship} relationship at once — not one asset: ${goes}. Meta's list names ad accounts, Pages, catalogs and apps only: Instagram accounts, datasets and any other asset of the relationship go too and are not listed. NO UNDO: ${relationship === 'agency' ? 'the agency must ask again and be accepted' : 'the client must share its assets again'}; Nexus cannot put it back.`,
        'Meta may require an ADMIN of the business portfolio to end a relationship: if it refuses, a person does it in Meta Business settings › Partners (D1).',
        tier, NO_META_CHECK,
      ],
      requests: [accessRequest(summary, live.portfolioId, 'portfolio', { business: partnerId }, {
        ...(relationship === 'agency' ? { operation: 'access.portfolio.agency.end', edge: 'agencies' as const } : { operation: 'access.portfolio.client.end', edge: 'clients' as const }), method: 'DELETE', undoable: false,
      })],
      // Review A-SF3 — what it would lose is in the basis: an asset shared after the approval stales it.
      stands: { account: { status: live.state.status, disableReason: live.state.disableReason }, portfolioId: live.portfolioId, relationship, partnerId, listed: true, shares: sharesBasis(row), nexusSystemUserId: live.nexusSystemUserId, chosenOwned: live.chosenOwned ?? null, clientInstagram: live.clientInstagram ?? null },
      before: { op: 'end-relationship', asset: 'portfolio', relationship, nodeId: live.portfolioId, partnerId, shared: true, tasks: null, noUndo: ['Ending a relationship has no undo: the partner asks or shares again.'] } satisfies PartnerAccessRecord,
      after: { op: 'end-relationship', asset: 'portfolio', relationship, nodeId: live.portfolioId, partnerId, shared: false, tasks: null } satisfies PartnerAccessRecord,
    })
  }

  const asset = live.asset
  if (!asset || !live.partners) return { refusal: 'Name the asset: asset ad-account, page or instagram (the business\'s chosen one).' }
  const now = live.partners.get(partnerId) ?? null
  const who = `business portfolio ${now?.name ? `"${now.name}" ` : ''}(${partnerId})`
  const sdk = SDK_ONLY[`${asset.asset}:${request.action}`]
  const kind = META_ACCESS_KIND_OF[asset.asset]
  if (request.action === 'share') {
    const tasks = [...new Set(request.permittedTasks ?? [])].sort()
    const problem = tasksProblem(asset, tasks, 'partner')
    if (problem) return { refusal: problem }
    if (now) {
      if (now.tasks && sameTasks(asset.asset, now.tasks, tasks)) return draftOf({ summary: 'Nothing to change', skipped: [`${asset.label} is shared with ${who} with exactly these tasks already.`], requests: [], stands: null, before: null, after: null })
      // Review B-F3 — Meta documents no update on any agencies edge; a second share likely answers 3989 (listed on the Page's).
      return { refusal: asset.asset === 'page'
        ? `${asset.label} is already shared with ${who} (${partnerTasks(now.tasks)}). Meta documents no change of a partner's tasks (its Page reference lists 3989 "duplicated asset" for a second share), and taking a Page partner off may not work by API (the reference says the delete is not supported): change it in Meta Business settings › Partners.`
        : `${asset.label} is already shared with ${who} (${partnerTasks(now.tasks)}). Meta documents no change of a partner's tasks in one call (a second share would most likely be refused as a duplicate): take the partner off (action remove), then share again with the tasks wanted — two changes, each approved.` }
    }
    const summary = `Share ${asset.label} with ${who}: ${tasks.join(', ')}`
    const warnings = [
      `The partner's people can then ${tasks.map((t) => META_TASK_WORDS[t] ?? t).join(', ')} on ${asset.label}, from their own business portfolio.`,
      // Review A-SF4 — a share with an admin's tasks says what an admin can do.
      ...(metaIsAssetAdmin(asset.asset, tasks) ? [`This makes ${who} an ADMIN of ${asset.label}: its people can then change who has it — and take others' access away, yours too.`] : []),
      ...(tasks.includes('ADVERTISE') || tasks.includes('MANAGE') ? [asset.asset === 'ad-account' ? 'ADVERTISE or MANAGE lets the partner create and run ads of this ad account that spend its money (no limit of Nexus\'s applies to what they do in Meta).' : `ADVERTISE or MANAGE lets the partner run ads as ${asset.label}.`] : []),
      'Meta may list the share as PENDING until the partner accepts it (access_status).',
      // Owner option 1 — a dataset's share (the Pixel Agency Sharing guide).
      ...(asset.asset === 'pixel' ? [
        'With no approved relationship between the two portfolios yet, Meta answers a pending request (pending_request_id): the dataset is shared once the partner accepts the sharing agreement in its Business settings.',
        ...(tasks.includes('EDIT') ? ['EDIT on a dataset is limited by Meta ("currently limited — contact your Meta representative"): Meta may refuse it.'] : []),
        'Meta\'s guide shares a dataset with the token of a system user that owns it: if Nexus\'s system user is not one, Meta refuses and a person shares it in Meta Business settings › Data sources.',
      ] : []),
      // Review B-F3 / B-F6 — a Page share's undo is the Page DELETE Meta's reference says is not supported; the Page token.
      ...(asset.asset === 'page' ? ['Taking it back (its undo, or action remove) uses a DELETE that Meta\'s Page reference says is not supported (its SDK has it): if Meta refuses, a person removes the partner in Meta Business settings › Partners.', PAGE_TOKEN_WARNING] : []),
      ...(sdk ? [sdk] : []),
      tier, NO_META_CHECK,
    ]
    return draftOf({
      summary,
      ...changeLinesOf([[`Sharing with ${who}`, 'not shared', `shared: ${tasksWords(tasks)}`]]),
      totals: { partners: 1, requests: 1 },
      warnings,
      requests: [accessRequest(summary, asset.nodeId, asset.asset, { business: partnerId, permitted_tasks: metaTaskList(tasks) }, { operation: `access.${kind}.partner.share`, edge: 'agencies' })],
      stands: { account: { status: live.state.status, disableReason: live.state.disableReason }, portfolioId: live.portfolioId, asset: asset.asset, nodeId: asset.nodeId, partnerId, shared: false },
      before: { op: 'share', asset: asset.asset, nodeId: asset.nodeId, partnerId, shared: false, tasks: null } satisfies PartnerAccessRecord,
      after: { op: 'share', asset: asset.asset, nodeId: asset.nodeId, partnerId, shared: true, tasks } satisfies PartnerAccessRecord,
    })
  }
  // remove
  if (!now) return { refusal: `${asset.label} is not shared with business portfolio ${partnerId}: nothing to take off.` }
  const own = nexusOwn()
  if (own) return { refusal: own }
  const summary = `Take ${who} off ${asset.label}`
  const noUndo = metaUndoTasks(asset.asset, now.tasks, 'partner') ? [] : [`Nexus did not read tasks it can give the partner back (${partnerTasks(now.tasks)}): undo of this change will refuse.`]
  // Review A-SF4 — undo's re-share in words that do not promise what Meta has not shown.
  const undoWords = asset.asset === 'ad-account'
    ? 'Undo asks to share it again, which Meta documents in its SDK only (its pages name the route, not its parameters): Meta may refuse it, and the partner may have to accept again — treat this removal as one-way until LIVE-PROBES ST41-03 settles it.'
    : 'Undo shares it again with the tasks it had (documented); Meta may then list it PENDING until the partner accepts.'
  return draftOf({
    summary,
    ...changeLinesOf([[`Sharing with ${who}`, `shared: ${partnerTasks(now.tasks)}${now.accessStatus ? ` (${now.accessStatus})` : ''}`, 'not shared']]),
    totals: { partners: 1, requests: 1 },
    warnings: [
      `${who} loses ${asset.label} at once: its people can no longer use it (ads they run with it stop being theirs to change).`,
      ...(sdk ? [sdk] : []),
      ...(noUndo.length ? [`No undo: ${noUndo.join(' ')}`] : [undoWords]),
      ...(asset.asset === 'page' ? [PAGE_TOKEN_WARNING] : []),
      ...(asset.asset === 'pixel' ? ['Meta\'s guide takes a partner off a dataset with an admin\'s token of the portfolio that owns it: if Meta refuses the system user, a person does it in Meta Business settings › Data sources.'] : []),
      tier, NO_META_CHECK,
    ],
    // Owner option 1 — a dataset's partner goes off on the QUERY (the guide's `DELETE <adspixel>/agencies?business=…`): its
    // plan hash still names the partner (planParams).
    requests: [asset.asset === 'pixel'
      ? accessRequest(summary, asset.nodeId, asset.asset, {}, { operation: `access.${kind}.partner.remove`, edge: 'agencies', method: 'DELETE', via: { query: { business: partnerId } }, planParams: { business: partnerId } })
      : accessRequest(summary, asset.nodeId, asset.asset, { business: partnerId }, { operation: `access.${kind}.partner.remove`, edge: 'agencies', method: 'DELETE' })],
    stands: { account: { status: live.state.status, disableReason: live.state.disableReason }, portfolioId: live.portfolioId, asset: asset.asset, nodeId: asset.nodeId, partnerId, shared: true, tasks: now.tasks, nexusSystemUserId: live.nexusSystemUserId },
    before: { op: 'remove', asset: asset.asset, nodeId: asset.nodeId, partnerId, shared: true, tasks: now.tasks, accessStatus: now.accessStatus, ...(noUndo.length ? { noUndo } : {}) } satisfies PartnerAccessRecord,
    after: { op: 'remove', asset: asset.asset, nodeId: asset.nodeId, partnerId, shared: false, tasks: null } satisfies PartnerAccessRecord,
  })
}

/** The from → to lines of a partner change (at most two: never cut). */
const changeLinesOf = (lines: Array<[string, unknown, unknown]>) => ({ changes: changeLines(lines).changes })

/** A partner after the change, as Meta read the asset's partners right after (Meta's list may lag: said, not judged). */
export function partnerReadBack(asked: readonly string[] | null, read: PartnerNow | null): { moved: string[]; reads: string } {
  if (asked === null) return { moved: [], reads: read ? 'still listed right after (Meta\'s list may catch up later)' : 'not shared' }
  if (!read) return { moved: [], reads: 'not listed yet right after (Meta\'s list may catch up later)' }
  // Re-review R-5 — Meta did not list the partner's tasks on this edge: said, never judged as "moved".
  if (read.tasks === null) return { moved: [], reads: `shared${read.accessStatus ? ` (${read.accessStatus})` : ''}; Meta did not list its tasks` }
  const missing = asked.filter((t) => !read.tasks!.includes(t))
  return { moved: missing.length ? ['permitted_tasks'] : [], reads: `shared: ${partnerTasks(read.tasks)}${read.accessStatus ? ` (${read.accessStatus})` : ''}` }
}

// ── a dataset's server-event businesses (Owner option 1, SG-014) ────────────────────────────────────────────────────────

export interface ServerEventsLive extends AccessCommonLive {
  asset: AccessAssetNow
  businesses: Map<string, ServerEventBusinessNow>
  more: boolean
  /** The asked ids another business in Nexus uses. */
  askedTaken: boolean
  systemUsers: Set<string> | null
}

/**
 * The WHOLE list of businesses allowed to send this dataset's server events (Conversions API): POST /{pixel}
 * server_events_business_ids (reference ads-pixel "Updating", array<numeric string>). Read first
 * (server_events_permitted_business); undo sends the old list back. Never the portfolio itself, never one another Nexus
 * business uses — and when the list holds one now, Nexus changes it not at all (it would keep it on the list).
 */
export function serverEventsDraft(request: { businessIds: string[]; confirmRemove?: boolean }, live: ServerEventsLive): MetaChangeDraft | { refusal: string } {
  const refused = metaAccountChangeRefusal(live.state)
  if (refused) return { refusal: refused }
  const asset = live.asset
  const bySettings = 'A person does it in Meta Events Manager › the dataset › Settings, if it is meant.'
  if (live.more) return { refusal: `More businesses may send ${asset.label}'s server events than Nexus reads (500). ${bySettings}` }
  if ([...live.businesses.values()].some((b) => b.takenByAnotherBusiness)) return { refusal: `${asset.label}'s server events may be sent by a business portfolio another business in Nexus uses: Nexus does not change the list (it would have to send it again). ${bySettings}` }
  // Option-1 review SF2 — the portfolio itself on Meta's list: every change would take it off and its undo could never put it back.
  if (live.businesses.has(live.portfolioId)) return { refusal: `Meta lists the dataset's own business portfolio among ${asset.label}'s server-event businesses: Nexus does not change that list (it would take the portfolio off, and undo could never put it back). ${bySettings}` }
  // Option-1 review N1 — a list longer than Nexus can send back whole (its undo) is not changed.
  if (live.businesses.size > MAX_SERVER_EVENT_BUSINESSES) return { refusal: `${asset.label} has ${live.businesses.size} server-event businesses, more than the ${MAX_SERVER_EVENT_BUSINESSES} Nexus sends as one whole list: it could not send this list back (undo), so it changes none. ${bySettings}` }
  const to = [...new Set(request.businessIds)].sort()
  if (to.includes(live.portfolioId)) return { refusal: 'The dataset\'s own business portfolio is not one of the businesses allowed to send its server events: it owns them.' }
  if (live.askedTaken) return { refusal: `The list names a business portfolio another business in Nexus uses: Nexus never lets it send this dataset's server events. ${bySettings}` }
  if (!live.nexusSystemUserId || !live.systemUsers) return { refusal: 'Nexus could not read its own system user and the portfolio\'s system users in full, so it changes no server-event business.' }
  if (!live.systemUsers.has(live.nexusSystemUserId)) return { refusal: `Nexus's own system user is not a system user of the dataset's business portfolio, so its own server events may come through one of these businesses: Nexus changes none. ${bySettings}` }
  const from = [...live.businesses.keys()].sort()
  if (sortedEq(from, to)) return draftOf({ summary: 'Nothing to change', skipped: [`${asset.label}'s server-event businesses are exactly these already.`], requests: [], stands: null, before: null, after: null })
  const added = to.filter((id) => !from.includes(id))
  const removed = from.filter((id) => !to.includes(id))
  const named = (id: string) => { const b = live.businesses.get(id); return b?.name ? `"${b.name}" (${id})` : id }
  // Option-1 review N2 — taking a business off is a removal: it takes confirmRemove, as every other removal does.
  if (removed.length && request.confirmRemove !== true) return { refusal: `This takes ${removed.map(named).join(', ')} off ${asset.label}'s server-event businesses (their events stop counting there at once): it takes confirmRemove: true.` }
  const summary = `Set the businesses allowed to send ${asset.label}'s server events: ${to.length ? to.join(', ') : 'none'}`
  return draftOf({
    summary,
    ...changeLinesOf([[`Server-event businesses of ${asset.label}`, from.length ? from.map(named).join(', ') : 'none', to.length ? to.join(', ') : 'none']]),
    totals: { added: added.length, removed: removed.length, requests: 1 },
    warnings: [
      'This is the WHOLE list (Meta replaces it): every business named may send server events (Conversions API) into this dataset — they count in the results the ad accounts using it optimise for.',
      ...(removed.length ? [`Taken off: ${removed.map(named).join(', ')} — their server events stop counting here at once.`] : []),
      'Undo sends the list as it is now back to Meta.',
      NO_META_CHECK,
    ],
    // Option-1 review N3 / N6 — the list it was built on goes to the gateway (it reads Meta's again under the lock); Meta's
    // answer is all there is (`via`: no generic read-back of the dataset; the run's sender reads the list itself).
    requests: [accessRequest(summary, asset.nodeId, 'pixel', { server_events_business_ids: JSON.stringify(to) }, { operation: 'access.accesspixel.server_events', via: {}, expectedIds: from })],
    stands: { account: { status: live.state.status, disableReason: live.state.disableReason }, portfolioId: live.portfolioId, nodeId: asset.nodeId, businesses: from, nexusSystemUserId: live.nexusSystemUserId },
    before: { op: 'server-events', asset: 'pixel', nodeId: asset.nodeId, partnerId: '', shared: false, tasks: null, businesses: from } satisfies PartnerAccessRecord,
    after: { op: 'server-events', asset: 'pixel', nodeId: asset.nodeId, partnerId: '', shared: false, tasks: null, businesses: to } satisfies PartnerAccessRecord,
  })
}
