/**
 * Meta ads step 43 (2026-10-26) — the live reads behind the business-asset guides (business-assets-admin.ts): ONLY reads
 * that are merged already — step 2's ad account lists of the chosen portfolio (live.ts liveAdAccounts), step 4's asset lists
 * (live-business.ts assetsView: Pages, Instagram accounts, apps, asset groups, each row masked by step 4's one rule),
 * step 3's read of the ad accounts allowed to advertise for the chosen Instagram account (the same path and keys), step 41's
 * account read (status, disable reason) and step 42's portfolio name; for set-meta-billing step 3's credit lines, invoice
 * groups, their ad accounts and the chosen ad account's own invoice group and payment method (live-account.ts), and step 41's
 * portfolio check (its own ad accounts, Pages and Instagram accounts). Every call is a GET through the gateway; nothing
 * here writes, stores or remembers anything (D1: the Owner makes these changes in Meta's screens).
 *
 * One business at a time: when another business in Nexus uses an ad account of the chosen portfolio, no asset guide is
 * given and nothing is read for it (bringing an asset in or taking one out would change that business's portfolio too).
 * An asset another business in Nexus picked, or whose owner portfolio it uses, gets no steps at all.
 */
import { MetaReadError } from './errors.js'
import { liveAdAccounts, metaChosenAccount, MetaLiveRefusal, type AdAccountList, type MetaChosenAccount } from './live.js'
import { assetsView, chosenPortfolio, portfolioShared, type AssetView } from './live-business.js'
import { portfolioName } from './live-business-admin.js'
import { liveAccessState, livePortfolioOwnAssets } from './live-access-change.js'
import { billingView, creditLines, DISABLE_REASON_WORDS } from './live-account.js'
import { listPaged, part } from './paging.js'
import { takenIds, type MetaTakenProduct } from './taken.js'
import { AD_ACCOUNT_STATUS_WORDS, metaAdAccountId } from '../../cx/connectors/meta/discovery.js'
import {
  appealGuide, assetGuide, billingGuide, newAdAccountGuide, removeGuide,
  type AppealAsk, type AssetAsk, type AssetLists, type BillingAsk, type BillingLive, type InvoiceGroupSeen, type ListedAsset, type NewAdAccountAsk, type RemoveAsk,
} from './business-assets-admin.js'
import type { AdminGuide } from './business-admin.js'

/** How many rows a guide reads of each list (step 4's cap): a target not found in a list Meta cut is refused, never guessed. */
const MAX_ROWS = 500

export const ASSETS_SHARED = 'Another business in Nexus uses an ad account of this Meta business portfolio, so Nexus gives no steps to bring assets into it or take them out, and reads nothing for them: that would change that business\'s portfolio too. A person with full access to the portfolio decides it in Meta Business settings › Accounts.'

/** The chosen ad account and its portfolio — refused in words, before any Meta call, when another business in Nexus uses that portfolio. */
async function assetScope(connectionId: string | null | undefined): Promise<{ account: MetaChosenAccount; portfolioId: string }> {
  const account = await metaChosenAccount(connectionId)
  const portfolioId = chosenPortfolio(account)
  if (await portfolioShared(portfolioId)) throw new MetaLiveRefusal(ASSETS_SHARED)
  return { account, portfolioId }
}

const done = (out: AdminGuide | { refusal: string }): AdminGuide => {
  if ('refusal' in out) throw new MetaLiveRefusal(out.refusal)
  return out
}
const isTaken = async (product: MetaTakenProduct, id: string | undefined) => (id ? (await takenIds(product, [id])).has(id) : false)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

// ── the ad account lists (step 2's) ──────────────────────────────────────────────────────────────────────────────

const AD_ACCOUNT_EDGE_LIST: Readonly<Record<string, string>> = {
  owned_ad_accounts: 'owned', client_ad_accounts: 'client', pending_owned_ad_accounts: 'pending-owned', pending_client_ad_accounts: 'pending-client',
}

/**
 * The portfolio's ad accounts, each with what Nexus may say about it: another business's (asset or owner portfolio) taken;
 * the portfolio's own named; a partner's named only when Meta names its owner portfolio and no other business in Nexus uses
 * it (step 4's rule), else unknown.
 */
async function adAccountLists(account: MetaChosenAccount, portfolioId: string, lists: readonly AdAccountList[]): Promise<AssetLists> {
  const rows: ListedAsset[] = []
  const unread: string[] = []
  let cut = false
  const raw: Array<{ id: string; list: string; name: string | null; owner: string | null; taken: boolean; requestId: string | null; chosenHere: boolean }> = []
  for (const list of lists) {
    const read = await part(() => liveAdAccounts({ connectionId: account.connectionId, list, maxRows: MAX_ROWS }))
    if (!read.value) { unread.push(`${list} ad accounts: ${read.notRead}`); continue }
    cut = cut || read.value.more
    for (const item of read.value.items) {
      const r = item as typeof item & { businessId?: string | null; name?: string | null }
      raw.push({ id: r.adAccountId, list: AD_ACCOUNT_EDGE_LIST[r.edge] ?? r.edge, name: r.takenByAnotherBusiness ? null : r.name ?? null, owner: r.businessId ?? null, taken: r.takenByAnotherBusiness === true, requestId: r.requestId ?? null, chosenHere: r.chosenHere === true })
    }
  }
  const owners = await takenIds('PORTFOLIO', [...new Set(raw.map((r) => r.owner).filter((o): o is string => !!o && o !== portfolioId))])
  for (const r of raw) {
    const seen = r.taken || (!!r.owner && owners.has(r.owner)) ? 'taken' as const
      : r.chosenHere || r.list === 'owned' || (!!r.owner && r.owner !== portfolioId) ? 'named' as const
        : 'unknown' as const
    rows.push({ id: r.id, list: r.list, name: seen === 'named' ? r.name : null, seen, requestId: r.requestId, chosenHere: r.chosenHere })
  }
  return { rows, cut, unread }
}

// ── step 4's asset lists, as the guides need them ────────────────────────────────────────────────────────────────

type ViewOut = { lists: Array<{ list: string; edge: string; items: Array<Record<string, unknown>>; more: boolean }>; missing: Array<{ part: string; sentence: string }> }

/** Which list of a guide each of step 4's edges is (an Instagram business asset counts as its account). */
const EDGE_LIST: Readonly<Record<string, string>> = {
  owned_pages: 'owned', client_pages: 'client', pending_owned_pages: 'pending-owned', pending_client_pages: 'pending-client',
  owned_instagram_accounts: 'owned', owned_instagram_assets: 'owned', client_instagram_accounts: 'client', client_instagram_assets: 'client',
  owned_apps: 'owned', client_apps: 'client', pending_client_apps: 'pending',
  business_asset_groups: 'owned', client_business_asset_groups: 'client',
}
const ID_KEY: Partial<Record<AssetView, string>> = { pages: 'pageId', instagram: 'instagramId', apps: 'appId', 'asset-groups': 'assetGroupId' }
const NAME_KEY: Partial<Record<AssetView, string>> = { pages: 'name', instagram: 'username', apps: 'name', 'asset-groups': 'name' }

/** Step 4's lists of a view (each masked by its one rule: takenByAnotherBusiness true / false / null), as guide rows. */
async function viewLists(account: MetaChosenAccount, view: AssetView, lists: readonly string[]): Promise<AssetLists> {
  const rows: ListedAsset[] = []
  const unread: string[] = []
  let cut = false
  const seen = new Set<string>()
  for (const list of lists) {
    const read = await part(() => assetsView({ connectionId: account.connectionId, view, list, maxRows: MAX_ROWS }) as Promise<ViewOut>)
    if (!read.value) { unread.push(`${view} ${list}: ${read.notRead}`); continue }
    const edgesRead = new Set(read.value.lists.map((l) => l.edge))
    // A list Meta refused is named in `missing` by its edge (step 4's readLists); a refused field group of a list that was read is not.
    for (const m of read.value.missing) if (EDGE_LIST[m.part] && !edgesRead.has(m.part)) unread.push(`${m.part}: ${m.sentence}`)
    for (const l of read.value.lists) {
      cut = cut || l.more
      for (const item of l.items) {
        const id = str(item[ID_KEY[view]!])
        if (!id) continue
        const key = `${EDGE_LIST[l.edge] ?? l.list}:${id}`
        if (seen.has(key)) continue
        seen.add(key)
        const flag = item.takenByAnotherBusiness
        const state = flag === true ? 'taken' as const : flag === false ? 'named' as const : 'unknown' as const
        rows.push({ id, list: EDGE_LIST[l.edge] ?? l.list, name: state === 'named' ? str(item[NAME_KEY[view]!]) : null, seen: state, requestId: str(item.requestId), chosenHere: item.chosenHere === true || item.nexusApp === true })
      }
    }
  }
  return { rows, cut, unread }
}

/** set-meta-business-assets — AA-063, AA-064, AA-066, BM-044, BM-045, BM-055, BM-056. */
export async function businessAssetsAdmin(input: { connectionId?: string | null } & AssetAsk): Promise<AdminGuide> {
  const { account, portfolioId } = await assetScope(input.connectionId)
  const readAt = new Date().toISOString()
  const ask: AssetAsk = { action: input.action, adAccountId: input.adAccountId, pageId: input.pageId, appId: input.appId, name: input.name, access: input.access }
  const name = await portfolioName(account)
  const chosen = { adAccountId: account.adAccountId, pageId: account.pageId, instagramId: account.instagramId, instagramName: account.connection.instagram?.username ?? null, appId: account.connection.appId ?? null }
  let lists: AssetLists | null = null
  let taken = false
  let authorized: { adAccountIds: string[]; more: boolean } | { refused: string } | null = null
  switch (ask.action) {
    case 'claim-ad-account':
    case 'request-ad-account':
      if (!ask.adAccountId) break
      taken = await isTaken('AD_ACCOUNT', ask.adAccountId)
      if (!taken) lists = await adAccountLists(account, portfolioId, ['owned', 'client', 'pending'])
      break
    case 'claim-page':
    case 'request-page':
      if (!ask.pageId) break
      taken = await isTaken('PAGE', ask.pageId)
      if (!taken) lists = await viewLists(account, 'pages', ['owned', 'client', 'pending-owned', 'pending-client'])
      break
    case 'claim-app':
    case 'request-app':
      if (ask.appId) lists = await viewLists(account, 'apps', ['owned', 'client', 'pending'])
      break
    case 'asset-group':
      if (ask.name !== undefined) lists = await viewLists(account, 'asset-groups', ['owned'])
      break
    case 'link-instagram': {
      if (!account.instagramId) break
      // Step 3's read (AA-067): the portfolio's ad accounts allowed to advertise for the CHOSEN Instagram account.
      const ig = account.instagramId
      try {
        const read = await listPaged(account.connectionId, 'assets.instagramAuthorizedAccounts', `${ig}/authorized_adaccounts`, { fields: 'account_id,name', business: portfolioId }, MAX_ROWS)
        authorized = { adAccountIds: read.rows.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((id): id is string => !!id), more: read.more }
      } catch (err) {
        if (!(err instanceof MetaReadError)) throw err
        authorized = { refused: err.message }
      }
      break
    }
  }
  return done(assetGuide(ask, { portfolioId, portfolioName: name, chosen, lists, taken, authorized, readAt }))
}

const REMOVE_PRODUCT = { 'ad-account': 'AD_ACCOUNT', page: 'PAGE', instagram: 'INSTAGRAM' } as const

/** remove-meta-business-asset — AA-065, BM-047, BM-049. */
export async function removeBusinessAssetAdmin(input: { connectionId?: string | null } & RemoveAsk): Promise<AdminGuide> {
  const { account, portfolioId } = await assetScope(input.connectionId)
  const readAt = new Date().toISOString()
  const taken = await isTaken(REMOVE_PRODUCT[input.asset], input.id)
  const name = await portfolioName(account)
  const lists = taken ? { rows: [], cut: false, unread: [] }
    : input.asset === 'ad-account' ? await adAccountLists(account, portfolioId, ['owned', 'client', 'pending'])
      : input.asset === 'page' ? await viewLists(account, 'pages', ['owned', 'client', 'pending-owned', 'pending-client'])
        : await viewLists(account, 'instagram', ['assets', 'owned', 'client'])
  return done(removeGuide(
    { asset: input.asset, id: input.id, since: input.since },
    { portfolioId, portfolioName: name, chosen: { adAccountId: account.adAccountId, pageId: account.pageId, instagramId: account.instagramId }, lists, taken, readAt },
  ))
}

/** create-meta-ad-account — AA-062. */
export async function newAdAccountAdmin(input: { connectionId?: string | null } & NewAdAccountAsk): Promise<AdminGuide> {
  const { account, portfolioId } = await assetScope(input.connectionId)
  const readAt = new Date().toISOString()
  const name = await portfolioName(account)
  let owned: { accounts: Array<{ adAccountId: string; name: string | null; currency: string | null; timeZone: string | null }>; more: boolean } | { refused: string }
  try {
    const read = await liveAdAccounts({ connectionId: account.connectionId, list: 'owned', maxRows: MAX_ROWS })
    owned = { accounts: read.items.filter((i) => i.edge === 'owned_ad_accounts').map((i) => { const r = i as typeof i & { name?: string | null; currency?: string | null; timeZone?: string | null }; return { adAccountId: r.adAccountId, name: r.takenByAnotherBusiness ? null : r.name ?? null, currency: r.currency ?? null, timeZone: r.timeZone ?? null } }), more: read.more }
  } catch (err) {
    if (!(err instanceof MetaReadError) && !(err instanceof MetaLiveRefusal)) throw err
    owned = { refused: err.message }
  }
  return done(newAdAccountGuide(
    { name: input.name, currency: input.currency, timeZone: input.timeZone, since: input.since },
    { portfolioId, portfolioName: name, chosen: { adAccountId: account.adAccountId, currency: account.currency, timeZone: account.timeZone }, owned, readAt },
  ))
}

/** create-meta-appeal — LG-015 (the chosen ad account), LG-016 (its business portfolio). */
export async function appealAdmin(input: { connectionId?: string | null } & AppealAsk): Promise<AdminGuide> {
  const chosen = await metaChosenAccount(input.connectionId)
  // The portfolio's appeal is the portfolio's: refused when another business in Nexus uses it (the ad account's is this business's own).
  const portfolioId = input.subject === 'portfolio' ? (await assetScope(input.connectionId)).portfolioId : chosen.businessId ?? ''
  const readAt = new Date().toISOString()
  let state: { adAccountId: string; name: string | null; status: number | null; disableReason: number | null } | { refused: string }
  if (input.subject === 'ad-account') {
    try {
      const read = await liveAccessState(chosen)
      state = { adAccountId: chosen.adAccountId, name: read.name ?? chosen.name, status: read.status, disableReason: read.disableReason }
    } catch (err) {
      if (!(err instanceof MetaReadError)) throw err
      state = { refused: err.message }
    }
  } else state = { adAccountId: chosen.adAccountId, name: chosen.name, status: null, disableReason: null }
  return done(appealGuide({ subject: input.subject, since: input.since }, { portfolioId, account: state, statusWords: AD_ACCOUNT_STATUS_WORDS, reasonWords: DISABLE_REASON_WORDS, readAt }))
}

export const BILLING_SHARED = 'Another business in Nexus uses an ad account, Page or Instagram account of this Meta business portfolio (or Nexus cannot read the portfolio\'s own in full), so Nexus gives no steps for its billing and reads nothing more of it: its credit line pays that business\'s ads too. A person with full access and finance access changes it in Meta Business settings › Billing & payments.'
/** How many invoice groups of the owned lines Nexus reads (100 a line, as step 3's meta-billing reads 50). */
const MAX_GROUPS = 100

/**
 * set-meta-billing — BM-903 … BM-907 (the leader's decision after review 1: a D1 guide). The portfolio is refused before any
 * call when its link is another business's, and after step 41's read of its own ad accounts, Pages and Instagram accounts
 * when one of them is another business's (or the lists cannot be read in full).
 */
export async function billingAdmin(input: { connectionId?: string | null } & BillingAsk): Promise<AdminGuide> {
  const { account, portfolioId } = await assetScope(input.connectionId)
  const own = await livePortfolioOwnAssets(account, portfolioId)
  if (!own.adAccounts || !own.pages || !own.instagram) throw new MetaLiveRefusal(BILLING_SHARED)
  const shared = (await takenIds('AD_ACCOUNT', own.adAccounts.filter((id) => id !== account.adAccountId))).size > 0
    || (await takenIds('PAGE', own.pages)).size > 0 || (await takenIds('INSTAGRAM', own.instagram)).size > 0
  if (shared) throw new MetaLiveRefusal(BILLING_SHARED)
  const readAt = new Date().toISOString()
  const name = await portfolioName(account)
  const lines = await creditLines(account, portfolioId, null)
  const groups: InvoiceGroupSeen[] = []
  const unsure: string[] = []
  for (const creditLineId of lines.owned) {
    const list = await part(() => listPaged(account.connectionId, 'assets.billing.invoiceGroups', `${creditLineId}/extended_credit_invoice_groups`, { fields: 'id,name,auto_enroll' }, MAX_GROUPS))
    if (!list.value) { unsure.push(`Meta did not answer credit line ${creditLineId}'s invoice groups (${list.notRead})`); continue }
    if (list.value.more) unsure.push(`credit line ${creditLineId} has more invoice groups than Nexus reads (${MAX_GROUPS})`)
    for (const row of list.value.rows) {
      const groupId = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : null
      if (!groupId || !/^\d{1,25}$/.test(groupId)) continue
      groups.push({ groupId, creditLineId, name: typeof row.name === 'string' ? row.name : null, autoEnroll: typeof row.auto_enroll === 'boolean' ? row.auto_enroll : null, adAccountIds: null, accountsMore: false, takenAccounts: [] })
    }
  }
  // The floor: the asked group's ad accounts, read in full (never another business's billing).
  const target = input.invoiceGroupId ? groups.find((g) => g.groupId === input.invoiceGroupId) : undefined
  if (target) {
    const accounts = await part(() => listPaged(account.connectionId, 'assets.billing.invoiceGroupAccounts', `${target.groupId}/ad_accounts`, { fields: 'account_id' }, 500))
    if (accounts.value) {
      target.adAccountIds = accounts.value.rows.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((id): id is string => !!id)
      target.accountsMore = accounts.value.more
      target.takenAccounts = [...await takenIds('AD_ACCOUNT', target.adAccountIds.filter((id) => id !== account.adAccountId))]
    }
  }
  // Review F3, F4 — the chosen ad account's own invoice group and payment method (step 3's read), for a move only.
  let billing: BillingLive['account'] = null
  if (input.action === 'add-account' || input.action === 'remove-account') {
    try {
      const pay = await billingView({ connectionId: account.connectionId, view: 'payment' }) as {
        invoiceGroup: { invoiceGroupId: string | null } | null
        paymentMethod: { paymentMethodId: string | null; type: number | null; typeText: string | null } | null
        missing: Array<{ part: string; sentence: string }>
      }
      const refusedPayment = pay.missing.find((m) => m.part === 'paymentMethod')
      billing = {
        group: { id: pay.invoiceGroup?.invoiceGroupId ?? null },
        payment: refusedPayment && !pay.paymentMethod ? { refused: refusedPayment.sentence }
          : { type: pay.paymentMethod?.type ?? null, typeText: pay.paymentMethod?.typeText ?? null, id: pay.paymentMethod?.paymentMethodId ?? null },
      }
    } catch (err) {
      if (!(err instanceof MetaReadError) && !(err instanceof MetaLiveRefusal)) throw err
      billing = { group: { refused: err.message }, payment: { refused: err.message } }
    }
  }
  return done(billingGuide(
    { action: input.action, creditLineId: input.creditLineId, invoiceGroupId: input.invoiceGroupId, name: input.name, confirmDelete: input.confirmDelete, since: input.since },
    { portfolioId, portfolioName: name, adAccountId: account.adAccountId, creditLines: lines.owned, foreignLines: lines.foreign.length, groups, groupsUnsure: unsure.length ? unsure.join('; ') : null, account: billing, readAt },
  ))
}
