/**
 * Meta ads step 3 (2026-10-21) — the chosen ad account ITSELF, live from Meta (GET only, through the gateway): its full
 * settings (meta-ad-account), its billing (meta-billing) and who and what has access to it (meta-account-access). Nothing
 * here stores anything. meta-ads-live view account is the short look (status, money, capabilities, terms); these are the
 * full reads, and reuse it where it already answers (promoted Pages: live.ts liveView).
 *
 * ONLY the business's chosen assets: the chosen ad account (metaChosenAccount); its own business portfolio — and the
 * portfolio's billing (invoices, credit lines, cards) only when no other business in Nexus uses an ad account of that
 * portfolio (nexus_meta_links_taken PORTFOLIO: its id and a flag, no call); the chosen Facebook Page and Instagram account;
 * a catalog of the chosen account's portfolio (owned, or shared with it); a pixel of the chosen ad account. A Page,
 * Instagram account, ad account or portfolio another business in Nexus uses is `{ id, takenByAnotherBusiness: true }` only. Fields are FIXED lists per
 * node type (a caller never names a Graph field or path); fields Meta's v26 reference does not list are asked in their own
 * group, and a group Meta refuses is named with Meta's sentence (live-objects.ts readGroups / listGroups).
 *
 * People: names and tasks only — Nexus never asks an e-mail address, a phone number or a token, and drops the e-mail
 * field Meta keeps in an agency declaration (an invoice group's e-mail addresses are never asked). Payment methods: only Meta's own masked
 * words (display_string, e.g. a card type and its last four digits; a card's type and last four) — never a card number,
 * expiry, holder's name or bank detail. Invoice PDF links (download_uri, cdn_download_uri) are never asked: they open the
 * invoice for whoever holds them.
 *
 * Checked 2026-10-21 (curl ≥ 3 s apart: developers.facebook.com/documentation/ads-commerce/marketing-api/reference/<page>.md
 * and developers.facebook.com/docs/marketing-api/reference/<node>/?locale=en_US; business-asset-management guides
 * ad-accounts, pages, instagram-accounts; Meta's Python Business SDK main, facebook_business/adobjects/<node>.py):
 *   - ad-account (v26 Reading table): every field of the settings' core group and of the other views, incl.
 *     direct_deals_tos_accepted (not in the SDK); NOT in the Reading table (SDK fields only, each in a group of its own so
 *     a refusal never costs the core): liable_address, send_bill_to_address, sold_to_address (sdkAddresses), owner_business,
 *     viewable_business (sdkPortfolios), user_access_expire_time, is_ba_skip_delayed_eligible and custom_audience_info
 *     (sdkOther — v26 lists custom_audience_info only as an Updating parameter), all_capabilities; funding_source_details and
 *     expired_funding_source_details need MANAGE ("the user making the API call must have a MANAGE task"), is_prepay_account
 *     and is_tax_id_required ADVERTISE or MANAGE; agency_client_declaration needs Business Manager Admin;
 *     user_tos_accepted "is not valid for system users" (so it is not asked); spend_cap is read in the currency's basic unit
 *     ("cents": money.ts metaAccountSpendCapMicros, the READ helper) and written in standard units ("23.50 for USD
 *     $23.50": money.ts minorToMetaStandard, the WRITE helper for step 40); disable_reason 0–15; tax_id_status 0–5
 *   - ad-account edges: users (AdAccountUser id, name, tasks), assigned_users (business REQUIRED; tasks, permitted_tasks,
 *     summary total_count), agencies (Business + access_requested_time, access_status, access_updated_time,
 *     permitted_tasks), applications, advertisable_applications (app_id, business_id), promote_pages, instagram_accounts
 *     (summary total_count), connected_instagram_accounts, connected_instagram_accounts_with_iabp (business_id; SDK only),
 *     account_controls (AdAccountBusinessConstraints: audience_controls, campaigns_with_error, placement_controls, status;
 *     is_age_restriction_enabled and placement_controls_per_objective SDK only), tracking (tracking_specs),
 *     customaudiencestos (node fields SDK only: id, type, content), minimum_budgets (bid_amount; MinimumBudget currency,
 *     min_daily_budget_imp / _video_views / _high_freq / _low_freq), dsa_recommendations (recommendations),
 *     mcmeconversions (AdsMcmeConversion, SDK fields), conversion_goals (SDK only: AdsConversionGoal),
 *     campaign_attribution_options (app_id and optimization_goal REQUIRED, event_name: it answers for an app's events),
 *     activities (the edge page lists no parameter; the SDK has since / until and category — adactivity.py Category
 *     ACCOUNT, AD, AD_SET, BUDGET …; reference/ad-activity "Event types by category" files every billing event under
 *     BUDGET and ad_account_billing_charge_failed under none: BILLING_EVENT_TYPES below)
 *   - insights/breakdowns "Insights feature settings": GET act_<id>/insights/feature-settings/list-features (feature_name,
 *     feature_type) and GET act_<id>/insights/feature-settings (insights_feature filter; enabled ones only, with
 *     insights_effective_date); switching one on is a POST that cannot be undone (not here)
 *   - business/business_invoices (start_date / end_date: billing period, BOTH exclusive, default the last 6 months;
 *     issue_start_date — needed for any issue-date query — / issue_end_date; invoice_id; type INV | CM | DM | PRO_FORMA) →
 *     OmegaCustomerTrx (amount "numeric string" — its unit is not documented, so it is answered as Meta sent it;
 *     amount_due CurrencyAmount);
 *     business/extendedcredits → ExtendedCredit (amounts CurrencyAmount, "measured in USD at the top level");
 *     extended-credit/extended_credit_invoice_groups (id, auto_enroll, customer_po_number, email, emails, name; addresses
 *     SDK only) and invoice-group/ad_accounts (SDK); extended-credit/owning_credit_allocation_configs
 *     (ExtendedCreditAllocationConfig); business/creditcards and business/extendedcreditapplications (only_show_pending):
 *     SDK only (Meta's pages answer 404)
 *   - system-user / business-user assigned_ad_accounts, assigned_pages, assigned_product_catalogs,
 *     assigned_business_asset_groups, assigned_whatsapp_business_accounts (SDK); assigned_instagram_accounts,
 *     assigned_ads_pixels, assigned_apps, assigned_creative_folders, assigned_offline_conversion_data_sets,
 *     assigned_monetization_properties (Meta's reference index only); for names, the owner: business{id} on ad
 *     accounts, Pages and catalogs (v26 ad-account, page, product-catalog), owner_business{id} on the others (SDK), the
 *     portfolio's owned_instagram_assets for Instagram accounts (PERSON_ASSET_EDGES);
 *     page / IG business asset / product-catalog / ads-pixel assigned_users (business REQUIRED: "the id of the business
 *     that owns" the asset); the IG business asset of an Instagram account: business/owned_instagram_assets and
 *     client_instagram_assets (InstagramBusinessAsset id, ig_user_id — SDK); a catalog: business/owned_product_catalogs
 *     and client_product_catalogs (reference business)
 *   - ig-user authorized_adaccounts (business REQUIRED; only that business's ad accounts)
 * Whatever is SDK-only or not documented is built and Meta's own answer decides (LIVE-PROBES.md, step 3 rows).
 */
import { metaAdAccountId, metaObjectId, AD_ACCOUNT_STATUS_WORDS } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { liveView, metaChosenAccount, MetaLiveRefusal, graphSafe, type MetaChosenAccount } from './live.js'
import { listGroups, listPaged, pageAdLimits, readGroups, type FieldGroup, type MissingPart } from './live-objects.js'
import { PAGE_TOKEN_NOTE, tidy } from './live-media.js'
// Step 16's one exported "part of an answer" helper (a part Meta refuses says why and never hides the others).
import { fieldsRefused, part } from './live-partners.js'
import { currencyAmountMicros, metaAccountSpendCapMicros, metaUnitsToMicros, minorOf, minorToMetaUnits } from './money.js'
import { takenIds } from './taken.js'

type Row = Record<string, unknown>

const act = (id: string) => `act_${id}`
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v).trim()) ? String(v).trim() : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
/** Meta's 0 / 1 flags (unsigned ints) as booleans. */
const flag = (v: unknown): boolean | null => { const n = num(v); return n === null ? bool(v) : n !== 0 }
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (typeof s === 'string' || typeof s === 'number' ? String(s) : null)).filter((s): s is string => !!s) : [])
/** A Meta offset-unit amount (amount spent, balance, minimum budgets) → minor units of its currency. */
const cents = (v: unknown, currency: string | null): number | null => minorOf(metaUnitsToMicros(v, currency), currency)
/** Meta's CurrencyAmount → minor units and the currency they are in (its own, never converted). */
function money(v: unknown): { cents: number | null; currency: string | null } {
  const amount = currencyAmountMicros(v)
  return amount ? { cents: minorOf(amount.micros, amount.currency), currency: amount.currency } : { cents: null, currency: null }
}
/** Meta's spec or answer as it sent it, without paging links or tokens. */
const spec = (v: unknown): unknown => (v === undefined || v === null ? null : graphSafe(v))
const missingOf = (parts: Array<[string, { notRead: string | null }]>): MissingPart[] => parts.filter(([, p]) => p.notRead).map(([name, p]) => ({ part: name, sentence: p.notRead! }))
const statusText = (status: number | null) => (status === null ? null : AD_ACCOUNT_STATUS_WORDS[status] ?? `Status ${status}`)

// ── the chosen account's portfolio, and what another business uses ──────────────────────────────────────────────────

/** The chosen ad account's business portfolio — refused in words when it belongs to none. */
function portfolioOf(account: MetaChosenAccount, what: string): string {
  if (!account.businessId) throw new MetaLiveRefusal(`The chosen ad account belongs to no Meta business portfolio, so ${what} cannot be read (Meta keeps them on a portfolio).`)
  return account.businessId
}

export const PORTFOLIO_SHARED = 'Another business in Nexus uses an ad account of this Meta business portfolio, so the portfolio\'s billing (invoices, credit lines, cards, credit applications) is not read here: it would show that business\'s billing too. A person sees it in Meta Business settings › Billing and payments; this ad account\'s own billing is views spend, payment, tax and events.'

/** Business-level billing: the portfolio's id and the flag, before any call, when another business in Nexus uses it. */
async function ownPortfolio(account: MetaChosenAccount, what: string): Promise<{ portfolioId: string; shared: null } | { portfolioId: string; shared: { portfolioId: string; takenByAnotherBusiness: true; sentence: string } }> {
  const portfolioId = portfolioOf(account, what)
  const taken = await takenIds('PORTFOLIO', [portfolioId])
  return taken.has(portfolioId) ? { portfolioId, shared: { portfolioId, takenByAnotherBusiness: true, sentence: PORTFOLIO_SHARED } } : { portfolioId, shared: null }
}

/** A business portfolio Meta names (an agency, an owner, a person's business): another Nexus business's is its id and the flag. */
function portfolioRef(value: unknown, taken: ReadonlySet<string>, own: string | null) {
  const b = obj(value)
  const id = idText(b?.id)
  if (!id) return null
  if (id === own) return { portfolioId: id, name: text(b?.name), chosenAccountsPortfolio: true, takenByAnotherBusiness: false }
  if (taken.has(id)) return { portfolioId: id, takenByAnotherBusiness: true as const }
  return { portfolioId: id, name: text(b?.name), chosenAccountsPortfolio: false, takenByAnotherBusiness: false }
}

const portfolioIdsOf = (values: unknown[]) => values.map((v) => idText(obj(v)?.id)).filter((id): id is string => !!id)

/**
 * An address Meta keeps (CRMAddress). Review round 3 — street and postal code only for an account Meta says is for
 * business use (businessUse: on a personal-use account, or when Meta does not say, they could be a person's home); tax
 * ids only where billing asks for them, on the same condition.
 */
function addressOf(v: unknown, show: { street: boolean; taxIds: boolean }) {
  const a = obj(v)
  if (!a) return null
  return {
    ...(show.street ? { street: [a.street1, a.street2, a.street3, a.street4].map(text).filter(Boolean) } : {}), city: text(a.city), state: text(a.state),
    ...(show.street ? { postalCode: text(a.postal_code) } : {}), country: text(a.country), validationStatus: text(a.validation_status),
    ...(show.street && show.taxIds ? { vatTaxId: text(a.vat_tax_id), registrationLabel: text(a.registration_label), registrationNumber: text(a.registration_number), cnpjTaxId: text(a.cnpj_tax_id) } : {}),
  }
}

/** A Page Meta names by id (end advertiser, promotable Pages): another business's is its id and the flag. */
function pageRef(id: string, takenPages: ReadonlySet<string>, account: MetaChosenAccount) {
  return takenPages.has(id) ? { pageId: id, takenByAnotherBusiness: true as const } : { pageId: id, chosenHere: id === account.pageId, takenByAnotherBusiness: false }
}

// ── meta-ad-account ──────────────────────────────────────────────────────────────────────────────────────────────────

export const ACCOUNT_VIEWS = ['settings', 'dsa', 'terms', 'capabilities', 'controls', 'tracking', 'limits', 'goals', 'attribution-options', 'insights-features'] as const
export type AccountView = typeof ACCOUNT_VIEWS[number]

/** disable_reason (reference/ad-account). */
export const DISABLE_REASON_WORDS: Readonly<Record<number, string>> = {
  0: 'None', 1: 'Ads integrity policy', 2: 'Ads IP review', 3: 'Payment risk', 4: 'Gray account shut down', 5: 'Ads AFC review',
  6: 'Business integrity review', 7: 'Closed for good', 8: 'Unused reseller account', 9: 'Unused account', 10: 'Umbrella ad account',
  11: 'Business Manager integrity policy', 12: 'Misrepresented ad account', 13: 'Legal entity de-shared', 14: 'Click-to-message thread review',
  15: 'Compromised ad account',
}

/** AA-010, AA-011, AA-016, AA-020, AA-022 — the account's own settings; the SDK-only ones in their own group. */
export const ACCOUNT_SETTINGS_GROUPS: FieldGroup[] = [
  {
    name: 'core',
    fields: [
      'id', 'account_id', 'name', 'account_status', 'disable_reason', 'age', 'created_time', 'currency', 'timezone_id', 'timezone_name',
      'timezone_offset_hours_utc', 'business{id,name}', 'owner', 'end_advertiser', 'end_advertiser_name', 'media_agency', 'partner', 'is_personal',
      'fb_entity', 'io_number', 'line_numbers', 'user_tasks', 'has_migrated_permissions', 'is_notifications_enabled',
      'brand_safety_content_filter_levels', 'default_dsa_payor', 'default_dsa_beneficiary', 'business_name', 'business_street',
      'business_street2', 'business_city', 'business_state', 'business_zip', 'business_country_code', 'ad_account_promotable_objects',
      'marketing_messages_settings',
    ].join(','),
  },
  // SDK only (AA-022), in three groups so one field Meta refuses never hides the others or the core. custom_audience_info
  // (review round 2, B1): v26 lists it only as an Updating parameter, never in the Reading table.
  { name: 'sdkAddresses', fields: 'liable_address,send_bill_to_address,sold_to_address' },
  { name: 'sdkPortfolios', fields: 'owner_business{id,name},viewable_business{id,name}' },
  { name: 'sdkOther', fields: 'user_access_expire_time,is_ba_skip_delayed_eligible,custom_audience_info' },
]
/**
 * AA-021 — needs Business Manager Admin: read on its own, so a refusal never costs the settings. Asked by its own
 * sub-fields (reference agency-client-declaration), never client_email_address; when Meta refuses the sub-field list, the
 * whole field is read once more and the e-mail is dropped here (LIVE-PROBES AA-021).
 */
export const AGENCY_DECLARATION_FIELDS = 'agency_client_declaration{agency_representing_client,client_based_in_france,client_city,client_country_code,client_name,client_postal_code,client_province,client_street,client_street2,has_written_mandate_from_advertiser,is_client_paying_invoices}'

const TASK_WORDS: Readonly<Record<string, string>> = {
  MANAGE: 'manage the account (people, payment, settings)', ADVERTISE: 'create and edit ads', ANALYZE: 'see results',
  DRAFT: 'draft ads (not publish)', AA_ANALYZE: 'see Advanced Analytics',
}
/** The ad-account role a set of tasks makes (the business-asset-management guide's three). */
function adAccountRole(tasks: string[]): string | null {
  if (tasks.includes('MANAGE')) return 'Admin (manage, advertise, analyse)'
  if (tasks.includes('ADVERTISE')) return 'Advertiser (advertise, analyse)'
  if (tasks.includes('ANALYZE')) return 'Analyst (reporting only)'
  return tasks.length ? null : 'No tasks'
}

async function accountSettings(account: MetaChosenAccount) {
  const { connectionId, adAccountId } = account
  const { body, missing } = await readGroups(connectionId, 'account.settings', act(adAccountId), ACCOUNT_SETTINGS_GROUPS)
  const declaration = await part(async () => {
    try {
      return await metaReadOne({ connectionId }, { operation: 'account.agencyDeclaration', path: act(adAccountId), query: { fields: AGENCY_DECLARATION_FIELDS } })
    } catch (err) {
      // Review round 2 — only when Meta refuses the sub-field LIST (#100); a permission refusal (#200: not a Business
      // Manager admin) would refuse the whole field too, so no second call.
      if (!fieldsRefused(err)) throw err
      return metaReadOne({ connectionId }, { operation: 'account.agencyDeclaration.whole', path: act(adAccountId), query: { fields: 'agency_client_declaration' } })
    }
  })
  if (declaration.notRead) missing.push({ part: 'agencyDeclaration', sentence: `${declaration.notRead} (Meta answers it only to a Business Manager admin.)` })
  const promotable = obj(body.ad_account_promotable_objects)
  const pageIds = [...new Set([...strings(promotable?.promotable_page_ids), ...[body.end_advertiser, body.media_agency, body.partner].map(idText).filter((id): id is string => !!id)])]
  const [takenPages, takenPortfolios] = await Promise.all([
    takenIds('PAGE', pageIds),
    takenIds('PORTFOLIO', portfolioIdsOf([body.business, body.owner_business, body.viewable_business])),
  ])
  const own = idText(obj(body.business)?.id) ?? account.businessId
  const status = num(body.account_status)
  const reason = num(body.disable_reason)
  /** end_advertiser / media_agency / partner: a Page alias, Page id or app id, or NONE / UNFOUND. */
  const party = (value: unknown, name?: unknown) => {
    const id = idText(value)
    if (id && takenPages.has(id)) return { id, takenByAnotherBusiness: true as const }
    return { value: text(value) ?? idText(value), ...(name !== undefined ? { name: text(name) } : {}), takenByAnotherBusiness: false }
  }
  const d = obj(obj(declaration.value?.body)?.agency_client_declaration)
  const customAudience = obj(body.custom_audience_info)
  const streets = businessUse(body)
  return {
    adAccountId, name: text(body.name), status, statusText: statusText(status), disableReason: reason, disableReasonText: reason === null ? null : DISABLE_REASON_WORDS[reason] ?? `Reason ${reason}`,
    ageDays: num(body.age), createdTime: text(body.created_time), currency: text(body.currency),
    timeZone: { id: num(body.timezone_id), name: text(body.timezone_name), offsetHoursUtc: num(body.timezone_offset_hours_utc) },
    portfolio: portfolioRef(body.business, takenPortfolios, own), ownerId: idText(body.owner),
    endAdvertiser: party(body.end_advertiser, body.end_advertiser_name), mediaAgency: party(body.media_agency), partner: party(body.partner),
    personalUse: flag(body.is_personal), fbEntity: num(body.fb_entity), ioNumber: text(body.io_number) ?? idText(body.io_number),
    lineNumbers: Array.isArray(body.line_numbers) ? body.line_numbers : null,
    nexusTasks: strings(body.user_tasks), nexusRole: body.user_tasks === undefined ? null : adAccountRole(strings(body.user_tasks)),
    migratedPermissions: bool(body.has_migrated_permissions), notificationsOn: bool(body.is_notifications_enabled),
    inventoryFilterLevels: strings(body.brand_safety_content_filter_levels),
    dsa: { payor: text(body.default_dsa_payor), beneficiary: text(body.default_dsa_beneficiary) },
    // Review round 3 — street and post code only when Meta says the account is for business use (else a person's home).
    businessAddress: {
      name: text(body.business_name), ...(streets ? { street: text(body.business_street), street2: text(body.business_street2) } : {}), city: text(body.business_city),
      state: text(body.business_state), ...(streets ? { zip: text(body.business_zip) } : {}), countryCode: text(body.business_country_code),
    },
    promotable: promotable ? {
      pages: strings(promotable.promotable_page_ids).map((id) => pageRef(id, takenPages, account)), appIds: strings(promotable.promotable_app_ids),
      urls: strings(promotable.promotable_urls),
    } : null,
    marketingMessages: body.marketing_messages_settings === undefined ? null : tidy(body.marketing_messages_settings),
    // SDK only (AA-022): Meta's answer decides; a refusal is named in missing.
    addresses: { liable: addressOf(body.liable_address, { street: streets, taxIds: false }), sendBillTo: addressOf(body.send_bill_to_address, { street: streets, taxIds: false }), soldTo: addressOf(body.sold_to_address, { street: streets, taxIds: false }) },
    ownerPortfolio: portfolioRef(body.owner_business, takenPortfolios, own), viewablePortfolio: portfolioRef(body.viewable_business, takenPortfolios, own),
    accessExpires: text(body.user_access_expire_time),
    customAudienceInfo: customAudience ? { newCustomerTag: text(customAudience.new_customer_tag), existingCustomerTag: text(customAudience.existing_customer_tag), audienceTypeParam: text(customAudience.audience_type_param_name) } : null,
    baSkipDelayedEligible: bool(body.is_ba_skip_delayed_eligible),
    // AA-021 — the agency declaration, without the client's e-mail address (Nexus never passes e-mail addresses on).
    agencyDeclaration: d ? {
      agencyRepresentingClient: flag(d.agency_representing_client), clientName: text(d.client_name),
      clientAddress: { street: [d.client_street, d.client_street2].map(text).filter(Boolean), city: text(d.client_city), postalCode: text(d.client_postal_code), province: text(d.client_province), countryCode: text(d.client_country_code) },
      clientBasedInFrance: flag(d.client_based_in_france), writtenMandateFromAdvertiser: flag(d.has_written_mandate_from_advertiser), clientPaysInvoices: flag(d.is_client_paying_invoices),
    } : null,
    missing,
    notes: [
      'nexusTasks: what Nexus\'s system user may do on this account (MANAGE is needed for the payment method, ADVERTISE or MANAGE for prepay and tax).',
      'personalUse: Meta treats the account as used for private purposes (it changes how VAT is charged); it is not whether the account belongs to a business.',
      ...(streets ? [] : ['The addresses show no street or post code: the account is for personal use (or Meta did not say), so they could be a person\'s home.']),
      'Meta cannot change the currency or time zone of an ad account by any API (Ads Manager neither: a new ad account is the way); the name, DSA defaults, business address, spending limit and notifications are changes a person approves.',
      'Status, money, terms and the opportunity score at a glance: meta-ads-live view account; spending limit and payment: meta-billing.',
    ],
  }
}

async function accountDsa(account: MetaChosenAccount) {
  const { connectionId, adAccountId } = account
  const read = await metaReadOne({ connectionId }, { operation: 'account.dsa', path: act(adAccountId), query: { fields: 'default_dsa_payor,default_dsa_beneficiary' } })
  const b = read.body as Row
  const suggestions = await part(() => listPaged(connectionId, 'account.dsaRecommendations', `${act(adAccountId)}/dsa_recommendations`, { fields: 'recommendations' }, 10))
  const payor = text(b.default_dsa_payor)
  const beneficiary = text(b.default_dsa_beneficiary)
  return {
    adAccountId, payor, beneficiary, readyForEu: !!(payor && beneficiary),
    suggestions: suggestions.value ? [...new Set(suggestions.value.rows.flatMap((r) => strings(r.recommendations)))] : null,
    missing: missingOf([['suggestions', suggestions]]),
    notes: [
      'The EU Digital Services Act: every ad set that reaches people in the EU names who pays (payor) and who benefits (beneficiary); an ad set without its own uses these account defaults, and Meta refuses an EU ad set when neither exists.',
      'suggestions: Meta\'s guesses ("we don\'t guarantee these will be correct"); the words are shown to people in the EU, so a person checks them before they are saved.',
      'Meta saves both or neither: changing them is a change a person approves.',
    ],
  }
}

async function accountTerms(account: MetaChosenAccount) {
  const { connectionId, adAccountId } = account
  const { body, missing } = await readGroups(connectionId, 'account.terms', act(adAccountId), [
    { name: 'core', fields: 'tos_accepted,offsite_pixels_tos_accepted' },
    // On the v26 field table, not in Meta's SDK: its own group.
    { name: 'directDeals', fields: 'direct_deals_tos_accepted' },
  ])
  const audienceTerms = await part(() => listGroups(connectionId, 'account.customAudiencesTos', `${act(adAccountId)}/customaudiencestos`, [{ name: 'core', fields: 'id,type' }, { name: 'content', fields: 'content' }], {}, 50))
  if (audienceTerms.notRead) missing.push({ part: 'customAudienceTerms', sentence: audienceTerms.notRead })
  return {
    adAccountId,
    accepted: spec(body.tos_accepted), offsitePixelsAccepted: bool(body.offsite_pixels_tos_accepted), directDealsAccepted: bool(body.direct_deals_tos_accepted),
    customAudienceTerms: audienceTerms.value ? audienceTerms.value.rows.map((r) => {
      const content = text(r.content)
      return { termsId: idText(r.id) ?? text(r.id), type: text(r.type), content: content && content.length > 1000 ? `${content.slice(0, 999)}…` : content, cut: !!content && content.length > 1000 }
    }) : null,
    missing: [...missing, ...(audienceTerms.value?.missing ?? [])],
    notes: [
      'accepted: the terms this ad account accepted (a key with 1 is accepted; a missing key is not).',
      'Meta cannot tell a system user whether a PERSON signed the Custom Audience terms: user_tos_accepted answers only to that person\'s own token ("not valid for system users", reference/ad-account), so Nexus does not ask it.',
      'Meta cannot accept terms for a system user: a person accepts the Custom Audience terms in Ads Manager (customer list audiences need them).',
    ],
  }
}

async function accountCapabilities(account: MetaChosenAccount) {
  const { connectionId, adAccountId } = account
  const { body, missing } = await readGroups(connectionId, 'account.capabilities', act(adAccountId), [
    { name: 'core', fields: 'capabilities,can_create_brand_lift_study,is_direct_deals_enabled,has_page_authorized_adaccount,is_attribution_spec_system_default,offsite_clo_signal_status,existing_customers,rf_spec' },
    { name: 'allCapabilities', fields: 'all_capabilities' },
  ])
  return {
    adAccountId,
    capabilities: strings(body.capabilities), allCapabilities: body.all_capabilities === undefined ? null : strings(body.all_capabilities),
    canCreateBrandLiftStudy: bool(body.can_create_brand_lift_study), directDeals: bool(body.is_direct_deals_enabled),
    pageAuthorizedForPoliticalAds: bool(body.has_page_authorized_adaccount), attributionIsSystemDefault: bool(body.is_attribution_spec_system_default),
    offsiteCloSignalStatus: num(body.offsite_clo_signal_status), existingCustomerAudienceIds: strings(body.existing_customers),
    reachAndFrequency: spec(body.rf_spec), missing,
    notes: [
      'Meta on capabilities: "accessible for legacy purposes … majority internal use only … avoid relying on its outcomes … will be phased out" — a hint, not a promise.',
      'existingCustomerAudienceIds: the custom audiences that tell Meta who already bought (Advantage+ sales uses them for new-customer goals).',
      'pageAuthorizedForPoliticalAds: political and social-issue ads are not allowed in the EU; Nexus never makes them.',
    ],
  }
}

const CONTROL_STATUS_WORDS: Readonly<Record<string, string>> = {
  APPLICATION_IN_PROGRESS: 'Being applied to the campaigns it fits',
  ACTIVE: 'Applied to every campaign it fits',
  WITH_CAMPAIGN_ERROR: 'Not applied to some campaigns (campaignsWithError): they conflict with the controls',
}

async function accountControls(account: MetaChosenAccount) {
  const { connectionId, adAccountId } = account
  const read = await listGroups(connectionId, 'account.controls', `${act(adAccountId)}/account_controls`, [
    { name: 'core', fields: 'audience_controls,campaigns_with_error,placement_controls,status' },
    { name: 'sdkOnly', fields: 'is_age_restriction_enabled,placement_controls_per_objective' },
  ], {}, 10)
  return {
    adAccountId,
    controls: read.rows.map((r) => ({
      status: text(r.status), statusText: text(r.status) ? CONTROL_STATUS_WORDS[text(r.status)!] ?? text(r.status) : null,
      audienceControls: spec(r.audience_controls), placementControls: spec(r.placement_controls), placementControlsPerObjective: spec(r.placement_controls_per_objective),
      ageRestriction: bool(r.is_age_restriction_enabled), campaignsWithError: strings(r.campaigns_with_error),
    })),
    missing: read.missing,
    notes: [
      'Account controls are the guard-rails every Advantage+ campaign of the account keeps (minimum age, countries in or out, excluded audiences, excluded placements). None listed: the account has none.',
      'Setting them is a change a person approves; Meta documents no update or delete of a control set (a new one is posted).',
    ],
  }
}

async function accountTracking(account: MetaChosenAccount) {
  const { connectionId, adAccountId } = account
  const read = await listPaged(connectionId, 'account.tracking', `${act(adAccountId)}/tracking`, { fields: 'tracking_specs' }, 10)
  return {
    adAccountId, trackingSpecs: read.rows.map((r) => spec(r.tracking_specs)),
    note: 'The account-level tracking specs Meta adds to every ad of the account (on top of each ad\'s own). Empty: none set.',
  }
}

/** Meta's documented object limits for an ad account (reference/ad-account "Limits"). */
const ACCOUNT_LIMITS = {
  peoplePerAdAccount: 25, adAccountsPerPerson: 25,
  campaigns: { regular: 6000, bulk: 10000, archived: 100000 }, adSets: { regular: 6000, bulk: 10000, archived: 100000 }, ads: { regular: 6000, bulk: 50000, archived: 100000 },
  note: 'Non-archived, non-deleted objects per ad account (bulk accounts: Meta\'s own grant). Ad images: no limit.',
}

async function accountLimits(account: MetaChosenAccount, bidAmountCents: number | null) {
  const { connectionId, adAccountId, currency } = account
  let bidAmount: number | null = null
  if (bidAmountCents !== null) {
    bidAmount = minorToMetaUnits(bidAmountCents, currency)
    if (bidAmount === null || bidAmount <= 0) throw new MetaLiveRefusal(`bidAmountCents must be a positive whole amount in ${currency ?? 'the account currency'}'s minor units that Meta can take.`)
  }
  const budgets = await part(() => listPaged(connectionId, 'account.minimumBudgets', `${act(adAccountId)}/minimum_budgets`, {
    fields: 'currency,min_daily_budget_imp,min_daily_budget_video_views,min_daily_budget_high_freq,min_daily_budget_low_freq', ...(bidAmount !== null ? { bid_amount: bidAmount } : {}),
  }, 200))
  const pages = await part(() => pageAdLimits(account))
  return {
    adAccountId, currency, ...(bidAmountCents !== null ? { bidAmountCents } : {}),
    minimumDailyBudgets: budgets.value ? budgets.value.rows.map((r) => {
      const c = text(r.currency)
      return {
        currency: c, chosenAccountsCurrency: !!c && c === currency,
        minDailyBudgetImpressionsCents: cents(r.min_daily_budget_imp, c), minDailyBudgetVideoViewsCents: cents(r.min_daily_budget_video_views, c),
        minDailyBudgetHighFrequencyCents: cents(r.min_daily_budget_high_freq, c), minDailyBudgetLowFrequencyCents: cents(r.min_daily_budget_low_freq, c),
      }
    }).sort((a, b) => Number(b.chosenAccountsCurrency) - Number(a.chosenAccountsCurrency)) : null,
    pageAdLimits: pages.value ? pages.value.pages : null,
    objectLimits: ACCOUNT_LIMITS,
    missing: [...missingOf([['minimumDailyBudgets', budgets], ['pageAdLimits', pages]]), ...(pages.value?.missing ?? [])],
    notes: [
      'minimumDailyBudgets: the least daily budget Meta takes for an ad set, by what it optimises for (impressions; clicks, likes and video views — high frequency; installs and offers — low frequency), in minor units of each currency. With bidAmountCents: the floors for that manual bid. Accounts in Italy, Germany, France, Spain, Austria, Belgium, the Netherlands and more have floors about twice as high (Meta\'s ad-set "Bid/Budget Validations"); Meta\'s answer here is the floor for this account.',
      'pageAdLimits: ads running or in review against each Page\'s ad limit. At the limit new ads do not publish and existing ones can only be paused or archived; ads with a day schedule count for the whole day. The account\'s own total: meta-ads-live view ads-volume.',
    ],
  }
}

async function accountGoals(account: MetaChosenAccount) {
  const { connectionId, adAccountId } = account
  const [mcme, goals] = await Promise.all([
    part(() => listPaged(connectionId, 'account.mcmeConversions', `${act(adAccountId)}/mcmeconversions`, { fields: 'id,name,description,mcme_conversion_type,is_archived,creation_time,omnichannel_object_id' }, 200)),
    // SDK only (adaccount.py get_conversion_goals → AdsConversionGoal).
    part(() => listPaged(connectionId, 'account.conversionGoals', `${act(adAccountId)}/conversion_goals`, { fields: 'id,name,description,performance_goal,conversion_event_value_source,goal_creation_method,update_status' }, 200)),
  ])
  return {
    adAccountId,
    mcmeConversions: mcme.value ? mcme.value.rows.map((r) => ({
      id: idText(r.id), name: text(r.name), description: text(r.description), type: text(r.mcme_conversion_type), archived: bool(r.is_archived), createdTime: text(r.creation_time), omnichannelObjectId: idText(r.omnichannel_object_id),
    })) : null,
    conversionGoals: goals.value ? goals.value.rows.map((r) => ({
      id: idText(r.id), name: text(r.name), description: text(r.description), performanceGoal: text(r.performance_goal), valueSource: text(r.conversion_event_value_source),
      createdBy: text(r.goal_creation_method), updateStatus: text(r.update_status),
    })) : null,
    missing: missingOf([['mcmeConversions', mcme], ['conversionGoals', goals]]),
    notes: [
      'Meta documents these lists by their fields only, not what each goal does in delivery: read them as Meta\'s names for the account\'s conversion goals (the ad sets that use one: meta-ad-sets).',
      'The attribution windows an ad set may use (1-day or 7-day click, 1-day view …) are set per ad set; meta-ad-account view attribution-options asks Meta for an app\'s events.',
    ],
  }
}

async function accountAttributionOptions(account: MetaChosenAccount, input: { appId: string | null; optimizationGoal: string | null; eventName: string | null }) {
  const { connectionId, adAccountId } = account
  const appId = input.appId ? metaObjectId(input.appId) : null
  if (input.eventName === 'OTHER') throw new MetaLiveRefusal('eventName OTHER means a custom app event Meta names by its own string (custom_event_str); Nexus reads the standard app events only — name one (e.g. PURCHASE, COMPLETE_REGISTRATION).')
  if (!appId || !input.optimizationGoal) {
    throw new MetaLiveRefusal('Meta answers the attribution options for an APP\'s events only: it needs appId (an app connected to the ad account, view apps of meta-account-access) and optimizationGoal (e.g. APP_INSTALLS, OFFSITE_CONVERSIONS). Nexus runs no app ads; a website ad set\'s attribution is its own setting (meta-ad-sets).')
  }
  // The app must be one the chosen account reaches (its applications, or the advertisable ones of its portfolio).
  const [connected, advertisable] = await Promise.all([
    part(() => listPaged(connectionId, 'account.applications', `${act(adAccountId)}/applications`, { fields: 'id' }, 500)),
    part(() => listPaged(connectionId, 'account.advertisableApplications', `${act(adAccountId)}/advertisable_applications`, { fields: 'id', ...(account.businessId ? { business_id: account.businessId } : {}) }, 500)),
  ])
  const known = new Set([...(connected.value?.rows ?? []), ...(advertisable.value?.rows ?? [])].map((r) => idText(r.id)).filter(Boolean))
  if (!known.has(appId)) {
    throw new MetaLiveRefusal(connected.value || advertisable.value ? 'That app is not one connected to (or advertisable from) the chosen ad account, so its attribution options are not read.' : `Nexus could not list the ad account's apps (${connected.notRead ?? advertisable.notRead}), so it cannot check the app.`)
  }
  const read = await listPaged(connectionId, 'account.campaignAttributionOptions', `${act(adAccountId)}/campaign_attribution_options`, {
    fields: 'is_eligible,value', app_id: appId, optimization_goal: input.optimizationGoal, ...(input.eventName ? { event_name: input.eventName } : {}),
  }, 100)
  return {
    adAccountId, appId, optimizationGoal: input.optimizationGoal, eventName: input.eventName,
    options: read.rows.map((r) => ({ value: text(r.value) ?? spec(r.value), eligible: bool(r.is_eligible) })), more: read.more,
    note: 'Meta\'s attribution choices for that app event and goal (value) and whether this account may use each (eligible).',
  }
}

/** IN-049 — what each insights feature unlocks (insights/breakdowns, "Insights feature settings"). */
const FEATURE_UNLOCKS: Readonly<Record<string, string>> = {
  comscore: 'breakdowns=comscore_market', impression_device: 'breakdowns=impression_device',
  time_of_day_viewer_tz: 'breakdowns=hourly_stats_aggregated_by_audience_time_zone', frequency_value: 'breakdowns=frequency_value',
}

async function accountInsightsFeatures(account: MetaChosenAccount, feature: string | null) {
  const { connectionId, adAccountId } = account
  const [available, enabled] = await Promise.all([
    part(() => listPaged(connectionId, 'account.insightsFeatures', `${act(adAccountId)}/insights/feature-settings/list-features`, {}, 100)),
    part(() => listPaged(connectionId, 'account.insightsFeaturesOn', `${act(adAccountId)}/insights/feature-settings`, feature ? { insights_feature: feature } : {}, 100)),
  ])
  if (!available.value && !enabled.value) throw new MetaLiveRefusal(available.notRead ?? enabled.notRead ?? 'Meta refused the read.')
  const on = new Map((enabled.value?.rows ?? []).map((r) => [text(r.feature_name), r] as const).filter((e): e is [string, Row] => !!e[0]))
  const names = [...new Set([...(available.value?.rows ?? []).map((r) => text(r.feature_name)).filter((n): n is string => !!n), ...on.keys()])].filter((n) => !feature || n === feature)
  return {
    adAccountId,
    features: names.map((name) => {
      const row = (available.value?.rows ?? []).find((r) => text(r.feature_name) === name)
      const enabledRow = on.get(name)
      return {
        name, type: text(row?.feature_type), unlocks: FEATURE_UNLOCKS[name] ?? null,
        enabled: enabled.value ? !!enabledRow && (text(enabledRow.status) ?? 'enabled') === 'enabled' : null,
        dataFrom: enabledRow ? text(enabledRow.insights_effective_date) ?? 'all dates' : null,
      }
    }),
    missing: missingOf([['available', available], ['enabled', enabled]]),
    notes: [
      'A breakdown whose feature is off comes back EMPTY with no error: it is "switched off", never 0.',
      'Switching a feature on is a change a person approves and cannot be undone (Meta has no API to switch one off); data then comes from about 24 hours later, going forward (dataFrom).',
    ],
  }
}

/** One view of the chosen ad account's own settings. */
export async function adAccountView(input: { connectionId?: string | null; view: AccountView; bidAmountCents?: number | null; appId?: string | null; optimizationGoal?: string | null; eventName?: string | null; feature?: string | null }) {
  const account = await metaChosenAccount(input.connectionId)
  switch (input.view) {
    case 'settings': return accountSettings(account)
    case 'dsa': return accountDsa(account)
    case 'terms': return accountTerms(account)
    case 'capabilities': return accountCapabilities(account)
    case 'controls': return accountControls(account)
    case 'tracking': return accountTracking(account)
    case 'limits': return accountLimits(account, input.bidAmountCents ?? null)
    case 'goals': return accountGoals(account)
    case 'attribution-options': return accountAttributionOptions(account, { appId: input.appId ?? null, optimizationGoal: input.optimizationGoal ?? null, eventName: input.eventName ?? null })
    case 'insights-features': return accountInsightsFeatures(account, input.feature ?? null)
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

// ── meta-billing ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const BILLING_VIEWS = ['spend', 'payment', 'tax', 'events', 'invoices', 'credit-lines', 'invoice-groups', 'credit-allocations', 'cards', 'credit-applications'] as const
export type BillingView = typeof BILLING_VIEWS[number]
export const INVOICE_TYPES = ['INV', 'CM', 'DM', 'PRO_FORMA'] as const

/** funding_source_details TYPE (reference/ad-account). */
export const FUNDING_TYPE_WORDS: Readonly<Record<number, string>> = {
  0: 'Not set', 1: 'Credit or debit card', 2: 'Facebook wallet', 3: 'Facebook paid credit', 4: 'Meta credit line (monthly invoicing)', 5: 'Order',
  6: 'Invoice', 7: 'Facebook token', 8: 'External funding', 9: 'Fee', 10: 'Currency exchange', 11: 'Discount', 12: 'PayPal', 13: 'PayPal billing agreement',
  14: 'None', 15: 'External deposit', 16: 'Tax', 17: 'Direct debit', 18: 'Placeholder', 19: 'Alternative payment method', 20: 'Stored balance (prepaid funds)',
}
/** tax_id_status (reference/ad-account). */
export const TAX_STATUS_WORDS: Readonly<Record<number, string>> = {
  0: 'Unknown', 1: 'VAT not required (US / Canada)', 2: 'VAT information required', 3: 'VAT information submitted', 4: 'Offline VAT check failed', 5: 'A personal account',
}
/**
 * LG-003 — the billing events of the activity log (AdActivity event_type). Review round 4: Meta's v26 ad-activity page
 * ("Event types by category", checked 2026-10-21) files every one of these under category BUDGET — none under ACCOUNT
 * (review, business information, status, people, images) — except ad_account_billing_charge_failed, which it files under
 * no category (CHARGE_FAILED).
 */
export const BILLING_EVENT_TYPES: ReadonlySet<string> = new Set([
  'ad_account_billing_charge', 'ad_account_billing_chargeback', 'ad_account_billing_chargeback_reversal',
  'ad_account_billing_decline', 'ad_account_billing_refund', 'billing_event', 'add_funding_source', 'remove_funding_source',
  'funding_event_initiated', 'funding_event_successful',
])
/** A failed charge: in the ad-activity enum, in none of Meta's categories. */
export const CHARGE_FAILED = 'ad_account_billing_charge_failed'

const NO_PAYMENT_API = 'Meta has no API to add, change or remove a payment method or to add prepaid funds: a person does it in Meta Business settings › Billing and payments (or Ads Manager › Billing).'

async function billingSpend(account: MetaChosenAccount) {
  const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'billing.spend', path: act(account.adAccountId), query: { fields: 'currency,amount_spent,spend_cap,balance,min_daily_budget,min_campaign_group_spend_cap' } })
  const b = read.body as Row
  const currency = text(b.currency) ?? account.currency
  const spent = metaUnitsToMicros(b.amount_spent, currency)
  const cap = metaAccountSpendCapMicros(b.spend_cap, currency)
  return {
    adAccountId: account.adAccountId, currency,
    amountSpentCents: minorOf(spent, currency), spendCapCents: minorOf(cap, currency), spendCapSet: cap !== null,
    spendLeftCents: cap !== null && spent !== null ? minorOf(cap > spent ? cap - spent : 0n, currency) : null,
    balanceCents: cents(b.balance, currency), minDailyBudgetCents: cents(b.min_daily_budget, currency), minCampaignSpendCapCents: cents(b.min_campaign_group_spend_cap, currency),
    notes: [
      'amountSpent counts against the spending limit (spendCap); when it is reached every ad of the account stops. A new limit counts only spend after it is set; resetting puts amountSpent back to 0. Meta allows 10 limit changes a day.',
      'amountSpent can differ from the spend in the numbers (Meta\'s help "why amount spent is different"): the numbers are meta-ads-overview / meta-ads-live.',
      'balance: what the account owes now (the bill not yet paid).',
      'Setting, resetting or removing the spending limit is a change a person approves.',
    ],
  }
}

/** A payment method as Meta shows it: its kind and Meta's own masked words, never more. */
function fundingOf(v: unknown) {
  const f = obj(v)
  if (!f) return null
  const pick = (key: string) => f[key] ?? f[key.toUpperCase()]
  const type = num(pick('type'))
  const coupons = [pick('coupon'), ...(Array.isArray(pick('coupons')) ? pick('coupons') as unknown[] : [])].map(obj).filter((c): c is Row => !!c)
  return {
    paymentMethodId: idText(pick('id')), type, typeText: type === null ? null : FUNDING_TYPE_WORDS[type] ?? `Type ${type}`,
    // Meta's own masked display (e.g. a card type and its last four digits): Nexus never reads more of a payment method.
    shownAs: text(pick('display_string')),
    coupons: coupons.map((c) => ({
      couponId: idText(c.coupon_id ?? c.COUPON_ID) ?? text(c.coupon_id), currency: text(c.currency ?? c.CURRENCY),
      displayAmount: text(c.display_amount ?? c.DISPLAY_AMOUNT), originalDisplayAmount: text(c.original_display_amount ?? c.ORIGINAL_DISPLAY_AMOUNT),
      startDate: text(c.start_date ?? c.START_DATE), expiration: text(c.expiration ?? c.EXPIRATION), campaignIds: strings(c.campaign_ids ?? c.CAMPAIGN_IDS),
    })),
  }
}

async function billingPayment(account: MetaChosenAccount) {
  const { connectionId, adAccountId } = account
  const { body, missing } = await readGroups(connectionId, 'billing.payment', act(adAccountId), [
    { name: 'core', fields: 'funding_source,show_checkout_experience,is_in_3ds_authorization_enabled_market,extended_credit_invoice_group{id,name}' },
    // ADVERTISE or MANAGE (reference/ad-account).
    { name: 'prepay', fields: 'is_prepay_account' },
  ])
  // Review A7 (step 2) — MANAGE only, and in a combined read a refusal nulls the rest: always its own read.
  const details = await part(() => metaReadOne({ connectionId }, { operation: 'billing.paymentMethod', path: act(adAccountId), query: { fields: 'funding_source_details,expired_funding_source_details' } }))
  if (details.notRead) missing.push({ part: 'paymentMethod', sentence: `${details.notRead} (Meta answers the payment method only to a system user with the MANAGE task on the ad account.)` })
  const d = obj(details.value?.body)
  const group = obj(body.extended_credit_invoice_group)
  return {
    adAccountId,
    paymentMethodId: idText(body.funding_source), hasPaymentMethod: body.funding_source === undefined ? null : !!idText(body.funding_source),
    prepaid: bool(body.is_prepay_account), prepaidCheckout: bool(body.show_checkout_experience), strongCustomerAuthenticationMarket: bool(body.is_in_3ds_authorization_enabled_market),
    invoiceGroup: group ? { invoiceGroupId: idText(group.id), name: text(group.name) } : null,
    paymentMethod: fundingOf(d?.funding_source_details), expiredPaymentMethod: fundingOf(d?.expired_funding_source_details),
    missing,
    notes: [
      'Without a payment method Meta still lets ads be made, but they do not deliver (and Meta hides the payment method while the account is disabled).',
      'shownAs is Meta\'s own masked text of the payment method; Nexus never reads a card number, expiry, holder\'s name or bank detail.',
      NO_PAYMENT_API,
    ],
  }
}

async function billingTax(account: MetaChosenAccount) {
  const { body, missing } = await readGroups(account.connectionId, 'billing.tax', act(account.adAccountId), [
    { name: 'core', fields: 'tax_id,tax_id_status,tax_id_type,is_personal' },
    // ADVERTISE or MANAGE only (reference/ad-account): its own group, so a refusal never costs the rest.
    { name: 'taxIdRequired', fields: 'is_tax_id_required' },
    { name: 'addresses', fields: 'liable_address,send_bill_to_address,sold_to_address' },
  ])
  const status = num(body.tax_id_status)
  const taxIds = businessUse(body)
  return {
    adAccountId: account.adAccountId,
    taxId: taxIds ? text(body.tax_id) : null, taxIdType: text(body.tax_id_type), taxIdStatus: status, taxIdStatusText: status === null ? null : TAX_STATUS_WORDS[status] ?? `Status ${status}`,
    taxIdRequired: bool(body.is_tax_id_required), personalUse: flag(body.is_personal),
    addresses: { liable: addressOf(body.liable_address, { street: taxIds, taxIds }), sendBillTo: addressOf(body.send_bill_to_address, { street: taxIds, taxIds }), soldTo: addressOf(body.sold_to_address, { street: taxIds, taxIds }) },
    missing,
    notes: [
      'Meta has no documented API to set the VAT number or the business address used for tax: a person sets them in Meta Business settings › Billing and payments.',
      'personalUse: the account is used for private purposes, so Meta charges VAT as to a consumer.',
      ...(taxIds ? [] : [flag(body.is_personal) === null && num(body.tax_id_status) !== 5
        ? 'Meta did not say whether the account is for personal use, so Nexus does not show its tax and registration numbers, streets or post codes (they could be a person\'s).'
        : 'A personal-use account: its tax and registration numbers, streets and post codes are a person\'s, so Nexus does not show them.']),
    ],
  }
}

/**
 * Review round 2 (A6) — tax and registration numbers are shown only for an account Meta says is NOT for personal use:
 * is_personal explicitly 0 and tax_id_status not 5 ("a personal account"). Meta silent: they could be a person's, masked.
 */
const businessUse = (b: Row) => flag(b.is_personal) === false && num(b.tax_id_status) !== 5

/**
 * LG-003 — the keys of a billing event's extra_data Nexus passes on (Meta documents the field only as "JSON encoded extra
 * information"): plain values only, never a nested object (a payment method's details could sit there), and never a
 * value that looks like an e-mail address (review round 2: a PayPal method's old / new value can be one). The names of
 * the keys left out are answered (never their values), so the list can grow from LIVE-PROBES LG-003.
 */
export const BILLING_EXTRA_KEYS: ReadonlySet<string> = new Set(['amount', 'currency', 'old_value', 'new_value', 'value', 'type', 'reason', 'status', 'payment_status', 'charge_type', 'billing_reason', 'transaction_id', 'funding_source_type'])
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/
/** A key name Meta sent, passed on only when it is a plain name (never data shaped like a key). */
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
function billingExtraOf(raw: unknown): { kept: Record<string, string | number | boolean> | null; dropped: number; droppedKeys: string[] } {
  let extra: unknown = raw ?? null
  if (typeof extra === 'string') { try { extra = JSON.parse(extra) } catch { return { kept: null, dropped: 1, droppedKeys: [] } } }
  const o = obj(extra)
  if (!o) return { kept: null, dropped: extra === null ? 0 : 1, droppedKeys: [] }
  const kept: Record<string, string | number | boolean> = {}
  const droppedKeys: string[] = []
  let dropped = 0
  for (const [key, value] of Object.entries(o)) {
    const plain = typeof value === 'string' ? !EMAIL_LIKE.test(value) : typeof value === 'number' || typeof value === 'boolean'
    if (BILLING_EXTRA_KEYS.has(key) && plain) kept[key] = typeof value === 'string' ? (graphSafe(value) as string) : value as number | boolean
    else {
      dropped++
      if (KEY_NAME.test(key) && !droppedKeys.includes(key)) droppedKeys.push(key)
    }
  }
  return { kept: Object.keys(kept).length ? kept : null, dropped, droppedKeys }
}

/** A day (YYYY-MM-DD) → Unix seconds at 00:00 UTC. */
const unixOf = (day: string) => Math.floor(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / 1000)

const ACTIVITY_FIELDS = 'event_time,event_type,translated_event_type,actor_id,actor_name,application_id,application_name,object_id,object_name,object_type,date_time_in_timezone,extra_data'
/** Who made a billing change: Nexus's own system user or the chosen Page by name; anyone else is Meta's id only. */
function actorOf(account: MetaChosenAccount, r: Row) {
  const actorId = idText(r.actor_id)
  // Review round 4 (step 5's rule, one for every tool) — people are named only in meta-account-access view people.
  const bySystemUser = !!actorId && actorId === (account.connection.systemUser?.id ?? null)
  const byPage = !!actorId && actorId === account.pageId
  return {
    actorId, who: bySystemUser ? 'Nexus\'s own system user' : byPage ? 'the chosen Facebook Page' : actorId ? 'someone else (a person, an agency or Meta)' : null,
    ...(bySystemUser || byPage ? { actorName: text(r.actor_name) } : {}),
  }
}

async function billingEvents(account: MetaChosenAccount, input: { from: string; to: string; maxRows: number }) {
  const { connectionId, adAccountId } = account
  const days = { since: unixOf(input.from), until: unixOf(input.to) + 86_400 }
  // Review round 4 — the billing events from category BUDGET, where Meta's v26 ad-activity page files them (the v26 edge
  // page lists no parameter; the SDK has since, until, category): its budget changes are left out here.
  const budget = await listPaged(connectionId, 'billing.events', `${act(adAccountId)}/activities`, { fields: ACTIVITY_FIELDS, category: 'BUDGET', ...days }, 500)
  // A failed charge is in no Meta category: ONE read of the whole log of these days (the same cap) is searched for it.
  // A throttle or a lost token ends the read; another refusal costs only the failed charges (said in Meta's words).
  let failed: Awaited<ReturnType<typeof listPaged>> | null = null
  const missing: MissingPart[] = []
  try {
    failed = await listPaged(connectionId, 'billing.eventsChargeFailed', `${act(adAccountId)}/activities`, { fields: ACTIVITY_FIELDS, ...days }, 500)
  } catch (err) {
    if (!(err instanceof MetaReadError) || err.failure.authLost || err.failure.throttled) throw err
    missing.push({ part: 'failedCharges', sentence: err.failure.sentence })
  }
  const seen = new Set<string>()
  const rows = [
    ...budget.rows.filter((r) => BILLING_EVENT_TYPES.has(text(r.event_type) ?? '') || text(r.event_type) === CHARGE_FAILED),
    ...(failed?.rows ?? []).filter((r) => text(r.event_type) === CHARGE_FAILED),
  ].filter((r) => {
    const key = JSON.stringify([r.event_time, r.event_type, r.object_id, r.actor_id, r.extra_data])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => (text(b.event_time) ?? '').localeCompare(text(a.event_time) ?? ''))
  const events = rows.slice(0, input.maxRows).map((r) => {
    const extra = billingExtraOf(r.extra_data)
    return {
      time: text(r.event_time), timeInAccountZone: text(r.date_time_in_timezone), type: text(r.event_type), typeText: text(r.translated_event_type),
      ...actorOf(account, r), appName: text(r.application_name), objectId: idText(r.object_id) ?? text(r.object_id), objectName: text(r.object_name),
      // Meta's details, only the plain keys Nexus knows (they may hold amounts, in Meta's units): money all the same.
      metaRaw: extra.kept, ...(extra.dropped ? { detailsLeftOut: extra.dropped, leftOutKeys: extra.droppedKeys } : {}),
    }
  })
  return {
    adAccountId, from: input.from, to: input.to, events, scanned: { budgetCategory: budget.rows.length, wholeLog: failed ? failed.rows.length : null },
    more: budget.more || failed?.more ? 'Nexus read the first 500 entries of the activity log in these days (each read); narrow the days to see older billing events.' : null,
    missing,
    notes: [
      'Charges, declined charges, refunds, chargebacks, payment-method changes and funding events from the account\'s activity log (Meta\'s category BUDGET); spending-limit and budget changes are in the activity log itself.',
      'A failed charge (ad_account_billing_charge_failed) is in none of Meta\'s categories: Nexus looks for it in one read of the whole activity log of these days, so only the first 500 entries Meta answers are searched (narrow the days to search further).',
      'who: Nexus\'s own system user or the chosen Facebook Page by name; anyone else is Meta\'s id only (meta-account-access view people names the people on the account).',
      'metaRaw: only the plain details Nexus knows (amount, currency, old and new value, reason, status …; never an e-mail address); detailsLeftOut counts what Meta sent besides and leftOutKeys names those keys (never their values).',
      'Receipts and invoices of card-paid accounts are in Ads Manager › Billing (Meta has no API for card receipts); monthly invoices of a credit line: view invoices.',
    ],
  }
}

/**
 * Review A1 — the portfolio's credit lines, for the views that read under one: only a line the chosen portfolio OWNS is
 * read further (its invoice groups, allocations); a line another portfolio shares into it is its id and a flag, with no
 * further call (its addresses, tax numbers, ad accounts and allocations are that portfolio's).
 */
async function creditLines(account: MetaChosenAccount, portfolioId: string, asked: string | null): Promise<{ owned: string[]; foreign: Array<{ creditLineId: string; ownedByAnotherPortfolio: true }> }> {
  const read = await listPaged(account.connectionId, 'billing.creditLineIds', `${portfolioId}/extendedcredits`, { fields: 'id,owner_business{id}' }, 50)
  const lines = read.rows.map((r) => ({ id: idText(r.id), owner: idText(obj(r.owner_business)?.id) })).filter((l): l is { id: string; owner: string | null } => !!l.id)
  const split = (list: typeof lines) => ({
    owned: list.filter((l) => l.owner === portfolioId).map((l) => l.id).slice(0, 10),
    foreign: list.filter((l) => l.owner !== portfolioId).map((l) => ({ creditLineId: l.id, ownedByAnotherPortfolio: true as const })),
  })
  if (asked) {
    const id = metaObjectId(asked)
    const line = lines.find((l) => l.id === id)
    if (!line) throw new MetaLiveRefusal('That is not a credit line of the chosen ad account\'s business portfolio (view credit-lines lists them).')
    return split([line])
  }
  return split(lines)
}
const FOREIGN_LINES = 'A credit line another business portfolio owns and shares into this one is its id and a flag only: its invoice groups, addresses, tax numbers and allocations are that portfolio\'s.'

const NO_CREDIT_LINE = 'The portfolio has no Meta credit line (monthly invoicing): card- or PayPal-paid accounts have none, so there is nothing here.'

async function billingPortfolioView(account: MetaChosenAccount, view: BillingView, input: BillingInput) {
  const { connectionId } = account
  const { portfolioId, shared } = await ownPortfolio(account, 'its billing')
  if (shared) return { adAccountId: account.adAccountId, portfolio: shared }
  const maxRows = input.maxRows ?? 100
  switch (view) {
    case 'invoices': {
      const query: Record<string, MetaQueryValue> = {}
      if (input.invoiceId) query.invoice_id = input.invoiceId
      else {
        // Meta: "issue_start_date … must be set in order to query by the issue date".
        if (input.issuedTo && !input.issuedFrom) throw new MetaLiveRefusal('Meta queries by issue date only from a first day: name issuedFrom too.')
        if (input.from) query.start_date = input.from
        if (input.to) query.end_date = input.to
        if (input.issuedFrom) query.issue_start_date = input.issuedFrom
        if (input.issuedTo) query.issue_end_date = input.issuedTo
        if (input.invoiceType) query.type = input.invoiceType
      }
      const read = await listGroups(connectionId, 'billing.invoices', `${portfolioId}/business_invoices`, [
        { name: 'core', fields: 'id,invoice_id,invoice_date,due_date,billing_period,type,invoice_type,payment_status,payment_term,currency,amount,amount_due,ad_account_ids,liability_type,entity,advertiser_name' },
        { name: 'details', fields: 'billed_amount_details' },
      ], query, maxRows, true)
      const takenAccounts = await takenIds('AD_ACCOUNT', read.rows.flatMap((r) => strings(r.ad_account_ids).map((id) => metaAdAccountId(id)).filter((id): id is string => !!id)))
      return {
        adAccountId: account.adAccountId, portfolioId, totalCount: read.totalCount,
        invoices: read.rows.map((r) => {
          const due = money(r.amount_due)
          const accounts = strings(r.ad_account_ids).map((id) => metaAdAccountId(id)).filter((id): id is string => !!id)
          return {
            invoiceRootId: idText(r.id), invoiceNumber: text(r.invoice_id) ?? idText(r.invoice_id), invoiceDate: text(r.invoice_date), dueDate: text(r.due_date), billingPeriod: text(r.billing_period),
            type: text(r.type), invoiceType: text(r.invoice_type), paymentStatus: text(r.payment_status), paymentTerm: text(r.payment_term), liabilityType: text(r.liability_type),
            metaEntity: text(r.entity), advertiserName: text(r.advertiser_name), currency: text(r.currency),
            // "numeric string", unit not documented: Meta's number as sent (LIVE-PROBES BM-025).
            amountMeta: text(r.amount) ?? num(r.amount), amountDueCents: due.cents, amountDueCurrency: due.currency,
            billedAmountMeta: spec(r.billed_amount_details),
            adAccounts: accounts.map((id) => (takenAccounts.has(id) ? { adAccountId: id, takenByAnotherBusiness: true } : { adAccountId: id, chosenHere: id === account.adAccountId, takenByAnotherBusiness: false })),
          }
        }),
        more: read.more, missing: read.missing,
        notes: [
          'Only a portfolio on monthly invoicing (a Meta credit line) has invoices; a card-paid account has none here.',
          'from / to are billing periods (the first day of the month invoiced; Meta includes neither from nor to); without them Meta answers the last 6 months. issuedFrom is included, issuedTo is not.',
          'amountMeta is Meta\'s invoice amount as sent (its unit is not documented); amountDueCents is what is left to pay. Nexus does not pass on Meta\'s PDF links (they open the invoice for whoever holds them): a person downloads an invoice in Meta Business settings › Billing and payments.',
        ],
      }
    }
    case 'credit-lines': {
      const read = await listPaged(connectionId, 'billing.creditLines', `${portfolioId}/extendedcredits`, {
        fields: 'id,credit_type,is_access_revoked,is_automated_experience,allocated_amount,balance,credit_available,max_balance,online_max_balance,legal_entity_name,liable_biz_name,owner_business{id,name},owner_business_name,partition_from,send_bill_to_biz_name',
      }, 50)
      const taken = await takenIds('PORTFOLIO', portfolioIdsOf(read.rows.map((r) => r.owner_business)))
      return {
        adAccountId: account.adAccountId, portfolioId,
        creditLines: read.rows.map((r) => {
          const owner = portfolioRef(r.owner_business, taken, portfolioId)
          const ownerTaken = owner?.takenByAnotherBusiness === true
          // Review A1 — a line another portfolio owns: never its legal names; one another Nexus business owns: its id only.
          const ownedHere = owner?.portfolioId === portfolioId
          const base = { creditLineId: idText(r.id), creditType: text(r.credit_type), accessRevoked: bool(r.is_access_revoked), automated: bool(r.is_automated_experience), owner, ownedByThisPortfolio: ownedHere }
          // Review round 2 (A3) — a line whose owner Meta does not name is treated as another business's: no amounts either.
          if (!owner || ownerTaken) return base
          const [allocated, balance, available, max, onlineMax] = [r.allocated_amount, r.balance, r.credit_available, r.max_balance, r.online_max_balance].map(money)
          return {
            ...base,
            balanceCents: balance.cents, balanceCurrency: balance.currency, creditAvailableCents: available.cents, creditAvailableCurrency: available.currency,
            maxBalanceCents: max.cents, maxBalanceCurrency: max.currency, onlineMaxBalanceCents: onlineMax.cents, onlineMaxBalanceCurrency: onlineMax.currency,
            allocatedCents: allocated.cents, allocatedCurrency: allocated.currency,
            ownerName: text(r.owner_business_name), grantedBy: text(r.partition_from),
            ...(ownedHere ? { legalEntityName: text(r.legal_entity_name), liableBusinessName: text(r.liable_biz_name), billToBusinessName: text(r.send_bill_to_biz_name) } : {}),
          }
        }),
        more: read.more,
        notes: [
          'A Meta credit line pays the portfolio\'s ad accounts by monthly invoice. Its amounts are in their own currency (Meta measures credit lines in USD at the top level), never converted.',
          'A line another business portfolio shares into this one shows no legal names; one another business in Nexus owns, or whose owner Meta does not name, shows no amounts either.',
          ...(read.rows.length ? [] : [NO_CREDIT_LINE]),
          'Meta has no API to open, raise or close a credit line: a person applies in Meta Business settings › Billing and payments.',
        ],
      }
    }
    case 'invoice-groups': {
      const lines = await creditLines(account, portfolioId, input.creditLineId ?? null)
      const out: unknown[] = []
      const missing: MissingPart[] = []
      let groupsRead = 0
      // Review A4 — a personal-use account's tax numbers are a person's: when it is (or Meta does not say), none shown.
      const personal = await part(() => metaReadOne({ connectionId }, { operation: 'billing.personalCheck', path: act(account.adAccountId), query: { fields: 'is_personal,tax_id_status' } }))
      const taxIds = !!personal.value && businessUse(personal.value.body as Row)
      for (const creditLineId of lines.owned) {
        const groups = await part(() => listGroups(connectionId, 'billing.invoiceGroups', `${creditLineId}/extended_credit_invoice_groups`, [
          // Never `email` / `emails`: the invoice e-mail addresses are people's addresses (Business settings shows them).
          { name: 'core', fields: 'id,name,auto_enroll,customer_po_number' },
          { name: 'addresses', fields: 'bill_to_address,sold_to_address,liable_address' },
        ], {}, 50))
        if (!groups.value) { missing.push({ part: `invoiceGroups ${creditLineId}`, sentence: groups.notRead! }); continue }
        missing.push(...groups.value.missing)
        for (const g of groups.value.rows) {
          const groupId = idText(g.id)
          let adAccounts: unknown = null
          if (groupId && groupsRead < 25) {
            groupsRead++
            const accounts = await part(() => listPaged(connectionId, 'billing.invoiceGroupAccounts', `${groupId}/ad_accounts`, { fields: 'account_id,name' }, 100))
            if (accounts.value) {
              const ids = accounts.value.rows.map((a) => metaAdAccountId(a.account_id ?? a.id)).filter((id): id is string => !!id)
              const taken = await takenIds('AD_ACCOUNT', ids)
              adAccounts = accounts.value.rows.map((a) => {
                const id = metaAdAccountId(a.account_id ?? a.id)
                return id && taken.has(id) ? { adAccountId: id, takenByAnotherBusiness: true } : { adAccountId: id, name: text(a.name), chosenHere: id === account.adAccountId, takenByAnotherBusiness: false }
              })
            } else adAccounts = { notRead: accounts.notRead }
          }
          out.push({
            creditLineId, invoiceGroupId: groupId, name: text(g.name), autoEnroll: bool(g.auto_enroll), purchaseOrderNumber: text(g.customer_po_number),
            billTo: addressOf(g.bill_to_address, { street: taxIds, taxIds }), soldTo: addressOf(g.sold_to_address, { street: taxIds, taxIds }), liable: addressOf(g.liable_address, { street: taxIds, taxIds }), adAccounts,
          })
        }
      }
      return {
        adAccountId: account.adAccountId, portfolioId, invoiceGroups: out, creditLinesOfOtherPortfolios: lines.foreign, missing,
        notes: [
          'An invoice group puts several ad accounts of a credit line on ONE monthly invoice. adAccounts: the accounts in each group (another business\'s by id only).',
          ...(lines.owned.length || lines.foreign.length ? [] : [NO_CREDIT_LINE]),
          ...(lines.foreign.length ? [FOREIGN_LINES] : []),
          ...(taxIds ? [] : ['The addresses show no street, post code, tax or registration number: the ad account is for personal use (or Meta did not say), so they would be a person\'s.']),
          'Nexus does not read the invoice e-mail addresses (people\'s addresses); a person sees them in Meta Business settings › Billing and payments.',
        ],
      }
    }
    case 'credit-allocations': {
      const lines = await creditLines(account, portfolioId, input.creditLineId ?? null)
      const rows: Array<{ creditLineId: string; row: Row }> = []
      const missing: MissingPart[] = []
      for (const creditLineId of lines.owned) {
        const read = await part(() => listPaged(connectionId, 'billing.creditAllocations', `${creditLineId}/owning_credit_allocation_configs`, {
          fields: 'id,currency_amount,liability_type,partition_type,request_status,send_bill_to,owning_business{id,name},receiving_business{id,name},owning_credential{id},receiving_credential{id}',
        }, 50))
        if (read.value) rows.push(...read.value.rows.map((row) => ({ creditLineId, row })))
        else missing.push({ part: `creditAllocations ${creditLineId}`, sentence: read.notRead! })
      }
      const taken = await takenIds('PORTFOLIO', portfolioIdsOf(rows.flatMap(({ row }) => [row.owning_business, row.receiving_business])))
      return {
        adAccountId: account.adAccountId, portfolioId,
        allocations: rows.map(({ creditLineId, row }) => {
          const amount = money(row.currency_amount)
          return {
            creditLineId, allocationId: idText(row.id), amountCents: amount.cents, amountCurrency: amount.currency, liabilityType: text(row.liability_type),
            partitionType: text(row.partition_type), requestStatus: text(row.request_status), invoicesGoTo: text(row.send_bill_to),
            owner: portfolioRef(row.owning_business, taken, portfolioId), receiver: portfolioRef(row.receiving_business, taken, portfolioId),
            owningCreditLineId: idText(obj(row.owning_credential)?.id), receivingCreditLineId: idText(obj(row.receiving_credential)?.id),
          }
        }),
        creditLinesOfOtherPortfolios: lines.foreign, missing,
        notes: [
          'Credit this portfolio\'s credit line shares with other businesses (an agency or partner set-up). A Nexus business pays only for itself: none listed is the usual case.',
          ...(lines.owned.length || lines.foreign.length ? [] : [NO_CREDIT_LINE]),
          ...(lines.foreign.length ? [FOREIGN_LINES] : []),
        ],
      }
    }
    case 'cards': {
      // SDK only (business.py get_credit_cards → CreditCard): Meta's type and last four only — never the holder, expiry or address.
      const read = await listPaged(connectionId, 'billing.cards', `${portfolioId}/creditcards`, { fields: 'id,readable_card_type,last4,is_enabled,is_soft_disabled,is_last_used' }, 50)
      return {
        adAccountId: account.adAccountId, portfolioId,
        cards: read.rows.map((r) => ({ cardId: idText(r.id), cardType: text(r.readable_card_type), endsWith: text(r.last4), enabled: bool(r.is_enabled), softDisabled: bool(r.is_soft_disabled), lastUsed: bool(r.is_last_used) })),
        more: read.more,
        notes: ['The cards saved on the business portfolio, as Meta masks them (type and last four digits). Nexus never reads a card number, expiry, holder\'s name or billing address.', NO_PAYMENT_API],
      }
    }
    case 'credit-applications': {
      // SDK only (business.py get_extended_credit_applications): no tax ids, phone numbers, addresses or who submitted.
      const read = await listPaged(connectionId, 'billing.creditApplications', `${portfolioId}/extendedcreditapplications`, {
        fields: 'id,status,display_currency,proposed_credit_limit,original_online_limit,product_types,billing_country,is_umi', ...(input.pendingOnly ? { only_show_pending: true } : {}),
      }, 50)
      return {
        adAccountId: account.adAccountId, portfolioId,
        applications: read.rows.map((r) => {
          const proposed = money(r.proposed_credit_limit)
          const original = money(r.original_online_limit)
          return {
            applicationId: idText(r.id), status: text(r.status), currency: text(r.display_currency), productTypes: strings(r.product_types), billingCountry: text(r.billing_country),
            proposedCreditLimitCents: proposed.cents, proposedCreditLimitCurrency: proposed.currency, originalOnlineLimitCents: original.cents, originalOnlineLimitCurrency: original.currency,
            umi: bool(r.is_umi),
          }
        }),
        more: read.more,
        notes: ['Applications for a Meta credit line (monthly invoicing) and their status. Applying is a person\'s step in Meta Business settings; Meta documents no API for it.'],
      }
    }
  }
  throw new MetaLiveRefusal(`Unknown view "${view}".`)
}

export interface BillingInput {
  connectionId?: string | null
  view: BillingView
  from?: string | null
  to?: string | null
  issuedFrom?: string | null
  issuedTo?: string | null
  invoiceId?: string | null
  invoiceType?: string | null
  creditLineId?: string | null
  pendingOnly?: boolean
  maxRows?: number
}

/** One view of the chosen ad account's billing (READ ONLY). */
export async function billingView(input: BillingInput) {
  const account = await metaChosenAccount(input.connectionId)
  switch (input.view) {
    case 'spend': return billingSpend(account)
    case 'payment': return billingPayment(account)
    case 'tax': return billingTax(account)
    case 'events': {
      if (!input.from || !input.to) throw new MetaLiveRefusal('Name the days (from and to, YYYY-MM-DD).')
      return billingEvents(account, { from: input.from, to: input.to, maxRows: input.maxRows ?? 200 })
    }
    default: return billingPortfolioView(account, input.view, input)
  }
}

// ── meta-account-access ──────────────────────────────────────────────────────────────────────────────────────────────

export const ACCESS_VIEWS = ['people', 'agencies', 'apps', 'pages', 'instagram', 'by-person', 'asset-people'] as const
export type AccessView = typeof ACCESS_VIEWS[number]
export const ASSET_KINDS = ['page', 'instagram', 'catalog', 'pixel'] as const
export type AssetKind = typeof ASSET_KINDS[number]

/**
 * BM-008 — what one person or system user can reach: the edge and the fields Nexus asks of each kind. Review round 2
 * (A1): a system user may serve several businesses in Nexus, so EVERY kind shows a name only when Nexus knows it is this
 * business's — the one chosen here, or one the chosen portfolio OWNS while no other business in Nexus uses that portfolio.
 * One another business in Nexus picked is its id and the flag; any other is its id only (takenByAnotherBusiness null:
 * Nexus does not know whose). The owner, asked with the name (a refused owner group costs the names, never shows one):
 * ad accounts, Pages and catalogs `business{id}` (v26 reference: ad-account "business", page "business — The Business
 * associated with this Page", product-catalog "Business that owns a catalog"); pixels, apps, asset groups, creative
 * folders, offline datasets and WhatsApp accounts `owner_business{id}` (on each node in Meta's SDK only: adspixel,
 * application, businessassetgroup, businesscreativefolder, offlineconversiondataset, whatsappbusinessaccount). An Instagram
 * account has no owner field: the chosen portfolio's owned_instagram_assets (InstagramBusinessAsset ig_user_id, SDK)
 * decide — a client asset is another portfolio's, like a client Page. Monetization properties have no owner field Nexus
 * knows: ids only.
 */
export const PERSON_ASSET_EDGES: Readonly<Record<string, { edge: string; fields: string; owner?: 'business' | 'owner_business' }>> = {
  adAccounts: { edge: 'assigned_ad_accounts', fields: 'account_id', owner: 'business' },
  pages: { edge: 'assigned_pages', fields: 'id', owner: 'business' },
  instagram: { edge: 'assigned_instagram_accounts', fields: 'id,username' },
  catalogs: { edge: 'assigned_product_catalogs', fields: 'id', owner: 'business' },
  pixels: { edge: 'assigned_ads_pixels', fields: 'id', owner: 'owner_business' },
  apps: { edge: 'assigned_apps', fields: 'id', owner: 'owner_business' },
  assetGroups: { edge: 'assigned_business_asset_groups', fields: 'id', owner: 'owner_business' },
  creativeFolders: { edge: 'assigned_creative_folders', fields: 'id', owner: 'owner_business' },
  offlineDatasets: { edge: 'assigned_offline_conversion_data_sets', fields: 'id', owner: 'owner_business' },
  whatsapp: { edge: 'assigned_whatsapp_business_accounts', fields: 'id', owner: 'owner_business' },
  monetization: { edge: 'assigned_monetization_properties', fields: 'id' },
}
/** The kinds Nexus's table of what another business picked answers (taken.ts), and the chosen one of each. */
const PICKED_KINDS: Readonly<Record<string, { product: 'AD_ACCOUNT' | 'PAGE' | 'INSTAGRAM'; chosen: (a: MetaChosenAccount) => string | null }>> = {
  adAccounts: { product: 'AD_ACCOUNT', chosen: (a) => a.adAccountId }, pages: { product: 'PAGE', chosen: (a) => a.pageId }, instagram: { product: 'INSTAGRAM', chosen: (a) => a.instagramId },
}
export const PERSON_ASSET_KINDS = Object.keys(PERSON_ASSET_EDGES)

const ASSIGNED_USER_FIELDS = 'id,name,user_type,tasks,permitted_tasks,business{id,name}'
const NO_EMAILS = 'Names and tasks only: Nexus never asks Meta for a person\'s e-mail address or token.'

/** People assigned to the chosen account (business and system users), with their portfolio masked. */
async function assignedToAccount(account: MetaChosenAccount, maxRows: number) {
  const portfolioId = portfolioOf(account, 'the people assigned to the ad account')
  return listPaged(account.connectionId, 'access.assignedUsers', `${act(account.adAccountId)}/assigned_users`, { fields: ASSIGNED_USER_FIELDS, business: portfolioId }, maxRows, true)
}

async function personRows(rows: Row[], account: MetaChosenAccount, withRole: boolean) {
  const taken = await takenIds('PORTFOLIO', portfolioIdsOf(rows.map((r) => r.business)))
  const systemUser = account.connection.systemUser?.id ?? null
  return rows.map((r) => {
    const tasks = strings(r.tasks)
    return {
      personId: idText(r.id), name: text(r.name), kind: text(r.user_type), tasks, taskWords: tasks.map((t) => TASK_WORDS[t] ?? t),
      ...(withRole ? { role: adAccountRole(tasks) } : {}), ...(r.permitted_tasks !== undefined ? { assignableTasks: strings(r.permitted_tasks) } : {}),
      ...(r.business !== undefined ? { portfolio: portfolioRef(r.business, taken, account.businessId) } : {}),
      nexusSystemUser: !!systemUser && idText(r.id) === systemUser,
    }
  })
}

async function accessPeople(account: MetaChosenAccount, maxRows: number) {
  const [users, assigned] = await Promise.all([
    part(() => listPaged(account.connectionId, 'access.users', `${act(account.adAccountId)}/users`, { fields: 'id,name,tasks' }, maxRows)),
    part(() => assignedToAccount(account, maxRows)),
  ])
  if (!users.value && !assigned.value) throw new MetaLiveRefusal(assigned.notRead ?? users.notRead ?? 'Meta refused the read.')
  return {
    adAccountId: account.adAccountId,
    assigned: assigned.value ? await personRows(assigned.value.rows, account, true) : null, assignedTotal: assigned.value?.totalCount ?? null,
    appScopedUsers: users.value ? await personRows(users.value.rows, account, true) : null,
    more: !!(users.value?.more || assigned.value?.more), missing: missingOf([['assigned', assigned], ['appScopedUsers', users]]),
    notes: [
      'assigned: the business\'s people and system users on this ad account with their tasks (Admin = manage, advertise, analyse; Advertiser = advertise, analyse; Analyst = analyse). nexusSystemUser marks the one Nexus uses. At most 25 people per ad account.',
      'appScopedUsers: the people as Meta shows them to Nexus\'s app (its own ids).',
      NO_EMAILS,
      'Adding, changing or removing someone\'s tasks is a change a person approves; inviting people to the business portfolio is a portfolio admin\'s step.',
    ],
  }
}

async function accessAgencies(account: MetaChosenAccount, maxRows: number) {
  const read = await listPaged(account.connectionId, 'access.agencies', `${act(account.adAccountId)}/agencies`, { fields: 'id,name,access_status,access_requested_time,access_updated_time,permitted_tasks' }, maxRows)
  const taken = await takenIds('PORTFOLIO', read.rows.map((r) => idText(r.id)).filter((id): id is string => !!id))
  return {
    adAccountId: account.adAccountId,
    agencies: read.rows.map((r) => {
      const id = idText(r.id)
      if (id && taken.has(id)) return { portfolioId: id, takenByAnotherBusiness: true }
      return { portfolioId: id, name: text(r.name), accessStatus: text(r.access_status), requested: text(r.access_requested_time), updated: text(r.access_updated_time), tasks: strings(r.permitted_tasks), takenByAnotherBusiness: false }
    }),
    more: read.more,
    notes: [
      'Other business portfolios (agencies, partners) with access to this ad account, with what they may do; one another business in Nexus uses is its id only.',
      'Removing an agency\'s access is a change a person approves; Meta has no API to add one (the agency asks, the account\'s admin accepts in Business settings).',
    ],
  }
}

async function accessApps(account: MetaChosenAccount, maxRows: number) {
  const [connected, advertisable] = await Promise.all([
    part(() => listPaged(account.connectionId, 'access.applications', `${act(account.adAccountId)}/applications`, { fields: 'id,name,category' }, maxRows)),
    part(() => listPaged(account.connectionId, 'access.advertisableApplications', `${act(account.adAccountId)}/advertisable_applications`, { fields: 'id,name', ...(account.businessId ? { business_id: account.businessId } : {}) }, maxRows)),
  ])
  if (!connected.value && !advertisable.value) throw new MetaLiveRefusal(connected.notRead ?? advertisable.notRead ?? 'Meta refused the read.')
  const appId = account.connection.appId
  return {
    adAccountId: account.adAccountId,
    connected: connected.value ? connected.value.rows.map((r) => ({ appId: idText(r.id), name: text(r.name), category: text(r.category), nexusApp: !!appId && idText(r.id) === appId })) : null,
    advertisable: advertisable.value ? advertisable.value.rows.map((r) => ({ appId: idText(r.id), name: text(r.name) })) : null,
    missing: missingOf([['connected', connected], ['advertisable', advertisable]]),
    notes: [
      'connected: the apps that can act on this ad account (nexusApp marks the business\'s own Meta app Nexus uses). An app you do not know here is worth removing in Business settings.',
      'advertisable: apps the account could advertise (app ads are not something Nexus runs).',
    ],
  }
}

async function accessInstagram(account: MetaChosenAccount, input: { maxRows: number }) {
  const { connectionId, adAccountId, businessId } = account
  const masked = async (rows: Row[]) => {
    const taken = await takenIds('INSTAGRAM', rows.map((r) => idText(r.id)).filter((id): id is string => !!id))
    return rows.map((r) => (idText(r.id) && taken.has(idText(r.id)!) ? { instagramId: idText(r.id), takenByAnotherBusiness: true } : { instagramId: idText(r.id), username: text(r.username), chosenHere: idText(r.id) === account.instagramId, takenByAnotherBusiness: false }))
  }
  const [accounts, connected, iabp, authorized] = await Promise.all([
    // AA-030 — the account's Instagram accounts, with Meta's total_count (summary).
    part(() => listPaged(connectionId, 'access.instagramAccounts', `${act(adAccountId)}/instagram_accounts`, { fields: 'id,username' }, input.maxRows, true)),
    part(() => listPaged(connectionId, 'access.connectedInstagram', `${act(adAccountId)}/connected_instagram_accounts`, { fields: 'id,username' }, input.maxRows)),
    // SDK only (adaccount.py get_connected_instagram_accounts_with_iabp).
    businessId ? part(() => listPaged(connectionId, 'access.connectedInstagramIabp', `${act(adAccountId)}/connected_instagram_accounts_with_iabp`, { fields: 'id,username', business_id: businessId }, input.maxRows)) : Promise.resolve({ value: null, notRead: 'The chosen ad account belongs to no business portfolio.' }),
    // AA-067 — which of the portfolio's ad accounts may advertise for the CHOSEN Instagram account.
    account.instagramId && businessId
      ? part(() => listPaged(connectionId, 'access.instagramAuthorizedAccounts', `${account.instagramId}/authorized_adaccounts`, { fields: 'account_id,name', business: businessId }, input.maxRows))
      : Promise.resolve({ value: null, notRead: account.instagramId ? 'The chosen ad account belongs to no business portfolio.' : 'No Instagram account is chosen for this business yet.' }),
  ])
  let authorizedAccounts: unknown = null
  if (authorized.value) {
    const ids = authorized.value.rows.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((id): id is string => !!id)
    const taken = await takenIds('AD_ACCOUNT', ids)
    authorizedAccounts = authorized.value.rows.map((r) => {
      const id = metaAdAccountId(r.account_id ?? r.id)
      return id && taken.has(id) ? { adAccountId: id, takenByAnotherBusiness: true } : { adAccountId: id, name: text(r.name), chosenHere: id === adAccountId, takenByAnotherBusiness: false }
    })
  }
  return {
    adAccountId, chosenInstagramId: account.instagramId,
    accounts: accounts.value ? await masked(accounts.value.rows) : null, accountsTotal: accounts.value?.totalCount ?? null,
    connected: connected.value ? await masked(connected.value.rows) : null,
    connectedWithIabp: iabp.value ? await masked(iabp.value.rows) : null,
    chosenAccountMayAdvertiseFrom: authorizedAccounts,
    missing: missingOf([['accounts', accounts], ['connected', connected], ['connectedWithIabp', iabp], ['chosenAccountMayAdvertiseFrom', authorized]]),
    notes: [
      'accounts / connected: the Instagram accounts this ad account can advertise as (connectedWithIabp: through the business portfolio, Meta\'s SDK only). One another business in Nexus uses is its id only.',
      'chosenAccountMayAdvertiseFrom: the portfolio\'s ad accounts allowed to run ads for the chosen Instagram account (another business\'s by id only).',
      'An ad creative names the Instagram account by these ids (Meta\'s older InstagramUserID is deprecated).',
    ],
  }
}

async function accessByPerson(account: MetaChosenAccount, input: { personId: string | null; kinds: string[] | null; maxRows: number }) {
  const { connectionId } = account
  const systemUser = account.connection.systemUser?.id ?? null
  let personId: string
  let personName: string | null = account.connection.systemUser?.name ?? null
  if (!input.personId || input.personId === systemUser) {
    if (!systemUser) throw new MetaLiveRefusal('Nexus has not read which system user this connection acts as yet (meta-connection view check reads it); name a person (personId from view people).')
    personId = systemUser
  } else {
    const id = metaObjectId(input.personId)
    if (!id) throw new MetaLiveRefusal(`"${input.personId}" is not a Meta person id (digits).`)
    // Only someone assigned to the chosen ad account (view people, assigned): never any id.
    const assigned = await assignedToAccount(account, 500)
    const person = assigned.rows.find((r) => idText(r.id) === id)
    if (!person) throw new MetaLiveRefusal('That person is not assigned to the chosen ad account (view people lists who is), so what they reach is not read.')
    personId = id
    personName = text(person.name)
  }
  const kinds = input.kinds?.length ? input.kinds.filter((k) => PERSON_ASSET_EDGES[k]) : PERSON_ASSET_KINDS
  const portfolioShared = account.businessId ? (await takenIds('PORTFOLIO', [account.businessId])).has(account.businessId) : false
  /** The portfolio whose own assets Nexus may name: the chosen account's, when no other business in Nexus uses it. */
  const namingPortfolio = account.businessId && !portfolioShared ? account.businessId : null
  const assets: Record<string, unknown> = {}
  const missing: MissingPart[] = []
  for (const kind of kinds) {
    const { edge, fields, owner } = PERSON_ASSET_EDGES[kind]
    const groups: FieldGroup[] = [{ name: 'core', fields }, ...(owner ? [{ name: 'owner', fields: `name,${owner}{id}` }] : [])]
    const read = await part(() => listGroups(connectionId, `access.person.${edge}`, `${personId}/${edge}`, groups, {}, input.maxRows))
    if (!read.value) { missing.push({ part: kind, sentence: read.notRead! }); continue }
    missing.push(...read.value.missing.map((m) => ({ part: `${kind} ${m.part}`, sentence: m.sentence })))
    const rows = read.value.rows
    const idOf = (r: Row) => (kind === 'adAccounts' ? metaAdAccountId(r.account_id ?? r.id) : idText(r.id))
    const picked = PICKED_KINDS[kind]
    const chosen = picked?.chosen(account) ?? null
    const taken = picked ? await takenIds(picked.product, rows.map(idOf).filter((id): id is string => !!id)) : new Set<string>()
    // Review round 2 (A1) — an Instagram account has no owner field: the chosen portfolio's own Instagram business assets
    // decide (read only when a row is neither the chosen one nor picked by another business).
    let ownedInstagram: ReadonlySet<string> = new Set()
    if (kind === 'instagram' && namingPortfolio && rows.some((r) => { const id = idOf(r); return !!id && id !== chosen && !taken.has(id) })) {
      const list = await portfolioList(connectionId, 'access.person.instagramOwner', `${namingPortfolio}/owned_instagram_assets`, 'id,ig_user_id')
      if ('rows' in list) ownedInstagram = new Set(list.rows.map((r) => idText(r.ig_user_id)).filter((id): id is string => !!id))
      else missing.push({ part: 'instagram owner', sentence: `Nexus could not list the business portfolio's own Instagram accounts (${list.notListed}), so only the chosen one is named.` })
    }
    assets[kind] = rows.map((r) => {
      const id = idOf(r)
      if (id && taken.has(id)) return { id, takenByAnotherBusiness: true }
      const chosenHere = !!id && id === chosen
      const owned = !!namingPortfolio && !!id && (kind === 'instagram' ? ownedInstagram.has(id) : !!owner && idText(obj(r[owner])?.id) === namingPortfolio)
      if (!chosenHere && !owned) return { id, takenByAnotherBusiness: null }
      const name = text(r.name ?? r.username)
      return picked ? { id, name, chosenHere, ownedByThisPortfolio: owned, takenByAnotherBusiness: false } : { id, name, ownedByThisPortfolio: true }
    })
    if (read.value.more) assets[`${kind}More`] = true
  }
  return {
    adAccountId: account.adAccountId, personId, personName, nexusSystemUser: personId === systemUser, assets, missing,
    notes: [
      'Everything this person (or Nexus\'s system user) is assigned in the business portfolio, kind by kind. For the system user it proves Nexus holds only this business\'s assets: anything another business in Nexus uses is its id only.',
      'A name is shown only for the ad account, Page or Instagram account chosen here, or an asset this business portfolio owns while no other business in Nexus uses the portfolio; one another business in Nexus picked is its id and takenByAnotherBusiness true; any other is its id only (takenByAnotherBusiness null: Nexus does not know whose). A system user may serve several businesses, so this holds for it too.',
      ...(portfolioShared ? ['This business portfolio is shared with another business in Nexus: everything but the assets chosen here is an id only.'] : []),
      NO_EMAILS,
    ],
  }
}

/**
 * Review round 2 (B5) — one list of the chosen portfolio (its owned / client Instagram assets or catalogs). A throttle or
 * a lost token ends the whole read (rethrown); any other refusal is `notListed`, Meta's sentence, so the caller says
 * Nexus could not list it — never "not one of the portfolio's".
 */
async function portfolioList(connectionId: string, operation: string, path: string, fields: string): Promise<{ rows: Row[] } | { notListed: string }> {
  try {
    return { rows: (await listPaged(connectionId, operation, path, { fields }, 500)).rows }
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return { notListed: err.failure.sentence }
    throw err
  }
}

/** The first row of the portfolio's lists (in this order) that matches, and the lists Meta did not answer (with its words). */
async function findInPortfolio(connectionId: string, portfolioId: string, operation: string, edges: readonly string[], fields: string, matches: (r: Row) => boolean): Promise<{ row: Row | null; notListed: string[] }> {
  const notListed: string[] = []
  for (const edge of edges) {
    const list = await portfolioList(connectionId, `${operation}.${edge}`, `${portfolioId}/${edge}`, fields)
    if ('notListed' in list) { notListed.push(`${edge}: ${list.notListed}`); continue }
    const row = list.rows.find(matches)
    if (row) return { row, notListed }
  }
  return { row: null, notListed }
}

async function accessAssetPeople(account: MetaChosenAccount, input: { asset: AssetKind; assetId: string | null; maxRows: number }) {
  const { connectionId } = account
  const portfolioId = portfolioOf(account, 'who holds tasks on an asset')
  let assetId: string
  switch (input.asset) {
    case 'page': {
      if (!account.pageId) throw new MetaLiveRefusal('No Facebook Page is chosen for this business yet.')
      if (input.assetId && metaObjectId(input.assetId) !== account.pageId) throw new MetaLiveRefusal('Only the Facebook Page this business chose is read here.')
      assetId = account.pageId
      break
    }
    case 'instagram': {
      if (!account.instagramId) throw new MetaLiveRefusal('No Instagram account is chosen for this business yet.')
      if (input.assetId && metaObjectId(input.assetId) !== account.instagramId) throw new MetaLiveRefusal('Only the Instagram account this business chose is read here.')
      // Review B1 — people hold tasks on the portfolio's Instagram BUSINESS ASSET, not on the IG user: find the asset whose
      // ig_user_id is the chosen account (business owned_instagram_assets, then client_instagram_assets; SDK
      // instagrambusinessasset.py id, ig_user_id), then read that asset's people. Review round 2 (B5): a throttle or a lost
      // token ends the read; a list Meta refused otherwise is said, never taken for "not an asset of the portfolio".
      const { row, notListed } = await findInPortfolio(connectionId, portfolioId, 'access.instagramAssets', ['owned_instagram_assets', 'client_instagram_assets'], 'id,ig_user_id', (r) => idText(r.ig_user_id) === account.instagramId)
      const found = idText(row?.id)
      if (!found) {
        throw new MetaLiveRefusal(notListed.length
          ? `Nexus could not list the business portfolio's Instagram assets (${notListed.join('; ')}), so it cannot find the chosen Instagram account's business asset: the people holding tasks on it are not read.`
          : 'The chosen Instagram account is not an Instagram asset of the chosen ad account\'s business portfolio (owned or client), so the people holding tasks on it are not read.')
      }
      assetId = found
      break
    }
    case 'catalog': {
      const id = input.assetId ? metaObjectId(input.assetId) : null
      if (!id) throw new MetaLiveRefusal('Name the catalog (assetId, digits).')
      const { shared } = await ownPortfolio(account, 'a catalog\'s people')
      if (shared) throw new MetaLiveRefusal('Another business in Nexus uses an ad account of this business portfolio, so Nexus cannot tell whose this catalog is: its people are not read here.')
      // Review round 2 (A5) — the id must be one of the portfolio's CATALOGS (business owned_product_catalogs, then
      // client_product_catalogs; reference business), as the pixel check looks in the account's pixels: an owner check
      // alone would let a Page, dataset or folder id of the same portfolio through.
      const { row, notListed } = await findInPortfolio(connectionId, portfolioId, 'access.catalogCheck', ['owned_product_catalogs', 'client_product_catalogs'], 'id', (r) => idText(r.id) === id)
      if (!row) {
        throw new MetaLiveRefusal(notListed.length
          ? `Nexus could not list the business portfolio's catalogs (${notListed.join('; ')}), so it cannot confirm this is one of them: its people are not read.`
          : 'That is not a catalog of the chosen ad account\'s business portfolio (owned, or shared with it), so its people are not read.')
      }
      assetId = id
      break
    }
    case 'pixel': {
      const id = input.assetId ? metaObjectId(input.assetId) : null
      if (!id) throw new MetaLiveRefusal('Name the pixel (assetId, digits).')
      const pixels = await listPaged(connectionId, 'access.pixelCheck', `${act(account.adAccountId)}/adspixels`, { fields: 'id' }, 500)
      if (!pixels.rows.some((r) => idText(r.id) === id)) throw new MetaLiveRefusal('That pixel is not one of the chosen ad account\'s pixels, so its people are not read.')
      assetId = id
      break
    }
  }
  let rows: Awaited<ReturnType<typeof listPaged>>
  try {
    rows = await listPaged(connectionId, `access.assetPeople.${input.asset}`, `${assetId}/assigned_users`, { fields: 'id,name,user_type,tasks,permitted_tasks', business: portfolioId }, input.maxRows, true)
  } catch (err) {
    // A Page's people: Meta asks the Page token of a person with MANAGE (graph-api/reference/page/assigned_users).
    if (input.asset === 'page' && err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.throttled && err.failure.permissionDenied) throw new MetaLiveRefusal(`${err.message} ${PAGE_TOKEN_NOTE}`)
    throw err
  }
  return {
    adAccountId: account.adAccountId, asset: input.asset, assetId, ...(input.asset === 'instagram' ? { instagramId: account.instagramId } : {}), totalCount: rows.totalCount,
    people: await personRows(rows.rows, account, false), more: rows.more,
    notes: [
      'The business\'s people and system users holding tasks on this asset (Page: manage, create content, moderate, advertise, analyse; Instagram: content, advertise, analyse; catalog: manage, advertise; pixel: use, edit).',
      NO_EMAILS,
      'Giving or taking tasks is a change a person approves.',
    ],
  }
}

/** One view of who and what has access to the chosen ad account. */
export async function accessView(input: { connectionId?: string | null; view: AccessView; personId?: string | null; kinds?: string[] | null; asset?: AssetKind | null; assetId?: string | null; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const maxRows = Math.min(500, Math.max(1, input.maxRows ?? 100))
  switch (input.view) {
    case 'people': return accessPeople(account, maxRows)
    case 'agencies': return accessAgencies(account, maxRows)
    case 'apps': return accessApps(account, maxRows)
    case 'pages': {
      // AA-029 — meta-ads-live's own read of the promoted Pages (reused; another business's Page is its id only).
      const read = await liveView({ connectionId: account.connectionId, view: 'pages', maxRows })
      return { ...read, note: 'The Pages promoted under this ad account. Who holds tasks on the chosen Page: view asset-people (asset page).' }
    }
    case 'instagram': return accessInstagram(account, { maxRows })
    case 'by-person': return accessByPerson(account, { personId: input.personId ?? null, kinds: input.kinds ?? null, maxRows })
    case 'asset-people': {
      if (!input.asset) throw new MetaLiveRefusal('Name the asset (asset: page, instagram, catalog or pixel; assetId for a catalog or pixel).')
      return accessAssetPeople(account, { asset: input.asset, assetId: input.assetId ?? null, maxRows })
    }
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}
