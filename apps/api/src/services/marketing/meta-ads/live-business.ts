/**
 * Meta ads step 4 (2026-10-25) — the BUSINESS PORTFOLIO of the business's chosen Meta connection, live from Meta (GET only,
 * through the gateway): the portfolio itself, its domains and the portfolios the system user belongs to (meta-business);
 * its people, system users, invitations and finance roles (meta-business-people); its Pages, Instagram accounts, apps,
 * asset groups, client objects, signal containers and WhatsApp accounts (meta-business-assets); its partners
 * (meta-business-partners). Nothing here stores anything. Step 42 (business settings, people, system users) and step 43
 * (business assets) build their previews and undo on the exported reads and field lists below, so they read nothing twice.
 *
 * ONLY the portfolio of the business's chosen ad account (metaChosenAccount → businessId; `me/businesses` lists the
 * system user's portfolios, the others masked). What another business in Nexus uses is `{ id, takenByAnotherBusiness: true }`
 * only (taken.ts): a Page, an Instagram account or an ad account another business picked, a portfolio another business's
 * chosen ad account belongs to. That table holds only what another business PICKED (one ad account, Page and Instagram
 * account each), so "not in the table" means unknown, never "ours". ONE rule therefore decides what Nexus says about an
 * asset (seenAs, below — step 12 fix A1's rule for a client catalog, applied to every list): the asset chosen here is
 * named; one the chosen portfolio owns is named while no other business in Nexus uses that portfolio; an asset NOT owned
 * here is named only when Meta names its owner portfolio and no other business in Nexus uses that portfolio; a Page,
 * Instagram account or ad account is named only by a plain digits id Nexus could check; anything else is its id only
 * (takenByAnotherBusiness null: Nexus cannot tell whose it is). A list with no owner field (pending Pages, client Instagram
 * business assets, client objects, an invitation's client assets) is ids only, but for the asset chosen here. When another
 * business in Nexus uses an ad account of the chosen portfolio, its people, partners and domains are not read at all
 * (they would show that business's too), and its other assets are ids only.
 *
 * People: names, roles, tasks and two-factor status only — what Business settings › People shows an admin. Nexus never
 * asks Meta for an e-mail address (business-user email / pending_email, an invitation's email), a person's first or last
 * name or title, an invitation's invite_link (anyone holding it can accept it), a domain's verification_code (it proves
 * ownership of the domain) or any token (the gateway refuses every field named *token*). Who made something is Meta's id
 * only (Nexus's own system user is said by name). Field lists are FIXED per node type (a caller never names a Graph field
 * or path); SDK-only fields are asked in their own group, and a group Meta refuses is named with Meta's sentence. Payment
 * ids (the portfolio's payment account, a WhatsApp account's funding id) are money keys: the ad-spend view, as meta-billing.
 *
 * Checked 2026-10-25 (curl ≥ 3 s apart: developers.facebook.com/documentation/ads-commerce/marketing-api/reference/<page>.md,
 * developers.facebook.com/docs/graph-api/reference/<node>/ and the WhatsApp phone-number guide; Meta's Python Business SDK
 * main, facebook_business/adobjects/<node>.py):
 *   - business (v26 Reading table): id, name, created_time, created_by, updated_time, updated_by, timezone_id,
 *     two_factor_type, verification_status (expired … verified), vertical, vertical_id, primary_page, link, is_hidden,
 *     profile_picture_uri, block_offline_analytics, payment_account_id, extended_updated_time,
 *     marketing_messages_onboarding_status (SDK MarketingMessagesOnboardingStatus: status, time),
 *     whatsapp_business_manager_messaging_limit, collaborative_ads_managed_partner_eligibility (SDK: is_eligible,
 *     reason_code, reason_description), collaborative_ads_managed_partner_business_info (SDK ManagedPartnerBusiness —
 *     only its status fields are asked: it also holds a retailer's credit and sales contact). Legal name, address, phone
 *     and website are not fields: Business settings only. A primary Page is one the portfolio owns (POST /{business_id}
 *     primary_page: #3918 "already owned by another Business Manager").
 *   - user/businesses (+ permitted_roles; #459 checkpointed); business/owned_domains (no parameters; OwnedDomain node
 *     page 404 — SDK owneddomain.py: domain_name, status, verification_code, owner_business)
 *   - business/business_users (+ role, summary total_count) → business-user (id, name, role, finance_permission,
 *     ip_permission, two_fac_status; email, first_name, last_name, pending_email, title — never asked; SDK adds tasks,
 *     marked_for_removal); business/system_users (+ role, total_count; the System Users guide: listing them needs an admin
 *     user's or admin system user's token) → system-user (id, name, created_by, created_time, finance_permission,
 *     ip_permission); business/pending_users (email filter — never sent) → business-role-request (id, role, status,
 *     created_by, created_time, expiration_time, finance_role, invited_user_type, updated_by, updated_time, email, owner;
 *     SDK adds tasks, ip_role, invite_link); business-role-request/assigned_owned_assets (BusinessObject: SDK asset,
 *     asset_type, id, name, picture) and assigned_client_assets (BusinessPermissionProxy, no node page) — both + role,
 *     permitted_roles, permitted_tasks, `asset_type` REQUIRED; business/finance_permissions (FinanceObject: SDK
 *     finance_permission, user (Object); `user` filter — not sent)
 *   - business/owned_pages, client_pages (+ permitted_tasks), pending_owned_pages and pending_client_pages
 *     (BusinessPageRequest: SDK id, page; + permitted_tasks), each with total_count; the Page's `business` (owner: a token of
 *     a Page admin) and `verification_status` (Page Public Metadata Access) in groups of their own;
 *     page/global_brand_children (a token with the MANAGE task on the Page, else Page Public Content Access);
 *     page/store_locations (read only; StoreLocation: SDK id, store_code, full_address, zip_code, phone_number, hours,
 *     price_range, pickup_options)
 *   - business/owned_instagram_accounts, client_instagram_accounts (+ permitted_tasks), instagram_accounts,
 *     instagram_business_accounts (IGUser; owner_business SDK only); owned_instagram_assets, client_instagram_assets (SDK
 *     only: InstagramBusinessAsset id, ig_user_id, ig_username)
 *   - business/owned_apps, client_apps (+ permitted_tasks), pending_client_apps (BusinessApplicationRequest: SDK id,
 *     application; + is_requested, permitted_tasks); Application `business` (owner) SDK only
 *   - business/business_asset_groups, client_business_asset_groups (+ permitted_tasks) → BusinessAssetGroup (SDK id,
 *     name, owner_business); business/client_objects (`type` REQUIRED, `owner_biz_id`; BusinessObject + permitted_tasks)
 *   - business/owned_ / client_ (+ permitted_tasks) / pending_shared_offsite_signal_container_business_objects
 *     (OffsiteSignalContainerBusinessObject: SDK id, name, business, is_unavailable, primary_container_id,
 *     is_eligible_for_sharing_to_ad_account, is_eligible_for_sharing_to_business)
 *   - business/owned_whatsapp_business_accounts (whatsapp_business_management + business_management and an ADMIN
 *     system-user token, per Meta's page; SDK whatsappbusinessaccount.py fields) and whatsapp-business-account/phone_numbers
 *     (the WhatsApp guide: id, display_phone_number, verified_name, quality_rating; one number adds
 *     code_verification_status, name_status)
 *   - business/agencies and business/clients (Business + adaccount_permissions, application_permissions,
 *     page_permissions, productcatalog_permissions, shared_ca_count; their item shape has no page or SDK class, so only an
 *     id and plain task / status words are kept from each), business/partner_relationships (exclude_declined_requests;
 *     + relationship), business/partners (no parameters; Business, total_count), business/initiated_sharing_agreements
 *     (receiving_business_id, request_status) and business/received_sharing_agreements (requesting_business_id,
 *     request_status) → BusinessAgreement (SDK id, request_status), business/owned_businesses (child_business_external_id,
 *     client_user_id — not sent; + relationship)
 * Whatever is SDK-only or not documented is built and Meta's own answer decides (LIVE-PROBES.md, step 4 rows).
 */
import { FIELDS } from '@nexus/shared/permissions'
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, metaConnectionFor, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { listGroups, readGroups, type FieldGroup, type MissingPart } from './live-objects.js'
import { fieldRefused, listPaged, part } from './paging.js'
import { onPage, pageOf, tidy } from './live-media.js'
import { takenIds, type MetaTakenProduct } from './taken.js'
import {
  META_CLIENT_OBJECT_TYPES, META_INVITATION_ASSET_TYPES, META_INVITATION_DEFAULT_TYPES, META_SHARING_AGREEMENT_STATUSES,
  type MetaClientObjectKind, type MetaInvitationAssetType,
} from '../../meta/meta-business-lists.js'

type Row = Record<string, unknown>

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v).trim()) ? String(v).trim() : null)
/** An id as Meta wrote it (digits, or a composite such as 123_456): never anything with other characters. */
const anyId = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && /^[0-9_:]{1,64}$/.test(String(v).trim()) ? String(v).trim() : null)
const digits = (id: string | null): boolean => !!id && /^\d{1,25}$/.test(id)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (typeof s === 'string' || typeof s === 'number' ? String(s) : null)).filter((s): s is string => !!s) : [])
/** A list Meta answered (maybe empty) — or null when the field was not read at all (a refused SDK-only group), never []. */
const stringsRead = (v: unknown): string[] | null => (v === undefined ? null : strings(v))
const clampRows = (n: number | undefined, dflt = 100) => Math.min(500, Math.max(1, Math.trunc(n ?? dflt)))

/** The portfolio's payment ids: money keys, shown only with the ad-spend view (as meta-billing's). */
export const META_BUSINESS_MONEY = { paymentAccountId: FIELDS.financialsAdspendView } as const
/** meta-business-assets' money key: a WhatsApp account's funding id (ad-spend view). */
export const META_BUSINESS_ASSETS_MONEY = { primaryFundingId: FIELDS.financialsAdspendView } as const

/** Words that look like an e-mail address: never passed on, whatever key Meta put them under. */
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/
/** A key that names a secret, a contact or a link: dropped from Meta's loosely documented objects. */
const UNSAFE_KEY = /token|secret|password|email|e_mail|phone|link|url|uri|address|code/i
/**
 * The plain words of an object Meta documents only loosely (a partner relationship, a permission item): its scalar values
 * and lists of scalars under plain key names, never a nested object, a value shaped like an e-mail address, or a key that
 * names a secret, a contact or a link.
 */
export function plainOf(v: unknown): Record<string, string | number | boolean | string[]> | null {
  const o = obj(v)
  if (!o) return null
  const out: Record<string, string | number | boolean | string[]> = {}
  for (const [key, value] of Object.entries(o)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || UNSAFE_KEY.test(key)) continue
    if (typeof value === 'string') { if (!EMAIL_LIKE.test(value)) out[key] = value }
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (Array.isArray(value) && value.every((s) => typeof s === 'string' || typeof s === 'number')) out[key] = value.map(String).filter((s) => !EMAIL_LIKE.test(s))
  }
  return Object.keys(out).length ? out : null
}
/** A list Meta answers as plain words or plain objects (a relationship type list): words only. */
const wordsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? (EMAIL_LIKE.test(x) ? null : x) : plainOf(x))).filter((x) => x !== null) : (plainOf(v) ? [plainOf(v)] : []))

/**
 * Review B-F12 — a list in field groups where each group fails on its own: ONE read with every group; when Meta refuses a
 * field, the list is read with its core group, then once per other group (`id` + that group) and merged by id, so a group
 * Meta refuses (a Page's owner, its verification state) is named with Meta's sentence and costs only itself. The core
 * group must hold `id`. A dropped owner group leaves the owner unknown (the asset is then its id only).
 */
/** The top-level field names of a Graph field list (`a,b{c,d},e` → a, b, e). */
function topLevelNames(fields: string): Set<string> {
  let depth = 0
  let top = ''
  for (const c of fields) {
    if (c === '{' || c === '(') depth++
    else if (c === '}' || c === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) top += c
  }
  return new Set(top.split(',').map((f) => f.trim()).filter(Boolean))
}

/** A row with only the top-level fields Nexus asked (re-review N6: never a field an answer carries unasked). */
const askedOnly = (r: Row, names: ReadonlySet<string>) => Object.fromEntries(Object.entries(r).filter(([key]) => names.has(key))) as Row
/** A row's own id as Meta wrote it (digits or a composite), or null. */
const rowId = (r: Row): string | null => anyId(r.id)

async function listEachGroup(connectionId: string, operation: string, path: string, groups: FieldGroup[], query: Record<string, MetaQueryValue>, maxRows: number, withTotal = false) {
  const allNames = topLevelNames(groups.map((g) => g.fields).join(','))
  try {
    const read = await listPaged(connectionId, operation, path, { ...query, fields: groups.map((g) => g.fields).join(',') }, maxRows, withTotal)
    return { ...read, rows: read.rows.map((r) => askedOnly(r, allNames)), missing: [] as MissingPart[] }
  } catch (err) {
    if (groups.length < 2 || !fieldRefused(err)) throw err
  }
  const core = await listPaged(connectionId, `${operation}.core`, path, { ...query, fields: groups[0].fields }, maxRows, withTotal)
  const rows = core.rows.map((r) => askedOnly(r, topLevelNames(groups[0].fields)))
  // Re-review N6 — merged by the row's own id only: a row without one gets nothing from another read.
  const byId = new Map(rows.filter((r) => rowId(r)).map((r) => [rowId(r)!, r] as const))
  const missing: MissingPart[] = []
  for (const group of groups.slice(1)) {
    try {
      const read = await listPaged(connectionId, `${operation}.${group.name}`, path, { ...query, fields: `id,${group.fields}` }, maxRows)
      // Only the fields this group asked are merged (never anything else an answer carries).
      const names = topLevelNames(group.fields)
      for (const r of read.rows) {
        const id = rowId(r)
        const row = id ? byId.get(id) : undefined
        if (row) for (const [key, value] of Object.entries(r)) if (names.has(key)) row[key] = value
      }
    } catch (err) {
      if (!fieldRefused(err)) throw err
      missing.push({ part: group.name, sentence: err.failure.sentence })
    }
  }
  return { rows, more: core.more, totalCount: core.totalCount, missing }
}

// ── the chosen portfolio, and what another business in Nexus uses ─────────────────────────────────────────────────

export const NO_PORTFOLIO = 'The chosen ad account belongs to no Meta business portfolio, so there is no portfolio to read (a person checks the ad account in Meta Business settings).'

/** The chosen ad account's business portfolio — the ONE portfolio these reads touch. */
export function chosenPortfolio(account: MetaChosenAccount): string {
  if (!account.businessId) throw new MetaLiveRefusal(NO_PORTFOLIO)
  return account.businessId
}

/** Does another business in Nexus use an ad account of this portfolio (nexus_meta_links_taken PORTFOLIO)? */
export async function portfolioShared(portfolioId: string): Promise<boolean> {
  return (await takenIds('PORTFOLIO', [portfolioId])).has(portfolioId)
}

const SHARED = (what: string, where: string) => `Another business in Nexus uses an ad account of this Meta business portfolio, so its ${what} are not read here: they would show that business's too. A person sees them in Meta Business settings › ${where}.`
export const PEOPLE_SHARED = SHARED('people', 'Users')
export const PARTNERS_SHARED = SHARED('partners', 'Users › Partners')
export const DOMAINS_SHARED = SHARED('domains', 'Brand safety › Domains')
/** Review A-F3 — step 42 changes nothing on a portfolio two businesses in Nexus share (a rename or a two-factor rule is both businesses'). */
export const SETTINGS_SHARED = 'Another business in Nexus uses an ad account of this Meta business portfolio, so Nexus does not read its settings for a change: a rename, a time zone or a two-factor rule would change that business\'s portfolio too. A person changes it in Meta Business settings › Business info.'

/** The portfolio and whether another business in Nexus uses it; `refuse`: the sentence when it does. */
async function scopeOf(account: MetaChosenAccount, refuse?: string): Promise<{ portfolioId: string; shared: boolean }> {
  const portfolioId = chosenPortfolio(account)
  const shared = await portfolioShared(portfolioId)
  if (shared && refuse) throw new MetaLiveRefusal(refuse)
  return { portfolioId, shared }
}

/** What Nexus may say about one asset: its details, its id and the flag, or its id only. */
export type Seen = 'details' | 'taken' | 'idOnly'
/**
 * THE rule (step 12 fix A1's client-catalog rule, for every list here; review A-F1), in this order: the asset chosen here →
 * details; another business in Nexus picked it, or uses the owner portfolio Meta named → taken; the chosen portfolio is
 * shared with another business in Nexus → id only; a Page, Instagram account or ad account whose id is not plain digits
 * (`checkable: false`: the taken table cannot be asked) → id only; the chosen portfolio owns it → details; Meta named its
 * owner portfolio (and no other business in Nexus uses it: checked above) → details; anything else → id only.
 *
 * It decides only what Nexus may SAY about an asset, never whether a change may touch it: step 43's claim / remove gate needs
 * the asset chosen here or owned by the unshared chosen portfolio, a digits id and not taken.
 */
export function seenAs(a: { chosen?: boolean; taken?: boolean; ownerTaken?: boolean; shared: boolean; ownedHere: boolean; ownerNamed?: boolean; checkable?: boolean }): Seen {
  if (a.chosen) return 'details'
  if (a.taken || a.ownerTaken) return 'taken'
  if (a.shared) return 'idOnly'
  if (a.checkable === false) return 'idOnly'
  if (a.ownedHere || a.ownerNamed) return 'details'
  return 'idOnly'
}

/** One asset as Nexus says it: under its own id key; details only when seen as details. */
function shown(seen: Seen, idKey: string, id: string | null, details: Row, always: Row = {}): Row {
  // Re-review N6 — a row Meta gave no id is never named (Nexus could check nothing about it).
  if (!id) return { [idKey]: null, ...always, takenByAnotherBusiness: null }
  if (seen === 'taken') return { [idKey]: id, takenByAnotherBusiness: true }
  if (seen === 'idOnly') return { [idKey]: id, ...always, takenByAnotherBusiness: null }
  return { [idKey]: id, ...details, ...always, takenByAnotherBusiness: false }
}

/** Which ids of one product another business in Nexus picked (a non-digit id is never sent). */
const takenOf = (product: MetaTakenProduct, ids: Array<string | null>) => takenIds(product, ids.filter((id): id is string => digits(id)))

/** Who made or changed something: Nexus's own system user by name; anyone else Meta's id only (meta-business-people names people). */
function whoOf(account: MetaChosenAccount, v: unknown) {
  const id = idText(obj(v)?.id)
  if (!id) return null
  const nexus = id === (account.connection.systemUser?.id ?? null)
  return nexus ? { id, who: 'Nexus\'s own system user', name: account.connection.systemUser?.name ?? null } : { id, who: 'a person or system user of the portfolio (meta-business-people view people / system-users names them)' }
}

/** A read Meta answers only to an admin token: its permission refusal comes with the plain next step. */
async function withNote<T>(work: () => Promise<T>, note: string): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled && err.failure.permissionDenied) throw new MetaLiveRefusal(`${err.message} ${note}`)
    throw err
  }
}

// ── meta-business ────────────────────────────────────────────────────────────────────────────────────────────────

export const BUSINESS_VIEWS = ['portfolio', 'businesses', 'domains'] as const
export type BusinessView = typeof BUSINESS_VIEWS[number]

export const VERIFICATION_WORDS: Readonly<Record<string, string>> = {
  verified: 'Verified', pending: 'Pending: Meta is reviewing it', pending_need_more_info: 'Pending: Meta needs more information',
  pending_submission: 'Started, not yet submitted', not_verified: 'Not verified', failed: 'Failed', rejected: 'Rejected', revoked: 'Revoked',
  expired: 'Expired: verify again', ineligible: 'Not eligible for verification',
}
export const TWO_FACTOR_WORDS: Readonly<Record<string, string>> = { none: 'Not required', admin_required: 'Required for admins', all_required: 'Required for everyone' }

/** BM-002, BM-003 — the portfolio node, in groups (one Meta refuses never costs the others or the core). */
export const BUSINESS_GROUPS: FieldGroup[] = [
  { name: 'core', fields: 'id,name,created_time,updated_time,timezone_id,two_factor_type,verification_status,vertical,vertical_id,primary_page{id,name},link,is_hidden,profile_picture_uri' },
  { name: 'more', fields: 'block_offline_analytics,payment_account_id,extended_updated_time' },
  // created_by / updated_by: BusinessUser | SystemUser — their id only.
  { name: 'people', fields: 'created_by{id},updated_by{id}' },
  { name: 'messaging', fields: 'marketing_messages_onboarding_status{status,time},whatsapp_business_manager_messaging_limit' },
  // Only the status parts: ManagedPartnerBusiness also holds a retailer's credit limit and a sales contact's e-mail.
  { name: 'collaborativeAds', fields: 'collaborative_ads_managed_partner_eligibility{is_eligible,reason_code,reason_description},collaborative_ads_managed_partner_business_info{seller_business_status,partition_type,vertical}' },
]

/**
 * The settings step 42 (set-meta-business-settings) changes and puts back: exactly these, Meta's names (POST /{business_id}
 * takes name, timezone_id, primary_page, vertical, two_factor_type). The READ of `vertical` is a string Meta does not
 * define further while the POST takes an enum (NOT_SET … OTHER): LIVE-PROBES BM-002 settles its format before an undo
 * sends it back.
 */
export const BUSINESS_SETTINGS_FIELDS = 'id,name,timezone_id,primary_page{id},vertical,two_factor_type'
export interface BusinessSettings { portfolioId: string; name: string | null; timezoneId: number | null; primaryPageId: string | null; vertical: string | null; twoFactorType: string | null }
/** Review A-F7 — the name exactly as Meta keeps it (never trimmed), so an undo puts back what was there. */
export function businessSettingsOf(portfolioId: string, b: Row): BusinessSettings {
  return { portfolioId, name: typeof b.name === 'string' ? b.name : null, timezoneId: num(b.timezone_id), primaryPageId: idText(obj(b.primary_page)?.id), vertical: typeof b.vertical === 'string' ? b.vertical : null, twoFactorType: text(b.two_factor_type) }
}
/**
 * The chosen portfolio's own settings as they are this minute (step 42's preview and undo read them here). Review A-F3:
 * refused (SETTINGS_SHARED, before any Meta call) when another business in Nexus uses the portfolio.
 */
export async function readBusinessSettings(account: MetaChosenAccount, operation = 'business.settings'): Promise<BusinessSettings> {
  const { portfolioId } = await scopeOf(account, SETTINGS_SHARED)
  const read = await metaReadOne({ connectionId: account.connectionId }, { operation, path: portfolioId, query: { fields: BUSINESS_SETTINGS_FIELDS } })
  return businessSettingsOf(portfolioId, read.body as Row)
}

async function businessPortfolio(account: MetaChosenAccount) {
  const { portfolioId, shared } = await scopeOf(account)
  const { body, missing } = await readGroups(account.connectionId, 'business.portfolio', portfolioId, BUSINESS_GROUPS)
  const settings = businessSettingsOf(portfolioId, body)
  const primary = obj(body.primary_page)
  const primaryId = idText(primary?.id)
  const takenPages = await takenOf('PAGE', [primaryId])
  const status = text(body.verification_status)
  const twoFactor = settings.twoFactorType
  const onboarding = obj(body.marketing_messages_onboarding_status)
  const eligibility = obj(body.collaborative_ads_managed_partner_eligibility)
  const partnerInfo = obj(body.collaborative_ads_managed_partner_business_info)
  return {
    portfolioId, name: text(body.name), sharedWithAnotherBusiness: shared,
    verification: { status, statusText: status ? VERIFICATION_WORDS[status] ?? status : null },
    settings: {
      name: settings.name, timeZoneId: settings.timezoneId, vertical: settings.vertical, verticalId: num(body.vertical_id),
      twoFactorType: twoFactor, twoFactorText: twoFactor ? TWO_FACTOR_WORDS[twoFactor] ?? twoFactor : null,
      // A primary Page is one the portfolio owns (#3918): named unless shared, taken, or not checkable.
      primaryPage: primaryId ? shown(seenAs({ chosen: primaryId === account.pageId, taken: takenPages.has(primaryId), shared, ownedHere: true }), 'pageId', primaryId, { name: text(primary?.name), chosenHere: primaryId === account.pageId }) : null,
    },
    createdTime: text(body.created_time), updatedTime: text(body.updated_time),
    createdBy: whoOf(account, body.created_by), updatedBy: whoOf(account, body.updated_by),
    link: text(body.link), hidden: bool(body.is_hidden), profilePictureUri: text(body.profile_picture_uri),
    blockOfflineAnalytics: bool(body.block_offline_analytics), paymentAccountId: idText(body.payment_account_id), creditsUpdatedTime: text(body.extended_updated_time),
    marketingMessagesOnboarding: onboarding ? { status: text(onboarding.status), time: text(onboarding.time) } : null,
    whatsappMessagingLimit: text(body.whatsapp_business_manager_messaging_limit),
    collaborativeAds: eligibility || partnerInfo ? {
      managedPartnerEligible: bool(eligibility?.is_eligible), reasonCode: text(eligibility?.reason_code) ?? num(eligibility?.reason_code), reason: text(eligibility?.reason_description),
      managedPartnerStatus: partnerInfo ? plainOf(partnerInfo) : null,
    } : null,
    missing,
    notes: [
      'verification: Meta\'s business verification of this portfolio (needed for some permissions, real lead downloads and more system users). Starting or finishing it is a person\'s step in Meta Business settings › Security centre: Meta documents no API for it (verification_status is read only).',
      'settings: what an admin may change (name, time zone, primary Page, industry, the two-factor rule) — the Owner\'s own step in Meta\'s screens (D1: set-meta-business-settings gives the steps and reads the result); turning the two-factor rule on can lock out people who have no two-factor (meta-business-people view people shows each one\'s status).',
      'Meta keeps the business\'s legal name, address, phone number and website in Business settings › Business info: no API field reads or changes them.',
      'createdBy / updatedBy: Nexus\'s own system user by name; anyone else is Meta\'s id (meta-business-people names the people). paymentAccountId needs the ad-spend permission (billing: meta-billing).',
      ...(shared ? ['Another business in Nexus uses an ad account of this portfolio: its people, partners and domains are not read through Nexus, and its other assets are ids only.'] : []),
    ],
  }
}

/** BM-001 — the portfolios the system user belongs to; another business's is its id and the flag. */
async function businessList(connectionId: string | null, maxRows: number) {
  const connection = await metaConnectionFor(connectionId)
  const chosen = connection.adAccount?.businessId ?? null
  const read = await listGroups(connection.connectionId, 'business.businesses', 'me/businesses', [
    { name: 'core', fields: 'id,name' },
    { name: 'details', fields: 'verification_status,permitted_roles' },
  ], {}, maxRows)
  const ids = read.rows.map((r) => idText(r.id))
  const taken = await takenOf('PORTFOLIO', ids)
  return {
    chosenPortfolioId: chosen,
    businesses: read.rows.map((r) => {
      const id = idText(r.id)
      const status = text(r.verification_status)
      const details = { name: text(r.name), permittedRoles: strings(r.permitted_roles), verificationStatus: status, verificationText: status ? VERIFICATION_WORDS[status] ?? status : null }
      if (id && id === chosen) return { portfolioId: id, ...details, chosenAccountsPortfolio: true, sharedWithAnotherBusiness: taken.has(id) }
      if (id && taken.has(id)) return { portfolioId: id, takenByAnotherBusiness: true }
      return { portfolioId: id, ...details, chosenAccountsPortfolio: false, takenByAnotherBusiness: false }
    }),
    more: read.more, missing: read.missing,
    notes: [
      'The Meta business portfolios this connection\'s system user belongs to (a system user belongs to the one portfolio that made it, so usually one). The chosen ad account\'s portfolio is marked; one another business in Nexus uses is its id only.',
      'Only the chosen ad account\'s portfolio is read further (views portfolio and domains, and the other meta-business-… tools).',
    ],
  }
}

/** BM-004 — the portfolio's domains and Meta's verification state (fields SDK only: owneddomain.py). */
async function businessDomains(account: MetaChosenAccount, maxRows: number) {
  const { portfolioId } = await scopeOf(account, DOMAINS_SHARED)
  const read = await listGroups(account.connectionId, 'business.domains', `${portfolioId}/owned_domains`, [
    { name: 'core', fields: 'id' },
    // Never verification_code (it proves ownership of the domain) or owner_business (always this portfolio).
    { name: 'sdkOnly', fields: 'domain_name,status' },
  ], {}, maxRows)
  return {
    portfolioId,
    domains: read.rows.map((r) => ({ domainId: anyId(r.id), domain: text(r.domain_name), status: text(r.status) })),
    more: read.more, missing: read.missing,
    notes: [
      'The web domains this portfolio owns in Meta and whether each is verified. A Conversions API event\'s event_source_url should be on a verified domain (meta-datasets checks the pixel\'s domains).',
      'Adding or verifying a domain is a person\'s step in Meta Business settings › Brand safety › Domains (meta tag, DNS record or file): Meta documents no API for it. Nexus does not read the verification code.',
    ],
  }
}

/** One view of the chosen ad account's business portfolio. */
export async function businessView(input: { connectionId?: string | null; view: BusinessView; maxRows?: number }) {
  const maxRows = clampRows(input.maxRows)
  if (input.view === 'businesses') return businessList(input.connectionId ?? null, maxRows)
  const account = await metaChosenAccount(input.connectionId)
  switch (input.view) {
    case 'portfolio': return businessPortfolio(account)
    case 'domains': return businessDomains(account, maxRows)
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

// ── meta-business-people ─────────────────────────────────────────────────────────────────────────────────────────

export const PEOPLE_VIEWS = ['people', 'system-users', 'invitations', 'invitation-assets', 'finance'] as const
export type PeopleView = typeof PEOPLE_VIEWS[number]

const NO_EMAILS = 'Names, roles, tasks and two-factor status only: Nexus never asks Meta for a person\'s e-mail address, first or last name, title, an invitation link or any token.'
/** Review B-F3 — Meta's System Users guide ("Retrieve"): the list needs an admin user's or admin system user's token. */
export const SYSTEM_USERS_NOTE = 'Meta\'s guide says listing system users needs an admin user\'s or an admin system user\'s token: when Nexus\'s system user is an Employee, Meta refuses — a person sees them in Business settings › Users › System users.'

/** BM-005 — the business users, the fields an admin screen needs. */
export const PEOPLE_GROUPS: FieldGroup[] = [
  { name: 'core', fields: 'id,name,role,finance_permission,ip_permission,two_fac_status' },
  // SDK only (businessuser.py): its own group, so a refusal never costs the people.
  { name: 'sdkOnly', fields: 'tasks,marked_for_removal' },
]
/** BM-006 — the system users (never a token: Meta has no such field, and the gateway refuses any field named *token*). */
export const SYSTEM_USER_GROUPS: FieldGroup[] = [
  { name: 'core', fields: 'id,name,role,created_time,finance_permission,ip_permission' },
  { name: 'creator', fields: 'created_by{id}' },
]
/** BM-007 — the pending invitations: never `email` (the invited address) or `invite_link` (anyone holding it can accept). */
export const INVITATION_GROUPS: FieldGroup[] = [
  { name: 'core', fields: 'id,role,status,created_time,expiration_time,updated_time,finance_role,invited_user_type' },
  { name: 'who', fields: 'created_by{id},updated_by{id}' },
  { name: 'sdkOnly', fields: 'tasks,ip_role' },
]

/**
 * One person. Review A-F4: `tasks` and `markedForRemoval` are null when Meta's SDK-only group was not read (named in
 * `missing`), never [] — an undo must not take "not read" for "no tasks". `role` holds Meta's base roles only (Admin /
 * Employee); the finance and ads-rights roles are their own fields.
 */
export interface PortfolioPerson { personId: string | null; name: string | null; role: string | null; financeRole: string | null; adsRightsRole: string | null; twoFactor: string | null; tasks: string[] | null; markedForRemoval: boolean | null }
const personOf = (r: Row): PortfolioPerson => ({
  personId: idText(r.id), name: text(r.name), role: text(r.role), financeRole: text(r.finance_permission), adsRightsRole: text(r.ip_permission),
  twoFactor: text(r.two_fac_status), tasks: stringsRead(r.tasks), markedForRemoval: bool(r.marked_for_removal),
})
const isAdmin = (role: string | null) => (role ?? '').toUpperCase() === 'ADMIN'

/** The portfolio's people as they are this minute (step 42's preview and undo read them here); refused when shared. */
export async function readPortfolioPeople(account: MetaChosenAccount, maxRows = 500) {
  const { portfolioId } = await scopeOf(account, PEOPLE_SHARED)
  const read = await listGroups(account.connectionId, 'people.businessUsers', `${portfolioId}/business_users`, PEOPLE_GROUPS, {}, clampRows(maxRows, 500), true)
  return { portfolioId, people: read.rows.map(personOf), totalCount: read.totalCount, more: read.more, missing: read.missing }
}

/**
 * One invitation. Review A-F4: `tasks` is null when Meta did not answer it (never [] for "not read"); `sdkRead: false` says the
 * SDK-only group (tasks, ip_role) was refused, so a null `adsRightsRole` is unknown too.
 */
export interface PortfolioInvitation {
  invitationId: string | null; role: string | null; status: string | null; financeRole: string | null; adsRightsRole: string | null; tasks: string[] | null; sdkRead: boolean
  invitedUserType: string[]; createdTime: string | null; expires: string | null; updatedTime: string | null; createdBy: ReturnType<typeof whoOf>; updatedBy: ReturnType<typeof whoOf>
}
/** The pending invitations as they are this minute (step 42 changes or cancels one by its id). */
export async function readInvitations(account: MetaChosenAccount, maxRows = 500) {
  const { portfolioId } = await scopeOf(account, PEOPLE_SHARED)
  // Re-review step-42 note — each group on its own: a refused tasks group never drops created_by (BM-035's undo finds the invitation by it).
  const read = await listEachGroup(account.connectionId, 'people.invitations', `${portfolioId}/pending_users`, INVITATION_GROUPS, {}, clampRows(maxRows, 500), true)
  const sdkRead = !read.missing.some((m) => m.part === 'sdkOnly')
  return {
    portfolioId, totalCount: read.totalCount, more: read.more, missing: read.missing,
    invitations: read.rows.map((r): PortfolioInvitation => ({
      invitationId: idText(r.id), role: text(r.role), status: text(r.status), financeRole: text(r.finance_role),
      adsRightsRole: text(r.ip_role), tasks: stringsRead(r.tasks), sdkRead,
      invitedUserType: strings(r.invited_user_type), createdTime: text(r.created_time), expires: text(r.expiration_time), updatedTime: text(r.updated_time),
      createdBy: whoOf(account, r.created_by), updatedBy: whoOf(account, r.updated_by),
    })),
  }
}

/** The system users as they are this minute (step 42's create-meta-system-user counts them; its rename keeps the old name). */
export async function readSystemUsers(account: MetaChosenAccount, maxRows = 500) {
  const { portfolioId } = await scopeOf(account, PEOPLE_SHARED)
  const read = await withNote(() => listGroups(account.connectionId, 'people.systemUsers', `${portfolioId}/system_users`, SYSTEM_USER_GROUPS, {}, clampRows(maxRows, 500), true), SYSTEM_USERS_NOTE)
  const nexus = account.connection.systemUser?.id ?? null
  const systemUsers = read.rows.map((r) => ({
    systemUserId: idText(r.id), name: typeof r.name === 'string' ? r.name : null, role: text(r.role), createdTime: text(r.created_time), createdBy: whoOf(account, r.created_by),
    financeRole: text(r.finance_permission), adsRightsRole: text(r.ip_permission), nexusSystemUser: !!nexus && idText(r.id) === nexus,
  }))
  return { portfolioId, systemUsers, totalCount: read.totalCount, more: read.more, missing: read.missing }
}

async function peoplePeople(account: MetaChosenAccount, maxRows: number) {
  const read = await readPortfolioPeople(account, maxRows)
  return {
    portfolioId: read.portfolioId, totalCount: read.totalCount,
    admins: read.people.filter((p) => isAdmin(p.role)).length,
    people: read.people, more: read.more, missing: read.missing,
    notes: [
      'role: the person\'s base role in the portfolio (Admin can do everything, including adding and removing people; Employee works on what they are given). financeRole and adsRightsRole: Meta\'s finance and ads-rights roles. tasks (Meta\'s SDK only): the person\'s roles as Meta lists them — null when Meta did not answer them (see missing), never "no tasks".',
      'twoFactor: whether the person has two-factor authentication on. Meta needs at least one admin (it refuses to remove the last one).',
      'What each person can reach on the chosen ad account: meta-account-access views people and by-person.',
      NO_EMAILS,
      'Inviting, changing or removing people is the Owner\'s own step in Meta\'s screens (D1): set-meta-business-people gives the steps and reads the result.',
    ],
  }
}

async function peopleSystemUsers(account: MetaChosenAccount, maxRows: number) {
  const read = await readSystemUsers(account, maxRows)
  const roles = read.systemUsers.map((s) => (s.role ?? '').toUpperCase())
  return {
    portfolioId: read.portfolioId, totalCount: read.totalCount,
    counts: { admin: roles.filter((r) => r === 'ADMIN').length, other: roles.filter((r) => r !== 'ADMIN').length },
    systemUsers: read.systemUsers, more: read.more, missing: read.missing,
    notes: [
      'System users are the portfolio\'s machine logins (Nexus acts as one: nexusSystemUser). role Admin reaches every asset of the portfolio; Employee only what is assigned to it.',
      'Meta\'s limits follow the app\'s Ads Management Standard Access feature: Standard 1 system user and 1 admin system user, Advanced 10 system users and still 1 admin system user ("Admin System User limits will stay at 1 admin").',
      'Meta documents a rename only (POST /{business_id}/system_users with system_user_id and name); it documents no role change and no delete (a person can invalidate a system user\'s tokens) — a person does those in Business settings › Users › System users (D1: create-meta-system-user gives the steps for a new system user, a rename or a removal).',
      SYSTEM_USERS_NOTE,
      'Nexus never reads a system user\'s token here.',
    ],
  }
}

async function peopleInvitations(account: MetaChosenAccount, maxRows: number) {
  const read = await readInvitations(account, maxRows)
  return {
    portfolioId: read.portfolioId, totalCount: read.totalCount,
    invitations: read.invitations, more: read.more, missing: read.missing,
    notes: [
      'Invitations to join the portfolio that are not accepted yet, with the role and tasks each will give and when it expires (tasks null with sdkRead false: Meta did not answer them). view invitation-assets (invitationId) shows which assets each one gives.',
      'Nexus does not show whom an invitation went to (an e-mail address) or its invitation link (anyone holding it could accept it): a person sees them in Meta Business settings › Users › People.',
      'Changing the role of an invitation or cancelling it is the Owner\'s own step in Meta\'s screens (D1): set-meta-business-people gives the steps and reads the result.',
    ],
  }
}

const ASSET_PRODUCT: Partial<Record<MetaInvitationAssetType, MetaTakenProduct>> = { AD_ACCOUNT: 'AD_ACCOUNT', PAGE: 'PAGE', INSTAGRAM_ACCOUNT_V2: 'INSTAGRAM' }
const INVITATION_ASSET_EDGES = [['owned', 'assigned_owned_assets'], ['client', 'assigned_client_assets']] as const

/**
 * BM-900, BM-901 — the assets one pending invitation of the chosen portfolio will give, type by type. Review B-F7: Meta does
 * not say the rows' `id` is the asset's own id (BusinessObject has a separate `asset`; BusinessPermissionProxy has no page),
 * so: an OWNED Page, Instagram account or ad account is named only by its `asset{id}` (own group), when that is digits and
 * not taken; another owned kind is the unshared portfolio's own (named); every CLIENT asset is its id only — until LIVE-PROBES
 * BM-900 shows what `id` is.
 */
async function peopleInvitationAssets(account: MetaChosenAccount, input: { invitationId: string | null; assetTypes: MetaInvitationAssetType[] | null; maxRows: number }) {
  const invitationId = input.invitationId ? metaObjectId(input.invitationId) : null
  if (!invitationId) throw new MetaLiveRefusal('Name the invitation (invitationId, digits: view invitations lists them).')
  const pending = await readInvitations(account, 500)
  if (!pending.invitations.some((inv) => inv.invitationId === invitationId)) {
    throw new MetaLiveRefusal(pending.more
      ? 'That invitation is not among the first 500 pending invitations of the chosen ad account\'s business portfolio, so what it gives is not read.'
      : 'That is not a pending invitation of the chosen ad account\'s business portfolio (view invitations lists them), so what it gives is not read.')
  }
  const types = input.assetTypes?.length ? [...new Set(input.assetTypes)] : [...META_INVITATION_DEFAULT_TYPES]
  const assets: Record<string, unknown> = {}
  const missing: MissingPart[] = []
  for (const type of types) {
    const product = ASSET_PRODUCT[type]
    const out: Record<string, unknown> = {}
    for (const [side, edge] of INVITATION_ASSET_EDGES) {
      const groups: FieldGroup[] = [
        { name: 'core', fields: 'id,role,permitted_tasks' },
        // BusinessObject's name and asset (SDK); BusinessPermissionProxy has no node page: Meta's answer decides.
        { name: 'name', fields: 'name' },
        ...(side === 'owned' && product ? [{ name: 'asset', fields: 'asset{id}' }] : []),
      ]
      const read = await part(() => listEachGroup(account.connectionId, `people.invitation.${edge}`, `${invitationId}/${edge}`, groups, { asset_type: type }, input.maxRows))
      if (!read.value) { missing.push({ part: `${type} ${side}`, sentence: read.notRead! }); out[side] = null; continue }
      missing.push(...read.value.missing.map((m) => ({ part: `${type} ${side} ${m.part}`, sentence: m.sentence })))
      const assetIdOf = (r: Row) => (type === 'AD_ACCOUNT' ? metaAdAccountId(obj(r.asset)?.id) : idText(obj(r.asset)?.id))
      const taken = product ? await takenOf(product, read.value.rows.map(assetIdOf)) : new Set<string>()
      out[side] = read.value.rows.map((r) => {
        const id = anyId(r.id)
        const assetId = product ? assetIdOf(r) : null
        const chosenId = type === 'AD_ACCOUNT' ? account.adAccountId : type === 'PAGE' ? account.pageId : type === 'INSTAGRAM_ACCOUNT_V2' ? account.instagramId : null
        const chosen = !!assetId && assetId === chosenId
        const seen = seenAs({ chosen, taken: !!assetId && taken.has(assetId), shared: false, ownedHere: side === 'owned', checkable: product ? digits(assetId) : true })
        return shown(seen, 'id', id, { ...(assetId ? { assetId } : {}), name: text(r.name), role: text(r.role) }, { tasks: strings(r.permitted_tasks) })
      })
      if (read.value.more) out[`${side}More`] = true
    }
    assets[type] = out
  }
  return {
    portfolioId: pending.portfolioId, invitationId, assetTypes: types, assets, missing,
    notes: [
      'What the invited person gets once they accept, type by type: owned = this portfolio\'s own assets, client = assets another portfolio shares with this one. tasks: what the person may do on each.',
      'Meta does not say whose a client asset is, so every client one is its id only. An owned Page, Instagram account or ad account is named only when Meta answers its own id (assetId) and no other business in Nexus picked it; another owned asset is this portfolio\'s own. One another business in Nexus picked is its id and the flag.',
      `Meta asks one asset type per read; Nexus reads ${META_INVITATION_DEFAULT_TYPES.join(', ')} unless assetTypes names others.`,
    ],
  }
}

/** BM-010 — finance roles (FinanceObject, SDK: finance_permission, user — an Object, so `user{id,name}` falls back to `user`). */
async function peopleFinance(account: MetaChosenAccount, maxRows: number) {
  const { portfolioId } = await scopeOf(account, PEOPLE_SHARED)
  const path = `${portfolioId}/finance_permissions`
  let read: Awaited<ReturnType<typeof listPaged>>
  let note: string | null = null
  try {
    read = await listPaged(account.connectionId, 'people.finance', path, { fields: 'finance_permission,user{id,name}' }, maxRows)
  } catch (err) {
    // Review B-F11 — Meta types `user` only as an Object: when it refuses the sub-fields, the field is read whole (only its
    // id and name are passed on).
    if (!fieldRefused(err)) throw err
    note = `Meta refused the person's id and name inside the list (${err.failure.sentence}); they were read whole, id and name kept.`
    read = await listPaged(account.connectionId, 'people.finance.whole', path, { fields: 'finance_permission,user' }, maxRows)
  }
  return {
    portfolioId,
    financeRoles: read.rows.map((r) => ({ personId: idText(obj(r.user)?.id), name: text(obj(r.user)?.name), financeRole: text(r.finance_permission) })),
    more: read.more, ...(note ? { missing: [{ part: 'user', sentence: note }] } : {}),
    notes: [
      'Who holds a finance role in the portfolio (finance editor: payment methods and invoices; finance analyst: sees them). The base roles: view people.',
      'Meta documents no change on this edge; its business-user role update lists FINANCE_EDITOR and FINANCE_ANALYST (what that sets is not documented) — a person changes finance roles in Business settings › Users › People.',
    ],
  }
}

/** One view of the chosen ad account's business portfolio's people. */
export async function peopleView(input: { connectionId?: string | null; view: PeopleView; invitationId?: string | null; assetTypes?: MetaInvitationAssetType[] | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const maxRows = clampRows(input.maxRows)
  switch (input.view) {
    case 'people': return peoplePeople(account, maxRows)
    case 'system-users': return peopleSystemUsers(account, maxRows)
    case 'invitations': return peopleInvitations(account, maxRows)
    case 'invitation-assets': return peopleInvitationAssets(account, { invitationId: input.invitationId ?? null, assetTypes: input.assetTypes ?? null, maxRows })
    case 'finance': return peopleFinance(account, maxRows)
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

// ── meta-business-assets ─────────────────────────────────────────────────────────────────────────────────────────

export const ASSET_VIEWS = ['pages', 'page-children', 'store-locations', 'instagram', 'apps', 'asset-groups', 'client-objects', 'signal-containers', 'whatsapp', 'whatsapp-numbers'] as const
export type AssetView = typeof ASSET_VIEWS[number]
/** The lists of each view (default: every list of the view). */
export const ASSET_LISTS = {
  pages: ['owned', 'client', 'pending-owned', 'pending-client'],
  instagram: ['assets', 'owned', 'client', 'all', 'converted'],
  apps: ['owned', 'client', 'pending'],
  'asset-groups': ['owned', 'client'],
  'signal-containers': ['owned', 'client', 'pending'],
} as const
export const ASSET_LIST_NAMES = [...new Set(Object.values(ASSET_LISTS).flat())] as [string, ...string[]]

/** One list of a view: its edge, field groups (the core first, holding `id`), whether the chosen portfolio owns its rows. */
type ListSpec = { list: string; edge: string; groups: FieldGroup[]; ownedHere: boolean; total?: boolean }

const PAGE_DETAILS: FieldGroup = { name: 'details', fields: 'category,link,is_published' }
// Review B-F12 — "can be read with Page Public Metadata Access": its own group.
const PAGE_VERIFICATION: FieldGroup = { name: 'verification', fields: 'verification_status' }
/** BM-011 — the portfolio's Pages: owned, client (+ permitted_tasks; owner `business`), and the claims and requests still pending. */
export const PAGE_LISTS: readonly ListSpec[] = [
  { list: 'owned', edge: 'owned_pages', groups: [{ name: 'core', fields: 'id,name' }, PAGE_DETAILS, PAGE_VERIFICATION], ownedHere: true, total: true },
  // The owner (Page `business`: a Page admin's token, v26 page reference) in its own group: a refused owner leaves it unknown.
  { list: 'client', edge: 'client_pages', groups: [{ name: 'core', fields: 'id,name,permitted_tasks' }, PAGE_DETAILS, PAGE_VERIFICATION, { name: 'owner', fields: 'business{id}' }], ownedHere: false, total: true },
  // A pending Page is not this portfolio's yet and its request names no owner: ids only.
  { list: 'pending-owned', edge: 'pending_owned_pages', groups: [{ name: 'core', fields: 'id,page{id,name}' }], ownedHere: false, total: true },
  { list: 'pending-client', edge: 'pending_client_pages', groups: [{ name: 'core', fields: 'id,page{id,name},permitted_tasks' }], ownedHere: false, total: true },
]
/** BM-012 — Instagram: the business assets (SDK only) and the IG accounts owned, shared in, all and converted. */
export const INSTAGRAM_LISTS: readonly ListSpec[] = [
  { list: 'assets', edge: 'owned_instagram_assets', groups: [{ name: 'core', fields: 'id,ig_user_id,ig_username' }], ownedHere: true },
  // InstagramBusinessAsset has no owner field: a client one is its ids only.
  { list: 'assets', edge: 'client_instagram_assets', groups: [{ name: 'core', fields: 'id,ig_user_id,ig_username' }], ownedHere: false },
  { list: 'owned', edge: 'owned_instagram_accounts', groups: [{ name: 'core', fields: 'id,username' }], ownedHere: true },
  // The owner (IGUser owner_business, SDK iguser.py) in its own group, as for client Pages.
  { list: 'client', edge: 'client_instagram_accounts', groups: [{ name: 'core', fields: 'id,username,permitted_tasks' }, { name: 'owner', fields: 'owner_business{id}' }], ownedHere: false },
  { list: 'all', edge: 'instagram_accounts', groups: [{ name: 'core', fields: 'id,username' }, { name: 'owner', fields: 'owner_business{id}' }], ownedHere: false },
  // Re-review N1 — "converted into business instagram accounts": Meta does not say owned by this portfolio; its owner as for `all`.
  { list: 'converted', edge: 'instagram_business_accounts', groups: [{ name: 'core', fields: 'id,username' }, { name: 'owner', fields: 'owner_business{id}' }], ownedHere: false },
]
/** BM-015 — apps: owned, client (+ permitted_tasks; owner SDK only) and requests still pending (no owner: ids only). */
export const APP_LISTS: readonly ListSpec[] = [
  { list: 'owned', edge: 'owned_apps', groups: [{ name: 'core', fields: 'id,name' }, { name: 'details', fields: 'category,link' }], ownedHere: true, total: true },
  { list: 'client', edge: 'client_apps', groups: [{ name: 'core', fields: 'id,name,permitted_tasks' }, { name: 'owner', fields: 'business{id}' }], ownedHere: false, total: true },
  { list: 'pending', edge: 'pending_client_apps', groups: [{ name: 'core', fields: 'id,application{id,name},is_requested,permitted_tasks' }], ownedHere: false },
]
/** BM-016 — business asset groups: owned and client (+ permitted_tasks); the owner SDK only. */
export const ASSET_GROUP_LISTS: readonly ListSpec[] = [
  { list: 'owned', edge: 'business_asset_groups', groups: [{ name: 'core', fields: 'id,name' }], ownedHere: true, total: true },
  { list: 'client', edge: 'client_business_asset_groups', groups: [{ name: 'core', fields: 'id,name,permitted_tasks' }, { name: 'owner', fields: 'owner_business{id}' }], ownedHere: false, total: true },
]
const SIGNAL_DETAILS: FieldGroup = { name: 'details', fields: 'name,is_unavailable,primary_container_id,is_eligible_for_sharing_to_ad_account,is_eligible_for_sharing_to_business' }
/** BM-018 — offsite signal containers: owned, client (+ permitted_tasks), pending shared; every field SDK only. */
export const SIGNAL_LISTS: readonly ListSpec[] = [
  { list: 'owned', edge: 'owned_offsite_signal_container_business_objects', groups: [{ name: 'core', fields: 'id' }, SIGNAL_DETAILS], ownedHere: true, total: true },
  { list: 'client', edge: 'client_offsite_signal_container_business_objects', groups: [{ name: 'core', fields: 'id,permitted_tasks' }, SIGNAL_DETAILS, { name: 'owner', fields: 'business{id}' }], ownedHere: false, total: true },
  { list: 'pending', edge: 'pending_shared_offsite_signal_container_business_objects', groups: [{ name: 'core', fields: 'id' }, SIGNAL_DETAILS, { name: 'owner', fields: 'business{id}' }], ownedHere: false, total: true },
]

interface ListRead { spec: ListSpec; rows: Row[]; more: boolean; totalCount: number | null }

/** Each list of a view as its own part (one Meta refuses never costs the others); each group of a list fails on its own. */
async function readLists(account: MetaChosenAccount, portfolioId: string, operation: string, specs: readonly ListSpec[], asked: string | null, maxRows: number) {
  const chosen = specs.filter((s) => !asked || s.list === asked)
  if (!chosen.length) throw new MetaLiveRefusal(`list "${asked}" is not one of this view (${[...new Set(specs.map((s) => s.list))].join(', ')}).`)
  const reads: ListRead[] = []
  const missing: MissingPart[] = []
  for (const spec of chosen) {
    const read = await part(() => listEachGroup(account.connectionId, `${operation}.${spec.edge}`, `${portfolioId}/${spec.edge}`, spec.groups, {}, maxRows, !!spec.total))
    if (!read.value) { missing.push({ part: spec.edge, sentence: read.notRead! }); continue }
    missing.push(...read.value.missing.map((m) => ({ part: `${spec.edge} ${m.part}`, sentence: m.sentence })))
    reads.push({ spec, rows: read.value.rows, more: read.value.more, totalCount: read.value.totalCount })
  }
  return { reads, missing }
}

/** Lists by edge, each `{ list, edge, items, more, totalCount }`. */
const listsOut = (reads: ListRead[], map: (read: ListRead) => unknown[]) => reads.map((read) => ({ list: read.spec.list, edge: read.spec.edge, totalCount: read.totalCount, items: map(read), more: read.more }))
/**
 * Re-review N3 — on a list NOT owned here, an owner Meta names counts only when it is another portfolio: the SDK-only owner
 * fields might name the portfolio that reads, not the one that owns, and the owned lists already say what is ours.
 */
const namedOwner = (owner: string | null, ownedHere: boolean, portfolioId: string | null) => !!owner && (ownedHere || owner !== portfolioId)
/** The owner portfolio Meta named on a row (`business{id}` or `owner_business{id}`), digits only. */
const ownerOf = (r: Row): string | null => idText(obj(r.business)?.id) ?? idText(obj(r.owner_business)?.id)
/** The owner portfolios another business in Nexus uses — never the chosen portfolio itself (when it is shared, `shared` decides). */
const ownersTaken = (reads: ListRead[], portfolioId: string) => takenOf('PORTFOLIO', reads.flatMap((read) => read.rows.map(ownerOf)).filter((id) => id !== portfolioId))
const tasksOf = (r: Row) => (r.permitted_tasks !== undefined ? { permittedTasks: strings(r.permitted_tasks) } : {})

const ONE_RULE = 'An asset this portfolio does not own is named only when Meta names its owner portfolio and no other business in Nexus uses that portfolio; one another business in Nexus picked, or whose owner portfolio it uses, is its id and the flag; any other is its id only (takenByAnotherBusiness null: Nexus cannot tell whose it is).'

async function assetPages(account: MetaChosenAccount, scope: { portfolioId: string; shared: boolean }, list: string | null, maxRows: number) {
  const { reads, missing } = await readLists(account, scope.portfolioId, 'assets.pages', PAGE_LISTS, list, maxRows)
  const pageOfRow = (r: Row, pending: boolean) => (pending ? obj(r.page) ?? {} : r)
  const taken = await takenOf('PAGE', reads.flatMap((read) => read.rows.map((r) => idText(pageOfRow(r, read.spec.list.startsWith('pending')).id))))
  const owners = await ownersTaken(reads, scope.portfolioId)
  return {
    portfolioId: scope.portfolioId, chosenPageId: account.pageId,
    lists: listsOut(reads, (read) => read.rows.map((r) => {
      const pending = read.spec.list.startsWith('pending')
      const page = pageOfRow(r, pending)
      const id = anyId(page.id)
      const owner = ownerOf(r)
      const seen = seenAs({
        chosen: !!id && id === account.pageId, taken: digits(id) && taken.has(id!), ownerTaken: !!owner && owners.has(owner),
        shared: scope.shared, ownedHere: read.spec.ownedHere, ownerNamed: namedOwner(owner, read.spec.ownedHere, scope.portfolioId), checkable: digits(id),
      })
      const row = shown(seen, 'pageId', id, {
        name: text(page.name), chosenHere: !!id && id === account.pageId,
        ...(pending ? {} : { category: text(page.category), link: text(page.link), published: bool(page.is_published), verificationStatus: text(page.verification_status) }),
      }, tasksOf(r))
      return pending ? { requestId: anyId(r.id), ...row } : row
    })),
    missing,
    notes: [
      'owned: Pages this portfolio owns; client: Pages another portfolio lets it use (permittedTasks: what it may do); pending-owned / pending-client: claims and access requests the Page\'s admins have not answered yet (ids only: the Page is not this portfolio\'s yet, and Meta names no owner; Meta answers the pending client Pages only to an admin system user — it says so when it refuses).',
      ONE_RULE + ' A client Page\'s owner is Meta\'s `business` field, which it answers only to a Page admin\'s token: when it refuses, the client Pages are ids only (see missing).',
      'The Pages the system user itself has a role on: meta-connection view choices; the Pages the chosen ad account promotes: meta-account-access view pages. A business with a global brand Page: view page-children; a Page\'s store locations: view store-locations.',
      'Claiming, requesting or removing a Page is an admin\'s change a person approves (a claim needs someone who has been a Page admin for over 7 days).',
      ...(scope.shared ? ['Another business in Nexus uses an ad account of this portfolio: every Page but the one chosen here is its id only.'] : []),
    ],
  }
}

async function assetPageChildren(account: MetaChosenAccount, maxRows: number) {
  const pageId = pageOf(account)
  const scope = account.businessId ? await scopeOf(account) : { portfolioId: null, shared: false }
  const read = await onPage(() => listEachGroup(account.connectionId, 'assets.pageChildren', `${pageId}/global_brand_children`, [
    { name: 'core', fields: 'id,name,link' },
    { name: 'owner', fields: 'business{id}' },
  ], {}, maxRows))
  const taken = await takenOf('PAGE', read.rows.map((r) => idText(r.id)))
  const owners = await takenOf('PORTFOLIO', read.rows.map(ownerOf).filter((id) => id !== scope.portfolioId))
  return {
    pageId,
    children: read.rows.map((r) => {
      const id = anyId(r.id)
      const owner = ownerOf(r)
      const seen = seenAs({
        chosen: id === account.pageId, taken: digits(id) && taken.has(id!), ownerTaken: !!owner && owners.has(owner), shared: scope.shared,
        ownedHere: !!owner && owner === scope.portfolioId, ownerNamed: !!owner, checkable: digits(id),
      })
      return shown(seen, 'pageId', id, { name: text(r.name), link: text(r.link) })
    }),
    more: read.more, missing: read.missing,
    notes: [
      'The child Pages of the chosen Page when it is a global brand Page (one brand, one Page per country or language). A Page that is not one answers an empty list.',
      'Meta answers it to a token that can do the MANAGE task on the Page (the system user needs the Page assigned with full control). ' + ONE_RULE,
    ],
  }
}

async function assetStoreLocations(account: MetaChosenAccount, maxRows: number) {
  const pageId = pageOf(account)
  const read = await onPage(() => listEachGroup(account.connectionId, 'assets.storeLocations', `${pageId}/store_locations`, [
    { name: 'core', fields: 'id,store_code' },
    { name: 'details', fields: 'full_address,zip_code,phone_number,hours,price_range,pickup_options' },
  ], {}, maxRows))
  return {
    pageId,
    storeLocations: read.rows.map((r) => ({
      storeLocationId: anyId(r.id), storeCode: text(r.store_code), address: text(r.full_address), zip: text(r.zip_code), phone: text(r.phone_number),
      hours: r.hours === undefined ? null : tidy(r.hours), priceRange: text(r.price_range), pickupOptions: strings(r.pickup_options),
    })),
    more: read.more, missing: read.missing,
    notes: [
      'The shops of the chosen Page (a Store Page): a lead form\'s store-locator question and store-visit ads use them. A Page with no store locations answers an empty list.',
      'This edge is read only; Meta\'s Page Locations API (/{page-id}/locations, with a Page token; creating locations is limited to selected developers) manages location Pages — Nexus does not use it. A person changes them in Meta\'s screens.',
    ],
  }
}

async function assetInstagram(account: MetaChosenAccount, scope: { portfolioId: string; shared: boolean }, list: string | null, maxRows: number) {
  const { reads, missing } = await readLists(account, scope.portfolioId, 'assets.instagram', INSTAGRAM_LISTS, list, maxRows)
  const igOf = (read: ListRead, r: Row) => (read.spec.list === 'assets' ? anyId(r.ig_user_id) : anyId(r.id))
  const taken = await takenOf('INSTAGRAM', reads.flatMap((read) => read.rows.map((r) => igOf(read, r))))
  const owners = await ownersTaken(reads, scope.portfolioId)
  return {
    portfolioId: scope.portfolioId, chosenInstagramId: account.instagramId,
    lists: listsOut(reads, (read) => read.rows.map((r) => {
      const igId = igOf(read, r)
      const owner = ownerOf(r)
      // Review A-F1 — an Instagram account is named only by a digits id Nexus could check (an asset without ig_user_id: ids only).
      const seen = seenAs({
        chosen: !!igId && igId === account.instagramId, taken: digits(igId) && taken.has(igId!), ownerTaken: !!owner && owners.has(owner),
        shared: scope.shared, ownedHere: read.spec.ownedHere, ownerNamed: namedOwner(owner, read.spec.ownedHere, scope.portfolioId), checkable: digits(igId),
      })
      if (read.spec.list === 'assets') {
        // The business asset's own id (people get tasks on it) and the Instagram account it stands for (ads use that one).
        const row = shown(seen, 'instagramId', igId, { username: text(r.ig_username), chosenHere: !!igId && igId === account.instagramId, ownedByThisPortfolio: read.spec.ownedHere })
        return seen === 'taken' ? row : { businessAssetId: anyId(r.id), ...row }
      }
      return shown(seen, 'instagramId', igId, { username: text(r.username), chosenHere: !!igId && igId === account.instagramId }, tasksOf(r))
    })),
    missing,
    notes: [
      'assets: the portfolio\'s Instagram business assets (Meta\'s SDK only) — businessAssetId is the id people are given tasks on (meta-account-access view asset-people), instagramId the account ads use; a client one names no owner, so it is ids only. owned / client / all / converted: the Instagram accounts the portfolio owns, uses for another portfolio (permittedTasks), can reach at all, and those converted to business accounts (named only with an owner Meta names).',
      ONE_RULE + ' The chosen ad account\'s own Instagram accounts: meta-account-access view instagram.',
      'Linking an Instagram account or removing one from the portfolio is an admin\'s change a person approves (re-adding one needs its password in Meta\'s screens).',
      ...(scope.shared ? ['Another business in Nexus uses an ad account of this portfolio: every account but the one chosen here is its id only.'] : []),
    ],
  }
}

async function assetApps(account: MetaChosenAccount, scope: { portfolioId: string; shared: boolean }, list: string | null, maxRows: number) {
  const { reads, missing } = await readLists(account, scope.portfolioId, 'assets.apps', APP_LISTS, list, maxRows)
  const nexusApp = account.connection.appId
  const appOf = (read: ListRead, r: Row) => (read.spec.list === 'pending' ? obj(r.application) ?? {} : r)
  const owners = await ownersTaken(reads, scope.portfolioId)
  const owned = reads.find((read) => read.spec.list === 'owned')
  // Review A-F6 — "not found" in a list Meta cut is not "not owned": null then.
  const foundOwned = owned && nexusApp ? owned.rows.some((r) => idText(r.id) === nexusApp) : null
  return {
    portfolioId: scope.portfolioId, nexusAppId: nexusApp,
    nexusAppOwnedByThisPortfolio: foundOwned === null ? null : foundOwned ? true : owned!.more ? null : false,
    lists: listsOut(reads, (read) => read.rows.map((r) => {
      const app = appOf(read, r)
      const id = idText(app.id)
      const owner = ownerOf(r)
      const isNexus = !!id && id === nexusApp
      const seen = seenAs({ chosen: isNexus, ownerTaken: !!owner && owners.has(owner), shared: scope.shared, ownedHere: read.spec.ownedHere, ownerNamed: namedOwner(owner, read.spec.ownedHere, scope.portfolioId) })
      const row = shown(seen, 'appId', id, { name: text(app.name), ...(read.spec.list === 'owned' ? { category: text(r.category), link: text(r.link) } : {}), nexusApp: isNexus },
        { ...tasksOf(r), ...(r.is_requested !== undefined ? { requestedByThisPortfolio: bool(r.is_requested) } : {}) })
      return read.spec.list === 'pending' ? { requestId: anyId(r.id), ...row } : row
    })),
    missing,
    notes: [
      'owned: apps this portfolio owns (nexusApp: the business\'s own Meta app Nexus uses — it must be owned by the portfolio of its system user, else Meta refuses to make system users, #104001; nexusAppOwnedByThisPortfolio null: the owned list was cut or not read); client: apps another portfolio shares (permittedTasks); pending: app requests not answered yet (requestedByThisPortfolio false: an app being shared TO this portfolio; ids only, Meta names no owner).',
      ONE_RULE + ' The apps of the chosen ad account: meta-account-access view apps.',
      'Claiming an app or asking a client for one is an admin\'s change a person approves.',
      ...(scope.shared ? ['Another business in Nexus uses an ad account of this portfolio: every app but Nexus\'s own is its id only.'] : []),
    ],
  }
}

async function assetGroups(account: MetaChosenAccount, scope: { portfolioId: string; shared: boolean }, list: string | null, maxRows: number) {
  const { reads, missing } = await readLists(account, scope.portfolioId, 'assets.assetGroups', ASSET_GROUP_LISTS, list, maxRows)
  const owners = await ownersTaken(reads, scope.portfolioId)
  return {
    portfolioId: scope.portfolioId,
    lists: listsOut(reads, (read) => read.rows.map((r) => {
      const owner = ownerOf(r)
      const seen = seenAs({ ownerTaken: !!owner && owners.has(owner), shared: scope.shared, ownedHere: read.spec.ownedHere, ownerNamed: namedOwner(owner, read.spec.ownedHere, scope.portfolioId) })
      return shown(seen, 'assetGroupId', anyId(r.id), { name: text(r.name), ...(owner ? { ownerPortfolioId: owner } : {}) }, tasksOf(r))
    })),
    missing,
    notes: [
      'A business asset group bundles a portfolio\'s Pages, ad accounts, catalogs and more, so people get tasks on all of them at once. client: groups another portfolio shares (permittedTasks).',
      ONE_RULE,
      'Meta documents no API to make an asset group (its Creating section is empty and the SDK has none): a person makes one in Business settings › Accounts › Business asset groups. Its contents are not read here.',
    ],
  }
}

/** BM-017 — the objects of one type other portfolios share with this one: no owner field, so ids only (review B-F7). */
async function assetClientObjects(account: MetaChosenAccount, scope: { portfolioId: string; shared: boolean }, kind: MetaClientObjectKind | null, maxRows: number) {
  if (!kind) throw new MetaLiveRefusal(`Name the kind of client object (objectType: ${Object.keys(META_CLIENT_OBJECT_TYPES).join(', ')}): Meta lists one type per read.`)
  const read = await listGroups(account.connectionId, 'assets.clientObjects', `${scope.portfolioId}/client_objects`, [
    { name: 'core', fields: 'id,permitted_tasks' },
    { name: 'details', fields: 'name' },
  ], { type: META_CLIENT_OBJECT_TYPES[kind] }, maxRows, true)
  const chosenId = kind === 'page' ? account.pageId : kind === 'ad-account' ? account.adAccountId : kind === 'instagram' ? account.instagramId : null
  return {
    portfolioId: scope.portfolioId, objectType: kind, totalCount: read.totalCount,
    objects: read.rows.map((r) => {
      const id = kind === 'ad-account' ? metaAdAccountId(r.id) ?? anyId(r.id) : anyId(r.id)
      const seen = seenAs({ chosen: !!id && id === chosenId, shared: scope.shared, ownedHere: false, ownerNamed: false })
      return shown(seen, 'objectId', id, { name: text(r.name) }, { permittedTasks: strings(r.permitted_tasks) })
    }),
    more: read.more, missing: read.missing,
    notes: [
      'Assets of this kind that other portfolios (clients) let this portfolio use, with what it may do on each (permittedTasks).',
      'Meta names no owner here and does not say the row\'s id is the asset\'s own, so each is its id only (it could be another business\'s in Nexus) — but for the asset chosen here. Pages, Instagram accounts, apps and asset groups with their owners: views pages, instagram, apps, asset-groups.',
    ],
  }
}

async function assetSignalContainers(account: MetaChosenAccount, scope: { portfolioId: string; shared: boolean }, list: string | null, maxRows: number) {
  const { reads, missing } = await readLists(account, scope.portfolioId, 'assets.signalContainers', SIGNAL_LISTS, list, maxRows)
  const owners = await ownersTaken(reads, scope.portfolioId)
  return {
    portfolioId: scope.portfolioId,
    lists: listsOut(reads, (read) => read.rows.map((r) => {
      const owner = ownerOf(r)
      const seen = seenAs({ ownerTaken: !!owner && owners.has(owner), shared: scope.shared, ownedHere: read.spec.ownedHere, ownerNamed: namedOwner(owner, read.spec.ownedHere, scope.portfolioId) })
      return shown(seen, 'containerId', anyId(r.id), {
        name: text(r.name), unavailable: bool(r.is_unavailable), primaryContainerId: anyId(r.primary_container_id),
        shareableToAdAccounts: bool(r.is_eligible_for_sharing_to_ad_account), shareableToPortfolios: bool(r.is_eligible_for_sharing_to_business),
      }, tasksOf(r))
    })),
    missing,
    notes: [
      'Meta\'s "offsite signal container business objects": Meta does not describe them on its pages (its SDK names their fields only) — the signal sources (such as datasets) a portfolio owns, uses for another, or has been offered. Read them as Meta\'s ids and names; the pixels and datasets themselves: meta-datasets.',
      ONE_RULE,
    ],
  }
}

export const WHATSAPP_NOTE = 'Meta answers WhatsApp Business Accounts to an ADMIN system user\'s token with the whatsapp_business_management permission (which may need Advanced Access): when Nexus\'s system user is an Employee, Meta refuses — a person sees them in WhatsApp Manager. Only Click-to-WhatsApp ads need them.'
/** EN-929 — the portfolio's WhatsApp Business Accounts (fields: SDK whatsappbusinessaccount.py). */
export const WHATSAPP_GROUPS: FieldGroup[] = [
  { name: 'core', fields: 'id,name' },
  { name: 'details', fields: 'status,account_review_status,business_verification_status,currency,timezone_id,country,creation_time,ownership_type,message_template_namespace,primary_funding_id,is_shared_with_partners,whatsapp_business_manager_messaging_limit,health_status,marketing_messages_onboarding_status{status,time}' },
]

async function assetWhatsApp(account: MetaChosenAccount, scope: { portfolioId: string; shared: boolean }, maxRows: number) {
  const read = await withNote(() => listGroups(account.connectionId, 'assets.whatsapp', `${scope.portfolioId}/owned_whatsapp_business_accounts`, WHATSAPP_GROUPS, {}, maxRows), WHATSAPP_NOTE)
  return {
    portfolioId: scope.portfolioId,
    whatsappAccounts: read.rows.map((r) => {
      const onboarding = obj(r.marketing_messages_onboarding_status)
      return shown(seenAs({ shared: scope.shared, ownedHere: true }), 'whatsappAccountId', idText(r.id), {
        name: text(r.name), status: text(r.status), reviewStatus: text(r.account_review_status), verificationStatus: text(r.business_verification_status),
        currency: text(r.currency), timeZoneId: text(r.timezone_id) ?? num(r.timezone_id), country: text(r.country), createdTime: text(r.creation_time), ownershipType: text(r.ownership_type),
        templateNamespace: text(r.message_template_namespace), primaryFundingId: idText(r.primary_funding_id), sharedWithPartners: bool(r.is_shared_with_partners),
        messagingLimit: text(r.whatsapp_business_manager_messaging_limit), health: r.health_status === undefined ? null : tidy(r.health_status),
        marketingMessagesOnboarding: onboarding ? { status: text(onboarding.status), time: text(onboarding.time) } : null,
      })
    }),
    more: read.more, missing: read.missing,
    notes: [
      'The WhatsApp Business Accounts this portfolio owns: their review and verification state, health and messaging limit (primaryFundingId needs the ad-spend permission). Their phone numbers: view whatsapp-numbers (whatsappAccountId).',
      WHATSAPP_NOTE,
      ...(scope.shared ? ['Another business in Nexus uses an ad account of this portfolio: each account is its id only.'] : []),
    ],
  }
}

async function assetWhatsAppNumbers(account: MetaChosenAccount, scope: { portfolioId: string; shared: boolean }, whatsappAccountId: string | null, maxRows: number) {
  const id = whatsappAccountId ? metaObjectId(whatsappAccountId) : null
  if (!id) throw new MetaLiveRefusal('Name the WhatsApp Business Account (whatsappAccountId, digits: view whatsapp lists them).')
  if (scope.shared) throw new MetaLiveRefusal('Another business in Nexus uses an ad account of this Meta business portfolio, so Nexus cannot tell whose WhatsApp account this is: its numbers are not read here.')
  const owned = await withNote(() => listPaged(account.connectionId, 'assets.whatsappCheck', `${scope.portfolioId}/owned_whatsapp_business_accounts`, { fields: 'id' }, 500), WHATSAPP_NOTE)
  if (!owned.rows.some((r) => idText(r.id) === id)) throw new MetaLiveRefusal('That is not a WhatsApp Business Account of the chosen ad account\'s business portfolio (view whatsapp lists them), so its numbers are not read.')
  const read = await withNote(() => listGroups(account.connectionId, 'assets.whatsappNumbers', `${id}/phone_numbers`, [
    { name: 'core', fields: 'id,display_phone_number,verified_name,quality_rating' },
    { name: 'details', fields: 'code_verification_status,name_status' },
  ], {}, maxRows), WHATSAPP_NOTE)
  return {
    portfolioId: scope.portfolioId, whatsappAccountId: id,
    numbers: read.rows.map((r) => ({
      phoneNumberId: idText(r.id), displayNumber: text(r.display_phone_number), verifiedName: text(r.verified_name), quality: text(r.quality_rating),
      codeVerification: text(r.code_verification_status), nameStatus: text(r.name_status),
    })),
    more: read.more, missing: read.missing,
    notes: [
      'The business\'s own WhatsApp numbers (never a customer\'s): the name WhatsApp shows, the quality rating (GREEN, YELLOW, RED, or NA / UNKNOWN when there is none yet) and the verification state (nameStatus is a Meta beta field). A Click-to-WhatsApp ad links one of them to the Page.',
      'Adding, verifying or moving a number is WhatsApp\'s own set-up (WhatsApp Manager, or WhatsApp\'s Business Management API, which Nexus does not use for it); Nexus reads them only.',
    ],
  }
}

/** One view of the chosen ad account's business portfolio's assets. */
export async function assetsView(input: { connectionId?: string | null; view: AssetView; list?: string | null; objectType?: MetaClientObjectKind | null; whatsappAccountId?: string | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const maxRows = clampRows(input.maxRows)
  const list = input.list ?? null
  if (list && !(input.view in ASSET_LISTS)) throw new MetaLiveRefusal(`view ${input.view} has no lists (list is for ${Object.keys(ASSET_LISTS).join(', ')}).`)
  switch (input.view) {
    case 'page-children': return assetPageChildren(account, maxRows)
    case 'store-locations': return assetStoreLocations(account, maxRows)
    default: break
  }
  const scope = await scopeOf(account)
  switch (input.view) {
    case 'pages': return assetPages(account, scope, list, maxRows)
    case 'instagram': return assetInstagram(account, scope, list, maxRows)
    case 'apps': return assetApps(account, scope, list, maxRows)
    case 'asset-groups': return assetGroups(account, scope, list, maxRows)
    case 'client-objects': return assetClientObjects(account, scope, input.objectType ?? null, maxRows)
    case 'signal-containers': return assetSignalContainers(account, scope, list, maxRows)
    case 'whatsapp': return assetWhatsApp(account, scope, maxRows)
    case 'whatsapp-numbers': return assetWhatsAppNumbers(account, scope, input.whatsappAccountId ?? null, maxRows)
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

// ── meta-business-partners ───────────────────────────────────────────────────────────────────────────────────────

export const PARTNER_VIEWS = ['agencies', 'clients', 'partners', 'relationships', 'sharing-agreements', 'child-businesses'] as const
export type PartnerView = typeof PARTNER_VIEWS[number]
/** sharing-agreements: the ones this portfolio started, or the ones others started with it (review B-F1). */
export const AGREEMENT_LISTS = ['initiated', 'received'] as const
export type AgreementList = typeof AGREEMENT_LISTS[number]
export { META_SHARING_AGREEMENT_STATUSES }

/** BM-019, BM-020 — a partner's permissions on assets: Meta documents the lists by name only, so each item keeps an id and plain words. */
const PERMISSION_LISTS = [
  ['adAccounts', 'adaccount_permissions', 'AD_ACCOUNT'], ['pages', 'page_permissions', 'PAGE'], ['catalogs', 'productcatalog_permissions', null], ['apps', 'application_permissions', null],
] as const
const PERMISSION_WORDS = ['permitted_tasks', 'tasks', 'permitted_roles', 'role', 'access_status', 'status'] as const

/**
 * One item of a permission list: its asset id (masked when another business in Nexus picked it) and its plain task / status
 * words. Re-review N8 — `ours`: an agency's items are THIS portfolio's assets (false = checked, not taken); a client's are the
 * client's, which Nexus cannot check beyond the table (null).
 */
function permissionItemOf(v: unknown, product: MetaTakenProduct | null, taken: ReadonlySet<string>, ours: boolean) {
  const o = obj(v)
  if (!o) return null
  const rawId = o.id ?? o.account_id ?? obj(o.ad_account)?.id ?? obj(o.page)?.id ?? obj(o.product_catalog)?.id ?? obj(o.application)?.id
  const id = product === 'AD_ACCOUNT' ? metaAdAccountId(rawId) : anyId(rawId)
  if (id && product && taken.has(id)) return { id, takenByAnotherBusiness: true }
  const words: Record<string, unknown> = {}
  for (const key of PERMISSION_WORDS) {
    const value = o[key]
    if (typeof value === 'string' && !EMAIL_LIKE.test(value)) words[key] = value
    else if (Array.isArray(value)) words[key] = strings(value)
  }
  return { id, ...words, ...(product ? { takenByAnotherBusiness: ours ? false : null } : {}) }
}

/** A partner portfolio Meta lists: one another business in Nexus uses is its id and the flag only. */
const partnerRow = (id: string | null, taken: ReadonlySet<string>, details: Row) => (id && taken.has(id) ? { portfolioId: id, takenByAnotherBusiness: true } : { portfolioId: id, ...details, takenByAnotherBusiness: false })

async function partnersList(account: MetaChosenAccount, portfolioId: string, edge: 'agencies' | 'clients', maxRows: number) {
  const read = await listGroups(account.connectionId, `partners.${edge}`, `${portfolioId}/${edge}`, [
    { name: 'core', fields: 'id,name' },
    { name: 'permissions', fields: 'adaccount_permissions,page_permissions,productcatalog_permissions,application_permissions,shared_ca_count' },
  ], {}, maxRows, true)
  const takenPortfolios = await takenOf('PORTFOLIO', read.rows.map((r) => idText(r.id)))
  const idsOf = (key: string, product: MetaTakenProduct) => read.rows.flatMap((r) => (Array.isArray(r[key]) ? r[key] as unknown[] : []).map((p) => {
    const o = obj(p)
    const raw = o?.id ?? o?.account_id ?? obj(o?.ad_account)?.id ?? obj(o?.page)?.id
    return product === 'AD_ACCOUNT' ? metaAdAccountId(raw) : anyId(raw)
  }))
  const [takenAccounts, takenPages] = await Promise.all([takenOf('AD_ACCOUNT', idsOf('adaccount_permissions', 'AD_ACCOUNT')), takenOf('PAGE', idsOf('page_permissions', 'PAGE'))])
  return {
    portfolioId, totalCount: read.totalCount,
    partners: read.rows.map((r) => {
      const id = idText(r.id)
      const perms: Record<string, unknown> = {}
      for (const [out, key, product] of PERMISSION_LISTS) {
        if (r[key] === undefined) continue
        const taken = product === 'AD_ACCOUNT' ? takenAccounts : product === 'PAGE' ? takenPages : new Set<string>()
        perms[out] = (Array.isArray(r[key]) ? r[key] as unknown[] : []).map((p) => permissionItemOf(p, product, taken, edge === 'agencies')).filter(Boolean)
      }
      return partnerRow(id, takenPortfolios, { name: text(r.name), ...perms, sharedAudiences: num(r.shared_ca_count) })
    }),
    more: read.more, missing: read.missing,
  }
}

async function partnersRelationships(account: MetaChosenAccount, portfolioId: string, includeDeclined: boolean, maxRows: number) {
  const read = await listGroups(account.connectionId, 'partners.relationships', `${portfolioId}/partner_relationships`, [
    { name: 'core', fields: 'id,name' },
    { name: 'relationship', fields: 'relationship' },
  ], { exclude_declined_requests: !includeDeclined }, maxRows, true)
  const taken = await takenOf('PORTFOLIO', read.rows.map((r) => idText(r.id)))
  return {
    portfolioId, includeDeclined, totalCount: read.totalCount,
    partners: read.rows.map((r) => partnerRow(idText(r.id), taken, { name: text(r.name), relationship: wordsOf(r.relationship) })),
    more: read.more, missing: read.missing,
    notes: [
      'Every partner portfolio connected to this one and how (Meta\'s relationship words: agency, client, …), without declined requests unless includeDeclined. One another business in Nexus uses is its id only.',
      'The partner portfolios alone: view partners.',
    ],
  }
}

/** Review B-F1 — business/partners: "other businesses which work with this business as partners" (no parameters). */
async function partnersPartners(account: MetaChosenAccount, portfolioId: string, maxRows: number) {
  const read = await listPaged(account.connectionId, 'partners.partners', `${portfolioId}/partners`, { fields: 'id,name' }, maxRows, true)
  const taken = await takenOf('PORTFOLIO', read.rows.map((r) => idText(r.id)))
  return {
    portfolioId, totalCount: read.totalCount,
    partners: read.rows.map((r) => partnerRow(idText(r.id), taken, { name: text(r.name) })),
    more: read.more,
    notes: [
      'The portfolios that work with this one as partners. One another business in Nexus uses is its id only. How each is connected: view relationships; what each may do on which asset: views agencies and clients.',
    ],
  }
}

async function partnersSharingAgreements(account: MetaChosenAccount, portfolioId: string, input: { list: AgreementList; status: string | null; receivingPortfolioId: string | null; requestingPortfolioId: string | null; maxRows: number }) {
  const received = input.list === 'received'
  if (received && input.receivingPortfolioId) throw new MetaLiveRefusal('receivingPortfolioId is for the agreements this portfolio started (list initiated); for received ones name requestingPortfolioId.')
  if (!received && input.requestingPortfolioId) throw new MetaLiveRefusal('requestingPortfolioId is for the agreements others started with this portfolio (list received); for initiated ones name receivingPortfolioId.')
  const partnerArg = received ? input.requestingPortfolioId : input.receivingPortfolioId
  const partner = partnerArg ? metaObjectId(partnerArg) : null
  if (partnerArg && !partner) throw new MetaLiveRefusal(`${received ? 'requestingPortfolioId' : 'receivingPortfolioId'} is a Meta business portfolio id (digits).`)
  // Re-review N5 — the agreements with a portfolio another business in Nexus uses are that business's too (relationships and
  // partners show it as id + flag): never read by naming it.
  if (partner && (await takenOf('PORTFOLIO', [partner])).has(partner)) throw new MetaLiveRefusal('Another business in Nexus uses an ad account of that business portfolio, so the sharing agreements with it are not read here.')
  const query: Record<string, MetaQueryValue> = {}
  if (input.status) query.request_status = input.status
  if (partner) query[received ? 'requesting_business_id' : 'receiving_business_id'] = partner
  const edge = received ? 'received_sharing_agreements' : 'initiated_sharing_agreements'
  const read = await listPaged(account.connectionId, `partners.${received ? 'receivedAgreements' : 'sharingAgreements'}`, `${portfolioId}/${edge}`, { fields: 'id,request_status', ...query }, input.maxRows)
  return {
    portfolioId, list: input.list, ...(input.status ? { status: input.status } : {}), ...(partner ? { [received ? 'requestingPortfolioId' : 'receivingPortfolioId']: partner } : {}),
    agreements: read.rows.map((r) => ({ agreementId: anyId(r.id), status: text(r.request_status) })),
    more: read.more,
    notes: [
      `Asset-sharing agreements ${received ? 'other portfolios started with this one' : 'this portfolio started with another'} (Meta answers an id and a status for each: APPROVE, DECLINE, IN_PROGRESS, PENDING, EXPIRED, CANCELED …). ${received ? 'The ones this portfolio started: list initiated.' : 'The ones others started with this portfolio: list received.'}`,
    ],
  }
}

async function partnersChildren(account: MetaChosenAccount, portfolioId: string, maxRows: number) {
  const read = await listGroups(account.connectionId, 'partners.childBusinesses', `${portfolioId}/owned_businesses`, [
    { name: 'core', fields: 'id,name' },
    { name: 'details', fields: 'created_time,verification_status' },
    { name: 'relationship', fields: 'relationship' },
  ], {}, maxRows, true)
  const taken = await takenOf('PORTFOLIO', read.rows.map((r) => idText(r.id)))
  return {
    portfolioId, totalCount: read.totalCount,
    childBusinesses: read.rows.map((r) => partnerRow(idText(r.id), taken, { name: text(r.name), createdTime: text(r.created_time), verificationStatus: text(r.verification_status), relationship: plainOf(r.relationship) })),
    more: read.more, missing: read.missing,
    notes: [
      'Child portfolios this one made through Meta\'s API (a two-tier set-up for platforms and agencies). Nexus businesses are separate portfolios, so this is usually empty; one another business in Nexus uses is its id only.',
    ],
  }
}

/** One view of the chosen ad account's business portfolio's partners. */
export async function partnersView(input: {
  connectionId?: string | null; view: PartnerView; includeDeclined?: boolean; list?: AgreementList | null; status?: string | null
  receivingPortfolioId?: string | null; requestingPortfolioId?: string | null; maxRows?: number
}) {
  const account = await metaChosenAccount(input.connectionId)
  const maxRows = clampRows(input.maxRows)
  if ((input.list || input.requestingPortfolioId || input.receivingPortfolioId || input.status) && input.view !== 'sharing-agreements') throw new MetaLiveRefusal('list, status, receivingPortfolioId and requestingPortfolioId are for view sharing-agreements.')
  const { portfolioId } = await scopeOf(account, PARTNERS_SHARED)
  switch (input.view) {
    case 'agencies': {
      const read = await partnersList(account, portfolioId, 'agencies', maxRows)
      return {
        ...read,
        notes: [
          'Partner portfolios (agencies) that may use THIS portfolio\'s assets, with what each may do on which ad account, Page, catalog and app, and how many audiences are shared with it. An asset another business in Nexus picked is its id only; so is a partner portfolio another business in Nexus uses.',
          'Meta documents these permission lists by name only: each item keeps an id and Meta\'s task and status words.',
          'Giving a partner access (asset by asset) or ending it is an admin\'s change a person approves; a partner can also ask, and an admin accepts in Business settings › Users › Partners. The partners of the chosen ad account alone: meta-account-access view agencies.',
        ],
      }
    }
    case 'clients': {
      const read = await partnersList(account, portfolioId, 'clients', maxRows)
      return {
        ...read,
        notes: [
          'Client portfolios that let THIS portfolio use their assets, with what it may do on each (their ad accounts, Pages, catalogs and apps by id). A client portfolio another business in Nexus uses is its id only.',
          'Meta documents these permission lists by name only: each item keeps an id and Meta\'s task and status words.',
        ],
      }
    }
    case 'partners': return partnersPartners(account, portfolioId, maxRows)
    case 'relationships': return partnersRelationships(account, portfolioId, input.includeDeclined === true, maxRows)
    case 'sharing-agreements': return partnersSharingAgreements(account, portfolioId, {
      list: input.list ?? 'initiated', status: input.status ?? null, receivingPortfolioId: input.receivingPortfolioId ?? null, requestingPortfolioId: input.requestingPortfolioId ?? null, maxRows,
    })
    case 'child-businesses': return partnersChildren(account, portfolioId, maxRows)
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

export { META_INVITATION_ASSET_TYPES, META_CLIENT_OBJECT_TYPES }
