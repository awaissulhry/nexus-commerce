/**
 * P1.8 (docs/channel-connections/FINAL-PLAN.md, section 13.7) — what the nightly contract run checks.
 *
 * The point is to notice a CHANNEL change before it reaches a live listing: our fixture tests only
 * replay answers we recorded ourselves, so a field a channel renames or drops stays green here and red
 * on the seller's account. These checks ask the real channel, on its sandbox, and read the shape of the
 * answer.
 *
 * Review 2026-09-26 — what each check can honestly claim. eBay's sandbox and the Amazon Ads test account
 * answer from a running service, so their shape checks can see a vendor change. Amazon SP-API's STATIC
 * sandbox answers FIXED examples (the same examples our finance mapping was built from), so the Amazon SP
 * checks prove sign-in and reachability only — our signing, the route, the version, the sandbox host — and
 * never a vendor contract change (`proves: 'sign-in and reachability'`). Watching Amazon's live answers
 * for drift is a separate, unbuilt follow-up.
 *
 * Two hard rules, enforced by the runner (`contract-run.service.ts`), not by good intentions:
 *   1. every check is a READ or the channel's own DRY RUN (eBay `Verify…`, Amazon `VALIDATION_PREVIEW`),
 *      so a contract run can never change a listing anywhere;
 *   2. every call goes to a SANDBOX host. A channel with no sandbox host is reported as not configured,
 *      never as green.
 *
 * P1.8 completion — coverage. A run is green only when every REQUIRED operation of every applicable channel
 * passed (`REQUIRED_OPERATIONS`); each check names the operation it proves (`covers`). An operation with
 * no check or a fixture nobody named keeps the run partial, by name. A channel with no sandbox at all is
 * NOT APPLICABLE (`NOT_APPLICABLE_CHANNELS`): out of the verdict, its reason stated in every run.
 */
import type { GatewayChannel } from '../gateway/vocabulary.js'
import { buildGetItemQuantitiesXml, parseGetItemQuantities, siteIdForMarket, tradingAnswerOk } from '../ebay-trading-api.service.js'
import { readTransactionsPage } from '../amazon-financial-events.service.js'
import { AMAZON_LISTING_READ_CHECK, EBAY_NOTIFICATION_READ_CHECKS } from './contract-read-checks.js'

export interface ContractContext {
  /** The sandbox account this channel's checks run as. */
  accountId: string
  /** Amazon only: the sandbox seller id. */
  sellerId?: string
  /** The named sandbox fixtures a check `needs`, by variable name (never empty: the runner checks). */
  fixture: Record<string, string>
  /** The account's token — only for `auth: 'iaf-header'` checks, which carry it in their own header. */
  token?: string
  /** Our app's client id for the named account's environment — only for `appClientId` checks. */
  appClientId?: string
}

export interface ContractCheck {
  channel: GatewayChannel
  /** Stable name, also the ledger operation: `ebay.getInventoryItems`. */
  name: string
  /** The required operation this check proves (an id in `REQUIRED_OPERATIONS[channel]`). */
  covers: string
  what: 'read' | 'dry-run write'
  /** Sandbox fixtures the Owner names by environment variable; one unset = not configured, nothing sent. */
  needs?: string[]
  /**
   * 'gateway' (default): the gateway signs the call with the account's token.
   * 'iaf-header': eBay Trading reads an OAuth token from X-EBAY-API-IAF-TOKEN, not from Authorization.
   * The runner fetches the account's token and the check sets the header itself, with gateway auth
   * 'none' — exactly as `callTradingApi` does. Without it eBay answers an auth error, not the contract.
   */
  auth?: 'gateway' | 'iaf-header' | 'ebay-app'
  /**
   * The channel wants OUR app's client id in a header of its own (Amazon Ads: Amazon-Advertising-API-ClientId,
   * as every Ads caller sends it). The runner reads it from `getChannelApp` for the named account's
   * environment; none = a failed check, nothing sent.
   */
  appClientId?: true
  /** For answers that carry a failure inside a 2xx (eBay Trading): tells the gateway's ledger it failed. */
  answerOk?: (text: string) => boolean
  /** The PRODUCTION url; the runner moves it to the channel's sandbox host and refuses if there is none. */
  url: (ctx: ContractContext) => string
  method?: 'GET' | 'POST'
  headers?: (ctx: ContractContext) => Record<string, string>
  body?: (ctx: ContractContext) => string
  /** The shape the answer must have. Return a sentence when it does not; null when the contract holds. */
  assert: (answer: { status: number; text: string; json: <T = unknown>() => T | null }, context?: ContractContext) => string | null
}

export interface RequiredOperation {
  id: string
  /** How the run's sentence names it. */
  label: string
  /** Why no check proves it yet — stated in the run's sentence rather than left out. */
  gap?: string
  /**
   * Set when a pass proves less than the vendor's contract: the sandbox answers a FIXED example, so a pass
   * means our sign-in reached the route and the example still reads — never that the live service is unchanged.
   */
  proves?: 'sign-in and reachability'
}

/** The eBay site the Trading checks run on: Nexus's home market (site 101). */
export const CONTRACT_EBAY_MARKET = 'IT'
export const EBAY_SANDBOX_SKU = 'NEXUS_CONTRACT_EBAY_SANDBOX_SKU'
export const EBAY_SANDBOX_ITEM_ID = 'NEXUS_CONTRACT_EBAY_SANDBOX_ITEM_ID'

/**
 * The named account must be a connection of this environment before any check of the channel is sent.
 * eBay: a sandbox token is issued by, and only valid on, eBay's sandbox — a contract check must never carry
 * a production account's token (Amazon SP-API and Ads sandboxes take the production sign-in, so no rule).
 */
export const ACCOUNT_ENVIRONMENT: Partial<Record<GatewayChannel, 'sandbox'>> = { EBAY: 'sandbox' }

/**
 * The Trading headers `callTradingApi` (ebay-trading-api.service.ts) sends, same names and value sources,
 * EXCEPT the app keys: eBay (Trading "Making a call", HTTP headers) — DEV/APP/CERT-NAME are "only required
 * for calls that set up and retrieve a user's authentication token … In all other calls, this value is
 * ignored". The real client sends the PRODUCTION keys (CERT is a secret); a sandbox call carries none.
 * `contract-coverage.p18` compares the two requests header for header.
 */
const tradingHeaders = (callName: string, ctx: ContractContext): Record<string, string> => ({
  'X-EBAY-API-CALL-NAME': callName,
  'X-EBAY-API-COMPATIBILITY-LEVEL': process.env.EBAY_COMPAT_LEVEL || '1193',
  'X-EBAY-API-SITEID': siteIdForMarket(CONTRACT_EBAY_MARKET),
  'X-EBAY-API-IAF-TOKEN': ctx.token ?? '',
  'Content-Type': 'text/xml',
})

/**
 * The errors eBay documents for an incomplete listing (Trading "Errors by number", RequestError class):
 * the answers our deliberately minimal item may provoke, which ARE the contract under watch. Anything
 * else fails — an auth, header or system error means eBay never validated the item, and an unknown code
 * means its vocabulary changed; either way nothing was proven tonight.
 */
export const VERIFY_VALIDATION_CODES: ReadonlySet<string> = new Set([
  '34', '37', '38', '10009', // a required input tag missing / empty / invalid ("Input data for tag <Item.X>")
  '69', '70', // title missing / too long
  '71', // location missing
  '73', // price invalid or below the minimum
  '83', // duration invalid
  '86', '87', '107', // category invalid / not a leaf
  '106', // description missing
  '354', // payment method missing
  '515', // quantity must be greater than 0
  '721', // shipping service missing or invalid
  '864', // currency invalid
  '21698', '21916883', '21916884', // item condition missing or invalid
  '21916250', // return option missing
  '21919136', // at least one photo
  '21919301', // GTIN missing
  '21919303', // required item specific missing
])

/** Codes that mean eBay did not look at the item at all — named in the failure so it reads as what it is. */
const EBAY_NOT_VALIDATION: Record<string, string> = {
  '930': 'auth: no token in the request', '931': 'auth: token invalid', '932': 'auth: token hard-expired',
  '16110': 'auth: token revoked by the user', '16112': 'auth: invalid authentication method', '16119': 'auth: token does not exist',
  '17470': 'auth: security token expired', '21916013': 'auth: token revoked by the app',
  '21916984': 'auth: IAF token invalid', '21917053': 'auth: IAF token expired',
  '2': 'header: unsupported call name', '26': 'header: invalid site id',
  '124': 'header: developer name invalid', '127': 'header: application name invalid', '131': 'header: certificate mismatch',
  '518': 'call usage limit reached', '10007': 'system error', '16100': 'system error: data unavailable',
}

/** The <Errors> blocks of a Trading answer that are errors (SeverityCode Warning is not). */
function tradingErrors(text: string): Array<{ code: string; classification: string; message: string }> {
  return [...text.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)].map((m) => m[1])
    .filter((block) => (/<SeverityCode>([^<]*)<\/SeverityCode>/.exec(block)?.[1] ?? 'Error') !== 'Warning')
    .map((block) => ({
      code: /<ErrorCode>([^<]*)<\/ErrorCode>/.exec(block)?.[1]?.trim() ?? '',
      classification: /<ErrorClassification>([^<]*)<\/ErrorClassification>/.exec(block)?.[1] ?? '',
      message: (/<LongMessage>([^<]*)<\/LongMessage>/.exec(block)?.[1] ?? /<ShortMessage>([^<]*)<\/ShortMessage>/.exec(block)?.[1] ?? '').slice(0, 160).replace(/\.\s*$/, ''),
    }))
}

const describeTradingError = (e: { code: string; classification: string; message: string }) =>
  `${e.code || 'no code'}${EBAY_NOT_VALIDATION[e.code] ? ` (${EBAY_NOT_VALIDATION[e.code]})` : ''}${e.classification ? ` [${e.classification}]` : ''}: ${e.message}`

/** Exported for the fixture pair: null when the answer is eBay validating the item, else why not. */
export function assertVerifyAnswer(status: number, text: string): string | null {
  if (status !== 200) return `eBay answered HTTP ${status} to the dry-run add.`
  const ack = /<Ack>([^<]*)<\/Ack>/.exec(text)?.[1]
  if (!ack) return 'eBay Verify answer carries no <Ack> — the Trading contract changed.'
  if (!/^(Success|Warning|Failure)$/.test(ack)) return `eBay Verify answered <Ack>${ack}</Ack>, which a single dry run never answers — the Trading contract changed.`
  // `<Fees/>` is self-closing on a clean verify, `<Fees>` carries entries — both are the contract.
  if (ack !== 'Failure') return /<Fees[\s/>]/.test(text) ? null : 'eBay Verify answered without errors but carries no fees — the Trading contract changed.'
  const errors = tradingErrors(text)
  if (errors.length === 0) return 'eBay Verify answered Failure with no error — the Trading contract changed.'
  const notValidation = errors.filter((e) => e.classification !== 'RequestError' || !VERIFY_VALIDATION_CODES.has(e.code))
  if (notValidation.length) {
    return `eBay did not validate the item — error ${notValidation.map(describeTradingError).join(' | ')}. Only listing-validation errors prove the dry-run contract.`
  }
  return null
}

export const CHANNEL_CONTRACTS: ContractCheck[] = [
  ...EBAY_NOTIFICATION_READ_CHECKS,
  AMAZON_LISTING_READ_CHECK,
  {
    channel: 'EBAY',
    name: 'ebay.getInventoryItems',
    covers: 'ebay.inventory.read',
    what: 'read',
    url: () => 'https://api.ebay.com/sell/inventory/v1/inventory_item?limit=1',
    // What the import reads (ebay-import.service.ts): the inventoryItems list itself, total for paging, and
    // each item's sku and product. An empty list proves none of it, so it fails.
    assert: ({ status, json }) => {
      if (status !== 200) return `eBay answered HTTP ${status} to the inventory read.`
      const body = json<{ inventoryItems?: unknown; total?: unknown }>()
      if (!body || !Array.isArray(body.inventoryItems)) return 'eBay inventory read no longer returns an inventoryItems list.'
      if (body.inventoryItems.length === 0) return 'eBay answered no inventory item — nothing about the item shape was proven (create one on the sandbox account).'
      if (typeof body.total !== 'number') return 'eBay inventory read no longer returns total as a number.'
      for (const item of body.inventoryItems as Array<Record<string, any>>) {
        if (typeof item?.sku !== 'string' || !item.product || typeof item.product !== 'object') return 'eBay inventory item no longer carries sku as text and a product object.'
      }
      return null
    },
  },
  {
    channel: 'EBAY',
    name: 'ebay.getOffers',
    covers: 'ebay.offer.read',
    what: 'read',
    needs: [EBAY_SANDBOX_SKU],
    url: (ctx) => `https://api.ebay.com/sell/inventory/v1/offer?sku=${encodeURIComponent(ctx.fixture[EBAY_SANDBOX_SKU])}`,
    // The fields the status reconcile reads (jobs/ebay-status-reconcile.job.ts): offerId, sku, status and,
    // once published, listing.listingId. An empty list proves nothing about them, so it fails.
    assert: ({ status, json }) => {
      if (status !== 200) return `eBay answered HTTP ${status} to the offer read of the named sandbox SKU.`
      const offers = json<{ offers?: unknown }>()?.offers
      if (!Array.isArray(offers)) return 'eBay offer read no longer returns an offers list.'
      if (offers.length === 0) return `eBay has no offer for the named sandbox SKU — nothing about the offer shape was proven (name a SKU with an offer in ${EBAY_SANDBOX_SKU}).`
      for (const offer of offers as Array<Record<string, any>>) {
        if (typeof offer?.offerId !== 'string' || typeof offer?.sku !== 'string' || typeof offer?.status !== 'string') {
          return 'eBay offer no longer carries offerId / sku / status as text.'
        }
        if (offer.status === 'PUBLISHED' && typeof offer.listing?.listingId !== 'string') return 'eBay published offer no longer carries listing.listingId.'
      }
      return null
    },
  },
  {
    channel: 'EBAY',
    name: 'ebay.getItem',
    covers: 'ebay.trading.GetItem',
    what: 'read',
    needs: [EBAY_SANDBOX_ITEM_ID],
    auth: 'iaf-header',
    answerOk: tradingAnswerOk,
    url: () => 'https://api.ebay.com/ws/api.dll',
    method: 'POST',
    headers: (ctx) => tradingHeaders('GetItem', ctx),
    // The request the quantity read-back sends, read with its own parser.
    body: (ctx) => buildGetItemQuantitiesXml(ctx.fixture[EBAY_SANDBOX_ITEM_ID]),
    assert: ({ status, text }) => {
      if (status !== 200) return `eBay answered HTTP ${status} to GetItem.`
      const ack = /<Ack>([^<]*)<\/Ack>/.exec(text)?.[1]
      if (!ack) return 'eBay GetItem answer carries no <Ack> — the Trading contract changed.'
      if (ack !== 'Success' && ack !== 'Warning') return `eBay GetItem answered ${ack}: ${tradingErrors(text).map(describeTradingError).join(' | ') || 'no error given'}.`
      const read = parseGetItemQuantities(text)
      if (!read.listingStatus) return 'eBay GetItem no longer returns SellingStatus.ListingStatus.'
      // The parser skips a variation it cannot read and then falls back to the ITEM quantity — so a renamed
      // Variation.SKU would read as a plain listing. Every declared <Variation> must read.
      const variationsBlock = /<Variations>([\s\S]*?)<\/Variations>/.exec(text)?.[1]
      if (variationsBlock !== undefined) {
        const declared = (variationsBlock.match(/<Variation>/g) ?? []).length
        if (declared === 0 || read.variations.length !== declared) {
          return `eBay GetItem variations no longer read: ${read.variations.length} of ${declared} <Variation> carry SKU and Quantity.`
        }
      }
      if (read.variations.length === 0 && read.itemAvailable === null) return 'eBay GetItem no longer returns a readable Quantity / QuantitySold for the item or its variations.'
      return null
    },
  },
  {
    channel: 'EBAY',
    name: 'ebay.verifyAddFixedPriceItem',
    covers: 'ebay.trading.VerifyAddFixedPriceItem',
    what: 'dry-run write',
    auth: 'iaf-header',
    answerOk: tradingAnswerOk,
    url: () => 'https://api.ebay.com/ws/api.dll',
    method: 'POST',
    headers: (ctx) => tradingHeaders('VerifyAddFixedPriceItem', ctx),
    // Deliberately a minimal item: eBay answers Failure with the fields it wants, which is exactly the
    // contract we want to watch. A changed error vocabulary shows up here first.
    body: () => `<?xml version="1.0" encoding="utf-8"?>
<VerifyAddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><Title>Nexus contract run</Title></Item></VerifyAddFixedPriceItemRequest>`,
    assert: ({ status, text }) => assertVerifyAnswer(status, text),
  },
  {
    channel: 'AMAZON_SP',
    name: 'amazon.getMarketplaceParticipations',
    covers: 'amazon.sellers.getMarketplaceParticipations',
    what: 'read',
    // SIGN-IN AND REACHABILITY only: the STATIC sandbox answers Amazon's own fixed example (sellers.json,
    // x-amzn-api-sandbox: one US row). A pass means our sandbox sign-in reached the route and the example still
    // reads with the fields the participation refresh uses — not how the live service answers a real seller.
    url: () => 'https://sellingpartnerapi-eu.amazon.com/sellers/v1/marketplaceParticipations',
    assert: ({ status, json }) => {
      if (status !== 200) return `Amazon's static sandbox answered HTTP ${status} to the participations read: sign-in or reachability failed.`
      const payload = json<{ payload?: unknown }>()?.payload
      if (!Array.isArray(payload)) return 'Amazon\'s static sandbox participations example has no payload list; sign-in and reachability not proven.'
      if (payload.length === 0) return 'Amazon\'s static sandbox answered no participation; its fixed example changed and nothing was read.'
      for (const row of payload as Array<Record<string, any>>) {
        if (typeof row?.marketplace?.id !== 'string' || typeof row?.marketplace?.countryCode !== 'string') return 'Amazon\'s static sandbox participation example no longer carries marketplace.id / marketplace.countryCode as text.'
        if (typeof row?.participation?.isParticipating !== 'boolean' || typeof row?.participation?.hasSuspendedListings !== 'boolean') {
          return 'Amazon\'s static sandbox participation example no longer carries participation.isParticipating / hasSuspendedListings as booleans.'
        }
      }
      return null
    },
  },
  {
    channel: 'AMAZON_SP',
    name: 'amazon.listTransactions',
    covers: 'amazon.finances.listTransactions',
    what: 'read',
    // SIGN-IN AND REACHABILITY only: Amazon's STATIC sandbox answers a canned example to exactly these
    // parameters (finances_2024-06-19.json, x-amzn-api-sandbox) — the same example the finance mapping was built
    // from, so a pass cannot show a vendor change. It proves the route, the version, our sandbox sign-in and that
    // the example still reads with `readTransactionsPage`.
    url: () => 'https://sellingpartnerapi-eu.amazon.com/finances/2024-06-19/transactions?postedAfter=2023-03-07&nextToken=jehgri34yo7jr9e8f984tr9i4o',
    assert: ({ status, json }) => {
      if (status !== 200) return `Amazon's static sandbox answered HTTP ${status} to listTransactions: sign-in or reachability failed.`
      let transactions: Array<Record<string, any>>
      try {
        transactions = readTransactionsPage(json()).transactions as Array<Record<string, any>>
      } catch (error) {
        return `Amazon's static sandbox listTransactions example no longer reads with readTransactionsPage: ${error instanceof Error ? error.message : String(error)}`
      }
      if (transactions.length === 0) return 'Amazon\'s static sandbox listTransactions answered no transaction; its fixed example changed and nothing was read.'
      const tx = transactions[0]
      if (typeof tx.transactionType !== 'string' || typeof tx.postedDate !== 'string' || typeof tx.totalAmount?.currencyAmount !== 'number' || typeof tx.totalAmount?.currencyCode !== 'string') {
        return 'Amazon\'s static sandbox transaction example no longer carries transactionType / postedDate / totalAmount.{currencyAmount, currencyCode}.'
      }
      return null
    },
  },
  {
    channel: 'AMAZON_ADS',
    name: 'ads.listProfiles',
    covers: 'ads.profiles.list',
    what: 'read',
    appClientId: true,
    url: () => 'https://advertising-api-eu.amazon.com/v2/profiles',
    headers: (ctx) => ({ 'Amazon-Advertising-API-ClientId': ctx.appClientId ?? '' }),
    // The fields account discovery and the Ads screens read (amazon-ads/spec.ts, amazon-ads-auth.routes.ts).
    assert: ({ status, json }) => {
      if (status !== 200) return `Amazon Ads answered HTTP ${status} to the profiles read.`
      const profiles = json()
      if (!Array.isArray(profiles)) return 'Amazon Ads profiles no longer answers with a list.'
      if (profiles.length === 0) return 'Amazon Ads answered no profile — nothing about the profile shape was proven (register a profile on the test account).'
      for (const profile of profiles as Array<Record<string, any>>) {
        if (typeof profile?.profileId !== 'number' && typeof profile?.profileId !== 'string') return 'Amazon Ads profile no longer carries profileId.'
        for (const key of ['countryCode', 'currencyCode', 'timezone']) {
          if (typeof profile[key] !== 'string') return `Amazon Ads profile no longer carries ${key} as text.`
        }
        for (const key of ['id', 'type', 'marketplaceStringId']) {
          if (typeof profile.accountInfo?.[key] !== 'string') return `Amazon Ads profile no longer carries accountInfo.${key} as text.`
        }
      }
      return null
    },
  },
]

/**
 * What must be proven before a run may be green, per in-scope channel (a NOT_APPLICABLE channel's list is
 * stated, not required). A static list on purpose: coverage is measured against what the connection USES,
 * not against whichever checks happen to exist.
 */
export const REQUIRED_OPERATIONS: Partial<Record<GatewayChannel, RequiredOperation[]>> = {
  EBAY: [
    { id: 'ebay.inventory.read', label: 'eBay inventory read' },
    { id: 'ebay.offer.read', label: 'eBay offer read (getOffers)' },
    { id: 'ebay.trading.GetItem', label: 'eBay Trading GetItem' },
    { id: 'ebay.trading.VerifyAddFixedPriceItem', label: 'eBay dry-run add (VerifyAddFixedPriceItem)' },
    { id: 'ebay.notification.read', label: 'eBay notification reads (sandbox application)' },
  ],
  AMAZON_SP: [
    // Amazon's STATIC sandbox answers fixed examples: a pass is sign-in and reachability, never vendor drift.
    { id: 'amazon.finances.listTransactions', label: 'Amazon finances listTransactions — sign-in and reachability (static sandbox example)', proves: 'sign-in and reachability' },
    { id: 'amazon.sellers.getMarketplaceParticipations', label: 'Amazon getMarketplaceParticipations — sign-in and reachability (static sandbox example)', proves: 'sign-in and reachability' },
    { id: 'amazon.listings.getListingsItem', label: 'Amazon getListingsItem — sign-in and reachability (static sandbox example)', proves: 'sign-in and reachability' },
  ],
  AMAZON_ADS: [
    // A contract check: the Ads test account answers from a running service, not a fixed example.
    { id: 'ads.profiles.list', label: 'Amazon Ads profiles read — the profile fields Nexus reads, from the Ads test account' },
  ],
  ETSY: [
    { id: 'etsy.shop.read', label: 'Etsy shop read' },
    { id: 'etsy.receipt.read', label: 'Etsy receipt read' },
  ],
}

/**
 * In scope, but with no sandbox at all: NOT APPLICABLE — excluded from the verdict, never counted as passed,
 * and its reason stated in every run's sentence. Not "not configured", which would promise a setting that
 * does not exist. Review 2026-09-26 (Owner-approved) replaced the 2026-09-23 rule that kept every run partial:
 * a gap that can never close made the run amber forever and hid real regressions behind it.
 */
export const NOT_APPLICABLE_CHANNELS: Array<{ channel: GatewayChannel; reason: string }> = [
  { channel: 'ETSY', reason: 'Etsy has no sandbox: every Etsy call reaches a real shop, so this run sends nothing to Etsy (a test listing on the real shop is the Owner\'s decision)' },
]

/**
 * Stated, but outside this programme's verdict (P8 deferred): Shopify has no sandbox host. A development
 * store is an ordinary connected account, so its checks need the Owner to name that account.
 */
export const OUT_OF_SCOPE_CHANNELS: Array<{ channel: GatewayChannel; reason: string }> = [
  { channel: 'SHOPIFY', reason: 'Shopify has no sandbox host: name a development-store account for the contract run.' },
]
