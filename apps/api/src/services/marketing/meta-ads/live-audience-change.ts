/**
 * Meta ads step 31 — what an audience change reads LIVE before it is built (and again when the approved change runs):
 * the audience itself (the chosen ad account's OWN only — step 11's ownAudience; a shared-in audience is never changed),
 * the ads that use it, who it is shared with (an audience shared with an ad account another business in Nexus uses is
 * never changed either), whether the Custom Audience terms are signed and the account's existing-customer audiences
 * (step 11's `terms` view), the account's audience-type URL tags, the names already taken, and whose every id named
 * inside a change is (the pixel — step 11's ownPixel, its "used by another business" verdict included —, the product
 * set — step 18's catalog rule —, a seed audience, a campaign or ad set, and audience-ids.ts for the rest).
 * GET only, through the gateway; nothing here changes anything.
 */
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaWriteBodyId } from '../../gateway/meta-calls.js'
import { MetaReadError } from './errors.js'
import { metaReadOne } from './read-client.js'
import { metaChosenAccount, MetaLiveRefusal, objectInAccount, type MetaChosenAccount } from './live.js'
import { AUDIENCE_DETAIL_FIELDS, audiencesView, ownAudience, ownPixel, readRows, act } from './live-audiences.js'
import { metaCatalogProblem } from './catalog-rule.js'
import { audienceIdProblem, type AudienceIdKind } from './audience-ids.js'

/** One audience of the chosen ad account, as Meta reads it now (the raw values an undo puts back). */
export interface AudienceDetail {
  id: string
  name: string | null
  subtype: string | null
  description: string | null
  /** Meta's rule, as Meta sends it (a JSON string), untouched. */
  rule: string | null
  lookalikeSpec: Record<string, unknown> | null
  lookalikeIds: string[]
  optOutLink: string | null
  customerFileSource: string | null
  retentionDays: number | null
  isValueBased: boolean | null
  labels: string[] | null
  operationCode: number | null
  /** Flagged for integrity (operation 471, or fields named): Meta refuses most edits. */
  flagged: boolean
  flaggedFields: string[]
  deliveryCode: number | null
}

export interface AudienceUse {
  /** The chosen account's ads that use it (at most 50 named). */
  ads: Array<{ adId: string | null; name: string | null; adSetId: string | null; campaignId: string | null; effectiveStatus: string | null }>
  activeAds: number
  /** Ads of other ad accounts it is shared with, per account (another business's: never counted, only flagged). */
  otherAccounts: Array<{ adAccountId: string; ads: number | null; takenByAnotherBusiness: boolean }>
  more: boolean
}

export interface AudienceSharing {
  /** The ad accounts it is shared with (Meta's /adaccounts edge). */
  accounts: string[]
  /** Why it may not be changed: shared with an account or portfolio another business in Nexus uses, or not checked. */
  problem: string | null
}

export interface TermsState {
  signed: boolean
  signLink: string
  /** The account's existing-customer audiences (null: Meta did not answer them). */
  existingCustomers: string[] | null
  existingProblem: string | null
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const idText = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? metaObjectId(v) : null)
const codeOf = (v: unknown): number | null => (v && typeof v === 'object' ? num((v as { code?: unknown }).code) : null)
const refuse = (message: string): never => { throw new MetaLiveRefusal(message) }

/** The business's chosen account as the step 11 reads take it (its Page, Instagram account and portfolio too). */
export const chosenOf = (connectionId: string): Promise<MetaChosenAccount> => metaChosenAccount(connectionId)

/**
 * The chosen account's OWN audience, read in full (raw rule and spec): refused in words when it is shared in (another
 * account owns it: Nexus never changes it) or not the chosen account's at all.
 */
export async function liveAudienceDetail(account: MetaChosenAccount, audienceId: string): Promise<AudienceDetail> {
  const own = await ownAudience(account, audienceId)
  if (own.sharedIn) refuse(`Audience ${own.audienceId} is shared with the chosen ad account by its owner: Nexus never changes an audience another account owns (its owner changes it).`)
  const body = (await metaReadOne({ connectionId: account.connectionId }, { operation: 'audiences.changeRead', path: own.audienceId, query: { fields: AUDIENCE_DETAIL_FIELDS } })).body as Record<string, unknown>
  const flaggedFields = Array.isArray(body.fields_violating_integrity_policy) ? body.fields_violating_integrity_policy.filter((f): f is string => typeof f === 'string') : []
  const labels = Array.isArray(body.audience_labels) ? body.audience_labels.filter((l): l is string => typeof l === 'string') : null
  const operationCode = codeOf(body.operation_status)
  return {
    id: own.audienceId,
    name: text(body.name),
    subtype: text(body.subtype),
    description: text(body.description),
    rule: text(body.rule),
    lookalikeSpec: body.lookalike_spec && typeof body.lookalike_spec === 'object' && !Array.isArray(body.lookalike_spec) ? body.lookalike_spec as Record<string, unknown> : null,
    lookalikeIds: Array.isArray(body.lookalike_audience_ids) ? body.lookalike_audience_ids.map(idText).filter((id): id is string => !!id) : [],
    optOutLink: text(body.opt_out_link),
    customerFileSource: text(body.customer_file_source),
    retentionDays: num(body.retention_days),
    isValueBased: typeof body.is_value_based === 'boolean' ? body.is_value_based : null,
    labels,
    operationCode,
    flagged: operationCode === 471 || flaggedFields.length > 0,
    flaggedFields,
    deliveryCode: codeOf(body.delivery_status),
  }
}

/** The ads that use an audience (step 11's ads-using view). */
export async function liveAudienceUse(account: MetaChosenAccount, audienceId: string): Promise<AudienceUse> {
  const view = await audiencesView({ connectionId: account.connectionId, view: 'ads-using', audienceId, maxRows: 500 }) as {
    ads: AudienceUse['ads']; otherAccounts: Array<{ adAccountId: string; ads?: number; takenByAnotherBusiness: boolean }>; more: boolean
  }
  return {
    ads: view.ads.slice(0, 50),
    activeAds: view.ads.filter((a) => a.effectiveStatus === 'ACTIVE').length,
    otherAccounts: view.otherAccounts.map((o) => ({ adAccountId: o.adAccountId, ads: typeof o.ads === 'number' ? o.ads : null, takenByAnotherBusiness: o.takenByAnotherBusiness })),
    more: view.more,
  }
}

/**
 * Who an audience is shared with (step 11's sharing view, each recipient account and portfolio another business in
 * Nexus uses already flagged there): such an audience is never changed — it is also that business's.
 */
export async function liveAudienceSharing(account: MetaChosenAccount, audienceId: string): Promise<AudienceSharing> {
  const view = await audiencesView({ connectionId: account.connectionId, view: 'sharing', audienceId, maxRows: 1000 }) as {
    recipients: unknown; sharedWithAdAccounts: unknown
  }
  const list = (part: unknown): Array<Record<string, unknown>> | null => (Array.isArray(part) ? part as Array<Record<string, unknown>> : null)
  const accounts = list(view.sharedWithAdAccounts)
  const recipients = list(view.recipients)
  if (!accounts) return { accounts: [], problem: `Nexus could not read who the audience is shared with (${(view.sharedWithAdAccounts as { refused?: string })?.refused ?? 'no answer'}), so it changes nothing of it.` }
  const taken = [...accounts, ...(recipients ?? [])].some((r) => r.takenByAnotherBusiness === true || r.businessTakenByAnotherBusiness === true)
  return {
    accounts: accounts.map((r) => (typeof r.adAccountId === 'string' ? r.adAccountId : null)).filter((id): id is string => !!id),
    problem: taken ? 'The audience is shared with an ad account another business in Nexus uses, so it is also that business\'s: Nexus never changes it (its owner changes it in Meta\'s Audiences).' : null,
  }
}

/** Is this audience the chosen account's own and no other Nexus business's? The audience, or refused in words. */
export async function changeableAudience(account: MetaChosenAccount, audienceId: string): Promise<{ audience: AudienceDetail; sharing: AudienceSharing }> {
  const audience = await liveAudienceDetail(account, audienceId)
  const sharing = await liveAudienceSharing(account, audience.id)
  if (sharing.problem) refuse(sharing.problem)
  return { audience, sharing }
}

/** The Custom Audience terms (signed by a person, never a system user) and the existing-customer audiences (step 11's terms view). */
export async function liveTerms(account: MetaChosenAccount): Promise<TermsState> {
  const view = await audiencesView({ connectionId: account.connectionId, view: 'terms' }) as {
    customAudienceTermsSigned: boolean; signLink: string; existingCustomerAudienceIds: unknown
  }
  const existing = view.existingCustomerAudienceIds
  return {
    signed: view.customAudienceTermsSigned === true,
    signLink: view.signLink,
    existingCustomers: Array.isArray(existing) ? existing.filter((id): id is string => typeof id === 'string') : null,
    existingProblem: Array.isArray(existing) ? null : (existing as { refused?: string })?.refused ?? 'Meta did not answer it',
  }
}

/** The account's audience-type URL tags (custom_audience_info; advantage-shopping-campaigns/audience-type-url-parameters). */
export async function liveAudienceTypeTags(account: MetaChosenAccount): Promise<Record<string, string> | null> {
  const body = (await metaReadOne({ connectionId: account.connectionId }, { operation: 'audiences.typeTags', path: act(account.adAccountId), query: { fields: 'custom_audience_info' } })).body as Record<string, unknown>
  const info = body.custom_audience_info
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null
  const out: Record<string, string> = {}
  for (const key of ['audience_type_param_name', 'new_customer_tag', 'existing_customer_tag']) {
    const v = (info as Record<string, unknown>)[key]
    if (typeof v === 'string' && v) out[key] = v
  }
  return Object.keys(out).length ? out : null
}

/** The ids of the account's audiences already named so (a create warns: Meta allows two audiences of one name). */
export async function liveAudiencesNamed(account: MetaChosenAccount, names: string[]): Promise<{ ids: string[]; checked: boolean }> {
  try {
    const read = await readRows(account.connectionId, 'audiences.names', `${act(account.adAccountId)}/customaudiences`, { fields: 'id,name' }, 1000, 100)
    const wanted = new Set(names.map((n) => n.trim().toLowerCase()))
    return { ids: read.rows.filter((r) => typeof r.name === 'string' && wanted.has(r.name.trim().toLowerCase())).map((r) => idText(r.id)).filter((id): id is string => !!id), checked: !read.more }
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return { ids: [], checked: false }
    throw err
  }
}

const AUDIENCE_ID_KINDS: ReadonlySet<string> = new Set<AudienceIdKind>(['page', 'instagram', 'leadform', 'canvas', 'video', 'adaccount'])

/**
 * Whose is every id named inside a change (the same kinds the gateway checks again before sending): the problems in
 * words, empty when every one is this business's.
 */
export async function liveIdProblems(account: MetaChosenAccount, ids: MetaWriteBodyId[]): Promise<string[]> {
  const problems: string[] = []
  for (const inner of ids) {
    try {
      if (inner.kind === 'pixel') await ownPixel(account, inner.id, false)
      else if (inner.kind === 'productset' || inner.kind === 'catalog') {
        const problem = await metaCatalogProblem({ connectionId: account.connectionId, adAccountId: account.adAccountId }, inner.kind === 'catalog' ? { catalogId: inner.id } : { productSetId: inner.id })
        if (problem) problems.push(problem)
      } else if (inner.kind === 'customaudience') await changeableAudience(account, inner.id)
      else if (inner.kind === 'campaignOrAdset') {
        try {
          await objectInAccount(account, inner.id, 'campaign', 'audiences.originCheck')
        } catch (err) {
          if (!(err instanceof MetaLiveRefusal)) throw err
          await objectInAccount(account, inner.id, 'adset', 'audiences.originCheck')
        }
      } else if (AUDIENCE_ID_KINDS.has(inner.kind)) {
        const problem = await audienceIdProblem(account, { id: inner.id, kind: inner.kind as AudienceIdKind })
        if (problem) problems.push(problem)
      } else problems.push(`${inner.id} is not an id an audience change names.`)
    } catch (err) {
      if (err instanceof MetaLiveRefusal) problems.push(err.message)
      else throw err
    }
  }
  return problems
}
