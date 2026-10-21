/**
 * Meta step 39 — set-meta-block-list and remove-meta-block-list as drafts (D6 B: block lists need a Meta capability grant —
 * each call is built; when Meta refuses for the grant, the step says so with the no-grant controls, live-safety.ts
 * grantRefusal). Pure: the request and the live state (step 16's liveSafety reads, live-brand-safety.ts) in, the draft
 * (or a refusal in words) out. One action per request. Master rows and Meta's calls (block-list.md, content-block-lists.md,
 * reference/ad-account/publisher_block_lists.md; meta-brand-safety-rules.ts has the checked facts):
 *   create                BS-005 the URL file as a draft → BS-006 Nexus waits for the draft → BS-007 the list from it
 *   replace               BS-008 a new draft, then the same list from it (block_list_id): it changes the list for every
 *                         ad account and business that uses it
 *   create-account-list   BS-011 an empty list of the ad account (Meta documents no way to fill it on that edge: a list
 *                         Nexus fills is made with create)
 *   share / unshare       BS-013 / BS-014 with another business portfolio (APPLY_BLOCK_LIST or MANAGE_BLOCK_LIST; never a
 *                         portfolio another business in Nexus uses; "to change the role … unshare … and then re-share")
 *   assign-user / unassign-user  BS-016 / BS-017 a person's role on the list (the preview names the person's id and role)
 *   apply-account / unapply-account  BS-019 / BS-020 on the chosen ad account only (is_auto_blocking_on)
 *   create-content-list   BS-022 · rename-content-list BS-025 · add-posts / remove-posts BS-028 / BS-029 (at most 250
 *                         posts per platform per request — Meta takes 50,000; never a batch) · apply-content-list /
 *                         unapply-content-list BS-031 / BS-032 on the chosen ad account only (Meta: at most 75 per account)
 *   remove-meta-block-list  BS-012 / BS-026 — only on the person's explicit ask (confirmDelete), only once the list is
 *                         shared with no business and applied to no ad account; a deleted list cannot come back
 * Meta has no check (validate_only) for any of these: "Meta has no check for this change".
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { BLOCK_LIST_ROLES, blockListEntry, blockListFileOf, MAX_POSTS_PER_PLATFORM } from '../../gateway/meta-brand-safety-rules.js'
import { MetaWriteError, type MetaChangeResult } from './write-client.js'
import { localFailure } from './errors.js'

export const BLOCK_LIST_ACTIONS = [
  'create', 'replace', 'create-account-list', 'share', 'unshare', 'assign-user', 'unassign-user', 'apply-account', 'unapply-account',
  'create-content-list', 'rename-content-list', 'add-posts', 'remove-posts', 'apply-content-list', 'unapply-content-list',
] as const
export type BlockListAction = typeof BLOCK_LIST_ACTIONS[number]
export type BlockListRole = typeof BLOCK_LIST_ROLES[number]

export interface BlockListRequest {
  action: BlockListAction
  blockListId?: string
  contentBlockListId?: string
  name?: string
  urls?: string[]
  agencyId?: string
  role?: BlockListRole
  userId?: string
  facebookIds?: string[]
  instagramIds?: string[]
  threadsIds?: string[]
}

/** What an action stands on, read live by the tool (step 16's liveSafety views and live-brand-safety.ts). */
export interface BlockListLive {
  adAccountId: string
  /** The chosen ad account's own business portfolio (not used by another business), where the action needs it. */
  portfolio?: string | null
  /** Whether any campaign of the account delivers now (for a change that unblocks something). */
  delivering?: boolean | null
  /** The ad account's publisher block lists, every page (names: Meta replaces a list of the same name). */
  accountLists?: Array<{ blockListId: string | null; name: string | null }>
  /** The publisher block list named, as step 16 reads it. */
  list?: { blockListId: string | null; name: string | null; items: number | null; ownerAdAccountId: string | null; ownerBusinessId: string | null }
  /** Its contents (replace: for undo), when read. */
  contents?: { web: string[]; app: string[]; total: number; cut: boolean; bad: number } | null
  sharedWith?: string[] | null
  sharedWithNotRead?: string | null
  people?: Array<{ userId: string | null; roles: unknown }> | null
  peopleNotRead?: string | null
  /** The ad accounts it is applied to (digits), or null when not read. */
  appliedTo?: string[] | null
  appliedNotRead?: string | null
  /** The content block list named. */
  contentList?: { contentBlockListId: string | null; name: string | null }
  /** The portfolio's content block lists (names), first page. */
  contentLists?: Array<{ contentBlockListId: string | null; name: string | null }>
}

/** The record of one action (AgentChange before / after; undo reads them). */
export interface BlockListRecord {
  action: BlockListAction | 'delete'
  kind?: 'publisher' | 'content'
  blockListId?: string | null
  contentBlockListId?: string | null
  name?: string | null
  /** The list's hosts and URLs (replace: before = what it held, when Nexus could read all of it and it fits one request). */
  urls?: string[] | null
  urlsWhy?: string
  agencyId?: string
  role?: BlockListRole | null
  userId?: string
  posts?: { facebookIds?: string[]; instagramIds?: string[]; threadsIds?: string[] }
  applied?: boolean
  shared?: boolean
  /** create-account-list: its entries (0 when made) and its owning ad account — undo deletes only a list still so. */
  items?: number | null
  ownerAdAccountId?: string | null
}

const GRANT_LISTS = 'block_list_management_v2_api_access'
const GRANT_CONTENT = 'brand_safety_content_block_list'
const NO_CHECK = { check: 'none' as const, readBackInPost: false, budget: false }

const listWords = (live: BlockListLive, id: string) => `publisher block list "${live.list?.name ?? 'no name'}" (${id})`
const contentWords = (live: BlockListLive, id: string) => `content block list "${live.contentList?.name ?? 'no name'}" (${id})`
const ids = (v: unknown): string[] => (Array.isArray((v as { data?: unknown })?.data) ? ((v as { data: unknown[] }).data) : [])
  .map((row) => (row && typeof row === 'object' ? (row as { id?: unknown; account_id?: unknown }) : {}))
  .flatMap((row) => [row.id, row.account_id])
  .map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x).replace(/^act_/, '') : ''))
  .filter(Boolean)
const hasNext = (v: unknown) => !!(v && typeof v === 'object' && (v as { paging?: { next?: unknown } }).paging?.next)

/** A read-back judge of a list edge (agencies, applied ad accounts): `want` there (or not). A list cut by a page is not judged against. */
function edgeJudge(id: string, want: boolean, what: string) {
  return (node: Record<string, unknown>) => {
    const listed = ids(node)
    const there = listed.includes(id)
    if (there === want || (!there && want && hasNext(node))) return { moved: [], reads: `${what} ${there ? 'lists' : 'does not list'} ${id}` }
    return { moved: [what], reads: `${what} ${there ? 'still lists' : 'does not list'} ${id}` }
  }
}

/** A person's role on a block list as step 16 reads it (APPLY_BLOCK_LIST / MANAGE_BLOCK_LIST), or null. */
function roleOf(roles: unknown): BlockListRole | null {
  const flat = JSON.stringify(roles ?? '')
  return flat.includes('MANAGE_BLOCK_LIST') ? 'MANAGE_BLOCK_LIST' : flat.includes('APPLY_BLOCK_LIST') ? 'APPLY_BLOCK_LIST' : null
}

/**
 * The list's contents as Nexus would write them back (replace's undo), or why they cannot be: Meta answered more than one
 * request holds, did not answer all of them, or answered an entry Nexus cannot write as a host or https URL.
 */
function contentsForUndo(live: BlockListLive): { urls: string[] } | { why: string } {
  const c = live.contents
  if (!c) return { why: 'Nexus could not read what the list held before, so it cannot put it back' }
  const all = [...c.web, ...c.app]
  if (c.bad) return { why: `Meta answered ${c.bad} entr${c.bad === 1 ? 'y' : 'ies'} Nexus cannot write back as a host or https URL` }
  if (c.cut || (live.list?.items != null && live.list.items !== all.length) || all.length !== c.total) return { why: `the list held ${live.list?.items ?? c.total} entries and Meta answered ${all.length} of them, so Nexus cannot put all of it back` }
  const file = blockListFileOf(all)
  if ('problem' in file) return { why: `${file.problem} Nexus cannot write it back as it was` }
  return { urls: file.entries }
}

/** BS-006 — the draft step 1 made, once Meta has read the file (the tool's wait for its status). */
export type DraftWait = (draftId: string) => Promise<void>

/** Review B8 — the draft step 1 made: its id, or why there is none (step 1 refused, or Meta gave no id). */
const draftIdOf = (done: ReadonlyArray<{ request: MetaChangeRequest; result: MetaChangeResult }>): { id: string } | { why: string } => {
  const first = done.find((d) => d.request.step === 1)
  if (!first) return { why: 'step 1 (the upload of the file as a draft) was not made, so nothing more was sent' }
  const id = first.result.node?.id
  return typeof id === 'string' || typeof id === 'number' ? { id: String(id) } : { why: 'Meta made the draft but gave no id for it, so Nexus makes no list from it' }
}

export function blockListDraft(request: BlockListRequest, live: BlockListLive, waitForDraft: DraftWait): MetaChangeDraft | { refusal: string } {
  const a = request.action
  const chosen = live.adAccountId
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const requests: MetaChangeRequest[] = []
  let before: BlockListRecord = { action: a }
  let after: BlockListRecord = { action: a }
  const need = (value: string | undefined, what: string) => (value ? null : `Name ${what} for action ${a}.`)
  const delivering = live.delivering
  const unblocks = (what: string) => (delivering === false
    ? warnings.push(`${what}: nothing spends yet — no campaign of the account delivers now.`)
    : spendsMoney.push(`${what}${delivering === null ? ' (Nexus could not read whether a campaign delivers now)' : ''}.`))

  switch (a) {
    case 'create':
    case 'replace': {
      const missing = a === 'replace' ? need(request.blockListId, 'the block list (blockListId)') : need(request.name, 'the new list (name)')
      if (missing) return { refusal: missing }
      if (!request.urls?.length) return { refusal: 'Name the hosts or URLs the list holds (urls: plain hosts like example.com, or https URLs).' }
      const file = blockListFileOf(request.urls)
      if ('problem' in file) return { refusal: file.problem }
      const portfolio = live.portfolio
      if (!portfolio) return { refusal: 'The chosen ad account names no business portfolio, so Nexus makes no block list for it.' }
      const name = request.name ?? live.list?.name ?? null
      if (!name) return { refusal: 'Name the list (name): Meta needs it on every upload, and Nexus could not read the list\'s own name.' }
      if (a === 'create') {
        const same = (live.accountLists ?? []).find((l) => l.name === name)
        if (same) return { refusal: `A block list named "${name}" exists (${same.blockListId}). Meta REPLACES a list of the same name with the new upload: to change it, use action replace with its blockListId; to keep it, choose another name.` }
        warnings.push('Meta REPLACES a list of the same name (it answers "a newly created or updated" list): none of the lists this ad account sees has this name, but Meta documents no read of the portfolio\'s other lists. If one of those has it, Meta replaces it — so Nexus cannot undo this create; to delete the list later, ask remove-meta-block-list.')
        lines.push([`publisher block list "${name}"`, 'none', `${file.entries.length} hosts or URLs`])
        before = { action: a, name }
        after = { action: a, name, urls: file.entries }
      } else {
        const id = request.blockListId!
        // Review A3 — a new name must not be another list's: Meta would replace that one too.
        const clash = request.name && request.name !== live.list?.name ? (live.accountLists ?? []).find((l) => l.name === request.name && l.blockListId !== id) : null
        if (clash) return { refusal: `Another block list is named "${request.name}" (${clash.blockListId}): Meta REPLACES a list of the same name, so Nexus does not give this list that name.` }
        const old = contentsForUndo(live)
        const removed = 'urls' in old ? old.urls.filter((u) => !file.entries.includes(u)) : null
        lines.push([listWords(live, id), live.list?.items != null ? `${live.list.items} entries` : 'its entries', `${file.entries.length} hosts or URLs`])
        if (name !== live.list?.name) lines.push([`${listWords(live, id)}: name`, live.list?.name ?? null, name])
        warnings.push('Replacing a block list changes it for EVERY ad account and business that uses it (and every business it is shared with), at once.')
        if (removed === null || removed.length) unblocks(`Replacing ${listWords(live, id)} ${removed === null ? 'may unblock hosts or URLs it held (Nexus could not read all of them)' : `unblocks ${removed.length} host${removed.length === 1 ? '' : 's'} or URL${removed.length === 1 ? '' : 's'} it held`}, which widens where ads that use it can show`)
        if (!('urls' in old)) warnings.push(`Undo cannot put the list back as it was: ${old.why}. A person can download it in Meta's Brand Safety and Suitability hub first.`)
        before = { action: a, blockListId: id, name: live.list?.name ?? null, urls: 'urls' in old ? old.urls : null, ...('why' in old ? { urlsWhy: old.why } : {}) }
        after = { action: a, blockListId: id, name, urls: file.entries }
      }
      requests.push({
        step: 1, label: `Upload ${file.entries.length} host${file.entries.length === 1 ? '' : 's'} or URL${file.entries.length === 1 ? '' : 's'} as a draft block list (a text file Nexus makes, one per line)`,
        objectKind: 'business', objectId: portfolio, edge: 'block_list_drafts', params: {}, file: file.text, ...NO_CHECK, raisesSpend: false, undoable: false,
        operation: 'blockList.draft', readBackFields: 'id,async_job_status,async_percent_completion', grant: GRANT_LISTS,
      })
      requests.push({
        step: 2, label: a === 'create' ? `Create publisher block list "${name}" from the draft` : `Replace the contents of ${listWords(live, request.blockListId!)} with the draft`,
        objectKind: 'business', objectId: portfolio, edge: 'publisher_block_lists', params: { name, ...(a === 'replace' ? { block_list_id: request.blockListId! } : {}) },
        ...NO_CHECK, raisesSpend: a === 'replace' && spendsMoney.length > 0, undoable: false, operation: a === 'create' ? 'blockList.create' : 'blockList.replace', expect: { name }, readBackFields: 'id,name', grant: GRANT_LISTS,
        prepare: async (done) => {
          const draft = draftIdOf(done)
          if ('why' in draft) throw new MetaWriteError(localFailure(`Not sent: ${draft.why}.`, 'BLOCK_LIST_NO_DRAFT'), 'blockList.create', 'not_sent')
          await waitForDraft(draft.id)
          return { draft_id: draft.id }
        },
      })
      warnings.push('Nexus waits for Meta to read the draft file (its status: scheduled, running, success) before it makes the list from it; a draft that fails makes no list.')
      break
    }
    case 'create-account-list': {
      const missing = need(request.name, 'the new list (name)')
      if (missing) return { refusal: missing }
      const same = (live.accountLists ?? []).find((l) => l.name === request.name)
      if (same) return { refusal: `A block list named "${request.name}" exists (${same.blockListId}); choose another name.` }
      warnings.push('Meta documents no way to fill a list made on the ad account\'s own edge: it stays empty until a person fills it in Meta\'s Brand Safety and Suitability hub (a list Nexus fills is made with action create).')
      lines.push([`the ad account's publisher block list "${request.name}"`, 'none', 'empty'])
      requests.push({
        step: 1, label: `Create the empty publisher block list "${request.name}" on the ad account`, objectKind: 'adaccount', objectId: `act_${chosen}`, edge: 'publisher_block_lists',
        params: { name: request.name! }, ...NO_CHECK, raisesSpend: false, undoable: false, operation: 'blockList.createOnAccount', expect: { name: request.name! }, readBackFields: 'id,name', grant: GRANT_LISTS,
      })
      before = { action: a, name: request.name! }
      after = { action: a, name: request.name!, items: 0, ownerAdAccountId: chosen }
      break
    }
    case 'share':
    case 'unshare': {
      const missing = need(request.blockListId, 'the block list (blockListId)') ?? need(request.agencyId, 'the business portfolio (agencyId)')
      if (missing) return { refusal: missing }
      const id = request.blockListId!
      const agency = request.agencyId!
      if (live.sharedWith == null) return { refusal: `Nexus could not read who ${listWords(live, id)} is shared with (${live.sharedWithNotRead ?? 'Meta did not answer'}), so nothing was asked of Meta.` }
      const shared = live.sharedWith.includes(agency)
      if (a === 'share') {
        if (!request.role) return { refusal: 'Say the role the business gets: APPLY_BLOCK_LIST (it may apply the list) or MANAGE_BLOCK_LIST (it may also replace its contents).' }
        if (shared) return { refusal: `${listWords(live, id)} is already shared with business portfolio ${agency}. To change its role, unshare it first, then share it again (Meta: a role cannot be changed in place).` }
        lines.push([`${listWords(live, id)}: shared with business portfolio ${agency}`, 'no', request.role])
        warnings.push(`Business portfolio ${agency} gets ${request.role === 'MANAGE_BLOCK_LIST' ? 'MANAGE_BLOCK_LIST: it may apply the list AND replace its contents, which changes it for every ad account and business using it' : 'APPLY_BLOCK_LIST: it may apply the list to what it has access to'}; its admins then give their people access.`)
        requests.push({ step: 1, label: `Share ${listWords(live, id)} with business portfolio ${agency} (${request.role})`, objectKind: 'publisherblocklist', objectId: id, edge: 'agencies',
          params: { agency_id: agency, permitted_roles: JSON.stringify([request.role]) }, ...NO_CHECK, raisesSpend: false, undoable: true, operation: 'blockList.share',
          readBackOf: `${id}/agencies`, readBackFields: 'id', judge: edgeJudge(agency, true, 'its shares'), grant: GRANT_LISTS })
        before = { action: a, blockListId: id, agencyId: agency, shared: false }
        after = { action: a, blockListId: id, agencyId: agency, role: request.role, shared: true }
      } else {
        if (!shared) return { refusal: `${listWords(live, id)} is not shared with business portfolio ${agency}: nothing to unshare.` }
        lines.push([`${listWords(live, id)}: shared with business portfolio ${agency}`, request.role ?? 'yes', 'no'])
        warnings.push(`Business portfolio ${agency} can no longer apply the list: where it applied it, its ads lose this exclusion.`)
        if (!request.role) warnings.push('Meta does not say which role the business had: undo shares it again as APPLY_BLOCK_LIST unless you name the role it had (role).')
        requests.push({ step: 1, label: `Unshare ${listWords(live, id)} from business portfolio ${agency}`, objectKind: 'publisherblocklist', objectId: id, edge: 'agencies', method: 'DELETE',
          params: { agency_id: agency }, ...NO_CHECK, raisesSpend: false, undoable: true, operation: 'blockList.unshare',
          readBackOf: `${id}/agencies`, readBackFields: 'id', judge: edgeJudge(agency, false, 'its shares'), grant: GRANT_LISTS })
        before = { action: a, blockListId: id, agencyId: agency, role: request.role ?? null, shared: true }
        after = { action: a, blockListId: id, agencyId: agency, shared: false }
      }
      break
    }
    case 'assign-user':
    case 'unassign-user': {
      const missing = need(request.blockListId, 'the block list (blockListId)') ?? need(request.userId, 'the person (userId: their business-scoped user id)')
      if (missing) return { refusal: missing }
      const id = request.blockListId!
      const user = request.userId!
      if (live.people == null) return { refusal: `Nexus could not read the people's roles on ${listWords(live, id)} (${live.peopleNotRead ?? 'Meta did not answer'}), so nothing was asked of Meta.` }
      const current = live.people.find((p) => p.userId === user)
      const had = current ? roleOf(current.roles) : null
      if (a === 'assign-user') {
        if (!request.role) return { refusal: 'Say the role the person gets: APPLY_BLOCK_LIST or MANAGE_BLOCK_LIST.' }
        if (current) return { refusal: `Person ${user} already has a role on ${listWords(live, id)}${had ? ` (${had})` : ''}. To change it, remove it first, then give the new one.` }
        lines.push([`${listWords(live, id)}: person ${user}`, 'no role', request.role])
        requests.push({ step: 1, label: `Give person ${user} the role ${request.role} on ${listWords(live, id)}`, objectKind: 'publisherblocklist', objectId: id, edge: 'assigned_users',
          params: { user, permitted_roles: JSON.stringify([request.role]) }, ...NO_CHECK, raisesSpend: false, undoable: true, operation: 'blockList.assignUser', grant: GRANT_LISTS })
        before = { action: a, blockListId: id, userId: user, role: null }
        after = { action: a, blockListId: id, userId: user, role: request.role }
      } else {
        if (!current) return { refusal: `Person ${user} has no role on ${listWords(live, id)}: nothing to remove.` }
        lines.push([`${listWords(live, id)}: person ${user}`, had ?? 'a role', 'no role'])
        if (!had) warnings.push('Meta did not say which role the person had: undo gives them APPLY_BLOCK_LIST.')
        requests.push({ step: 1, label: `Remove person ${user}'s role on ${listWords(live, id)}`, objectKind: 'publisherblocklist', objectId: id, edge: 'assigned_users', method: 'DELETE',
          params: { user }, ...NO_CHECK, raisesSpend: false, undoable: true, operation: 'blockList.unassignUser', grant: GRANT_LISTS })
        before = { action: a, blockListId: id, userId: user, role: had }
        after = { action: a, blockListId: id, userId: user, role: null }
      }
      break
    }
    case 'apply-account':
    case 'unapply-account': {
      const missing = need(request.blockListId, 'the block list (blockListId)')
      if (missing) return { refusal: missing }
      const id = request.blockListId!
      if (live.appliedTo == null) return { refusal: `Nexus could not read which ad accounts ${listWords(live, id)} is applied to (${live.appliedNotRead ?? 'Meta did not answer'}), so nothing was asked of Meta.` }
      const applied = live.appliedTo.includes(chosen)
      const on = a === 'apply-account'
      if (applied === on) return { refusal: `Nothing to change: ${listWords(live, id)} is ${on ? 'already' : 'not'} applied to the chosen ad account.` }
      lines.push([`${listWords(live, id)} on the chosen ad account`, applied ? 'applied' : 'not applied', on ? 'applied' : 'not applied'])
      if (!on) unblocks(`Removing ${listWords(live, id)} from the ad account unblocks what it lists for every campaign of the account`)
      if (on) warnings.push('Applying a block list to the ad account blocks its publishers for every campaign of the account (Meta\'s thresholds per account: 200,000 in-stream / Reels, 20,750 Audience Network, 11,350 rewarded video).')
      // Meta: business_id is "the business ID that owns the block list": sent only when the portfolio owns it.
      const owner = live.list?.ownerBusinessId && live.list.ownerBusinessId === live.portfolio && live.list.ownerAdAccountId !== chosen ? live.portfolio : null
      requests.push({
        step: 1, label: `${on ? 'Apply' : 'Remove'} ${listWords(live, id)} ${on ? 'to' : 'from'} the chosen ad account`, objectKind: 'publisherblocklist', objectId: id, edge: 'auto_applied_ad_accounts',
        params: { account_id: chosen, is_auto_blocking_on: on ? 'true' : 'false', ...(owner ? { business_id: owner } : {}) }, ...NO_CHECK, raisesSpend: !on, undoable: true,
        operation: on ? 'blockList.applyAccount' : 'blockList.unapplyAccount', readBackOf: `${id}/auto_applied_ad_accounts`, readBackFields: 'id', judge: edgeJudge(chosen, on, 'its ad accounts'), grant: GRANT_LISTS,
      })
      before = { action: a, blockListId: id, applied }
      after = { action: a, blockListId: id, applied: on }
      break
    }
    case 'create-content-list': {
      const missing = need(request.name, 'the new list (name)')
      if (missing) return { refusal: missing }
      const portfolio = live.portfolio
      if (!portfolio) return { refusal: 'The chosen ad account names no business portfolio, so Nexus makes no content block list for it.' }
      const same = (live.contentLists ?? []).find((l) => l.name === request.name)
      if (same) return { refusal: `A content block list named "${request.name}" exists (${same.contentBlockListId}); choose another name.` }
      lines.push([`content block list "${request.name}"`, 'none', 'empty'])
      warnings.push('A business portfolio holds at most 200 content block lists; a list holds at most 2 million posts.')
      requests.push({ step: 1, label: `Create the content block list "${request.name}"`, objectKind: 'business', objectId: portfolio, edge: 'content_block_lists', params: { name: request.name! },
        ...NO_CHECK, raisesSpend: false, undoable: false, operation: 'contentBlockList.create', expect: { name: request.name! }, readBackFields: 'id,name', grant: GRANT_CONTENT })
      before = { action: a, name: request.name! }
      after = { action: a, name: request.name! }
      break
    }
    case 'rename-content-list': {
      const missing = need(request.contentBlockListId, 'the content block list (contentBlockListId)') ?? need(request.name, 'its new name (name)')
      if (missing) return { refusal: missing }
      const id = request.contentBlockListId!
      if (live.contentList?.name === request.name) return { refusal: `Nothing to change: ${contentWords(live, id)} already has that name.` }
      lines.push([`${contentWords(live, id)}: name`, live.contentList?.name ?? null, request.name])
      requests.push({ step: 1, label: `Rename ${contentWords(live, id)} to "${request.name}"`, objectKind: 'contentblocklist', objectId: id, params: { name: request.name! },
        ...NO_CHECK, raisesSpend: false, undoable: true, operation: 'contentBlockList.rename', expect: { name: request.name! }, readBackFields: 'id,name', grant: GRANT_CONTENT })
      before = { action: a, contentBlockListId: id, name: live.contentList?.name ?? null }
      after = { action: a, contentBlockListId: id, name: request.name! }
      break
    }
    case 'add-posts':
    case 'remove-posts': {
      const missing = need(request.contentBlockListId, 'the content block list (contentBlockListId)')
      if (missing) return { refusal: missing }
      const id = request.contentBlockListId!
      const posts = { facebookIds: [...new Set(request.facebookIds ?? [])], instagramIds: [...new Set(request.instagramIds ?? [])], threadsIds: [...new Set(request.threadsIds ?? [])] }
      const count = posts.facebookIds.length + posts.instagramIds.length + posts.threadsIds.length
      if (!count) return { refusal: 'Name the posts (facebookIds, instagramIds, threadsIds).' }
      if (Object.values(posts).some((p) => p.length > MAX_POSTS_PER_PLATFORM)) return { refusal: `At most ${MAX_POSTS_PER_PLATFORM} posts per platform in one request.` }
      const add = a === 'add-posts'
      lines.push([`${contentWords(live, id)}: posts`, add ? 'not on it' : 'on it', `${add ? 'added' : 'removed'}: ${count}`])
      warnings.push('Meta files a share, attachment or cross-post under its root post\'s id, and cannot yet answer whether one post is on a list ("planned but not yet available"): undo '
        + `${add ? 'removes these posts again — also any of them that was already on the list' : 'adds these posts back — also any of them that was not on the list'}.`)
      if (!add && (live.appliedTo == null || live.appliedTo.includes(chosen))) unblocks(`Removing posts from ${contentWords(live, id)} lets the ad account's ads show next to them again${live.appliedTo == null ? ' (Nexus could not read whether the list is applied to the ad account)' : ''}`)
      const params: Record<string, string> = {
        ...(posts.facebookIds.length ? { facebook_ids: JSON.stringify(posts.facebookIds) } : {}),
        ...(posts.instagramIds.length ? { instagram_ids: JSON.stringify(posts.instagramIds) } : {}),
        ...(posts.threadsIds.length ? { threads_ids: JSON.stringify(posts.threadsIds) } : {}),
      }
      requests.push({ step: 1, label: `${add ? 'Add' : 'Remove'} ${count} post${count === 1 ? '' : 's'} ${add ? 'to' : 'from'} ${contentWords(live, id)}`, objectKind: 'contentblocklist', objectId: id, edge: 'content',
        ...(add ? {} : { method: 'DELETE' as const }), params, ...NO_CHECK, raisesSpend: !add && spendsMoney.length > 0, undoable: true, operation: add ? 'contentBlockList.addPosts' : 'contentBlockList.removePosts', grant: GRANT_CONTENT })
      before = { action: a, contentBlockListId: id, posts }
      after = { action: a, contentBlockListId: id, posts }
      break
    }
    case 'apply-content-list':
    case 'unapply-content-list': {
      const missing = need(request.contentBlockListId, 'the content block list (contentBlockListId)')
      if (missing) return { refusal: missing }
      const id = request.contentBlockListId!
      if (live.appliedTo == null) return { refusal: `Nexus could not read which ad accounts ${contentWords(live, id)} is applied to (${live.appliedNotRead ?? 'Meta did not answer'}), so nothing was asked of Meta.` }
      const applied = live.appliedTo.includes(chosen)
      const on = a === 'apply-content-list'
      if (applied === on) return { refusal: `Nothing to change: ${contentWords(live, id)} is ${on ? 'already' : 'not'} applied to the chosen ad account.` }
      lines.push([`${contentWords(live, id)} on the chosen ad account`, applied ? 'applied' : 'not applied', on ? 'applied' : 'not applied'])
      if (on) warnings.push('Meta applies at most 75 content block lists to one ad account; it refuses the 76th.')
      else unblocks(`Removing ${contentWords(live, id)} from the ad account lets every campaign's ads show next to its posts again`)
      requests.push({ step: 1, label: `${on ? 'Apply' : 'Remove'} ${contentWords(live, id)} ${on ? 'to' : 'from'} the chosen ad account`, objectKind: 'contentblocklist', objectId: id, edge: 'applied_ad_accounts',
        ...(on ? {} : { method: 'DELETE' as const }), params: { account_id: chosen }, ...NO_CHECK, raisesSpend: !on, undoable: true,
        operation: on ? 'contentBlockList.apply' : 'contentBlockList.unapply', readBackOf: `${id}/applied_ad_accounts`, readBackFields: 'id,account_id', judge: edgeJudge(chosen, on, 'its ad accounts'), grant: GRANT_CONTENT })
      before = { action: a, contentBlockListId: id, applied }
      after = { action: a, contentBlockListId: id, applied: on }
      break
    }
  }
  warnings.push(`These lists need a capability grant from Meta (${GRANT_LISTS} for publisher block lists, ${GRANT_CONTENT} for content block lists): when Meta has not granted it, the step says so plainly.`)
  const { changes } = changeLines(lines)
  return {
    summary: requests.length === 1 ? `Meta: ${requests[0].label}.` : `Meta: ${requests.map((r) => r.label).join('; then ')}.`,
    changes, totals: { requests: requests.length }, warnings, spendsMoney, skipped: [], requests,
    stands: {
      action: a, list: live.list ?? null, sharedWith: live.sharedWith ?? null, people: live.people?.map((p) => p.userId) ?? null, appliedTo: live.appliedTo ?? null,
      contentList: live.contentList ?? null, names: (live.accountLists ?? live.contentLists ?? []).map((l) => l.name), contents: live.contents ? live.contents.total : null,
      delivering: live.delivering ?? 'not read',
    },
    before, after,
  }
}

/** remove-meta-block-list — BS-012 / BS-026, on the person's explicit ask, once the list is unshared and unapplied. */
export function removeBlockListDraft(request: { kind: 'publisher' | 'content'; id: string }, live: BlockListLive): MetaChangeDraft | { refusal: string } {
  const warnings: string[] = []
  const spendsMoney: string[] = []
  if (request.kind === 'publisher') {
    const who = listWords(live, request.id)
    if (live.sharedWith == null) return { refusal: `Nexus could not read who ${who} is shared with (${live.sharedWithNotRead ?? 'Meta did not answer'}), so it deletes nothing.` }
    if (live.sharedWith.length) return { refusal: `${who} is still shared with business portfolio ${live.sharedWith.join(', ')}: Meta deletes a list only once it is unshared from every business (set-meta-block-list unshare first).` }
    if (live.appliedTo == null) return { refusal: `Nexus could not read which ad accounts ${who} is applied to (${live.appliedNotRead ?? 'Meta did not answer'}), so it deletes nothing.` }
    if (live.appliedTo.length) return { refusal: `${who} is still applied to ad account ${live.appliedTo.join(', ')}: remove it from ${live.appliedTo.length === 1 ? 'it' : 'them'} first (set-meta-block-list unapply-account).` }
    if (live.delivering !== false) spendsMoney.push(`Deleting ${who} ends every exclusion of it: ad sets that exclude it in their targeting show their ads on its publishers again${live.delivering === null ? ' (Nexus could not read whether a campaign delivers now)' : ''}.`)
    warnings.push(`A deleted block list cannot come back: Nexus can only make a new list (a new id) with the same hosts or URLs (set-meta-block-list create).`)
    const record: BlockListRecord = { action: 'delete', kind: 'publisher', blockListId: request.id, name: live.list?.name ?? null }
    return {
      summary: `Meta: delete ${who}.`, changes: changeLines([[who, `${live.list?.items ?? '?'} entries`, 'deleted']]).changes, totals: { requests: 1 }, warnings, spendsMoney, skipped: [],
      requests: [{ step: 1, label: `Delete ${who}`, objectKind: 'publisherblocklist', objectId: request.id, method: 'DELETE', params: {}, ...NO_CHECK, raisesSpend: spendsMoney.length > 0, undoable: false, operation: 'blockList.delete', grant: GRANT_LISTS }],
      stands: { list: live.list ?? null, sharedWith: live.sharedWith, appliedTo: live.appliedTo, delivering: live.delivering ?? 'not read' },
      before: record, after: { ...record, deleted: true },
    }
  }
  const who = contentWords(live, request.id)
  if (live.appliedTo == null) return { refusal: `Nexus could not read which ad accounts ${who} is applied to (${live.appliedNotRead ?? 'Meta did not answer'}), so it deletes nothing.` }
  if (live.appliedTo.length) return { refusal: `${who} is still applied to ad account ${live.appliedTo.join(', ')}: Meta deletes a content block list only when it is applied to none (set-meta-block-list unapply-content-list first).` }
  warnings.push('A deleted content block list cannot come back: its posts would have to be added to a new list.')
  const record: BlockListRecord = { action: 'delete', kind: 'content', contentBlockListId: request.id, name: live.contentList?.name ?? null }
  return {
    summary: `Meta: delete ${who}.`, changes: changeLines([[who, 'kept', 'deleted']]).changes, totals: { requests: 1 }, warnings, spendsMoney, skipped: [],
    requests: [{ step: 1, label: `Delete ${who}`, objectKind: 'contentblocklist', objectId: request.id, method: 'DELETE', params: {}, ...NO_CHECK, raisesSpend: false, undoable: false, operation: 'contentBlockList.delete', grant: GRANT_CONTENT }],
    stands: { contentList: live.contentList ?? null, appliedTo: live.appliedTo },
    before: record, after: { ...record, deleted: true },
  }
}

/** The publisher entries step 16 reads (web domain_url, app store_url), as Nexus writes entries (null: one it cannot). */
export function entriesOf(web: Array<{ url: string | null }> | null | undefined, app: Array<Record<string, unknown>> | null | undefined): { web: string[]; app: string[]; bad: number } {
  let bad = 0
  const norm = (raw: unknown) => {
    if (typeof raw !== 'string') { bad++; return null }
    const one = blockListEntry(raw)
    if ('problem' in one) { bad++; return null }
    return one.entry
  }
  return {
    web: (web ?? []).map((w) => norm(w.url)).filter((x): x is string => !!x),
    app: (app ?? []).map((p) => norm(p.store_url)).filter((x): x is string => !!x),
    bad,
  }
}
