/**
 * Meta step 39 (2026-10-21) — the gateway's owner checks of the brand-safety changes (gateway.ts 3b): before anything is
 * sent, every object a change names — on its path and inside its body — must be THIS business's, from Nexus's own rows
 * (the chosen ad account and its business portfolio, MetaAccountLink), else one live read through this gateway:
 *   adaccount           the path's `act_<id>` (and a body's account_id) is the chosen ad account itself
 *   business            the business portfolio of the chosen ad account (the link's businessId), and not a portfolio another
 *                       business in Nexus uses (step 10's nexus_meta_links_taken PORTFOLIO)
 *   publisherblocklist  owned by the chosen ad account or by that portfolio (`GET /<list>?fields=id,business_owner_id,
 *                       owner_ad_account_id`, block-list.md); a list only APPLIED (to the chosen ad account, or excluded by
 *                       one of its ad sets) may also be one Meta lists for the chosen ad account (`GET
 *                       /act_<id>/publisher_block_lists`, one page) — a list another business owns is never changed
 *   contentblocklist    one of that portfolio's content block lists (`GET /<portfolio>/content_block_lists`, every page —
 *                       review A1: a catalog, a Page or any other node of the portfolio also answers `business`)
 *   agency              a portfolio a list is shared with: digits, never this business's own portfolio, never one another
 *                       business in Nexus uses
 *   blocklistdraft      the draft THIS gateway saw Meta make for this connection in the SAME run of a change (its first
 *                       request; review A9), used once: a draft id from anywhere else, or a second time, is refused
 * and an ad set's targeting (Q7): the gateway reads the ad set's live targeting itself — in the SAME one read as its owner
 * and kind check (`GET /<ad set>?fields=account_id,optimization_goal,billing_event,targeting`) — and refuses any key outside
 * the brand-safety keys that is not exactly Meta's (meta-brand-safety-rules.ts targetingOutsideProblem). No live read:
 * nothing is sent. A sentence never names another business's account or portfolio.
 */
import { metaChosenAdAccountOf, metaChosenPortfolioOf, metaPortfolioTakenByAnother } from './account.js'
import { holdsInexactNumber, targetingOutsideProblem } from './meta-brand-safety-rules.js'
import type { MetaJudgedWrite, MetaWriteBodyId } from './meta-calls.js'

/**
 * One Graph read the gateway makes for a check (through itself): Meta's body, or why there is none, and how many
 * token-shaped things the gateway removed from Meta's answer (review A7: a value read that way is not Meta's own).
 */
export type MetaCheckRead = (path: string, query: Record<string, string>) => Promise<{ body: Record<string, unknown> | null; words: string | null; scrubbed?: number }>

export type OwnerProblem = { code: string; sentence: string } | null

/** The step-39 kinds a change names (gateway.ts routes them here). */
export const BRAND_SAFETY_KINDS: ReadonlySet<string> = new Set(['adaccount', 'business', 'publisherblocklist', 'contentblocklist'])
/** The rules that only APPLY a publisher block list (a list Meta lists for the chosen ad account may be one shared with it). */
const APPLY_ONLY_RULES: ReadonlySet<string> = new Set(['blocklist.apply_account'])

const NOTHING = 'Nothing was sent to Meta: '
const WORD: Readonly<Record<string, string>> = { adaccount: 'ad account', business: 'business portfolio', publisherblocklist: 'publisher block list', contentblocklist: 'content block list', agency: 'business portfolio', blocklistdraft: 'block-list draft' }
const text = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v) : null)
const accountOf = (v: unknown): string | null => { const id = text(v)?.replace(/^act_/, '') ?? null; return id && /^\d{1,25}$/.test(id) ? id : null }
const idOf = (v: unknown): string | null => {
  const raw = v && typeof v === 'object' && !Array.isArray(v) ? (v as { id?: unknown }).id : v
  const id = text(raw)
  return id && /^\d{1,25}$/.test(id) ? id : null
}
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// ── drafts this gateway saw made ──────────────────────────────────────────────────────────────────────────────────

/** A run waits at most about a minute for Meta to read a draft: a draft older than this is not used. */
const DRAFT_TTL_MS = 15 * 60_000
const MAX_DRAFTS = 500
const drafts = new Map<string, number>()
const draftKey = (connectionId: string, run: string, id: string) => `${connectionId}:${run}:${id}`

/**
 * After a block-list draft upload Meta accepted: remember its id for this connection AND this run of a change (the kit's
 * own run id; review A9). An upload with no run id (not a Nexus change's run) is not remembered: no list is made from it.
 */
export function noteBlockListDraftMade(connectionId: string, run: string | undefined, answer: string, now = Date.now()): void {
  if (!run) return
  let id: string | null = null
  try { id = idOf(JSON.parse(answer)) } catch { id = null }
  if (!id) return
  for (const [key, at] of drafts) if (now - at > DRAFT_TTL_MS || drafts.size >= MAX_DRAFTS) drafts.delete(key)
  drafts.set(draftKey(connectionId, run, id), now)
}
/** The draft made in this run, used once (taken here: a second list from the same draft is refused). */
const takeDraft = (connectionId: string, run: string | undefined, id: string, now = Date.now()) => {
  if (!run) return false
  const key = draftKey(connectionId, run, id)
  const at = drafts.get(key)
  drafts.delete(key)
  return at !== undefined && now - at <= DRAFT_TTL_MS
}
export const __brandSafetyOwnerTest = { reset: () => drafts.clear() }

// ── the checks ────────────────────────────────────────────────────────────────────────────────────────────────────

interface Owner { connectionId: string; chosen: string | null; portfolio: string | null | undefined; read: MetaCheckRead; run?: string }

async function portfolioOf(owner: Owner): Promise<string | null> {
  if (owner.portfolio === undefined) owner.portfolio = await metaChosenPortfolioOf(owner.connectionId)
  return owner.portfolio
}

/** The chosen ad account's own business portfolio, not shared with another business in Nexus — or why not. */
async function ownPortfolioProblem(owner: Owner, id: string): Promise<OwnerProblem> {
  const portfolio = await portfolioOf(owner)
  if (!portfolio) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOTHING}the chosen ad account names no business portfolio, so Nexus changes no brand-safety list of one.` }
  if (id !== portfolio) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOTHING}business portfolio ${id} is not the chosen ad account's own.` }
  if (await metaPortfolioTakenByAnother(portfolio)) {
    return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOTHING}the chosen ad account's business portfolio is also used by another business in Nexus, so Nexus changes no brand-safety list there (it would be that business's too).` }
  }
  return null
}

const unconfirmed = (what: string, id: string, words: string | null): OwnerProblem => ({ code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOTHING}Nexus could not confirm that ${what} ${id} is this business's${words ? ` (Meta: ${words})` : ''}.` })

/**
 * A publisher block list: owned by the chosen ad account or its own portfolio; `apply`: or listed by Meta for the chosen
 * ad account (one page of 100).
 */
async function publisherBlockListProblem(owner: Owner, id: string, apply: boolean): Promise<OwnerProblem> {
  const what = 'publisher block list'
  const read = await owner.read(id, { fields: 'id,business_owner_id,owner_ad_account_id' })
  if (read.body) {
    if (accountOf(read.body.owner_ad_account_id) === owner.chosen) return null
    const business = idOf(read.body.business_owner_id)
    if (business && business === (await portfolioOf(owner)) && !(await metaPortfolioTakenByAnother(business))) return null
  }
  if (apply && owner.chosen) {
    const listed = await owner.read(`act_${owner.chosen}/publisher_block_lists`, { fields: 'id', limit: '100' })
    if (listed.body && Array.isArray(listed.body.data) && listed.body.data.some((row) => idOf(row) === id)) return null
    if (!listed.body) return unconfirmed(what, id, listed.words)
  }
  if (!read.body) return unconfirmed(what, id, read.words)
  return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOTHING}publisher block list ${id} is not owned by the chosen ad account or its business portfolio${apply ? ', and Meta does not list it for the chosen ad account' : ''}.` }
}

/** At most this many pages of 100 (Meta: at most 200 content block lists per business). */
const MAX_LIST_PAGES = 5

/** Every id of one Meta list, page by page (cursor `after`); `cut` when pages were left or Meta did not answer one. */
async function listedIds(owner: Owner, path: string): Promise<{ ids: Set<string>; cut: boolean; words: string | null }> {
  const ids = new Set<string>()
  let after: string | null = null
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const read = await owner.read(path, { fields: 'id', limit: '100', ...(after ? { after } : {}) })
    if (!read.body || !Array.isArray(read.body.data)) return { ids, cut: true, words: read.words }
    for (const row of read.body.data) { const id = idOf(row); if (id) ids.add(id) }
    const paging = plainObject(read.body.paging) ? read.body.paging : null
    const next = plainObject(paging?.cursors) ? text((paging!.cursors as Record<string, unknown>).after) : null
    if (!paging?.next || !next) return { ids, cut: false, words: null }
    after = next
  }
  return { ids, cut: true, words: `more than ${MAX_LIST_PAGES * 100} lists` }
}

/**
 * A content block list (review A1): one Meta lists among the chosen portfolio's own content block lists — a node of
 * another kind that also answers `business` (a catalog, a Page, a custom conversion) is never one.
 */
async function contentBlockListProblem(owner: Owner, id: string): Promise<OwnerProblem> {
  const portfolio = await portfolioOf(owner)
  const own = await ownPortfolioProblem(owner, portfolio ?? '')
  if (own) return own
  const listed = await listedIds(owner, `${portfolio}/content_block_lists`)
  if (listed.ids.has(id)) return null
  if (listed.cut) return unconfirmed('content block list', id, listed.words)
  return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOTHING}${id} is not one of the content block lists of the chosen ad account's business portfolio.` }
}

async function kindProblem(owner: Owner, kind: string, id: string, rule: string): Promise<OwnerProblem> {
  switch (kind) {
    case 'adaccount': {
      const account = accountOf(id)
      return account && account === owner.chosen ? null : { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOTHING}${id} is not the Meta ad account this business chose through this connection.` }
    }
    case 'business': return ownPortfolioProblem(owner, id)
    case 'publisherblocklist': return publisherBlockListProblem(owner, id, APPLY_ONLY_RULES.has(rule))
    case 'contentblocklist': return contentBlockListProblem(owner, id)
    case 'agency': {
      if (!/^\d{1,25}$/.test(id)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}a block list is shared with a business portfolio named by its id (digits).` }
      if (id === (await portfolioOf(owner))) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}${id} is this business's own portfolio: a block list is shared with another business.` }
      if (await metaPortfolioTakenByAnother(id)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}${id} is a business portfolio another business in Nexus uses: Nexus never shares a block list with another business of its own.` }
      return null
    }
    case 'blocklistdraft':
      return takeDraft(owner.connectionId, owner.run, id) ? null : { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}block-list draft ${id} is not the one Nexus uploaded in this same run of this change (a draft is used once).` }
    default:
      return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}a brand-safety change names an ad account, a business portfolio or a block list, not a ${kind}.` }
  }
}

/**
 * Why a brand-safety change (its path's object of the kind named, then every id inside its body) is refused for this
 * connection, or null.
 */
export async function metaBrandSafetyOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string, read: MetaCheckRead, run?: string): Promise<OwnerProblem> {
  if (!write.kinds?.includes(kind as never)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}${write.objectId} is named a ${WORD[kind] ?? kind}, which this change is not for.` }
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOTHING}this business has no Meta ad account chosen through this connection, so Nexus changes nothing on Meta.` }
  const owner: Owner = { connectionId, chosen, portfolio: undefined, read, run }
  const path = await kindProblem(owner, kind, write.objectId, write.rule)
  if (path) return path
  return bodyIdsProblem(owner, write.ids ?? [], write.rule)
}

async function bodyIdsProblem(owner: Owner, ids: readonly MetaWriteBodyId[], rule: string): Promise<OwnerProblem> {
  if (ids.length > 150) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}a change names at most 150 objects inside its body.` }
  for (const inner of ids) {
    const problem = await kindProblem(owner, inner.kind, inner.id, rule)
    if (problem) return { code: problem.code, sentence: problem.sentence.replace(new RegExp(`^${NOTHING}`), `${NOTHING}inside this change, `) }
  }
  return null
}

/**
 * Q7 — an ad set's brand-safety change: ONE live read of its account, its kind's two fields and its targeting; the ad set
 * must be of the chosen ad account and an ad set; the targeting sent differs from the live one only in the brand-safety
 * keys; each block list it newly excludes is one the chosen ad account may use.
 */
export async function metaTargetingOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string | undefined, read: MetaCheckRead): Promise<OwnerProblem> {
  const id = write.objectId
  if (kind !== 'adsettargeting' || !write.targeting) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}a targeting change of ${id} names it an ad set's targeting.` }
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOTHING}this business has no Meta ad account chosen through this connection, so Nexus changes nothing on Meta.` }
  const answer = await read(id, { fields: 'account_id,optimization_goal,billing_event,targeting' })
  if (!answer.body) {
    if (/nonexisting field/i.test(answer.words ?? '')) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}${id} is not an ad set Nexus can confirm (Meta: ${answer.words}); a brand-safety targeting change writes only an ad set.` }
    return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOTHING}Nexus could not read ad set ${id}'s account and live targeting${answer.words ? ` (Meta: ${answer.words})` : ''}, so it sends no targeting.` }
  }
  const account = accountOf(answer.body.account_id)
  if (!account) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOTHING}Nexus could not confirm which ad account ${id} belongs to.` }
  if (account !== chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOTHING}object ${id} is not of the Meta ad account this business chose through this connection.` }
  if (!text(answer.body.optimization_goal) || !text(answer.body.billing_event)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}${id} is not an ad set Nexus can confirm; a brand-safety targeting change writes only an ad set.` }
  // Review A7 — a value the gateway scrubbed (a token shape → "[removed]") is not Meta's own: never sent back as if it were.
  if (answer.scrubbed) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}Meta's answer about ad set ${id} held something shaped like a token, which Nexus removed, so Nexus cannot send its targeting back exactly (change it in Ads Manager).` }
  const live = answer.body.targeting
  if (!plainObject(live)) return { code: 'META_ACCOUNT_UNCONFIRMED', sentence: `${NOTHING}Meta answered no targeting for ad set ${id}, so Nexus cannot keep the rest of it exactly as it is.` }
  if (holdsInexactNumber(live)) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}ad set ${id}'s live targeting holds a number Nexus cannot carry exactly, so Nexus sends no targeting for it (change it in Ads Manager).` }
  const outside = targetingOutsideProblem(live, write.targeting.sent, write.targeting.keys)
  if (outside) return { code: 'META_WRITE_NOT_ALLOWED', sentence: `${NOTHING}${outside} (ad set ${id}).` }
  const listed = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const before = new Set(listed(live.excluded_publisher_list_ids))
  const added = listed(write.targeting.sent.excluded_publisher_list_ids).filter((listId) => !before.has(listId))
  if (!added.length) return null
  const owner: Owner = { connectionId, chosen, portfolio: undefined, read }
  for (const listId of added) {
    const problem = await publisherBlockListProblem(owner, listId, true)
    if (problem) return { code: problem.code, sentence: problem.sentence.replace(new RegExp(`^${NOTHING}`), `${NOTHING}inside this change, `) }
  }
  return null
}

/** BS-033 — the CSV export of a content block list: the list must be the chosen portfolio's. */
export async function metaExportOwnerProblem(connectionId: string, contentBlockListId: string, read: MetaCheckRead): Promise<OwnerProblem> {
  const chosen = await metaChosenAdAccountOf(connectionId)
  if (!chosen) return { code: 'META_ACCOUNT_NOT_CHOSEN', sentence: `${NOTHING}this business has no Meta ad account chosen through this connection.` }
  return contentBlockListProblem({ connectionId, chosen, portfolio: undefined, read }, contentBlockListId)
}
