/**
 * eBay Trading API module (shared-SKU multi-listing feature).
 *
 * Purpose-built for OAuth (IAF-token) auth + per-market Site IDs +
 * multi-variation AddFixedPriceItem. Distinct from the legacy
 * `eBayAPIProvider` singleton in providers/ebay.provider.ts, which uses a
 * static Auth'n'Auth token + fixed Site ID and is left untouched.
 */

import { assertEbayWriteAllowed, ebayHostOf } from './ebay-publish-gate.service.js'

const SITE_ID_BY_MARKET: Record<string, string> = {
  IT: '101',
  DE: '77',
  FR: '71',
  ES: '186',
  UK: '3',
}

export function ebaySiteMarket(market: string): string {
  const code = (market ?? '').toUpperCase()
  return code === 'GB' ? 'UK' : code
}

export function ebayListingRegion(market: string): string {
  const code = (market ?? '').toUpperCase()
  return code === 'UK' ? 'GB' : code
}

export function siteIdForMarket(market: string): string {
  const id = SITE_ID_BY_MARKET[ebaySiteMarket(market)]
  if (!id) throw new Error(`unknown eBay market: ${market}`)
  return id
}

export function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * One InventoryStatus: the quantity and/or the price (`StartPrice`) of one SKU of one item. A quantity-only request is
 * byte-for-byte what it was before the price was added; the price goes in `currency` (the market's own, the caller's job)
 * with two decimals. Neither a quantity nor a price, a price that is not a positive number, or a price with no currency
 * → refused here, before anything is sent.
 */
export function buildReviseInventoryStatusXml(input: {
  itemId: string
  sku: string
  quantity?: number
  price?: number
  currency?: string
}): string {
  const hasQuantity = input.quantity !== undefined && input.quantity !== null
  const hasPrice = input.price !== undefined && input.price !== null
  if (!hasQuantity && !hasPrice) throw new Error('buildReviseInventoryStatusXml: a quantity or a price is required')
  if (hasPrice && !(Number.isFinite(input.price) && (input.price as number) > 0)) {
    throw new Error(`buildReviseInventoryStatusXml: the price must be a positive number, got ${input.price}`)
  }
  if (hasPrice && !input.currency) throw new Error('buildReviseInventoryStatusXml: a price needs its currency')
  const fields = [
    `    <ItemID>${escapeXml(input.itemId)}</ItemID>`,
    `    <SKU>${escapeXml(input.sku)}</SKU>`,
    ...(hasQuantity ? [`    <Quantity>${Math.max(0, Math.trunc(input.quantity as number))}</Quantity>`] : []),
    ...(hasPrice ? [`    <StartPrice currencyID="${escapeXml(input.currency as string)}">${(input.price as number).toFixed(2)}</StartPrice>`] : []),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
${fields.join('\n')}
  </InventoryStatus>
</ReviseInventoryStatusRequest>`
}

/** RT.2 — batched form: eBay allows up to FOUR InventoryStatus nodes per
 *  ReviseInventoryStatus call, and each CALL (not each SKU) counts toward the
 *  ~250 revises/listing/day cap. Callers chunk to ≤4. */
export const REVISE_INVENTORY_STATUS_MAX_ENTRIES = 4

export function buildReviseInventoryStatusBatchXml(input: {
  itemId: string
  entries: Array<{ sku: string; quantity: number }>
}): string {
  if (input.entries.length === 0 || input.entries.length > REVISE_INVENTORY_STATUS_MAX_ENTRIES) {
    throw new Error(
      `buildReviseInventoryStatusBatchXml: entries must be 1..${REVISE_INVENTORY_STATUS_MAX_ENTRIES}, got ${input.entries.length}`,
    )
  }
  const nodes = input.entries
    .map(
      (e) => `  <InventoryStatus>
    <ItemID>${escapeXml(input.itemId)}</ItemID>
    <SKU>${escapeXml(e.sku)}</SKU>
    <Quantity>${Math.max(0, Math.trunc(e.quantity))}</Quantity>
  </InventoryStatus>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
${nodes}
</ReviseInventoryStatusRequest>`
}

export interface TradingVariation {
  sku: string
  price: number
  quantity: number
  specifics: Record<string, string>
  /** Product identifier. eBay IT REQUIRES an EAN element per variation on most
   *  categories (code 21919301); live listings without a real code carry the
   *  literal "Does not apply" — the builder defaults to it when absent. */
  ean?: string
}
export interface AddFixedPriceItemInput {
  /** Item-level SKU = eBay's "Custom label" in Seller Hub. The PARENT SKU —
   *  without it the listing shows an empty label (incident #30). */
  sku?: string
  title: string
  description: string
  categoryId: string
  /** eBay's numeric ConditionID. '' = none in Nexus: the XML carries no <ConditionID>, so a Revise keeps eBay's and a new
   *  listing is refused before it is sent (Nexus never guesses a condition, Owner 2026-10-04). */
  conditionId: string
  country: string
  currency: string
  /** Free-text shipping origin (a town name) — eBay rejects a new listing
   *  without a postal code or a town ("item's location was not filled in"). */
  location?: string
  postalCode?: string
  /** Listing-level item specifics (Marca, Stagione…) — the category's required
   *  aspects live here, NOT in VariationSpecifics (eBay code 71 without them).
   *  Multi-value aspects (Caratteristiche…) pass an ARRAY — eBay caps each
   *  VALUE at 65 chars (code 21919308); a list must be many values, not one
   *  long string. */
  itemSpecifics?: Record<string, string | string[]>
  listingDuration?: string
  variationSpecificNames: string[]
  /** Incident #39 — pre-ordered axis value sets (operator order → canonical
   *  size order → locale alphabetical). When present, the XML emits EXACTLY
   *  this order instead of first-seen variation order. */
  variationSpecificsSet?: Record<string, string[]>
  variations: TradingVariation[]
  pictureUrls?: string[]
  /** `order` (images rebuild P2c): emit the sets in exactly this order — an object re-orders number-like keys ("42"). */
  variationPictures?: { axisName: string; byValue: Record<string, string[]>; order?: string[] }
  policies?: { fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string }
}

function nameValueList(name: string, values: string[]): string {
  const vals = values.map((v) => `<Value>${escapeXml(v)}</Value>`).join('')
  return `<NameValueList><Name>${escapeXml(name)}</Name>${vals}</NameValueList>`
}

export function buildAddFixedPriceItemXml(input: AddFixedPriceItemInput): string {
  const duration = input.listingDuration ?? 'GTC'

  const variationsXml = input.variations
    .map((v) => {
      const specifics = input.variationSpecificNames
        .map((n) => nameValueList(n, [v.specifics[n] ?? '']))
        .join('')
      const ean = (v.ean ?? '').trim() || 'Does not apply'
      return `      <Variation>
        <SKU>${escapeXml(v.sku)}</SKU>
        <StartPrice>${v.price}</StartPrice>
        <Quantity>${Math.max(0, Math.trunc(v.quantity))}</Quantity>
        <VariationProductListingDetails><EAN>${escapeXml(ean)}</EAN></VariationProductListingDetails>
        <VariationSpecifics>${specifics}</VariationSpecifics>
      </Variation>`
    })
    .join('\n')

  // VariationSpecificsSet: the pre-ordered set when provided (incident #39 —
  // deterministic operator/canonical order); else distinct values per axis in
  // first-seen order (legacy callers).
  const setXml = input.variationSpecificNames
    .map((n) => {
      const preOrdered = input.variationSpecificsSet?.[n]
      if (preOrdered?.length) return `        ${nameValueList(n, preOrdered)}`
      const seen: string[] = []
      for (const v of input.variations) {
        const val = v.specifics[n]
        if (val != null && !seen.includes(val)) seen.push(val)
      }
      return `        ${nameValueList(n, seen)}`
    })
    .join('\n')

  const galleryXml = (input.pictureUrls ?? []).length
    ? `    <PictureDetails>\n${(input.pictureUrls ?? [])
        .map((u) => `      <PictureURL>${escapeXml(u)}</PictureURL>`)
        .join('\n')}\n    </PictureDetails>\n`
    : ''

  let picturesXml = ''
  if (input.variationPictures && Object.keys(input.variationPictures.byValue).length) {
    const byValue = input.variationPictures.byValue
    const sets = (input.variationPictures.order ?? Object.keys(byValue)).map((value) => [value, byValue[value] ?? []] as const)
      .filter(([, urls]) => urls.length > 0)
      .map(([value, urls]) => {
        const pics = urls.map((u) => `          <PictureURL>${escapeXml(u)}</PictureURL>`).join('\n')
        return `        <VariationSpecificPictureSet>
          <VariationSpecificValue>${escapeXml(value)}</VariationSpecificValue>
${pics}
        </VariationSpecificPictureSet>`
      })
      .join('\n')
    picturesXml = `      <Pictures>
        <VariationSpecificName>${escapeXml(input.variationPictures.axisName)}</VariationSpecificName>
${sets}
      </Pictures>\n`
  }

  const profilesXml = input.policies
    ? `    <SellerProfiles>
      ${input.policies.fulfillmentPolicyId ? `<SellerShippingProfile><ShippingProfileID>${escapeXml(input.policies.fulfillmentPolicyId)}</ShippingProfileID></SellerShippingProfile>` : ''}
      ${input.policies.paymentPolicyId ? `<SellerPaymentProfile><PaymentProfileID>${escapeXml(input.policies.paymentPolicyId)}</PaymentProfileID></SellerPaymentProfile>` : ''}
      ${input.policies.returnPolicyId ? `<SellerReturnProfile><ReturnProfileID>${escapeXml(input.policies.returnPolicyId)}</ReturnProfileID></SellerReturnProfile>` : ''}
    </SellerProfiles>\n`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
${input.sku ? `    <SKU>${escapeXml(input.sku)}</SKU>\n` : ''}    <Title>${escapeXml(input.title)}</Title>
    <Description><![CDATA[${input.description.replace(/]]>/g, ']]]]><![CDATA[>')}]]></Description>
    <PrimaryCategory><CategoryID>${escapeXml(input.categoryId)}</CategoryID></PrimaryCategory>
${input.conditionId ? `    <ConditionID>${escapeXml(input.conditionId)}</ConditionID>\n` : ''}    <Country>${escapeXml(input.country)}</Country>
    <Currency>${escapeXml(input.currency)}</Currency>
${input.location ? `    <Location>${escapeXml(input.location)}</Location>\n` : ''}${input.postalCode ? `    <PostalCode>${escapeXml(input.postalCode)}</PostalCode>\n` : ''}${Object.keys(input.itemSpecifics ?? {}).length ? `    <ItemSpecifics>${Object.entries(input.itemSpecifics ?? {}).map(([n, v]) => nameValueList(n, Array.isArray(v) ? v : [v])).join('')}</ItemSpecifics>\n` : ''}    <ListingDuration>${escapeXml(duration)}</ListingDuration>
${galleryXml}${profilesXml}    <Variations>
${variationsXml}
${picturesXml}      <VariationSpecificsSet>
${setXml}
      </VariationSpecificsSet>
    </Variations>
  </Item>
</AddFixedPriceItemRequest>`
}

export interface TradingCallContext {
  oauthToken: string
  siteId: string
  /**
   * P1.2 — the eBay account the token belongs to. Every Trading call goes through the channel gateway,
   * which checks this account's state and records the call against it (a write never falls back to the
   * primary account).
   */
  connectionId: string
  /** The market (IT, DE, …) for the call ledger. */
  market?: string
  /**
   * P3.2 — the ChannelListing this call is about, when the caller knows it.
   *
   * With it, an eBay rejection is filed on the listing in eBay's own words; without it
   * the call behaves exactly as before. `OutboundApiCallLog` has carried a `listingId`
   * column since P1.2 and it was filled on 0 of 469,462 rows, because no sender ever
   * named one — so it is passed to the gateway ledger from here too.
   */
  listingId?: string | null
  /** CX (review 2026-09-26) — a bounded read (the variation price check): the caller's deadline/cancel signal, the
   *  gateway timeout and its retry counts. Omitted → the gateway's defaults, as before. */
  signal?: AbortSignal
  timeoutMs?: number
  maxTransientRetries?: number
  max429Retries?: number
}
export interface TradingCallResult {
  ack: string
  itemId?: string
  errors: string[]
  raw: string
}

/** A duplicate failure can describe a previously accepted write, not a rejected submission. */
export class TradingApiFailure extends Error {
  /**
   * P3.2 — eBay's own error codes and messages, still in parts.
   *
   * The `message` is the operator's sentence and is unchanged. These are what the
   * listing needs: eBay's ErrorCode is the issue code, and its LongMessage names the
   * offending tag ("Input data for tag <Item.X> is invalid"), which is the attribute.
   */
  readonly channelErrors: Array<{ code: string; message: string }>
  constructor(
    message: string,
    public readonly duplicateSubmission: boolean,
    public readonly priorItemId?: string,
    channelErrors: Array<{ code: string; message: string }> = [],
    /** eBay's whole answer, so a reader can tell an Error from a Warning per `<Errors>` block (the review's Verify step). */
    public readonly raw?: string,
  ) {
    super(message)
    this.name = 'TradingApiFailure'
    this.channelErrors = channelErrors
  }
}

function duplicateItemId(callName: string, request: string, response: string): string | undefined {
  if (callName === 'AddFixedPriceItem' && /<UUID>[a-f0-9]{32}<\/UUID>/i.test(request)) {
    const duplicate = [...response.matchAll(/<Errors>[\s\S]*?<\/Errors>/g)].map(match => match[0])
      .find(error => /<ErrorCode>488<\/ErrorCode>/.test(error))
    if (!duplicate) return undefined
    const parameter = (id: string) => duplicate.match(new RegExp(`<ErrorParameters\\s+ParamID=["']${id}["']\\s*>\\s*<Value>([^<]+)<\\/Value>\\s*<\\/ErrorParameters>`))?.[1]
    const itemId = parameter('1')
    // Error 488 identifies the existing item and whether the same app created it.
    if (parameter('0') === '1' && itemId && /^\d+$/.test(itemId)) return itemId
  }
  if (callName === 'ReviseFixedPriceItem') {
    const key = request.match(/<InvocationID>([a-f0-9]{32})<\/InvocationID>/i)?.[1]
    const details = response.match(/<DuplicateInvocationDetails>[\s\S]*?<\/DuplicateInvocationDetails>/)?.[0] ?? ''
    const previousKey = details.match(/<DuplicateInvocationID>([^<]+)<\/DuplicateInvocationID>/)?.[1]
    const itemId = request.match(/<ItemID>(\d+)<\/ItemID>/)?.[1]
    if (key && previousKey?.toUpperCase() === key.toUpperCase() && /<Status>Success<\/Status>/.test(details)) return itemId
  }
  return undefined
}

function tradingEndpoint(): string {
  return process.env.EBAY_SANDBOX === 'true'
    ? 'https://api.sandbox.ebay.com/ws/api.dll'
    : 'https://api.ebay.com/ws/api.dll'
}

/**
 * P0.1 — Trading calls that change a listing. These follow the eBay publish
 * mode like every other listing write. Reads (Get…, Verify…) and order,
 * feedback and notification calls keep their own switches.
 */
export const TRADING_LISTING_WRITES: ReadonlySet<string> = new Set([
  'AddItem', 'AddItems', 'AddFixedPriceItem',
  'ReviseItem', 'ReviseFixedPriceItem', 'ReviseInventoryStatus',
  'EndItem', 'EndItems', 'EndFixedPriceItem',
  'RelistItem', 'RelistFixedPriceItem',
  'UploadSiteHostedPictures',
])

/** Read, listing write, order / buyer action, or connection setup — for the gateway. */
export function tradingCallKind(callName: string): 'read' | 'write' | 'action' | 'setup' {
  if (TRADING_LISTING_WRITES.has(callName)) return 'write'
  if (/^(Get|Verify|GeteBay)/.test(callName)) return 'read'
  if (callName === 'SetNotificationPreferences') return 'setup'
  return 'action'
}

/** Trading reports failure inside an HTTP 200; a duplicate submission is a failure too. */
export function tradingAnswerOk(raw: string): boolean {
  if (/<Ack>(Failure|PartialFailure)<\/Ack>/.test(raw)) return false
  return !/<ErrorCode>(488|21060)<\/ErrorCode>|<DuplicateInvocationDetails>/.test(raw)
}

/**
 * The <Errors> blocks of a Trading answer that are errors (SeverityCode Warning is not): eBay's code, its
 * ErrorClassification (RequestError / SystemError) and its words. (2026-10-06: moved here, unchanged, from the channel
 * contracts, so the contract check and a Trading listing's stock row read eBay's errors one way.)
 */
export function tradingErrorBlocks(text: string): Array<{ code: string; classification: string; message: string }> {
  return [...text.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)].map((m) => m[1])
    .filter((block) => (/<SeverityCode>([^<]*)<\/SeverityCode>/.exec(block)?.[1] ?? 'Error') !== 'Warning')
    .map((block) => ({
      code: /<ErrorCode>([^<]*)<\/ErrorCode>/.exec(block)?.[1]?.trim() ?? '',
      classification: /<ErrorClassification>([^<]*)<\/ErrorClassification>/.exec(block)?.[1] ?? '',
      message: (/<LongMessage>([^<]*)<\/LongMessage>/.exec(block)?.[1] ?? /<ShortMessage>([^<]*)<\/ShortMessage>/.exec(block)?.[1] ?? '').slice(0, 160).replace(/\.\s*$/, ''),
    }))
}

/**
 * 2026-10-06 (Trading stock sync) — eBay's answer to a Trading revise of an item the Inventory API holds: error 21919474,
 * "This operation is not allowed for inventory items." (seen live on IT as "operazione non consentita per gli oggetti del
 * magazzino"). Nothing was changed on eBay. The code decides; the words are the fallback for an answer that lost it. Narrower
 * than the description push's `/inventor|magazzino|non consentita/` on purpose: a ReviseInventoryStatus refusal names
 * "InventoryStatus" in other errors (a SKU that is not in the item), and those must stay refusals.
 */
export const EBAY_INVENTORY_MANAGED_CODE = '21919474'
const INVENTORY_MANAGED_WORDS = /not allowed for inventory items|inventory-based listing management|oggetti del magazzino/i
export function isEbayInventoryManagedRefusal(codes: readonly string[], message: string): boolean {
  return codes.includes(EBAY_INVENTORY_MANAGED_CODE) || INVENTORY_MANAGED_WORDS.test(message)
}

export async function callTradingApi(
  callName: string,
  xml: string,
  ctx: TradingCallContext,
): Promise<TradingCallResult> {
  const realApiOptIn = process.env.NEXUS_EBAY_REAL_API === 'true'
  const isProduction = process.env.NODE_ENV === 'production'

  if (!realApiOptIn) {
    if (isProduction) {
      throw new Error(
        `eBay ${callName} not invoked: NEXUS_EBAY_REAL_API not enabled in production. ` +
          `Refusing to fake-success — would cause overselling.`,
      )
    }
    return { ack: 'Success', itemId: `DRYRUN-${callName}`, errors: [], raw: '' }
  }

  const endpoint = tradingEndpoint()
  if (TRADING_LISTING_WRITES.has(callName)) assertEbayWriteAllowed(ebayHostOf(endpoint))

  // P1.2 — through the channel gateway: the account's state, the rate bucket, one ledger row with the
  // Trading Ack read as the outcome. The token stays in the IAF header; the P0.1 switches above stay the
  // mode check for this client.
  // P4.1 — the ledger's own listingId was filled on 0 of 469,462 rows because no
  // sender ever named one. For a Trading call the listing is derivable from the
  // request's `<ItemID>` and this account, so the ledger gets it too. Resolved
  // BEFORE the send, because the row is written by the send. A shared eBay item
  // belongs to several listings and the ledger column holds one, so the ledger
  // records a listing only when exactly ONE resolves; the issue path, which can
  // hold many, files on all of them. One is a column, the other is the truth.
  const { itemIdOfTradingXml: itemIdOf, resolveEbayListingIds } = await import('./listing-issue-recorder.service.js')
  const ledgerListingIds = await resolveEbayListingIds({
    listingId: ctx.listingId ?? null,
    itemId: itemIdOf(xml),
    connectionId: ctx.connectionId,
  })

  const { gatewayFetch } = await import('./gateway/gateway.js')
  const res = await gatewayFetch({
    channel: 'EBAY',
    operation: `trading.${callName}`,
    kind: tradingCallKind(callName),
    connectionId: ctx.connectionId,
    url: endpoint,
    method: 'POST',
    headers: {
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-COMPATIBILITY-LEVEL': process.env.EBAY_COMPAT_LEVEL || '1193',
      'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID || '',
      'X-EBAY-API-APP-NAME': process.env.EBAY_APP_ID || '',
      'X-EBAY-API-CERT-NAME': process.env.EBAY_CERT_ID || '',
      'X-EBAY-API-SITEID': ctx.siteId,
      'X-EBAY-API-IAF-TOKEN': ctx.oauthToken,
      'Content-Type': 'text/xml',
    },
    body: xml,
    auth: 'none',
    marketplace: ctx.market ?? null,
    marketHeaders: 'caller',
    modeAppliedByCaller: true,
    answerOk: tradingAnswerOk,
    ledger: { listingId: ledgerListingIds.length === 1 ? ledgerListingIds[0] : (ctx.listingId ?? null) },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
    ...(ctx.maxTransientRetries !== undefined ? { maxTransientRetries: ctx.maxTransientRetries } : {}),
    ...(ctx.max429Retries !== undefined ? { max429Retries: ctx.max429Retries } : {}),
  })

  if (!res.ok) throw new Error(`eBay ${callName} HTTP ${res.status}`)
  const raw = await res.text()
  const ack = raw.match(/<Ack>([^<]+)<\/Ack>/)?.[1] ?? 'Unknown'
  const itemId = raw.match(/<ItemID>([^<]+)<\/ItemID>/)?.[1]
  const decodeEntities = (x: string) => x
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
  const longMessages = [...raw.matchAll(/<LongMessage>([^<]+)<\/LongMessage>/g)].map((m) => decodeEntities(m[1]))
  const shortMessages = [...raw.matchAll(/<ShortMessage>([^<]+)<\/ShortMessage>/g)].map((m) => decodeEntities(m[1]))
  const errorCodes = [...raw.matchAll(/<ErrorCode>([^<]+)<\/ErrorCode>/g)].map((m) => m[1])
  // LongMessage names the exact offending field ("Input data for tag <Item.X>
  // is invalid…"); ShortMessage alone ("Input data is invalid.") is useless to
  // the operator — never surface it when a LongMessage exists.
  const errors = longMessages.length ? longMessages : shortMessages
  const duplicateSubmission = errorCodes.some(code => code === '488' || code === '21060') || /<DuplicateInvocationDetails>/.test(raw)
  if (ack === 'Failure' || duplicateSubmission) {
    const detail = errors.slice(0, 2).join(' | ') || 'unknown'
    const code = errorCodes.length ? ` (code ${errorCodes[0]})` : ''
    // eBay pairs each ErrorCode with its message positionally in the response.
    const channelErrors = errors.map((message, i) => ({ code: errorCodes[i] ?? errorCodes[0] ?? 'EBAY_FAILURE', message }))
    // P3.2 — the rejection goes onto the listing in eBay's own words before the throw.
    // Awaited, not fire-and-forget: the done-when is "within one minute", and an
    // un-awaited write in a process that is about to throw can be lost. The recorder
    // never throws of its own accord.
    //
    // P4.1 — and it no longer depends on the caller naming the listing. A derived
    // census found **14 Trading write call sites across 12 files and NOT ONE passed
    // a listingId**, so this path has never once filed an issue in production. The
    // listing is resolved from what the call already carries: the `<ItemID>` in its
    // request (a revise) or in eBay's answer (an add), plus the account in ctx. A
    // caller that names a listing still wins outright.
    const { itemIdOfTradingXml, recordEbayTradingRejection } = await import('./listing-issue-recorder.service.js')
    const rejectionItemId = itemIdOfTradingXml(xml) ?? itemIdOfTradingXml(raw)
    if (ctx.listingId || rejectionItemId) {
      await recordEbayTradingRejection({
        listingId: ctx.listingId ?? null,
        itemId: rejectionItemId,
        connectionId: ctx.connectionId,
        issues: channelErrors.map((e) => ({
          code: e.code,
          message: e.message,
          severity: 'ERROR',
          // The attribute is inside eBay's sentence: "Input data for tag <Item.X>".
          attributeNames: [...e.message.matchAll(/<([A-Za-z][\w.]*)>/g)].map((m) => m[1]).slice(0, 4),
          categories: [`trading.${callName}`],
        })),
      })
    }
    throw new TradingApiFailure(`eBay ${callName} Failure: ${detail}${code}`, duplicateSubmission,
      duplicateSubmission ? duplicateItemId(callName, xml, raw) : undefined, channelErrors, raw)
  }
  return { ack, itemId, errors, raw }
}

/**
 * P1.7 — every Add goes through eBay's own dry run first. `VerifyAddFixedPriceItem` takes the same XML
 * and answers with the errors the real Add would raise, without creating a listing. eBay's answer must
 * be Success or Warning; anything else refuses here, so a listing that eBay would reject is never
 * created. (The studio has its own copy of this step for the XML it builds itself.)
 */
export async function verifyAddFixedPriceItem(
  xml: string,
  ctx: { oauthToken: string; siteId: string; connectionId: string; market: string },
): Promise<{ warnings: string[] }> {
  const check = await callTradingApi('VerifyAddFixedPriceItem', xml.replace(/AddFixedPriceItemRequest/g, 'VerifyAddFixedPriceItemRequest'), ctx)
  // A local rehearsal answers `DRYRUN-…` with no body: nothing was validated, and the Add that follows
  // is neutralized the same way. Any other empty body is a real answer we cannot read — refuse.
  if (check.itemId?.startsWith('DRYRUN-')) return { warnings: [] }
  if (!check.raw || !['Success', 'Warning'].includes(check.ack)) {
    throw Object.assign(new Error('eBay did not validate this listing. Nothing was submitted.'), { notSent: true })
  }
  return { warnings: check.errors ?? [] }
}

export async function addFixedPriceItem(
  input: AddFixedPriceItemInput,
  ctx: { oauthToken: string; market: string; connectionId: string },
): Promise<{ itemId: string }> {
  const siteId = siteIdForMarket(ctx.market)
  const xml = buildAddFixedPriceItemXml(input)
  const call = { oauthToken: ctx.oauthToken, siteId, connectionId: ctx.connectionId, market: ctx.market }
  await verifyAddFixedPriceItem(xml, call)
  const res = await callTradingApi('AddFixedPriceItem', xml, call)
  if (!res.itemId) throw new Error('eBay AddFixedPriceItem succeeded but returned no ItemID')
  return { itemId: res.itemId }
}

export async function reviseInventoryStatus(
  input: { itemId: string; sku: string; quantity: number },
  ctx: { oauthToken: string; market: string; connectionId: string },
): Promise<void> {
  const siteId = siteIdForMarket(ctx.market)
  const xml = buildReviseInventoryStatusXml(input)
  await callTradingApi('ReviseInventoryStatus', xml, { oauthToken: ctx.oauthToken, siteId, connectionId: ctx.connectionId, market: ctx.market })
}

/** RT.4 — minimal GetItem for listing-lifecycle reconcile: only the
 *  SellingStatus.ListingStatus field is requested/parsed. */
export function buildGetItemStatusXml(itemId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(itemId)}</ItemID>
  <DetailLevel>ReturnSummary</DetailLevel>
  <OutputSelector>Item.SellingStatus.ListingStatus</OutputSelector>
</GetItemRequest>`
}

export async function getItemListingStatus(
  itemId: string,
  ctx: { oauthToken: string; market: string; connectionId: string },
): Promise<string | null> {
  const siteId = siteIdForMarket(ctx.market)
  const res = await callTradingApi('GetItem', buildGetItemStatusXml(itemId), {
    oauthToken: ctx.oauthToken,
    siteId,
    connectionId: ctx.connectionId,
    market: ctx.market,
  })
  return res.raw.match(/<ListingStatus>([^<]+)<\/ListingStatus>/)?.[1] ?? null
}

/** AS.4a — GetItem for the Trading-lane quantity read-back. Narrow
 *  OutputSelectors (no description payload); IncludeVariations so each
 *  variation's Quantity + SellingStatus.QuantitySold comes back. */
export function buildGetItemQuantitiesXml(itemId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(itemId)}</ItemID>
  <IncludeVariations>true</IncludeVariations>
  <OutputSelector>Item.Quantity</OutputSelector>
  <OutputSelector>Item.SellingStatus</OutputSelector>
  <OutputSelector>Item.Variations</OutputSelector>
  <OutputSelector>Item.StartPrice</OutputSelector>
</GetItemRequest>`
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** A StartPrice as eBay sent it: `value` null when absent or not a plain decimal — never 0 for "absent". */
export interface TradingStartPrice { value: number | null; currency: string | null }

export interface ItemQuantityReadback {
  listingStatus: string | null
  /** SKU → remaining available. eBay's GetItem Quantity is the LIFETIME total
   *  (available + sold); remaining = Quantity − SellingStatus.QuantitySold. */
  variations: Array<{ sku: string; available: number }>
  /** Item-level remaining for non-variation listings; null when variations exist. */
  itemAvailable: number | null
  /** P4.4 (CX) — StartPrice per variation (its own block) and for the item. On a variation listing eBay
   *  sets Item.StartPrice to the LOWEST variation price, so the item price is a single-SKU listing's only.
   *  Absent when the answer holds no <Item> (a dry-run's empty raw). `hasVariations`: a <Variations> block
   *  exists, whether or not a SKU was parsed from it — the item price is then never a SKU's. */
  prices?: { item: TradingStartPrice | null; variations: Array<{ sku: string } & TradingStartPrice>; hasVariations: boolean }
}

/**
 * CX (review 2026-09-26) — THE StartPrice parser: the first <StartPrice currencyID="…">…</StartPrice> of a GetItem
 * block, or null when there is none. `value` is null unless the text is a plain decimal (never 0 or NaN for
 * "unreadable"); `text` is eBay's text as sent, for a caller that must echo it back unchanged (the axis rename).
 * The Trading sweep, the SKU-less adoption and the axis rename all read through it.
 */
export function parseStartPrice(block: string): (TradingStartPrice & { text: string }) | null {
  const m = block.match(/<StartPrice\b([^>]*)>([^<]*)<\/StartPrice>/)
  if (!m) return null
  const currency = m[1].match(/currencyID\s*=\s*["']([A-Za-z]{3})["']/)?.[1]?.toUpperCase() ?? null
  const trimmed = m[2].trim()
  return { value: /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : null, currency, text: m[2] }
}

function startPriceOf(block: string): TradingStartPrice | null {
  const parsed = parseStartPrice(block)
  return parsed && { value: parsed.value, currency: parsed.currency }
}

/** Pure XML extraction — exported for tests. Variation blocks are parsed
 *  first and removed so item-level Quantity/QuantitySold regexes can never
 *  match inside them. */
export function parseGetItemQuantities(rawXml: string): ItemQuantityReadback {
  const varBlock = rawXml.match(/<Variations>([\s\S]*?)<\/Variations>/)
  const variations: Array<{ sku: string; available: number }> = []
  if (varBlock) {
    for (const v of varBlock[1].matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)) {
      const block = v[1]
      const sku = block.match(/<SKU>([^<]*)<\/SKU>/)?.[1]
      if (!sku) continue
      const qty = Number(block.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] ?? Number.NaN)
      if (!Number.isFinite(qty)) continue
      const sold = Number(block.match(/<QuantitySold>(\d+)<\/QuantitySold>/)?.[1] ?? 0)
      variations.push({ sku: unescapeXml(sku), available: Math.max(0, qty - sold) })
    }
  }
  const rest = varBlock ? rawXml.replace(varBlock[0], '') : rawXml
  const listingStatus = rest.match(/<ListingStatus>([^<]+)<\/ListingStatus>/)?.[1] ?? null
  let itemAvailable: number | null = null
  if (variations.length === 0) {
    const qty = Number(rest.match(/<Quantity>(\d+)<\/Quantity>/)?.[1] ?? Number.NaN)
    if (Number.isFinite(qty)) {
      const sold = Number(rest.match(/<QuantitySold>(\d+)<\/QuantitySold>/)?.[1] ?? 0)
      itemAvailable = Math.max(0, qty - sold)
    }
  }
  // P4.4 (CX) — prices beside, never inside, the quantity parse above. Each variation's price comes from
  // ITS block; the item's from `rest` (variations removed), so a variation price can never be read as it.
  if (!/<Item\b/.test(rawXml)) return { listingStatus, variations, itemAvailable }
  const variationPrices: Array<{ sku: string } & TradingStartPrice> = []
  if (varBlock) {
    for (const v of varBlock[1].matchAll(/<Variation>([\s\S]*?)<\/Variation>/g)) {
      const sku = v[1].match(/<SKU>([^<]*)<\/SKU>/)?.[1]
      if (!sku) continue
      variationPrices.push({ sku: unescapeXml(sku), ...(startPriceOf(v[1]) ?? { value: null, currency: null }) })
    }
  }
  return { listingStatus, variations, itemAvailable, prices: { item: startPriceOf(rest), variations: variationPrices, hasVariations: !!varBlock } }
}

export async function getItemQuantities(
  itemId: string,
  ctx: { oauthToken: string; market: string; connectionId: string } & Pick<TradingCallContext, 'signal' | 'timeoutMs' | 'maxTransientRetries' | 'max429Retries'>,
): Promise<ItemQuantityReadback> {
  const siteId = siteIdForMarket(ctx.market)
  const res = await callTradingApi('GetItem', buildGetItemQuantitiesXml(itemId), {
    oauthToken: ctx.oauthToken,
    siteId,
    connectionId: ctx.connectionId,
    market: ctx.market,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    maxTransientRetries: ctx.maxTransientRetries,
    max429Retries: ctx.max429Retries,
  })
  return parseGetItemQuantities(res.raw)
}

/** RT.2 — batched revise: ≤4 SKUs of ONE ItemID per Trading call. */
export async function reviseInventoryStatusBatch(
  input: { itemId: string; entries: Array<{ sku: string; quantity: number }> },
  ctx: { oauthToken: string; market: string; connectionId: string },
): Promise<void> {
  const siteId = siteIdForMarket(ctx.market)
  const xml = buildReviseInventoryStatusBatchXml(input)
  await callTradingApi('ReviseInventoryStatus', xml, { oauthToken: ctx.oauthToken, siteId, connectionId: ctx.connectionId, market: ctx.market })
}

// ── EndFixedPriceItem ──────────────────────────────────────────────────────

export interface EndFixedPriceItemInput {
  itemId: string
  /** Defaults to 'NotAvailable' (seller-initiated end, relistable). */
  endingReason?: string
}

/**
 * Build the EndFixedPriceItem XML body.
 * Valid EndingReason values: NotAvailable | LostOrBroken | OtherListingError.
 * We default to NotAvailable since this is called from a delete/delist flow.
 */
export function buildEndFixedPriceItemXml(input: EndFixedPriceItemInput): string {
  const reason = input.endingReason ?? 'NotAvailable'
  return `<?xml version="1.0" encoding="UTF-8"?>
<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <EndingReason>${escapeXml(reason)}</EndingReason>
  <ItemID>${escapeXml(input.itemId)}</ItemID>
</EndFixedPriceItemRequest>`
}

/**
 * Call EndFixedPriceItem via the Trading API.
 * Inherits the real-API gate from callTradingApi: throws in production when
 * NEXUS_EBAY_REAL_API is not 'true', dry-runs in dev/test.
 * Returns normalised { ack, itemId?, errors } on success/warning; throws on Failure.
 */
export async function endFixedPriceItem(
  input: EndFixedPriceItemInput,
  ctx: TradingCallContext,
): Promise<{ ack: string; itemId?: string; errors: string[] }> {
  const xml = buildEndFixedPriceItemXml(input)
  const res = await callTradingApi('EndFixedPriceItem', xml, ctx)
  return { ack: res.ack, itemId: res.itemId, errors: res.errors }
}

/**
 * Sheet publish parity, step 7 — RelistFixedPriceItem: put an ended fixed-price item back on sale. eBay answers with a
 * NEW ItemID (the old one stays ended); the caller writes it on its own listing coordinate only. Only the ItemID is sent,
 * so eBay relists the item exactly as it ended.
 */
export function buildRelistFixedPriceItemXml(input: { itemId: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<RelistFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <ItemID>${escapeXml(input.itemId)}</ItemID>
  </Item>
</RelistFixedPriceItemRequest>`
}

/** RelistFixedPriceItem through the gateway (a listing write: the eBay publish mode applies). Throws on Failure. */
export async function relistFixedPriceItem(
  input: { itemId: string },
  ctx: TradingCallContext,
): Promise<{ ack: string; newItemId: string | null; errors: string[] }> {
  const res = await callTradingApi('RelistFixedPriceItem', buildRelistFixedPriceItemXml(input), ctx)
  // The answer's ItemID is the new item. A rehearsal answers `DRYRUN-…` and nothing was relisted.
  const newItemId = res.itemId && res.itemId !== input.itemId ? res.itemId : null
  return { ack: res.ack, newItemId: res.itemId?.startsWith('DRYRUN-') ? res.itemId : newItemId, errors: res.errors }
}
