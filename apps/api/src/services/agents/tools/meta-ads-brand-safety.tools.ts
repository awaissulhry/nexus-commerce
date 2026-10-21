/**
 * Meta ads changes, step 39 (2026-10-21) — brand safety (D6: the controls that need no Meta grant first; the grant-only
 * parts are built and answer plainly when Meta has not granted them). Each a Nexus change like every other Meta change
 * (meta-ads-kit.ts): a preview from the live state (Meta has no check — validate_only — for any of these), an approvalId,
 * a person approves it, it runs as that person request by request, and undo puts back what it changed.
 *
 *   set-meta-brand-safety   an ad set's inventory filter, excluded publisher categories, excluded block lists, content
 *                           severity levels and excluded content types (all inside its targeting, which goes whole: Q7,
 *                           marketing/meta-ads/targeting-merge.ts), or the ad account's own inventory filter (master AA-060,
 *                           BS-001, BS-003, BS-004, TG-093–097)
 *   set-meta-block-list     publisher block lists (upload as a draft and create or replace, an empty account list, share,
 *                           people's roles, apply to the ad account) and content block lists (create, rename, posts, apply)
 *                           (BS-005–008, BS-011, BS-013, BS-014, BS-016, BS-017, BS-019, BS-020, BS-022, BS-025, BS-028,
 *                           BS-029, BS-031, BS-032)
 *   remove-meta-block-list  delete a publisher or content block list, on the person's explicit ask only (BS-012, BS-026)
 * The drafts are marketing/meta-ads/change-brand-safety.ts and change-block-lists.ts; the live reads live-brand-safety.ts
 * and step 16's live-safety.ts; the gateway's rules gateway/meta-brand-safety-rules.ts and its owner checks
 * gateway/meta-brand-safety-owner.ts. The CSV export of a content block list (BS-033) is meta-brand-safety view
 * content-block-list-file (a read: it changes no ad or list).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { liveSafety } from '../../marketing/meta-ads/live-safety.js'
import { metaChosenAccount, MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { accountDelivering, liveAccountFilter, liveAdSetSafety, ownPortfolio, waitForBlockListDraft } from '../../marketing/meta-ads/live-brand-safety.js'
import {
  accountSafetyDraft, adSetSafetyDraft, brandSafetyUndoArgs, FILTER_CHOICES, safetyOf, type AdSetSafetyChange, type BrandSafetyRecord, type BrandSafetyRequest,
} from '../../marketing/meta-ads/change-brand-safety.js'
import {
  BLOCK_LIST_ACTIONS, blockListDraft, entriesOf, removeBlockListDraft, type BlockListLive, type BlockListRecord, type BlockListRequest,
} from '../../marketing/meta-ads/change-block-lists.js'
import { BLOCK_LIST_ROLES, MAX_BLOCK_LIST_URLS, MAX_POSTS_PER_PLATFORM, MAX_SAFETY_TOKENS, MAX_URL_LENGTH, PUBLISHER_CATEGORIES } from '../../gateway/meta-brand-safety-rules.js'
import type { MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import type { MetaChangeDraft } from '../../marketing/meta-ads/change-draft.js'

type Row = Record<string, any>
const refusalOf = async (work: () => Promise<MetaChangeDraft | { refusal: string }>): Promise<MetaChangeDraft | { refusal: string }> => {
  try { return await work() } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

// ── set-meta-brand-safety ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * At Meta's Limited access tier an ad account has about 60 points per 5 minutes (a read 1, a change 3): each ad set is
 * read at the preview, at the gate's re-check and at the run, by the gateway once more (its live targeting), changed and
 * read back — about 8 points, so 6 ad sets stay inside one window.
 */
const MAX_AD_SETS = 6
const SAFETY_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const choiceArg = (where: string) => z.enum(FILTER_CHOICES).optional().describe(`${where}: EXPANDED, MODERATE or LIMITED (Meta's words; LIMITED is the strictest), or NONE (no level of its own: Meta's default, which Meta does not document)`)
const levelsArg = z.object({
  inContent: choiceArg('in-content ads (Facebook in-stream videos, ads on Facebook Reels)'),
  audienceNetwork: choiceArg('Audience Network'),
  feed: choiceArg('feeds (Facebook and Instagram Feed and Reels Feed)'),
}).describe('the inventory filter per placement; a placement not named stays as it is')
const tokenList = (what: string) => z.array(z.string().trim().regex(SAFETY_TOKEN, 'one of Meta\'s values (a letter, then letters, digits or _)')).max(MAX_SAFETY_TOKENS).optional()
  .describe(`${what} (Meta documents no list of values: give them as Meta writes them, e.g. as meta-ad-sets shows an ad set's targeting)`)
const categoryList = (what: string) => z.array(z.enum(PUBLISHER_CATEGORIES)).max(PUBLISHER_CATEGORIES.length).optional()
  .describe(`${what}: dating, gambling (every placement); debated_social_issues, mature_audiences, tragedy_and_conflict (Audience Network and in-stream)`)
const listIds = (what: string) => z.array(metaIdArg('a publisher block list')).max(50).optional().describe(`${what} (meta-brand-safety view block-lists shows them)`)

const safetyRequest = (args: Record<string, unknown>): BrandSafetyRequest => ({
  ...(Array.isArray(args.adSets) ? { adSets: args.adSets as AdSetSafetyChange[] } : {}),
  ...(args.account && typeof args.account === 'object' ? { account: args.account as BrandSafetyRequest['account'] } : {}),
})

const buildSafety = (args: Record<string, unknown>): MetaDraftBuilder => (account) => refusalOf(async () => {
  const request = safetyRequest(args)
  if (!!request.adSets?.length === !!request.account) return { refusal: 'Name either adSets (their brand safety) or account (the ad account\'s own inventory filter) — one of them.' }
  const accountLevels = await liveAccountFilter(account)
  if (request.account) {
    return accountSafetyDraft(request.account.filterLevels ?? {}, { adAccountId: account.adAccountId, accountLevels, delivering: await accountDelivering(account) })
  }
  const adSets = new Map<string, Awaited<ReturnType<typeof liveAdSetSafety>>>()
  for (const item of request.adSets!) if (!adSets.has(item.adSetId)) adSets.set(item.adSetId, await liveAdSetSafety(account, item.adSetId))
  return adSetSafetyDraft(request.adSets!, { adSets, accountLevels })
})

const safetyUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as BrandSafetyRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      if (after.account) return { ...after, account: { levels: [...(await liveAccountFilter(account))].sort() } }
      const adSets = []
      for (const a of after.adSets ?? []) adSets.push({ id: a.id, name: a.name, safety: safetyOf((await liveAdSetSafety(account, a.id)).targeting) })
      return { ...after, adSets }
    } catch (err) {
      if (err instanceof MetaLiveRefusal) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as BrandSafetyRecord & { accountId?: string }
    const back = brandSafetyUndoArgs(before, (change.after ?? {}) as BrandSafetyRecord)
    if ('refusal' in back) return back
    return { tool: 'set-meta-brand-safety', args: { ...(before.accountId ? { connectionId: before.accountId } : {}), ...back, why: 'undo of an earlier Meta brand-safety change' } }
  },
}

const setMetaBrandSafety: AgentTool = {
  name: 'set-meta-brand-safety',
  title: 'Meta brand safety of ad sets',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // An ad set's settings are put back in full; the account's filter cannot be cleared by API (undo then says so).
  reversibility: 'partial',
  consequencesFor: (args) => (Array.isArray(args.adSets) && args.adSets.length && !args.account ? { reversibility: 'full' } : null),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    adSets: z.array(z.object({
      adSetId: metaIdArg('the ad set (of the chosen ad account)'),
      filterLevels: levelsArg.optional(),
      addCategories: categoryList('publisher categories to exclude'),
      removeCategories: categoryList('publisher categories to exclude no longer'),
      addBlockLists: listIds('publisher block lists to exclude (each one the chosen ad account may use)'),
      removeBlockLists: listIds('publisher block lists to exclude no longer'),
      severityLevels: tokenList('the content severity levels, the whole list ([] clears it)'),
      addContentTypes: tokenList('content types to exclude, e.g. INSTREAM_LIVE (live videos in in-stream; Meta\'s one documented example, feed-verification.md)'),
      removeContentTypes: tokenList('content types to exclude no longer'),
    })).min(1).max(MAX_AD_SETS).optional().describe(`the ad sets and what changes on each (at most ${MAX_AD_SETS}: Meta's Limited access tier)`),
    account: z.object({ filterLevels: levelsArg }).optional().describe('instead of ad sets: the ad account\'s own inventory filter (every campaign of the account; an ad set may then only be as strict or stricter)'),
    why: metaWhyArg,
  }),
  description:
    'Brand safety that needs no grant from Meta, on the business\'s chosen Meta ad account. adSets: per ad set its '
    + 'inventory filter (in-content, Audience Network and feeds: EXPANDED, MODERATE or LIMITED), excluded publisher '
    + 'categories (dating, gambling; Audience Network and in-stream also debated social issues, mature audiences, tragedy '
    + 'and conflict), the publisher block lists it excludes, and its content severity levels and excluded content types '
    + '(Meta documents no values for the first and one example for the second, INSTREAM_LIVE: given as Meta writes them, '
    + 'Meta judges them). These sit inside the ad '
    + 'set\'s targeting, which Meta takes only whole: Nexus sends every other part of it exactly as Meta has it, and its '
    + 'gateway reads the live targeting again itself and sends nothing if anything else would change. A level looser '
    + 'than the ad account\'s own is refused. A targeting change sends the ad set\'s ads back to Meta\'s review. account: '
    + 'the ad account\'s own inventory filter (every campaign; Meta documents it only in its SDK — its answer says if it '
    + 'refuses). Stricter settings can only narrow where ads show; a looser level, a removed exclusion or a changed '
    + 'severity on an ad set that is on (or a looser account filter while a campaign delivers) is SPENDS MONEY. Meta has no '
    + 'check for this change. Block lists themselves are set-meta-block-list. Undo puts back what it changed (the '
    + 'account\'s filter cannot be cleared by API).'
    + META_CHANGE_RULES,
  undo: safetyUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildSafety(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildSafety(args), (draft, done) => {
    const before = draft.before as BrandSafetyRecord
    const after = draft.after as BrandSafetyRecord
    if (before.account) return { data: { account: { from: before.account.levels, to: after.account?.levels ?? null } }, before, after }
    const made = new Set(done.map(({ request }) => request.objectId))
    const keep = (r: BrandSafetyRecord) => ({ adSets: (r.adSets ?? []).filter((a) => made.has(a.id)) })
    const b = keep(before)
    const a = keep(after)
    return { data: { adSets: a.adSets.map((x) => ({ id: x.id, name: x.name, from: b.adSets.find((y) => y.id === x.id)?.safety ?? null, to: x.safety })) }, before: b, after: a }
  }, async () => 'meta-ad-sets and meta-ads-live show the targeting now (Nexus keeps no copy of it).'),
}

// ── set-meta-block-list ────────────────────────────────────────────────────────────────────────────────────────────

const PEOPLE_ACTIONS = new Set(['assign-user', 'unassign-user'])
/** Pages of 100 read to check names (Meta: at most 200 block lists, 200 content block lists per business). */
const MAX_LIST_PAGES = 5
const postIds = (what: string, pattern: RegExp) => z.array(z.string().trim().regex(pattern, 'a post id (digits)')).max(MAX_POSTS_PER_PLATFORM).optional()
  .describe(`${what} post ids (at most ${MAX_POSTS_PER_PLATFORM} per platform per request)`)

const asRow = (v: unknown): Row => (v && typeof v === 'object' ? v as Row : {})

/** The publisher block list named, as step 16 reads it (its owner checked there): refused when another business owns it. */
async function publisherLive(account: MetaChangeAccount, blockListId: string, live: BlockListLive, opts: { items?: boolean; people?: boolean } = {}): Promise<void> {
  const view = asRow(await liveSafety({ connectionId: account.accountId, view: 'block-list', blockListId, items: !!opts.items }, !!opts.people))
  if (view.takenByAnotherBusiness) throw new MetaLiveRefusal('That block list is owned by an ad account another business in Nexus uses: Nexus changes nothing on it.')
  const list = asRow(view.blockList)
  live.list = { blockListId: list.blockListId ?? null, name: list.name ?? null, items: typeof list.items === 'number' ? list.items : null, ownerAdAccountId: list.ownerAdAccountId ?? null, ownerBusinessId: list.ownerBusinessId ?? null }
  live.sharedWith = Array.isArray(view.sharedWithBusinesses) ? view.sharedWithBusinesses.map((b: Row) => b.businessId).filter(Boolean) : null
  live.sharedWithNotRead = view.sharedWithNotRead ?? null
  live.people = Array.isArray(view.peopleRoles) ? view.peopleRoles.map((p: Row) => ({ userId: p.userId ?? null, roles: p.roles ?? null })) : null
  live.peopleNotRead = view.peopleRolesNotRead ?? null
  live.appliedTo = Array.isArray(view.appliedToAdAccounts) ? view.appliedToAdAccounts.map((a: Row) => a.adAccountId).filter(Boolean) : null
  live.appliedNotRead = view.appliedToNotRead ?? null
  if (opts.items) {
    const web = asRow(view.webPublishers)
    const app = asRow(view.appPublishers)
    if (!Array.isArray(web.items) || !Array.isArray(app.items)) { live.contents = null; return }
    const entries = entriesOf(web.items, app.items)
    live.contents = { web: entries.web, app: entries.app, total: (web.total ?? 0) + (app.total ?? 0), cut: !!web.cut || !!app.cut, bad: entries.bad }
  }
}

/** The content block list named, as step 16 reads it (only the business portfolio's; another business's portfolio refused). */
async function contentLive(account: MetaChangeAccount, contentBlockListId: string, live: BlockListLive): Promise<void> {
  live.portfolio = await ownPortfolio(account)
  const view = asRow(await liveSafety({ connectionId: account.accountId, view: 'content-block-list', contentBlockListId }, false))
  const list = asRow(view.contentBlockList)
  live.contentList = { contentBlockListId: list.contentBlockListId ?? null, name: list.name ?? null }
  live.appliedTo = Array.isArray(view.appliedToAdAccounts) ? view.appliedToAdAccounts.map((a: Row) => a.adAccountId).filter(Boolean) : null
  live.appliedNotRead = view.appliedToNotRead ?? null
}

async function blockListLive(account: MetaChangeAccount, request: BlockListRequest): Promise<BlockListLive> {
  const live: BlockListLive = { adAccountId: account.adAccountId }
  // Review A3 / B2 — every page of the ad account's lists (Meta: at most 200 per business); refused while one is left.
  const accountLists = async () => {
    const lists: Array<{ blockListId: string | null; name: string | null }> = []
    let after: string | null = null
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const view = asRow(await liveSafety({ connectionId: account.accountId, view: 'block-lists', limit: 100, after }, false))
      lists.push(...(Array.isArray(view.items) ? view.items : []).map((l: Row) => ({ blockListId: l.blockListId ?? null, name: l.name ?? null })))
      after = typeof view.nextAfter === 'string' ? view.nextAfter : null
      if (!after) { live.accountLists = lists; return }
    }
    throw new MetaLiveRefusal(`The ad account has more than ${MAX_LIST_PAGES * 100} block lists: Nexus could not check all their names (Meta replaces a list of the same name), so nothing was asked of Meta.`)
  }
  switch (request.action) {
    case 'create':
      live.portfolio = await ownPortfolio(account)
      await accountLists()
      break
    case 'replace':
      live.portfolio = await ownPortfolio(account)
      if (request.blockListId) await publisherLive(account, request.blockListId, live, { items: true })
      if (request.name) await accountLists()
      live.delivering = await accountDelivering(account)
      break
    case 'create-account-list':
      await accountLists()
      break
    case 'share': case 'unshare': case 'assign-user': case 'unassign-user': case 'apply-account': case 'unapply-account':
      if (request.blockListId) await publisherLive(account, request.blockListId, live, { people: PEOPLE_ACTIONS.has(request.action) })
      if (request.action === 'apply-account' || request.action === 'unapply-account') {
        // business_id goes only for a list the portfolio owns, and only a portfolio no other business in Nexus uses.
        live.portfolio = await ownPortfolio(account).catch((err) => { if (err instanceof MetaLiveRefusal) return null; throw err })
      }
      if (request.action === 'unapply-account') live.delivering = await accountDelivering(account)
      break
    case 'create-content-list': {
      live.portfolio = await ownPortfolio(account)
      const lists: Array<{ contentBlockListId: string | null; name: string | null }> = []
      let after: string | null = null
      for (let page = 0; ; page++) {
        if (page >= MAX_LIST_PAGES) throw new MetaLiveRefusal(`The business portfolio has more than ${MAX_LIST_PAGES * 100} content block lists: Nexus could not check all their names, so nothing was asked of Meta.`)
        const view = asRow(await liveSafety({ connectionId: account.accountId, view: 'content-block-lists', limit: 100, after }, false))
        lists.push(...(Array.isArray(view.items) ? view.items : []).map((l: Row) => ({ contentBlockListId: l.contentBlockListId ?? null, name: l.name ?? null })))
        after = typeof view.nextAfter === 'string' ? view.nextAfter : null
        if (!after) break
      }
      live.contentLists = lists
      break
    }
    default:
      if (request.contentBlockListId) await contentLive(account, request.contentBlockListId, live)
      if (request.action === 'remove-posts' || request.action === 'unapply-content-list') live.delivering = await accountDelivering(account)
  }
  return live
}

const blockListRequest = (args: Record<string, unknown>): BlockListRequest => args as unknown as BlockListRequest

const buildBlockList = (args: Record<string, unknown>): MetaDraftBuilder => (account) => refusalOf(async () => {
  const request = blockListRequest(args)
  return blockListDraft(request, await blockListLive(account, request), (draftId) => waitForBlockListDraft(account.accountId, draftId))
})

/** The live state in the record's shape, for undo's "has it moved since?" (posts cannot be checked: Meta has no read of one). */
async function blockListNow(after: BlockListRecord & { accountId?: string; adAccountId?: string }): Promise<unknown> {
  const account = await recordAccount(after)
  if (!account) return null
  const live: BlockListLive = { adAccountId: account.adAccountId }
  try {
    switch (after.action) {
      case 'create':
        if (!after.blockListId) return after
        await publisherLive(account, after.blockListId, live)
        return { ...after, name: live.list?.name ?? null }
      case 'create-account-list':
        // Its entries and owner now: undo deletes only a list still empty and still the chosen ad account's own (an older
        // portfolio list Meta replaced by name would carry business_owner_id instead). Entries Meta does not count: not read.
        if (!after.blockListId) return after
        await publisherLive(account, after.blockListId, live)
        return { ...after, name: live.list?.name ?? null, items: live.list?.items ?? 'not read', ownerAdAccountId: live.list?.ownerAdAccountId ?? null }
      case 'replace': {
        await publisherLive(account, after.blockListId!, live, { items: true })
        const now = live.contents && !live.contents.bad && !live.contents.cut ? [...live.contents.web, ...live.contents.app] : null
        const same = !!now && now.length === (after.urls ?? []).length && now.every((u) => (after.urls ?? []).includes(u))
        return { ...after, name: live.list?.name ?? null, urls: same ? after.urls : now }
      }
      case 'share': case 'unshare':
        await publisherLive(account, after.blockListId!, live)
        return { ...after, shared: live.sharedWith ? live.sharedWith.includes(after.agencyId!) : null }
      case 'assign-user': case 'unassign-user': {
        await publisherLive(account, after.blockListId!, live, { people: true })
        const person = live.people?.find((p) => p.userId === after.userId)
        return { ...after, role: live.people == null ? 'not read' : person ? (JSON.stringify(person.roles ?? '').includes('MANAGE_BLOCK_LIST') ? 'MANAGE_BLOCK_LIST' : 'APPLY_BLOCK_LIST') : null }
      }
      case 'apply-account': case 'unapply-account':
        await publisherLive(account, after.blockListId!, live)
        return { ...after, applied: live.appliedTo ? live.appliedTo.includes(account.adAccountId) : null }
      case 'create-content-list':
        if (!after.contentBlockListId) return after
        await contentLive(account, after.contentBlockListId, live)
        return { ...after, name: live.contentList?.name ?? null }
      case 'rename-content-list':
        await contentLive(account, after.contentBlockListId!, live)
        return { ...after, name: live.contentList?.name ?? null }
      case 'apply-content-list': case 'unapply-content-list':
        await contentLive(account, after.contentBlockListId!, live)
        return { ...after, applied: live.appliedTo ? live.appliedTo.includes(account.adAccountId) : null }
      default:
        return after
    }
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return null
    throw err
  }
}

const OPPOSITE: Readonly<Record<string, BlockListRequest['action']>> = {
  share: 'unshare', unshare: 'share', 'assign-user': 'unassign-user', 'unassign-user': 'assign-user', 'apply-account': 'unapply-account', 'unapply-account': 'apply-account',
  'add-posts': 'remove-posts', 'remove-posts': 'add-posts', 'apply-content-list': 'unapply-content-list', 'unapply-content-list': 'apply-content-list',
}

const blockListUndo: ToolUndo = {
  current: (change) => blockListNow((change.after ?? {}) as BlockListRecord),
  request(change: ToolChange) {
    const before = (change.before ?? {}) as BlockListRecord & { accountId?: string }
    const after = (change.after ?? {}) as BlockListRecord
    const conn = before.accountId ? { connectionId: before.accountId } : {}
    const why = 'undo of an earlier Meta block-list change'
    switch (after.action) {
      case 'create':
        // Review A3 — Meta answers "a newly created or updated" list: the id may be an older list of the same name Meta
        // replaced, one this ad account cannot see. Deleting it could delete that list: no undo.
        return { refusal: 'Nexus cannot undo this create: Meta may have replaced an older list with the same name that this ad account cannot see. To delete the list, ask remove-meta-block-list.' }
      case 'create-account-list':
        if (after.blockListId && (after.items !== 0 || after.ownerAdAccountId !== (after as { adAccountId?: string }).adAccountId)) {
          return { refusal: 'Nexus deletes only an empty list the chosen ad account itself owns: this record does not show that, so there is nothing it will put back.' }
        }
        return after.blockListId
          ? { tool: 'remove-meta-block-list', args: { ...conn, kind: 'publisher', blockListId: after.blockListId, confirmDelete: true, why: `${why} (it made this list)` } }
          : { refusal: 'This change made no list: nothing to put back.' }
      case 'create-content-list':
        return after.contentBlockListId
          ? { tool: 'remove-meta-block-list', args: { ...conn, kind: 'content', contentBlockListId: after.contentBlockListId, confirmDelete: true, why: `${why} (it made this list)` } }
          : { refusal: 'This change made no content block list: nothing to put back.' }
      case 'replace':
        return before.urls?.length && before.name
          ? { tool: 'set-meta-block-list', args: { ...conn, action: 'replace', blockListId: before.blockListId, name: before.name, urls: before.urls, why } }
          : { refusal: `Undo cannot put the list back as it was: ${before.urlsWhy ?? 'Nexus could not read what it held before'}. A person restores it in Meta's Brand Safety and Suitability hub.` }
      case 'rename-content-list':
        return before.name
          ? { tool: 'set-meta-block-list', args: { ...conn, action: 'rename-content-list', contentBlockListId: before.contentBlockListId, name: before.name, why } }
          : { refusal: 'Nexus did not read the list\'s old name, so it cannot rename it back.' }
      default: {
        const back = OPPOSITE[after.action]
        if (!back) return { refusal: 'This change has nothing to put back.' }
        const role = after.action === 'unshare' || after.action === 'unassign-user' ? before.role ?? 'APPLY_BLOCK_LIST' : after.role ?? undefined
        return {
          tool: 'set-meta-block-list',
          args: {
            ...conn, action: back,
            ...(after.blockListId ? { blockListId: after.blockListId } : {}), ...(after.contentBlockListId ? { contentBlockListId: after.contentBlockListId } : {}),
            ...(after.agencyId ? { agencyId: after.agencyId } : {}), ...(after.userId ? { userId: after.userId } : {}),
            ...(role && (back === 'share' || back === 'assign-user' || back === 'unshare') ? { role } : {}),
            ...(after.posts ? Object.fromEntries(Object.entries(after.posts).filter(([, v]) => Array.isArray(v) && v.length)) : {}),
            why: after.action === 'unshare' && !before.role ? `${why} (shared again as APPLY_BLOCK_LIST: Meta does not say which role it had)` : why,
          },
        }
      }
    }
  },
}

const setMetaBlockList: AgentTool = {
  name: 'set-meta-block-list',
  title: 'Meta block lists',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A replace can be put back only when Nexus read the whole list before (at most 250 entries); a create not at all (Meta
  // may have replaced a same-name list the ad account cannot see — review A3); everything else in full.
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'create' ? { reversibility: 'none' } : args.action === 'replace' ? null : { reversibility: 'full' }),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(BLOCK_LIST_ACTIONS).describe(BLOCK_LIST_ACTIONS.join(' | ')),
    blockListId: metaIdArg('replace, share, unshare, assign-user, unassign-user, apply-account, unapply-account: the publisher block list (meta-brand-safety view block-lists)').optional().describe('the publisher block list, for the actions on one (meta-brand-safety view block-lists)'),
    contentBlockListId: metaIdArg('the content block list').optional().describe('rename-content-list, add-posts, remove-posts, apply-content-list, unapply-content-list: the content block list (meta-brand-safety view content-block-lists)'),
    name: z.string().trim().min(1).max(200).optional().describe('create, create-account-list, create-content-list: the new list\'s name; replace: a new name (default: its own); rename-content-list: the new name'),
    urls: z.array(z.string().trim().min(1).max(MAX_URL_LENGTH)).max(MAX_BLOCK_LIST_URLS).optional()
      .describe(`create, replace: the hosts or URLs the list holds (plain hosts like example.com, or https URLs of Pages or apps; at most ${MAX_BLOCK_LIST_URLS}; Nexus writes them into a text file itself, one per line)`),
    agencyId: metaIdArg('the business portfolio').optional().describe('share, unshare: the business portfolio (its id) the list is shared with — never one another business in Nexus uses'),
    role: z.enum(BLOCK_LIST_ROLES).optional().describe('share, assign-user: APPLY_BLOCK_LIST (apply it) or MANAGE_BLOCK_LIST (also replace its contents); unshare: the role it had, so undo shares it back the same way'),
    userId: metaIdArg('the person').optional().describe('assign-user, unassign-user: the person\'s business-scoped user id (meta-brand-safety view block-list shows people\'s roles)'),
    facebookIds: postIds('add-posts, remove-posts: Facebook', /^\d{1,20}(_\d{1,20})?$/),
    instagramIds: postIds('add-posts, remove-posts: Instagram', /^\d{1,20}$/),
    threadsIds: postIds('add-posts, remove-posts: Threads', /^\d{1,20}$/),
    why: metaWhyArg,
  }),
  description:
    'Block lists of the business\'s chosen Meta ad account and its business portfolio — Meta must grant these to the '
    + 'business (block_list_management_v2_api_access, brand_safety_content_block_list): when it has not, the answer says '
    + 'so plainly and names the controls that need no grant (set-meta-brand-safety). Publisher block lists: create '
    + '(Nexus writes the hosts or URLs into a text file, uploads it as a draft, waits for Meta to read it, then makes the '
    + 'list — a name that exists is refused, because Meta REPLACES a list of the same name; a create cannot be undone: Meta may '
    + 'have replaced a same-name list the ad account cannot see), replace (the same list, new '
    + 'contents: it changes for every account and business using it), create-account-list (an empty list of the ad '
    + 'account), share / unshare with another business portfolio (never one another business in Nexus uses; the preview '
    + 'names the business that gets access), assign-user / unassign-user (a person\'s role; needs Team & access), '
    + 'apply-account / unapply-account (the chosen ad account only). Content block lists (Facebook, Instagram, Threads '
    + 'posts): create-content-list, rename-content-list, add-posts / remove-posts (at most 250 per platform per request), '
    + 'apply-content-list / unapply-content-list (the chosen ad account only; Meta allows 75 per account). Anything that '
    + 'unblocks something while a campaign delivers is SPENDS MONEY. Meta has no check for this change. Deleting a list is '
    + 'remove-meta-block-list. Undo puts back what it changed (a replace only when Nexus could read the whole list before; '
    + 'a create has none).'
    + META_CHANGE_RULES,
  undo: blockListUndo,
  async handler(args, ctx): Promise<ToolResult> {
    if (PEOPLE_ACTIONS.has(String(args.action)) && !ctx?.can?.(F.usersManage)) return { ok: false, error: 'Giving or removing a person\'s role on a block list needs the permission to manage the team (Team & access).' }
    return metaChangePreview(args, ctx, buildBlockList(args))
  },
  execute: (args, ctx) => runMetaChange(args, ctx, buildBlockList(args), (draft, done) => {
    const before = draft.before as BlockListRecord
    let after = draft.after as BlockListRecord
    const all = done.length === draft.requests.length
    const last = done[done.length - 1]?.result.node
    const madeId = all && last && (typeof last.id === 'string' || typeof last.id === 'number') ? String(last.id) : null
    if (after.action === 'create' || after.action === 'create-account-list') after = { ...after, blockListId: madeId }
    if (after.action === 'create-content-list') after = { ...after, contentBlockListId: madeId }
    if (!all && (after.action === 'create' || after.action === 'replace')) after = { ...before, ...(after.action === 'create' ? { blockListId: null } : {}) }
    return { data: { action: after.action, ...(madeId ? { madeId } : {}), list: after.blockListId ?? after.contentBlockListId ?? null }, before, after }
  }, async () => 'meta-brand-safety (views block-lists, block-list, content-block-lists, content-block-list) shows the lists now.'),
}

// ── remove-meta-block-list ─────────────────────────────────────────────────────────────────────────────────────────

const buildRemove = (args: Record<string, unknown>): MetaDraftBuilder => (account) => refusalOf(async () => {
  if (args.confirmDelete !== true) return { refusal: 'A block list is deleted only on an explicit ask: set confirmDelete to true. A deleted list cannot come back.' }
  const kind = args.kind === 'content' ? 'content' : 'publisher'
  const id = String((kind === 'content' ? args.contentBlockListId : args.blockListId) ?? '')
  if (!id) return { refusal: kind === 'content' ? 'Name the content block list (contentBlockListId).' : 'Name the publisher block list (blockListId).' }
  const live: BlockListLive = { adAccountId: account.adAccountId }
  if (kind === 'content') await contentLive(account, id, live)
  else {
    await publisherLive(account, id, live)
    // Only a list the chosen ad account or its own portfolio owns is deleted (one shared with it is another business's).
    const portfolio = (await metaChosenAccount(account.accountId)).businessId
    if (live.list?.ownerAdAccountId !== account.adAccountId && !(portfolio && live.list?.ownerBusinessId === portfolio)) {
      return { refusal: 'That block list is not owned by the chosen ad account or its business portfolio, so Nexus does not delete it.' }
    }
    live.delivering = await accountDelivering(account)
  }
  return removeBlockListDraft({ kind, id }, live)
})

const removeMetaBlockList: AgentTool = {
  name: 'remove-meta-block-list',
  title: 'Delete a Meta block list',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A deleted list cannot come back (Meta has no restore): a new list would be a new id.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    kind: z.enum(['publisher', 'content']).describe('publisher (a publisher block list) or content (a content block list)'),
    blockListId: metaIdArg('the publisher block list').optional().describe('kind publisher: the list (meta-brand-safety view block-lists)'),
    contentBlockListId: metaIdArg('the content block list').optional().describe('kind content: the list (meta-brand-safety view content-block-lists)'),
    confirmDelete: z.literal(true).describe('true: the person asked to delete this list (a deleted list cannot come back)'),
    why: metaWhyArg,
  }),
  description:
    'Delete a publisher or content block list of the business\'s chosen Meta ad account or its business portfolio — only '
    + 'when the person explicitly asks (confirmDelete). A publisher list must first be shared with no business and applied '
    + 'to no ad account (set-meta-block-list unshare, unapply-account); a content list applied to no ad account '
    + '(unapply-content-list): otherwise it is refused in words. A deleted list cannot come back: this cannot be undone '
    + '(a new list with the same hosts or URLs would be a new list). Deleting a publisher list ends every ad set\'s '
    + 'exclusion of it: while a campaign delivers that is SPENDS MONEY. Meta must grant block lists to the business; when '
    + 'it has not, the answer says so. Meta has no check for this change.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildRemove(args), (draft) => ({ data: { deleted: (draft.before as BlockListRecord).blockListId ?? (draft.before as BlockListRecord).contentBlockListId }, before: draft.before, after: draft.after })),
}

export const META_ADS_BRAND_SAFETY_TOOLS: AgentTool[] = [setMetaBrandSafety, setMetaBlockList, removeMetaBlockList]
