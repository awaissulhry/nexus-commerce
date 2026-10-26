/**
 * Meta step 41 (2026-10-25) — the gateway's own check of a people or partner access change (gateway.ts hands every write a
 * step-41 rule judged here, by the rule, never by the kind alone). Nothing is sent to Meta unless every part of it holds,
 * with the gateway's OWN reads (a caller that skipped set-meta-user-access / set-meta-partner-access still sends nothing
 * the tools would refuse). Reads only, through the gateway; a read that is refused, not a success, or cut (more pages than
 * Nexus reads, or a next page Meta gives no cursor for: review A-N1) refuses the change. And ONE access change of an asset
 * at a time, from this check through its send (metaAccessLock, review A-SF2): two removals of two admins cannot both pass.
 *
 *   the object (its kind)
 *     accessadaccount  `act_<id>`: THE ad account this business chose through this connection
 *     accesspage       the business's CHOSEN Facebook Page, owned by the chosen ad account's business portfolio (its
 *                      owned_pages: "the business id must be the id of the business that owns the page")
 *     accessinstagram  the chosen Instagram account's BUSINESS ASSET (the portfolio's owned_instagram_assets row whose
 *                      ig_user_id is the chosen account) — never the IG user id, never a client's asset
 *     accessportfolio  the chosen ad account's business portfolio itself, used by no other Nexus business (the end of a
 *                      relationship cuts every asset of the portfolio, so it would be that business's change too)
 *     accesspixel      a dataset (pixel) of the chosen ad account that no other Nexus business uses and its portfolio owns
 *                      (live-access-change.ts liveAccessPixel: step 32's ownSignalPixel + owner_business) — its people,
 *                      its partners (the removal on the query) and its server-event businesses: the WHOLE list, never the
 *                      portfolio itself or another Nexus business's (sent, or on Meta's list now, read under the lock), and
 *                      never when Meta's list moved since the change was built
 *   a person (`user`, the user rules)
 *     never Nexus's own system user (`me`, read now): its fewer tasks or none would cut Nexus off; a SYSTEM user is changed
 *     only when `me` is one of the portfolio's system users (review A-N2: else the two could be one); a person given tasks is
 *     a business user or system user of the portfolio (business_users, system_users) — and when another Nexus business uses
 *     the portfolio too (or Nexus cannot tell: review A-N3), never a system user; a person taken off is assigned now (never
 *     on a dataset: Meta has no removal there); and
 *     the LAST ADMIN is never removed or lowered (meta/meta-access-lists.ts metaLastAdminProblem: a target whose tasks Nexus
 *     cannot judge counts as an admin, review A-MF2). A Page's or Instagram asset's `business` is the portfolio itself.
 *   a partner (`business`, the partner and portfolio rules)
 *     never the portfolio itself, never a portfolio another Nexus business uses (nexus_meta_links_taken PORTFOLIO); a partner
 *     taken off or a relationship ended is listed now (the asset's agencies; the portfolio's agencies or clients); and
 *     Nexus's own system user is a system user of THIS portfolio (else its access may come through that partner, and
 *     taking the partner off could cut Nexus off — and the Meta app with it: an app is installed for a system user of its
 *     own portfolio, guides/system-users). Ending a relationship (review A-MF1, fail closed): the portfolio is unshared in
 *     Nexus (its link and its own ad accounts); Meta lists the ad accounts and Pages the relationship holds, readably, and
 *     none is another Nexus business's; a CLIENT relationship also needs the chosen Page and Instagram account to be the
 *     portfolio's own, and no Instagram account the portfolio holds as a client to be another Nexus business's.
 * Checked 2026-10-25: ad-account/assigned_users and page/assigned_users (`business` required on a read), the
 * instagram-accounts guide (owned_instagram_assets / client_instagram_assets: InstagramBusinessAsset id, ig_user_id — SDK),
 * business/owned_pages, business/owned_ad_accounts, business/business_users and system_users, ad-account/agencies,
 * page/agencies, business/agencies and business/clients (adaccount_permissions, page_permissions).
 */
import { randomUUID } from 'node:crypto'
import type { MetaJudgedWrite } from './meta-calls.js'
import { chosenBusiness, type MetaOwnerIo, type MetaOwnerProblem } from './meta-optimize-owner.js'
import { metaChosenInstagramOf, metaChosenPageOf } from './account.js'
import { rateRedis } from './rate.js'
import { takenIds } from '../marketing/meta-ads/taken.js'
import { metaLastAdminProblem, metaPermissionIds, type MetaAccessAsset, type MetaAssignee } from '../meta/meta-access-lists.js'
import type { MetaAccessKind } from './meta-access-rules.js'

const NOT_CHOSEN = 'META_ACCOUNT_NOT_CHOSEN'
const UNCONFIRMED = 'META_ACCOUNT_UNCONFIRMED'
const NOT_ALLOWED = 'META_WRITE_NOT_ALLOWED'
const say = (code: string, sentence: string): MetaOwnerProblem => ({ code, sentence: `Nothing was sent to Meta: ${sentence}` })
const idOf = (v: unknown): string | null => {
  const raw = v && typeof v === 'object' ? (v as Record<string, unknown>).id : v
  return (typeof raw === 'string' || typeof raw === 'number') && /^\d{1,25}$/.test(String(raw)) ? String(raw) : null
}
const isProblem = (v: unknown): v is MetaOwnerProblem => !!v && typeof v === 'object' && 'code' in v && 'sentence' in v
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
/** How many pages of 100 the checks read of a list. */
const PAGES = 5

/**
 * Every row of a list (these fields), page by page up to `pages`; null when a page could not be read, more are left, or
 * Meta says there is a next page without the cursor to read it (review A-N1: never taken for the end of the list).
 */
export async function listedRows(io: MetaOwnerIo, path: string, query: Record<string, string>, pages = PAGES): Promise<Record<string, unknown>[] | null> {
  const rows: Record<string, unknown>[] = []
  let after: string | null = null
  for (let page = 0; page < pages; page++) {
    const body = await io.read(path, { limit: '100', ...query, ...(after ? { after } : {}) })
    if (!body || !Array.isArray(body.data)) return null
    for (const row of body.data) if (row && typeof row === 'object') rows.push(row as Record<string, unknown>)
    const paging = body.paging as { cursors?: { after?: unknown }; next?: unknown } | undefined
    if (!paging?.next) return rows
    if (typeof paging.cursors?.after !== 'string' || !paging.cursors.after) return null
    after = paging.cursors.after
  }
  return null
}
/** The ids of a list read in full (listedRows), or null. */
export async function listedIdSet(io: MetaOwnerIo, path: string, query: Record<string, string> = {}, pages = PAGES): Promise<Set<string> | null> {
  const rows = await listedRows(io, path, { fields: 'id', ...query }, pages)
  return rows ? new Set(rows.map(idOf).filter((id): id is string => !!id)) : null
}

/** The chosen Instagram account's business asset in the portfolio's OWN Instagram assets, or why not. */
async function ownInstagramAsset(io: MetaOwnerIo, portfolio: string, instagramId: string): Promise<string | MetaOwnerProblem> {
  const rows = await listedRows(io, `${portfolio}/owned_instagram_assets`, { fields: 'id,ig_user_id' })
  if (!rows) return say(UNCONFIRMED, 'Nexus could not read the business portfolio\'s own Instagram accounts.')
  const row = rows.find((r) => idOf(r.ig_user_id) === instagramId)
  const asset = row ? idOf(row) : null
  return asset ?? say(NOT_CHOSEN, 'the chosen Instagram account is not one of the business portfolio\'s own Instagram accounts (a client\'s account is its owner\'s to share).')
}

/** The portfolio's business users and system users (ids), or null. */
async function portfolioPeople(io: MetaOwnerIo, portfolio: string): Promise<{ persons: Set<string>; systemUsers: Set<string> } | null> {
  const persons = await listedIdSet(io, `${portfolio}/business_users`, {}, 10)
  const systemUsers = await listedIdSet(io, `${portfolio}/system_users`, {}, 10)
  return persons && systemUsers ? { persons, systemUsers } : null
}

/**
 * Review A-N3, re-review R-1 — is the portfolio another Nexus business's too? Its link names it (PORTFOLIO), or that business
 * chose one of the portfolio's OWN ad accounts, Pages or Instagram accounts (owned_ad_accounts, owned_pages,
 * owned_instagram_assets ig_user_id — each read in full): a link saved without its portfolio, or a business that reaches an
 * asset of this portfolio through a partner, fails closed. Null: Nexus cannot tell (counted as shared wherever it matters).
 */
export async function sharedPortfolio(io: MetaOwnerIo, portfolio: string, chosen: string): Promise<boolean | null> {
  if ((await takenIds('PORTFOLIO', [portfolio])).has(portfolio)) return true
  const accounts = await listedRows(io, `${portfolio}/owned_ad_accounts`, { fields: 'account_id' })
  const pages = await listedRows(io, `${portfolio}/owned_pages`, { fields: 'id' })
  const instagram = await listedRows(io, `${portfolio}/owned_instagram_assets`, { fields: 'id,ig_user_id' })
  if (!accounts || !pages || !instagram) return null
  const accountIds = accounts.map((r) => String(r.account_id ?? r.id ?? '').replace(/^act_/, '')).filter((id) => /^\d{1,25}$/.test(id) && id !== chosen)
  if ((await takenIds('AD_ACCOUNT', accountIds)).size) return true
  if ((await takenIds('PAGE', pages.map(idOf).filter((x): x is string => !!x))).size) return true
  return (await takenIds('INSTAGRAM', instagram.map((r) => idOf(r.ig_user_id)).filter((x): x is string => !!x))).size > 0
}

/**
 * Why a step-41 change of this object is refused for this connection, or null. `query`: the judged query of a DELETE that
 * carries its keys there (a dataset's partner removal, `inQuery`) — its write has no body.
 */
export async function metaAccessOwnerProblem(connectionId: string, write: MetaJudgedWrite, kind: string | undefined, io: MetaOwnerIo, query?: URLSearchParams, expectedIds?: readonly string[]): Promise<MetaOwnerProblem | null> {
  if (write.check) return say(NOT_ALLOWED, 'Meta documents no check (validate_only) for a people or partner access change.')
  if (!kind || !(write.kinds as readonly string[] | undefined)?.includes(kind)) return say(NOT_ALLOWED, `this access change is not one of a ${kind ?? 'named kind of object'}.`)
  const chosen = await io.chosenAdAccount()
  if (!chosen) return say(NOT_CHOSEN, 'this business has no Meta ad account chosen through this connection, so Nexus changes no one\'s access on Meta.')
  const portfolio = await chosenBusiness(io, chosen)
  if (!portfolio) return say(UNCONFIRMED, 'Nexus could not read the business portfolio of the chosen ad account (people and partners belong to a portfolio).')
  const id = write.objectId
  const params = write.body ? new URLSearchParams(write.body) : new URLSearchParams(query ?? '')
  const me = async (): Promise<string | MetaOwnerProblem> => idOf(await io.read('me', { fields: 'id' })) ?? say(UNCONFIRMED, 'Nexus could not read which system user it is, so it changes no one\'s access.')

  // ── the object ──
  let asset: MetaAccessAsset | null = null
  switch (kind as MetaAccessKind) {
    case 'accessadaccount':
      if (id !== `act_${chosen}`) return say(NOT_CHOSEN, 'an access change of an ad account goes only to the Meta ad account this business chose through this connection.')
      asset = 'ad-account'
      break
    case 'accesspage': {
      const page = await metaChosenPageOf(connectionId)
      if (!page || id !== page) return say(NOT_CHOSEN, `${id} is not the Facebook Page this business chose through this connection.`)
      const owned = await listedIdSet(io, `${portfolio}/owned_pages`)
      if (!owned) return say(UNCONFIRMED, 'Nexus could not read the business portfolio\'s own Pages.')
      if (!owned.has(page)) return say(NOT_CHOSEN, 'the chosen Facebook Page is not one of the business portfolio\'s own Pages (a client\'s Page is its owner\'s to share).')
      asset = 'page'
      break
    }
    case 'accessinstagram': {
      const instagram = await metaChosenInstagramOf(connectionId)
      if (!instagram) return say(NOT_CHOSEN, 'this business has chosen no Instagram account through this connection.')
      const own = await ownInstagramAsset(io, portfolio, instagram)
      if (isProblem(own)) return own
      if (id !== own) return say(NOT_CHOSEN, `${id} is not the business asset of the Instagram account this business chose.`)
      asset = 'instagram'
      break
    }
    case 'accessportfolio': {
      if (id !== portfolio) return say(NOT_CHOSEN, `${id} is not the business portfolio of the ad account this business chose.`)
      if (await sharedPortfolio(io, portfolio, chosen) !== false) return say(NOT_CHOSEN, 'another business in Nexus uses this business portfolio (or Nexus could not tell that none does): ending one of its relationships would cut that business\'s assets too, so Nexus ends none.')
      break
    }
    case 'accesspixel': {
      // Owner option 1 — a dataset on the chosen ad account no other Nexus business uses (step 11's verdict, step 32's rule)
      // and owned by the chosen ad account's portfolio (its owner_business): the tool's own check, run again here.
      const { metaChosenAccount, MetaLiveRefusal } = await import('../marketing/meta-ads/live.js')
      const { MetaReadError } = await import('../marketing/meta-ads/errors.js')
      const { liveAccessPixel } = await import('../marketing/meta-ads/live-access-change.js')
      try {
        await liveAccessPixel(await metaChosenAccount(connectionId), id, portfolio)
      } catch (err) {
        if (err instanceof MetaLiveRefusal) return say(NOT_CHOSEN, err.message)
        return say(UNCONFIRMED, `Nexus could not confirm dataset ${id} is one of the chosen ad account's own (${err instanceof MetaReadError || err instanceof Error ? err.message : String(err)}).`)
      }
      asset = 'pixel'
      break
    }
    default:
      return say(NOT_ALLOWED, `${id} is not an object Nexus checks for an access change.`)
  }

  // ── a dataset's server-event businesses (SG-014: the WHOLE list) ──
  if (write.rule === 'access.accesspixel.server_events') {
    let ids: string[] = []
    try { ids = JSON.parse(params.get('server_events_business_ids') ?? '[]') as string[] } catch { return say(NOT_ALLOWED, 'server_events_business_ids is a JSON list.') }
    if (ids.includes(portfolio)) return say(NOT_ALLOWED, 'the dataset\'s own business portfolio is not one of the businesses allowed to send its server events: it owns them.')
    if ((await takenIds('PORTFOLIO', ids)).size) return say(NOT_CHOSEN, 'the list names a business portfolio another business in Nexus uses: Nexus never lets it send this dataset\'s server events (nor keeps it on the list).')
    // Option-1 review SF1 / SF2 / N3 — the list Meta holds NOW, read in full under the asset's lock: never one that holds the
    // portfolio itself or another Nexus business's portfolio (a caller that skipped the tool could take it off), and never
    // one that moved since the change was built (the whole list would drop what was added in Meta meanwhile).
    const current = await listedRows(io, `${id}/server_events_permitted_business`, { fields: 'id' })
    if (!current) return say(UNCONFIRMED, `Nexus could not read in full the businesses allowed to send dataset ${id}'s server events.`)
    const now = [...new Set(current.map(idOf).filter((x): x is string => !!x))].sort()
    if (now.includes(portfolio)) return say(NOT_ALLOWED, 'Meta lists the dataset\'s own business portfolio among its server-event businesses: Nexus does not change that list (it would take the portfolio off, and its undo could never put it back).')
    if ((await takenIds('PORTFOLIO', now)).size) return say(NOT_CHOSEN, 'the dataset\'s server events may be sent now by a business portfolio another business in Nexus uses: Nexus does not change that list.')
    if (!expectedIds) return say(NOT_ALLOWED, 'a server-event change names the list it was built on, so the gateway can tell whether Meta\'s moved.')
    if (JSON.stringify(now) !== JSON.stringify([...new Set(expectedIds)].sort())) return say(NOT_ALLOWED, 'the dataset\'s server-event businesses changed in Meta since this change was built: the whole list would drop what was added. Ask again with the list as it is now.')
    // Nexus's own system user is the portfolio's: a business taken off the list is never the one Nexus sends through.
    const own = await me()
    if (isProblem(own)) return own
    const systemUsers = await listedIdSet(io, `${portfolio}/system_users`, {}, 10)
    if (!systemUsers) return say(UNCONFIRMED, 'Nexus could not read the system users of the chosen business portfolio.')
    return systemUsers.has(own) ? null : say(NOT_ALLOWED, 'Nexus\'s own system user is not a system user of the dataset\'s business portfolio, so its server events may come through one of these businesses: Nexus changes no server-event business here.')
  }

  // ── a person ──
  if (/\.user\.(set|remove)$/.test(write.rule)) {
    const user = params.get('user') ?? ''
    const own = await me()
    if (isProblem(own)) return own
    if (user === own) return say(NOT_ALLOWED, `${user} is Nexus's own system user: Nexus never changes its own access (fewer tasks or none would cut Nexus off). A person does that in Meta Business settings, if it is meant.`)
    if (params.has('business') && params.get('business') !== portfolio) return say(NOT_CHOSEN, 'the business named with a Page\'s or Instagram account\'s people is the portfolio that owns it: the chosen ad account\'s.')
    const people = await portfolioPeople(io, portfolio)
    if (!people) return say(UNCONFIRMED, 'Nexus could not read the people and system users of the chosen business portfolio.')
    // Review A-N2 — a system user (or someone Nexus cannot place) is changed only when Nexus's own is the portfolio's.
    if (!people.persons.has(user) && !people.systemUsers.has(own)) return say(NOT_ALLOWED, `Nexus's own system user is not listed among the business portfolio's system users, so Nexus cannot be sure ${user} is not itself: it changes no system user's access here.`)
    const node = id
    const rows = await listedRows(io, `${node}/assigned_users`, { business: portfolio, fields: 'id,tasks' })
    if (!rows) return say(UNCONFIRMED, `Nexus could not read who holds tasks on ${node} (all of them), so it changes no one's access there.`)
    const assigned: MetaAssignee[] = rows.map((r) => ({ id: idOf(r) ?? '', tasks: strings(r.tasks) })).filter((r) => !!r.id)
    const setting = write.rule.endsWith('.user.set')
    if (setting) {
      if (!people.persons.has(user) && !people.systemUsers.has(user)) return say(NOT_CHOSEN, `${user} is not a person or system user of the chosen business portfolio: Nexus gives access only to them.`)
      if (people.systemUsers.has(user) && await sharedPortfolio(io, portfolio, chosen) !== false) return say(NOT_ALLOWED, `${user} is a system user, and another business in Nexus uses this business portfolio (or Nexus could not tell that none does): Nexus cannot tell whose system user it is, so it gives it no access.`)
    } else if (!assigned.some((a) => a.id === user)) {
      return say(NOT_ALLOWED, `${user} holds no task on ${node}: nothing to take off.`)
    }
    let after: string[] | null = null
    if (setting) { try { after = JSON.parse(params.get('tasks') ?? '[]') as string[] } catch { after = [] } }
    const floor = metaLastAdminProblem(asset!, assigned, people.persons, user, after)
    return floor ? say(NOT_ALLOWED, floor) : null
  }

  // ── a partner, or a relationship ──
  const partner = params.get('business') ?? ''
  if (partner === portfolio) return say(NOT_ALLOWED, 'that is this business\'s own business portfolio: access is shared with (or taken from) a partner, never its owner.')
  if ((await takenIds('PORTFOLIO', [partner])).has(partner)) return say(NOT_CHOSEN, `business portfolio ${partner} is used by another business in Nexus: Nexus never changes what it shares with it or takes from it.`)
  if (write.rule.endsWith('.partner.share')) return null
  // A partner taken off, a relationship ended: Nexus's own system user must be this portfolio's (not reached through it).
  const own = await me()
  if (isProblem(own)) return own
  const systemUsers = await listedIdSet(io, `${portfolio}/system_users`, {}, 10)
  if (!systemUsers) return say(UNCONFIRMED, 'Nexus could not read the system users of the chosen business portfolio.')
  if (!systemUsers.has(own)) return say(NOT_ALLOWED, 'Nexus\'s own system user is not a system user of the chosen business portfolio, so its access (and its app\'s) may come through a partner: Nexus takes no partner off and ends no relationship that could cut itself off. A person does it in Meta Business settings › Partners, if it is meant.')
  if (write.rule.endsWith('.partner.remove')) {
    const listed = await listedIdSet(io, `${id}/agencies`)
    if (!listed) return say(UNCONFIRMED, `Nexus could not read who ${id} is shared with.`)
    return listed.has(partner) ? null : say(NOT_ALLOWED, `${id} is not shared with business portfolio ${partner}: nothing to take off.`)
  }
  const client = write.rule === 'access.portfolio.client.end'
  // Review A-MF1 — the relationship's own row, with the ad accounts and Pages Meta lists for it, read in full and readable.
  const rows = await listedRows(io, `${portfolio}/${client ? 'clients' : 'agencies'}`, { fields: 'id,adaccount_permissions,page_permissions' })
  if (!rows) return say(UNCONFIRMED, `Nexus could not read the business portfolio's ${client ? 'clients' : 'agencies'} with what each relationship holds.`)
  const row = rows.find((r) => idOf(r) === partner)
  if (!row) return say(NOT_ALLOWED, `business portfolio ${partner} is not ${client ? 'a client' : 'an agency'} of the chosen business portfolio.`)
  const adAccounts = metaPermissionIds(row.adaccount_permissions)
  const pages = metaPermissionIds(row.page_permissions)
  if (!adAccounts || !pages) return say(UNCONFIRMED, 'Meta did not list the ad accounts and Pages this relationship holds in a form Nexus can read, so Nexus cannot confirm ending it cuts no other business in Nexus.')
  if ((await takenIds('AD_ACCOUNT', adAccounts)).size || (await takenIds('PAGE', pages)).size) return say(NOT_ALLOWED, 'the relationship holds an ad account or Page another business in Nexus uses: ending it could cut that business off.')
  if (client) {
    // The chosen Page and Instagram account must be the portfolio's own: a client's would go with the relationship.
    const page = await metaChosenPageOf(connectionId)
    if (page) {
      const owned = await listedIdSet(io, `${portfolio}/owned_pages`)
      if (!owned) return say(UNCONFIRMED, 'Nexus could not read the business portfolio\'s own Pages.')
      if (!owned.has(page)) return say(NOT_ALLOWED, 'the chosen Facebook Page is not the business portfolio\'s own: ending a client relationship could take it away from Nexus.')
    }
    const instagram = await metaChosenInstagramOf(connectionId)
    if (instagram) {
      const ownIg = await ownInstagramAsset(io, portfolio, instagram)
      if (isProblem(ownIg)) return ownIg.code === UNCONFIRMED ? ownIg : say(NOT_ALLOWED, 'the chosen Instagram account is not the business portfolio\'s own: ending a client relationship could take it away from Nexus.')
    }
    // Meta names no Instagram account for a relationship: none this portfolio holds as a client may be another Nexus business's.
    const clientIg = await listedRows(io, `${portfolio}/client_instagram_assets`, { fields: 'id,ig_user_id' })
    if (!clientIg) return say(UNCONFIRMED, 'Nexus could not read in full the Instagram accounts this portfolio holds as a client.')
    const igIds = clientIg.map((r) => idOf(r.ig_user_id)).filter((x): x is string => !!x)
    if ((await takenIds('INSTAGRAM', igIds)).size) return say(NOT_ALLOWED, 'this portfolio holds, as a client, an Instagram account another business in Nexus uses: ending a client relationship could cut that business off.')
  }
  return null
}

// ── one access change of an asset at a time (review A-SF2) ─────────────────────────────────────────────────────────────

/**
 * How long a lock lives. The owner check makes up to about 32 reads, and each may wait up to 30 s for a rate slot before
 * its own 20 s, so a check under heavy throttling can outlast any fixed time: the lock is CONFIRMED (still this change's,
 * then extended) right before the send, and a lock that lapsed — whoever took it since — refuses the change (re-review R-4).
 */
const LOCK_MS = 300_000
const LOCK_LUA = "if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 else return 0 end"
const UNLOCK_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"
const CONFIRM_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end"
const memoryLocks = new Map<string, { token: string; until: number }>()
let memoryOnly = false

/** Tests: keep the locks in this process's memory (and start empty). */
export const __metaAccessLockTest = {
  useMemory() { memoryOnly = true; memoryLocks.clear() },
  reset() { memoryOnly = false; memoryLocks.clear() },
}

/** A lock held: `confirm` (still this change's? then extended) right before the send, `release` after it. */
export interface MetaAccessLock { confirm: () => Promise<boolean>; release: () => Promise<void> }

/**
 * Take the lock of ONE asset's access (`objectId`) for this connection, from the owner check through the send, so two
 * approved changes of the same asset (two admins removed at once) never both pass the last-admin floor. Shared through the
 * app's Redis; this process's memory when no Redis is configured. Null (fail closed): another change of the asset holds it,
 * or Redis is configured but not ready.
 */
export async function metaAccessLock(connectionId: string, objectId: string): Promise<MetaAccessLock | null> {
  const key = `gw:metaaccess:${connectionId}:${objectId}`
  const token = randomUUID()
  const redis = memoryOnly ? null : rateRedis()
  if (redis) {
    try {
      if (Number(await redis.eval(LOCK_LUA, 1, key, token, LOCK_MS)) !== 1) return null
    } catch {
      return null
    }
    return {
      confirm: async () => { try { return Number(await redis.eval(CONFIRM_LUA, 1, key, token, LOCK_MS)) === 1 } catch { return false } },
      release: async () => { try { await redis.eval(UNLOCK_LUA, 1, key, token) } catch { /* it expires by itself */ } },
    }
  }
  if (!memoryOnly && (process.env.REDIS_URL?.trim() || process.env.REDIS_HOST?.trim())) return null
  const held = memoryLocks.get(key)
  if (held && held.until > Date.now()) return null
  memoryLocks.set(key, { token, until: Date.now() + LOCK_MS })
  return {
    confirm: async () => {
      const now = memoryLocks.get(key)
      if (!now || now.token !== token || now.until <= Date.now()) return false
      now.until = Date.now() + LOCK_MS
      return true
    },
    release: async () => { if (memoryLocks.get(key)?.token === token) memoryLocks.delete(key) },
  }
}
