/**
 * Meta ads step 39 (2026-10-21) — what the brand-safety changes read LIVE before they are built (GET only, through the
 * gateway). The block lists themselves are read with step 16's meta-brand-safety reads (live-safety.ts liveSafety: owner,
 * shares, people, ad accounts, contents); this file adds only what step 16 has no read for:
 *   - one ad set with its targeting (Q7: targeting-merge.ts readAdSetTargeting) — only an ad set of the chosen ad account
 *     (account_id and the two fields only an ad set has, services/meta/meta-kinds.ts), with its campaign's status
 *   - the ad account's inventory filter (`brand_safety_content_filter_levels`, a documented read field of the ad account,
 *     reference/ad-account.md)
 *   - whether any campaign of the account delivers now (`act_<id>/campaigns?effective_status=["ACTIVE"]`, one row), for
 *     the SPENDS MONEY sentence of a change that loosens the whole account
 */
import { metaAdAccountId } from '../../cx/connectors/meta/discovery.js'
import { localFailure, MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal } from './live.js'
import { metaReadOne } from './read-client.js'
import { readAdSetTargeting } from './targeting-merge.js'
import { takenIds } from './taken.js'
import type { MetaChangeAccount } from './change-account.js'
import { MetaWriteError } from './write-client.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)

export interface AdSetSafetyState {
  id: string
  name: string | null
  /** Its own status (ACTIVE, PAUSED, …). */
  status: string | null
  campaign: { id: string | null; name: string | null; status: string | null } | null
  /** The live targeting spec, exactly as Meta answered it. */
  targeting: Row
}

/** One ad set of the chosen ad account with its live targeting — refused in words when it is not one. */
export async function liveAdSetSafety(account: MetaChangeAccount, adSetId: string): Promise<AdSetSafetyState> {
  let read
  try {
    read = await readAdSetTargeting(account.accountId, adSetId, ['id', 'name', 'account_id', 'status', 'optimization_goal', 'billing_event', 'campaign{id,name,status}'], 'brandSafety.adSet')
  } catch (err) {
    if (err instanceof MetaReadError) {
      if (err.failure.origin === 'meta' && /nonexisting field/i.test(err.failure.sentence)) throw new MetaLiveRefusal(`${adSetId} is not an ad set of the chosen ad account (Meta does not know an ad set's own fields on it).`)
      throw new MetaLiveRefusal(`Nexus could not read ad set ${adSetId} (${err.failure.sentence}), so nothing was asked of Meta.`)
    }
    throw err
  }
  const node = read.node
  if (metaAdAccountId(node.account_id) !== account.adAccountId) throw new MetaLiveRefusal(`Ad set ${adSetId} does not belong to the ad account this business chose, so Nexus changes nothing on it.`)
  if (!text(node.optimization_goal) || !text(node.billing_event)) throw new MetaLiveRefusal(`${adSetId} is not an ad set of the chosen ad account.`)
  const campaign = obj(node.campaign)
  return {
    id: adSetId,
    name: text(node.name),
    status: text(node.status),
    campaign: campaign ? { id: text(campaign.id), name: text(campaign.name), status: text(campaign.status) } : null,
    targeting: read.targeting,
  }
}

/** The ad account's inventory filter levels as Meta answers them (an empty list when none is set). */
export async function liveAccountFilter(account: MetaChangeAccount): Promise<string[]> {
  try {
    const { body } = await metaReadOne<Row>({ connectionId: account.accountId }, { operation: 'brandSafety.accountFilter', path: `act_${account.adAccountId}`, query: { fields: 'id,brand_safety_content_filter_levels' } })
    const levels = body.brand_safety_content_filter_levels
    return Array.isArray(levels) ? levels.filter((l): l is string => typeof l === 'string') : []
  } catch (err) {
    if (err instanceof MetaReadError) throw new MetaLiveRefusal(`Nexus could not read the ad account's inventory filter (${err.failure.sentence}), so nothing was asked of Meta.`)
    throw err
  }
}

/** Does any campaign of the chosen ad account deliver now (effective status ACTIVE)? Null when Meta could not say. */
export async function accountDelivering(account: MetaChangeAccount): Promise<boolean | null> {
  try {
    const { body } = await metaReadOne<Row>({ connectionId: account.accountId }, { operation: 'brandSafety.activeCampaigns', path: `act_${account.adAccountId}/campaigns`, query: { effective_status: ['ACTIVE'], fields: 'id', limit: 1 } })
    return Array.isArray(body.data) ? body.data.length > 0 : null
  } catch (err) {
    if (err instanceof MetaReadError) return null
    throw err
  }
}

/**
 * The chosen ad account's business portfolio for a change of the portfolio's lists — refused in words when the account
 * names none, or when another business in Nexus uses that portfolio (its lists would be that business's too).
 */
export async function ownPortfolio(account: MetaChangeAccount): Promise<string> {
  const chosen = await metaChosenAccount(account.accountId)
  if (!chosen.businessId) throw new MetaLiveRefusal('The chosen ad account names no Meta business portfolio, so its block lists cannot be changed through Nexus (a person checks the ad account in Meta Business settings).')
  if ((await takenIds('PORTFOLIO', [chosen.businessId])).has(chosen.businessId)) {
    throw new MetaLiveRefusal('The chosen ad account\'s business portfolio is also used by another business in Nexus, so Nexus changes none of its block lists (they would be that business\'s too). A person manages them in Meta\'s Brand Safety and Suitability hub.')
  }
  return chosen.businessId
}

/** How long Nexus waits for Meta to read a block-list file, between its status reads (about 50 s in all). */
const DRAFT_WAITS_MS = [2_000, 3_000, 5_000, 8_000, 12_000, 20_000]

/**
 * BS-006 — wait until Meta has read the block-list file of a draft (`GET /{draft_id}?fields=async_job_status,
 * async_percent_completion`: scheduled | failed | running | success, block-list.md). Resolves on success; a failed draft,
 * one still running after about 50 s, or a read Meta refuses throws a MetaWriteError (nothing more is sent: no list is
 * made from it).
 */
export async function waitForBlockListDraft(connectionId: string, draftId: string, options: { sleep?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const operation = 'blockList.draftStatus'
  let last: { status: string | null; percent: number | null } = { status: null, percent: null }
  for (const wait of DRAFT_WAITS_MS) {
    await sleep(wait)
    let body: Row
    try {
      body = (await metaReadOne<Row>({ connectionId }, { operation, path: draftId, query: { fields: 'id,async_job_status,async_percent_completion' } })).body
    } catch (err) {
      if (err instanceof MetaReadError) throw new MetaWriteError({ ...err.failure, sentence: `Nexus could not read the draft's status (${err.failure.sentence}), so it made no list from it.` }, operation, 'not_sent')
      throw err
    }
    const status = text(body.async_job_status)?.toLowerCase() ?? null
    last = { status, percent: typeof body.async_percent_completion === 'number' ? body.async_percent_completion : null }
    if (status === 'success') return
    if (status === 'failed') throw new MetaWriteError(localFailure('Meta could not read the uploaded file (the draft failed), so no list was made from it. Check the hosts and URLs and ask again.', 'BLOCK_LIST_DRAFT_FAILED'), operation, 'not_sent')
  }
  throw new MetaWriteError(localFailure(`Meta was still reading the file after about 50 s (${last.status ?? 'no status'}${last.percent !== null ? `, ${last.percent}%` : ''}), so Nexus made no list from it. Ask again: a new draft is uploaded then.`, 'BLOCK_LIST_DRAFT_SLOW'), operation, 'not_sent')
}
