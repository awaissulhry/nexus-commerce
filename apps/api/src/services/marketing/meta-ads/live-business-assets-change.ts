/**
 * Meta ads step 43 (2026-10-26) — the live reads behind create-meta-backed-account and set-meta-billing (pure drafts:
 * change-business-assets.ts). GET only, through the gateway; the same paths and keys the merged reads use: step 10's read of
 * the chosen Page's Page-backed Instagram account (live-media.ts), step 15's of the Instagram- and Page-backed Threads
 * accounts (live-messaging.ts destinations), step 3's credit lines, invoice groups and their ad accounts (live-account.ts
 * billing), step 41's account read (status, portfolio) and its portfolio check.
 *
 * One business at a time: a billing change goes only through the business's chosen ad account, on the credit lines its OWN
 * portfolio owns, and never when another business in Nexus uses that portfolio (its link, or one of the portfolio's own ad
 * accounts, Pages or Instagram accounts — step 41's check; a list Nexus cannot read in full counts as shared). Nothing goes
 * through a disabled, risk-reviewed, closing, closed or compromised ad account (step 40's rule).
 */
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { accessAccount, liveAccessState, livePortfolioOwnAssets } from './live-access-change.js'
import { metaAccountChangeRefusal } from './change-account-settings.js'
import { creditLines } from './live-account.js'
import { listPaged, part } from './paging.js'
import { takenIds } from './taken.js'
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaWriteTarget } from './write-client.js'
import type { BackedKind, BackedLive, BillingLive, InvoiceGroupNow } from './change-business-assets.js'

type Row = Record<string, unknown>
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const rowsOf = (v: unknown): Row[] => (Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? obj(v)!.data as unknown[] : []).map(obj).filter((r): r is Row => !!r)
/** One row of an answer that is a list or a node (Meta answers these edges either way). */
const firstOf = (v: unknown): Row | null => (Array.isArray(v) || Array.isArray(obj(v)?.data) ? rowsOf(v)[0] ?? null : obj(v))

/** How many invoice groups (of the owned lines) Nexus reads the ad accounts of; beyond it, where an account sits is unknown. */
export const MAX_GROUPS = 25

export const BILLING_SHARED = 'Another business in Nexus uses an ad account, Page or Instagram account of this Meta business portfolio (or Nexus cannot read the portfolio\'s own in full), so Nexus changes nothing of its billing: its credit line pays that business\'s ads too. A person with finance access changes it in Meta Business settings › Billing & payments.'

/**
 * The chosen ad account, its state and its portfolio for a billing change — or why none goes through it (step 40's rule
 * first, then step 41's shared-portfolio check).
 */
export async function billingScope(target: MetaWriteTarget): Promise<{ chosen: MetaChosenAccount; portfolioId: string } | { refusal: string }> {
  const chosen = await accessAccount(target)
  const state = await liveAccessState(chosen)
  const refused = metaAccountChangeRefusal(state)
  if (refused) return { refusal: refused }
  if (!state.portfolioId) return { refusal: 'The chosen ad account belongs to no Meta business portfolio, so it has no credit line or invoice groups Nexus can change.' }
  const portfolioId = state.portfolioId
  if ((await takenIds('PORTFOLIO', [portfolioId])).has(portfolioId)) return { refusal: BILLING_SHARED }
  const own = await livePortfolioOwnAssets(chosen, portfolioId)
  if (!own.adAccounts || !own.pages || !own.instagram) return { refusal: BILLING_SHARED }
  const shared = (await takenIds('AD_ACCOUNT', own.adAccounts.filter((id) => id !== chosen.adAccountId))).size > 0
    || (await takenIds('PAGE', own.pages)).size > 0 || (await takenIds('INSTAGRAM', own.instagram)).size > 0
  return shared ? { refusal: BILLING_SHARED } : { chosen, portfolioId }
}

/** The portfolio's own credit lines, their invoice groups and the ad accounts each bills (step 3's reads, the e-mails never asked). */
export async function liveBilling(chosen: MetaChosenAccount, portfolioId: string): Promise<BillingLive> {
  const lines = await creditLines(chosen, portfolioId, null)
  const groups: InvoiceGroupNow[] = []
  const unsure: string[] = []
  let read = 0
  for (const creditLineId of lines.owned) {
    const list = await part(() => listPaged(chosen.connectionId, 'billingChange.invoiceGroups', `${creditLineId}/extended_credit_invoice_groups`, { fields: 'id,name' }, 100))
    if (!list.value) { unsure.push(`Meta did not answer credit line ${creditLineId}'s invoice groups: ${list.notRead}`); continue }
    if (list.value.more) unsure.push(`credit line ${creditLineId} has more invoice groups than Nexus reads (100)`)
    for (const row of list.value.rows) {
      const groupId = metaObjectId(row.id)
      if (!groupId) continue
      const name = typeof row.name === 'string' ? row.name : null
      if (read >= MAX_GROUPS) { unsure.push(`the credit lines have more invoice groups than Nexus reads the ad accounts of (${MAX_GROUPS})`); groups.push({ groupId, creditLineId, name, adAccountIds: null, accountsMore: false, takenAccounts: [] }); continue }
      read++
      const accounts = await part(() => listPaged(chosen.connectionId, 'billingChange.invoiceGroupAccounts', `${groupId}/ad_accounts`, { fields: 'account_id' }, 500))
      const ids = accounts.value ? accounts.value.rows.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((id): id is string => !!id) : null
      const taken = ids ? [...await takenIds('AD_ACCOUNT', ids.filter((id) => id !== chosen.adAccountId))] : []
      groups.push({ groupId, creditLineId, name, adAccountIds: ids, accountsMore: accounts.value?.more ?? false, takenAccounts: taken })
    }
  }
  return { portfolioId, adAccountId: chosen.adAccountId, creditLines: lines.owned, foreignLines: lines.foreign.length, groups, groupsUnsure: unsure.length ? [...new Set(unsure)].join('; ') : null }
}

/** The id of the account a backed-account read answered (digits), or null. */
const idIn = (row: Row | null, key: string) => metaObjectId(row?.[key])

/** What exists already for the backed account asked: one per Page / Instagram account (Meta answers the existing one). */
export async function liveBacked(chosen: MetaChosenAccount, kind: BackedKind): Promise<BackedLive> {
  const { connectionId } = chosen
  const refused = (err: unknown) => {
    if (err instanceof MetaReadError) return { refused: err.message }
    if (err instanceof MetaLiveRefusal) return { refused: err.message }
    throw err
  }
  if (kind === 'threads-for-instagram') {
    const ig = chosen.instagramId
    if (!ig) return { kind, objectId: null, existing: { id: null } }
    let existing: BackedLive['existing']
    try {
      const read = await metaReadOne({ connectionId }, { operation: 'backedChange.instagramThreads', path: `${ig}/instagram_backed_threads_user`, query: { fields: 'threads_user_id' } })
      existing = { id: idIn(firstOf(read.body), 'threads_user_id') }
    } catch (err) { existing = refused(err) }
    const linked = await part(() => metaReadOne({ connectionId }, { operation: 'backedChange.linkedThreads', path: `${ig}/connected_threads_user`, query: { fields: 'threads_user_id' } }))
    return { kind, objectId: ig, existing, linkedThreads: linked.value ? idIn(firstOf(linked.value.body), 'threads_user_id') : undefined }
  }
  const page = chosen.pageId
  if (!page) return { kind, objectId: null, existing: { id: null } }
  const pbia = async () => {
    const read = await listPaged(connectionId, 'backedChange.pageBackedInstagram', `${page}/page_backed_instagram_accounts`, { fields: 'id' }, 5)
    return metaObjectId(read.rows[0]?.id)
  }
  if (kind === 'instagram-for-page') {
    let existing: BackedLive['existing']
    try { existing = { id: await pbia() } } catch (err) { existing = refused(err) }
    return { kind, objectId: page, existing }
  }
  let existing: BackedLive['existing']
  try {
    const read = await metaReadOne({ connectionId }, { operation: 'backedChange.pageThreads', path: page, query: { fields: 'id,page_backed_threads_account_id' } })
    const body = obj(read.body)
    if (metaObjectId(body?.id) !== page) throw new MetaLiveRefusal('Meta answered for another Page than the chosen one.')
    existing = { id: idIn(body, 'page_backed_threads_account_id') }
  } catch (err) { existing = refused(err) }
  const instagram = await part(pbia)
  return { kind, objectId: page, existing, pageBackedInstagram: instagram.value === null && instagram.notRead ? undefined : instagram.value }
}
