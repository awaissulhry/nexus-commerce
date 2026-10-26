/**
 * Meta ads changes, step 41 (2026-10-25) — people and partner access of the business's CHOSEN Meta assets:
 *   set-meta-user-access     give a person or system user of the ad account's business portfolio tasks on the chosen ad
 *                            account, Page or Instagram account, change them, or take them off — AA-056, AA-057, BM-038,
 *                            BM-039, BM-040
 *   set-meta-partner-access  share one of those assets with a partner business portfolio, take a partner off it, or end the
 *                            portfolio's whole relationship with an agency or a client — AA-058, AA-059, BM-046, BM-050,
 *                            BM-054
 * Each a Nexus change like set-meta-status (meta-ads-kit.ts): a preview from the live state, an approvalId, a person
 * approves it, it runs as that person, and undo puts back what it changed (an ended relationship has none: said). The
 * leader's hard floors are refused before Meta is called — at the preview, the re-check and the run (change-access.ts),
 * and again by the gateway with its own reads (gateway/meta-access-owner.ts): never the last admin removed or lowered; never
 * Nexus's own system user (nor a partner its access may come through); never a person or business the person asking did
 * not name, one outside the portfolio, the portfolio itself or a portfolio another business in Nexus uses. Step 40's rule:
 * nothing through a disabled, risk-reviewed, closing, closed or compromised ad account.
 *
 * Meta lets only the FULL Marketing API access tier manage people and partners by API: the preview names the tier Meta
 * named on the read it just made, and a refusal at the run is passed on with Meta's words and what it needs (no workaround).
 * Connection writes (revoke / rotate a token, install the app — ACC-001/002/003/005/006/012) are NOT here (the Owner's
 * decision 2026-10-20: their own preview and yes). Meta's own MCP has no tool for these (master rows: "—").
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, objectChangeOf, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { MetaLiveRefusal, type MetaChosenAccount } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import type { MetaChangeAccount } from '../../marketing/meta-ads/change-account.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import { metaSendChange, type MetaChangeResult, type MetaWriteTarget } from '../../marketing/meta-ads/write-client.js'
import { metaAccountChangeRefusal } from '../../marketing/meta-ads/change-account-settings.js'
import { liveNexusSystemUser, livePortfolioPeople } from '../../marketing/meta-ads/live-catalog-admin.js'
import { takenIds } from '../../marketing/meta-ads/taken.js'
import {
  accessAccount, liveAccessAsset, liveAccessState, liveAssetPartners, liveAssignees, liveChosenAssetsOwned, liveClientInstagramIds, livePortfolioOwnAssets, livePortfolioRelationships,
  liveServerEventBusinesses, type AccessAccountState, type AssigneeNow, type PartnerNow,
} from '../../marketing/meta-ads/live-access-change.js'
import {
  metaUndoTasks, partnerAccessDraft, partnerReadBack, PIXEL_NO_REMOVE, serverEventsDraft, userAccessDraft, userReadBack,
  type MetaRelationship, type PartnerAccessAction, type PartnerAccessRecord, type UserAccessAction, type UserAccessRecord,
} from '../../marketing/meta-ads/change-access.js'
import { MAX_SERVER_EVENT_BUSINESSES, META_ACCESS_ASSETS, META_AD_ACCOUNT_TASKS, META_INSTAGRAM_TASKS, META_PAGE_TASKS, META_PIXEL_PARTNER_TASKS, META_PIXEL_TASKS, type MetaAccessAsset } from '../../meta/meta-access-lists.js'

type Args = Record<string, unknown>
type Done = Array<{ request: MetaChangeRequest; result: MetaChangeResult; notAsAsked?: string }>

/** Every task any of the assets takes (the draft judges the asset's own list). */
const ALL_TASKS = [...new Set<string>([...META_AD_ACCOUNT_TASKS, ...META_PAGE_TASKS, ...META_INSTAGRAM_TASKS, ...META_PIXEL_TASKS])] as [string, ...string[]]
const TASKS_TEXT = `ad-account: ${META_AD_ACCOUNT_TASKS.join(', ')} (Admin = MANAGE, ADVERTISE, ANALYZE; Advertiser = ADVERTISE, ANALYZE; Analyst = ANALYZE); `
  + 'page: MANAGE, CREATE_CONTENT, MODERATE, MESSAGING, ADVERTISE, ANALYZE, MODERATE_COMMUNITY, MANAGE_LEADS and Meta\'s other Page tasks (Admin = MANAGE, CREATE_CONTENT, MODERATE, ADVERTISE, ANALYZE; Editor = CREATE_CONTENT, MODERATE, ADVERTISE, ANALYZE; Moderator = MODERATE, ADVERTISE, ANALYZE; Advertiser = ADVERTISE, ANALYZE; Analyst = ANALYZE); '
  + `instagram: ${META_INSTAGRAM_TASKS.join(', ')} (all five = full control); `
  + `pixel (a dataset): ${META_PIXEL_TASKS.join(', ')} for a person, ${META_PIXEL_PARTNER_TASKS.join(', ')} for a partner (EDIT = its admin; Meta limits EDIT for partners)`

/**
 * The Nexus permission both tools need (review A-MF3, the Owner's option 1, 2026-10-26): who may use the business's Meta
 * assets is people and connections — users.manage and ads.connect, exactly as set-google-user-access — by the Owner's
 * narrow tool-never exception (tool-never.vitest.test.ts NEVER_EXCEPTIONS). The person who approves needs them too (the
 * approval gate re-checks the approver against `requires`: approval-inbox.service.ts deciderPrincipal).
 */
const ACCESS_REQUIRES: AgentTool['requires'] = [F.usersManage, F.adsConnect]

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

/** A builder that turns a refusal of the live reads into words. */
const guarded = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

/** Only the arguments of the action asked (a stray one is refused, never ignored). */
function onlyArgs(args: Args, action: string, allowed: readonly string[]): string | null {
  const extra = Object.keys(args).filter((k) => args[k] !== undefined && !['connectionId', 'why', 'action', ...allowed].includes(k))
  return extra.length ? `${extra.join(', ')} ${extra.length === 1 ? 'is' : 'are'} not an argument of action ${action} (it takes ${allowed.join(', ')}).` : null
}

/** The account, its state and its portfolio — or why no access change goes through it (step 40's rule first). */
async function accountOf(account: MetaChangeAccount): Promise<{ chosen: MetaChosenAccount; state: AccessAccountState; portfolioId: string; portfolioShared: boolean | null } | { refusal: string }> {
  const chosen = await accessAccount(account.target)
  const state = await liveAccessState(chosen)
  const refused = metaAccountChangeRefusal(state)
  if (refused) return { refusal: refused }
  if (!state.portfolioId) return { refusal: 'The chosen ad account belongs to no Meta business portfolio, so it has no people or partners Nexus can change (Meta keeps them on a portfolio).' }
  // Review A-N3, re-review R-1 — shared when another business's link names the portfolio, OR it chose one of the portfolio's
  // own ad accounts, Pages or Instagram accounts (a link without its portfolio, an asset reached through a partner); null when
  // Nexus cannot read them in full (counted as shared).
  const portfolioId = state.portfolioId
  let portfolioShared: boolean | null = (await takenIds('PORTFOLIO', [portfolioId])).has(portfolioId)
  if (!portfolioShared) {
    const own = await livePortfolioOwnAssets(chosen, portfolioId)
    portfolioShared = !own.adAccounts || !own.pages || !own.instagram ? null
      : (await takenIds('AD_ACCOUNT', own.adAccounts.filter((id) => id !== chosen.adAccountId))).size > 0
        || (await takenIds('PAGE', own.pages)).size > 0 || (await takenIds('INSTAGRAM', own.instagram)).size > 0
  }
  return { chosen, state, portfolioId, portfolioShared }
}

const head = (record: { accountId?: string } | undefined, why: string) => ({ ...(record?.accountId ? { connectionId: record.accountId } : {}), why })
/** A dataset is named by its id (pixelId), and only a dataset is. */
function pixelArgProblem(args: Args): string | null {
  if (args.asset === 'pixel' && !args.pixelId) return 'Name the dataset: pixelId (meta-datasets view list shows the chosen ad account\'s).'
  if (args.asset !== 'pixel' && args.pixelId !== undefined) return 'pixelId goes only with asset pixel (a dataset).'
  return null
}
/** The undo arguments that name the asset again (a dataset by its id). */
const assetArgs = (record: { asset: string; nodeId: string }) => ({ asset: record.asset, ...(record.asset === 'pixel' ? { pixelId: record.nodeId } : {}) })

// ── set-meta-user-access ────────────────────────────────────────────────────────────────────────────────────────────

const USER_ACTIONS = ['set', 'remove'] as const

/**
 * The run's sender: the request through the write client (the gateway judges it again), then ONE read of the asset's
 * people, judged by userReadBack. The read is kept for the record (`seen`).
 */
function withUserSender(draft: MetaChangeDraft, chosen: MetaChosenAccount, asset: MetaAccessAsset, nodeId: string, portfolioId: string, seen: { read?: AssigneeNow | null }): MetaChangeDraft {
  const after = draft.after as UserAccessRecord | null
  if (!after) return draft
  return {
    ...draft,
    requests: draft.requests.map((request) => ({
      ...request,
      send: async (target: MetaWriteTarget) => {
        const result = await metaSendChange(target, { ...objectChangeOf(request), judge: undefined })
        const people = await liveAssignees(chosen, nodeId, portfolioId).catch(() => null)
        if (!people) return { ...result, node: result.node, readBack: 'none' as const }
        seen.read = people.people.get(after.personId) ?? null
        return { ...result, node: { person: seen.read }, readBack: 'second-read' as const }
      },
      judge: (node: Record<string, unknown>) => userReadBack(asset, after.op === 'set' ? after.tasks : null, (node.person ?? null) as AssigneeNow | null),
    })),
  }
}

const buildUser = (args: Args, seen: { read?: AssigneeNow | null } = {}): MetaDraftBuilder => guarded(async (account) => {
  const action = args.action as UserAccessAction
  const extra = onlyArgs(args, action, action === 'set' ? ['asset', 'personId', 'tasks', 'pixelId'] : ['asset', 'personId', 'confirmRemove', 'pixelId'])
  if (extra) return { refusal: extra }
  const pixelProblem = pixelArgProblem(args)
  if (pixelProblem) return { refusal: pixelProblem }
  // Owner option 1 — Meta has no removal of a person from a dataset: said before anything is read.
  if (action === 'remove' && args.asset === 'pixel') return { refusal: PIXEL_NO_REMOVE }
  if (action === 'remove' && args.confirmRemove !== true) return { refusal: 'Taking someone off takes confirmRemove: true (they lose the asset in Meta at once).' }
  const base = await accountOf(account)
  if ('refusal' in base) return base
  const { chosen, state, portfolioId, portfolioShared } = base
  const asset = await liveAccessAsset(chosen, args.asset as MetaAccessAsset, portfolioId, args.pixelId as string | undefined)
  const assigned = await liveAssignees(chosen, asset.nodeId, portfolioId)
  const people = await livePortfolioPeople(chosen, portfolioId)
  const draft = userAccessDraft({ asset: asset.asset, action, personId: String(args.personId), tasks: args.tasks as string[] | undefined }, {
    state, portfolioId, portfolioShared, nexusSystemUserId: await liveNexusSystemUser(chosen),
    asset, assigned: assigned.people, assignedMore: assigned.more, people: people.people, peopleMore: people.more,
  })
  return 'refusal' in draft ? draft : withUserSender(draft, chosen, asset.asset, asset.nodeId, portfolioId, seen)
})

/** The record: what the person holds after the change, as Meta read it right after (else as sent: Meta's list may lag). */
function userFinish(draft: MetaChangeDraft, done: Done, seen: { read?: AssigneeNow | null }) {
  const after = { ...(draft.after as UserAccessRecord) }
  const read = seen.read
  if (done.length && read !== undefined) {
    if (after.op === 'set' && read) { after.assigned = true; after.tasks = read.tasks }
    if (after.op === 'remove' && !read) { after.assigned = false; after.tasks = null }
  }
  return { data: { asset: after.asset, personId: after.personId, assigned: after.assigned, tasks: after.tasks }, before: draft.before, after }
}

const userUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as UserAccessRecord & { accountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const base = await accountOf(account)
      if ('refusal' in base) return null
      const asset = await liveAccessAsset(base.chosen, after.asset, base.portfolioId, after.asset === 'pixel' ? after.nodeId : null)
      // The asset chosen now must be the one the change was made on (another chosen Page is another asset).
      if (asset.nodeId !== after.nodeId) return null
      const person = (await liveAssignees(base.chosen, asset.nodeId, base.portfolioId)).people.get(after.personId) ?? null
      return { ...after, assigned: !!person, tasks: person ? person.tasks : null }
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as UserAccessRecord
    const after = (change.after ?? {}) as UserAccessRecord & { accountId?: string }
    const h = head(after, 'undo of an earlier Meta people access change')
    if (!before.assigned) {
      // Owner option 1 — a dataset's person cannot be taken off by API.
      if (after.asset === 'pixel') return { refusal: PIXEL_NO_REMOVE }
      return { tool: 'set-meta-user-access', args: { ...h, ...assetArgs(after), action: 'remove', personId: after.personId, confirmRemove: true } }
    }
    // An ad account's tasks go back as Meta's preset (its read-back is unpacked); a list Nexus cannot send refuses.
    const tasks = metaUndoTasks(after.asset, before.tasks)
    if (!tasks) return { refusal: (before.noUndo ?? []).join(' ') || 'Nexus did not read tasks it can give back to this person: give access again with set-meta-user-access (action set) and the tasks wanted.' }
    return { tool: 'set-meta-user-access', args: { ...h, ...assetArgs(after), action: 'set', personId: after.personId, tasks } }
  },
}

const setMetaUserAccess: AgentTool = {
  ...common,
  name: 'set-meta-user-access',
  requires: ACCESS_REQUIRES,
  title: 'Change who has access to a Meta asset',
  // Undo gives the old tasks back, or takes back what it gave; a task Nexus does not send, or a person who left the
  // portfolio since, cannot be put back (said).
  reversibility: 'partial',
  input: z.object({
    connectionId: metaConnectionArg,
    asset: z.enum(META_ACCESS_ASSETS).describe('ad-account, page or instagram: the business\'s CHOSEN one (never another); a Page or Instagram account only when the ad account\'s business portfolio owns it; pixel: a dataset of the chosen ad account its portfolio owns (pixelId)'),
    pixelId: metaIdArg('asset pixel: the dataset (meta-datasets view list)').optional(),
    action: z.enum(USER_ACTIONS).describe('set: give the person tasks, or change them (the WHOLE list they should hold) · remove: take them off (needs confirmRemove: true; never on a dataset: Meta has no way)'),
    personId: metaIdArg('the person or system user — a business user or system user of the ad account\'s business portfolio, named by the person asking (meta-account-access view people / asset-people lists who holds what)'),
    tasks: z.array(z.enum(ALL_TASKS)).min(1).max(META_PAGE_TASKS.length).optional().describe(`set: the WHOLE list of tasks — ${TASKS_TEXT}`),
    confirmRemove: z.literal(true).optional().describe('remove: must be true (they lose the asset in Meta at once)'),
    why: metaWhyArg,
  }),
  description:
    'Who may use the business\'s chosen Meta ad account, Facebook Page or Instagram account: give a person or system user of '
    + 'the ad account\'s business portfolio tasks on it (Admin, Advertiser, Analyst … as task lists), change their tasks (the '
    + 'same call), or take them off (confirmRemove: true). The person is always named by its id; Nexus never gives access to '
    + 'someone outside the portfolio (inviting a person to the portfolio is its admin\'s step in Meta Business settings). '
    + 'Hard floors, refused before Meta is called (and by the gateway again): never Nexus\'s own system user (fewer tasks '
    + 'would cut Nexus off); never the LAST admin of the asset removed or lowered (another PERSON must stay an admin: MANAGE '
    + 'on the ad account, MANAGE or full control on the Page, every task on the Instagram account; tasks Nexus cannot read count '
    + 'as an admin\'s for the one changed); a Page or Instagram '
    + 'account only when the portfolio owns it. A dataset (asset pixel, pixelId): one of the chosen ad account\'s that no other '
    + 'Nexus business uses and its portfolio owns; tasks AA_ANALYZE, ADVERTISE, ANALYZE, EDIT (its admin), UPLOAD; set only — '
    + 'Meta has no way to take a person\'s dataset tasks back by API (no undo of a first grant: Business settings › Data '
    + 'sources). Needs the users.manage and ads.connect permissions (the Owner\'s exception), for whoever approves too. '
    + 'ADVERTISE lets the person create ads that spend the account\'s money; MANAGE '
    + 'makes them an admin (people, payment): the preview says so. Meta lets only the FULL Marketing API access tier manage '
    + 'people by API: the preview names the tier Meta named, and at the Limited tier Meta refuses — its words are passed on '
    + '(no workaround). Refused on a disabled, risk-reviewed, closing, closed or compromised ad account. Meta has no check for '
    + 'an access change. An ad account takes only Meta\'s task combinations (Admin, General, Reporting). Undo gives back the old '
    + 'tasks or takes back what it gave (the preview says when it cannot).'
    + META_CHANGE_RULES,
  undo: userUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildUser(args)),
  execute: (args, ctx) => {
    const seen: { read?: AssigneeNow | null } = {}
    return runMetaChange(args, ctx, buildUser(args, seen), (draft, done) => userFinish(draft, done, seen))
  },
}

// ── set-meta-partner-access ─────────────────────────────────────────────────────────────────────────────────────────

const PARTNER_ACTIONS = ['share', 'remove', 'end-relationship', 'server-events'] as const

/** The run's sender: the request through the write client, then ONE read of the asset's partners (or the relationship's list). */
type PartnerSeen = { read?: PartnerNow | null; listed?: boolean; businesses?: string[] | null }

function withPartnerSender(draft: MetaChangeDraft, chosen: MetaChosenAccount, portfolioId: string, seen: PartnerSeen): MetaChangeDraft {
  const after = draft.after as PartnerAccessRecord | null
  if (!after) return draft
  return {
    ...draft,
    requests: draft.requests.map((request) => ({
      ...request,
      send: async (target: MetaWriteTarget) => {
        const result = await metaSendChange(target, { ...objectChangeOf(request), judge: undefined })
        // Owner option 1 (SG-014) — the dataset's server-event businesses as Meta lists them right after.
        if (after.op === 'server-events') {
          const list = await liveServerEventBusinesses(chosen, after.nodeId).catch(() => null)
          if (!list || list.more) return { ...result, readBack: 'none' as const }
          seen.businesses = [...list.businesses.keys()].sort()
          return { ...result, node: { businesses: seen.businesses }, readBack: 'second-read' as const }
        }
        if (after.op === 'end-relationship') {
          const list = await livePortfolioRelationships(chosen, portfolioId, after.relationship!).catch(() => null)
          if (!list) return { ...result, readBack: 'none' as const }
          seen.listed = list.partners.has(after.partnerId)
          return { ...result, node: { listed: seen.listed }, readBack: 'second-read' as const }
        }
        const partners = await liveAssetPartners(chosen, after.nodeId, after.asset as MetaAccessAsset).catch(() => null)
        if (!partners) return { ...result, readBack: 'none' as const }
        seen.read = partners.partners.get(after.partnerId) ?? null
        // A dataset's share may wait for the partner's acceptance (Meta answers pending_request_id): said with the read-back.
        const answer = result.node as Record<string, unknown> | null
        const pending = !!answer && (typeof answer.pending_request_id === 'string' || typeof answer.pending_request_id === 'number')
        return { ...result, node: { partner: seen.read, pending }, readBack: 'second-read' as const }
      },
      judge: (node: Record<string, unknown>) => {
        if (after.op === 'end-relationship') return { moved: [], reads: node.listed ? 'still listed right after (Meta\'s list may catch up later)' : 'ended' }
        if (after.op === 'server-events') {
          const now = Array.isArray(node.businesses) ? node.businesses as string[] : []
          const same = JSON.stringify(now) === JSON.stringify(after.businesses ?? [])
          return { moved: same ? [] : ['server_events_business_ids'], reads: `server-event businesses ${now.length ? now.join(', ') : 'none'}` }
        }
        const judged = partnerReadBack(after.op === 'share' ? after.tasks : null, (node.partner ?? null) as PartnerNow | null)
        // Option-1 review N4 — until the partner accepts, the share is not listed: its undo refuses then, and Nexus cannot withdraw the request.
        return node.pending && !node.partner ? { moved: [], reads: 'pending: Meta answered a sharing request the partner must accept first — until then the share is not listed, its undo refuses, and Nexus cannot withdraw the request (a person does it in Meta Business settings)' } : judged
      },
    })),
  }
}

const buildPartner = (args: Args, seen: PartnerSeen = {}): MetaDraftBuilder => guarded(async (account) => {
  const action = args.action as PartnerAccessAction
  const allowed: Record<PartnerAccessAction, string[]> = {
    share: ['asset', 'partnerBusinessId', 'permittedTasks', 'pixelId'], remove: ['asset', 'partnerBusinessId', 'confirmRemove', 'pixelId'],
    'end-relationship': ['relationship', 'partnerBusinessId', 'confirmRemove'], 'server-events': ['asset', 'pixelId', 'businessIds', 'confirmRemove'],
  }
  const extra = onlyArgs(args, action, allowed[action])
  if (extra) return { refusal: extra }
  const pixelProblem = pixelArgProblem(args)
  if (pixelProblem) return { refusal: pixelProblem }
  if (action === 'server-events') {
    if (args.asset !== 'pixel' || !Array.isArray(args.businessIds)) return { refusal: 'server-events is a dataset\'s: asset pixel, pixelId and businessIds (the WHOLE list of business portfolios allowed to send its server events; [] clears it).' }
    const base = await accountOf(account)
    if ('refusal' in base) return base
    const { chosen, state, portfolioId, portfolioShared } = base
    const asset = await liveAccessAsset(chosen, 'pixel', portfolioId, args.pixelId as string)
    const list = await liveServerEventBusinesses(chosen, asset.nodeId)
    const asked = args.businessIds as string[]
    const nexusSystemUserId = await liveNexusSystemUser(chosen)
    const people = await livePortfolioPeople(chosen, portfolioId)
    const ids = new Set([...people.people].filter(([, p]) => p.kind === 'system user').map(([id]) => id))
    const draft = serverEventsDraft({ businessIds: asked, confirmRemove: args.confirmRemove === true }, {
      state, portfolioId, portfolioShared, nexusSystemUserId, asset, businesses: list.businesses, more: list.more,
      askedTaken: (await takenIds('PORTFOLIO', asked)).size > 0, systemUsers: !people.more || (nexusSystemUserId && ids.has(nexusSystemUserId)) ? ids : null,
    })
    return 'refusal' in draft ? draft : withPartnerSender(draft, chosen, portfolioId, seen)
  }
  if (!args.partnerBusinessId) return { refusal: 'Name the partner\'s business portfolio (partnerBusinessId).' }
  if (action !== 'share' && args.confirmRemove !== true) return { refusal: action === 'remove' ? 'Taking a partner off takes confirmRemove: true (it loses the asset at once).' : 'Ending a relationship takes confirmRemove: true (the partner loses every asset of it at once, and it has no undo).' }
  if (action === 'end-relationship' ? !args.relationship : !args.asset) return { refusal: action === 'end-relationship' ? 'Name the relationship: agency or client.' : 'Name the asset: ad-account, page, instagram (the business\'s chosen one) or pixel (a dataset, pixelId).' }
  const base = await accountOf(account)
  if ('refusal' in base) return base
  const { chosen, state, portfolioId, portfolioShared } = base
  const partnerId = String(args.partnerBusinessId)
  const partnerTaken = (await takenIds('PORTFOLIO', [partnerId])).has(partnerId)
  const nexusSystemUserId = await liveNexusSystemUser(chosen)
  const systemUsersOf = async () => {
    const people = await livePortfolioPeople(chosen, portfolioId)
    const ids = new Set([...people.people].filter(([, p]) => p.kind === 'system user').map(([id]) => id))
    // A list cut short that does not show Nexus's own system user cannot prove it is not there: null (refused).
    return !people.more || (nexusSystemUserId && ids.has(nexusSystemUserId)) ? ids : null
  }
  let draft: MetaChangeDraft | { refusal: string }
  if (action === 'end-relationship') {
    const relationship = args.relationship as MetaRelationship
    const list = await livePortfolioRelationships(chosen, portfolioId, relationship)
    // Review A-MF1 — what the relationship holds that another business in Nexus chose (an ad account, a Page): checked only
    // on lists Meta answered and Nexus read in full; otherwise unknown (undefined), and the draft ends nothing.
    const shares = list.partners.get(partnerId)?.shares ?? null
    const sharesTaken = shares && shares.adAccounts && shares.pages && !list.sharesNote
      ? (await takenIds('AD_ACCOUNT', shares.adAccounts)).size > 0 || (await takenIds('PAGE', shares.pages)).size > 0
      : undefined
    // A client relationship: every Instagram account this portfolio holds as a client (Meta names none for a relationship).
    let clientInstagram: 'ok' | 'taken' | 'unread' | undefined
    if (relationship === 'client') {
      const ids = await liveClientInstagramIds(chosen, portfolioId)
      clientInstagram = ids === null ? 'unread' : (await takenIds('INSTAGRAM', ids)).size > 0 ? 'taken' : 'ok'
    }
    draft = partnerAccessDraft({ action, relationship, partnerBusinessId: partnerId }, {
      state, portfolioId, portfolioShared, nexusSystemUserId, relationships: list.partners, sharesNote: list.sharesNote, listMore: list.more && !list.partners.has(partnerId), partnerTaken, sharesTaken,
      systemUsers: await systemUsersOf(), ...(relationship === 'client' ? { chosenOwned: await liveChosenAssetsOwned(chosen, portfolioId), clientInstagram } : {}),
    })
  } else {
    const asset = await liveAccessAsset(chosen, args.asset as MetaAccessAsset, portfolioId, args.pixelId as string | undefined)
    const partners = await liveAssetPartners(chosen, asset.nodeId, asset.asset)
    draft = partnerAccessDraft({ action, asset: asset.asset, partnerBusinessId: partnerId, permittedTasks: args.permittedTasks as string[] | undefined }, {
      state, portfolioId, portfolioShared, nexusSystemUserId, asset, partners: partners.partners, listMore: partners.more, partnerTaken,
      ...(action === 'remove' ? { systemUsers: await systemUsersOf() } : {}),
    })
  }
  return 'refusal' in draft ? draft : withPartnerSender(draft, chosen, portfolioId, seen)
})

/** The record: the partner after the change, as Meta read it right after (else as sent: Meta's list may lag). */
function partnerFinish(draft: MetaChangeDraft, done: Done, seen: PartnerSeen) {
  const after = { ...(draft.after as PartnerAccessRecord) }
  if (done.length && after.op === 'server-events' && seen.businesses) after.businesses = seen.businesses
  if (done.length && (after.op === 'share' || after.op === 'remove') && seen.read !== undefined) {
    if (after.op === 'share' && seen.read) after.tasks = seen.read.tasks
    if (after.op === 'remove' && !seen.read) { after.shared = false; after.tasks = null }
  }
  const before = draft.before as PartnerAccessRecord
  return {
    data: after.op === 'server-events'
      ? { asset: after.asset, pixelId: after.nodeId, businesses: after.businesses ?? [] }
      : { partnerId: after.partnerId, asset: after.asset, ...(after.relationship ? { relationship: after.relationship } : {}), shared: after.shared, tasks: after.tasks },
    before,
    after,
    ...(after.op === 'end-relationship' ? { noUndo: 'Ending a relationship has no undo: the partner asks or shares again.' } : {}),
  }
}

const partnerUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as PartnerAccessRecord & { accountId?: string }
    if (after.op === 'end-relationship') return null
    const account = await recordAccount(after)
    if (!account) return null
    try {
      const base = await accountOf(account)
      if ('refusal' in base) return null
      const asset = await liveAccessAsset(base.chosen, after.asset as MetaAccessAsset, base.portfolioId, after.asset === 'pixel' ? after.nodeId : null)
      if (asset.nodeId !== after.nodeId) return null
      if (after.op === 'server-events') {
        const list = await liveServerEventBusinesses(base.chosen, asset.nodeId)
        return list.more ? null : { ...after, businesses: [...list.businesses.keys()].sort() }
      }
      const partner = (await liveAssetPartners(base.chosen, asset.nodeId, asset.asset)).partners.get(after.partnerId) ?? null
      return { ...after, shared: !!partner, tasks: partner ? partner.tasks : null }
    } catch (err) {
      if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return null
      throw err
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as PartnerAccessRecord
    const after = (change.after ?? {}) as PartnerAccessRecord & { accountId?: string }
    if (after.op === 'end-relationship') return { refusal: 'Ending a relationship has no undo: the agency asks again (and is accepted), or the client shares its assets again, in Meta Business settings › Partners.' }
    const h = head(after, 'undo of an earlier Meta partner access change')
    // SG-014 — the dataset's server-event businesses go back to the list they were.
    if (after.op === 'server-events') {
      const back = before.businesses ?? []
      // An undo that takes a business off again is a removal too (confirmRemove).
      const removes = (after.businesses ?? []).some((id) => !back.includes(id))
      return { tool: 'set-meta-partner-access', args: { ...h, action: 'server-events', asset: 'pixel', pixelId: after.nodeId, businessIds: back, ...(removes ? { confirmRemove: true } : {}) } }
    }
    if (after.op === 'share') return { tool: 'set-meta-partner-access', args: { ...h, action: 'remove', ...assetArgs(after), partnerBusinessId: after.partnerId, confirmRemove: true } }
    const tasks = metaUndoTasks(after.asset as MetaAccessAsset, before.tasks, 'partner')
    if (!tasks) return { refusal: (before.noUndo ?? []).join(' ') || 'Nexus did not read tasks it can give the partner back: share it again with set-meta-partner-access (action share) and the tasks wanted.' }
    return { tool: 'set-meta-partner-access', args: { ...h, action: 'share', ...assetArgs(after), partnerBusinessId: after.partnerId, permittedTasks: tasks } }
  },
}

const setMetaPartnerAccess: AgentTool = {
  ...common,
  name: 'set-meta-partner-access',
  requires: ACCESS_REQUIRES,
  title: 'Change which partners have a Meta asset',
  // A share is taken back and a partner taken off is shared again (it may have to accept again); an ended relationship has none.
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'end-relationship' ? { reversibility: 'none' } : null),
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(PARTNER_ACTIONS).describe('share: give a partner portfolio tasks on the asset · remove: take a partner off it (confirmRemove: true) · end-relationship: end the portfolio\'s WHOLE relationship with an agency or a client (confirmRemove: true; NO undo) · server-events: a dataset\'s WHOLE list of business portfolios allowed to send its server events (asset pixel)'),
    asset: z.enum(META_ACCESS_ASSETS).optional().describe('share, remove: ad-account, page or instagram — the business\'s CHOSEN one, owned by the ad account\'s business portfolio — or pixel (a dataset of the chosen ad account its portfolio owns, pixelId); server-events: pixel'),
    pixelId: metaIdArg('asset pixel: the dataset (meta-datasets view list)').optional(),
    businessIds: z.array(z.string().trim().regex(/^[1-9]\d{0,19}$/, 'a Meta business portfolio id (digits)')).max(MAX_SERVER_EVENT_BUSINESSES).optional().describe('server-events: the WHOLE list of business portfolios allowed to send the dataset\'s server events (Meta replaces the list; [] clears it)'),
    relationship: z.enum(['agency', 'client']).optional().describe('end-relationship: agency (a partner this portfolio shares with: it loses every asset) or client (a business that shares with this portfolio: this portfolio loses every asset it shares)'),
    partnerBusinessId: metaIdArg('share, remove, end-relationship: the partner\'s business portfolio, named by the person asking (meta-account-access view agencies lists who has the ad account)').optional(),
    permittedTasks: z.array(z.enum(ALL_TASKS)).min(1).max(META_PAGE_TASKS.length).optional().describe(`share (always sent): what the partner may do — ${TASKS_TEXT}`),
    confirmRemove: z.literal(true).optional().describe('remove, end-relationship, and server-events that takes a business off: must be true'),
    why: metaWhyArg,
  }),
  description:
    'Which partner business portfolios have the business\'s chosen Meta ad account, Facebook Page or Instagram account: share '
    + 'one with a partner (its tasks always named), take a partner off (confirmRemove: true), or end the portfolio\'s WHOLE '
    + 'relationship with an agency (it loses every asset shared) or a client (this portfolio loses every asset it shared) — '
    + 'confirmRemove: true, NO undo, and Meta may take it only from an admin of the portfolio (else a person does it in Meta '
    + 'Business settings › Partners); Nexus ends one only when Meta lists the ad accounts and Pages it holds readably and none '
    + 'is another Nexus business\'s. The partner is always named by its id. Hard floors, refused before Meta is called (and '
    + 'by the gateway again): never the portfolio itself; never a portfolio another business in Nexus uses; never a partner '
    + 'taken off or a relationship ended when Nexus\'s own system user is not one of the portfolio\'s (its access, and its '
    + 'app\'s, could come through that partner); a client relationship only when the chosen Page and Instagram account are '
    + 'the portfolio\'s own; an asset only when the portfolio owns it. A partner already shared is not changed in place (Meta: '
    + 'duplicates): take it off, then share again. An ad account\'s share is a route Meta names whose parameters are in its SDK '
    + 'only, and taking a partner off a Page is in the SDK only (Meta\'s Page reference says it is not supported): Meta\'s answer '
    + 'decides. An ad account takes only Meta\'s task combinations (Admin, General, Reporting). A dataset (asset pixel, '
    + 'pixelId — one of the chosen ad account\'s that no other Nexus business uses and its portfolio owns): share it (ADVERTISE, '
    + 'ANALYZE, EDIT, UPLOAD; Meta limits EDIT; with no approved relationship Meta answers a request the partner must accept), '
    + 'take a partner off (Meta\'s query form), or set the WHOLE list of business portfolios allowed to send its server events '
    + '(server-events, businessIds — confirmRemove when it takes one off; read first, and again by the gateway, which sends '
    + 'nothing if Meta\'s list moved; undo sends the old list back; never the portfolio itself or another Nexus '
    + 'business\'s). Needs the users.manage and ads.connect permissions (the Owner\'s exception), for whoever approves too. '
    + 'Meta lets only the FULL Marketing API access tier manage '
    + 'partners by API: the preview names the tier Meta named, and at the Limited tier Meta refuses — its words are passed on '
    + '(no workaround). Refused on a disabled, risk-reviewed, closing, closed or compromised ad account. Meta has no check for '
    + 'an access change. Undo takes a share back or shares a removed partner again with the tasks it had (the preview says when '
    + 'it cannot).'
    + META_CHANGE_RULES,
  undo: partnerUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildPartner(args)),
  execute: (args, ctx) => {
    const seen: PartnerSeen = {}
    return runMetaChange(args, ctx, buildPartner(args, seen), (draft, done) => partnerFinish(draft, done, seen))
  },
}

export const META_ADS_ACCESS_TOOLS: AgentTool[] = [setMetaUserAccess, setMetaPartnerAccess]
