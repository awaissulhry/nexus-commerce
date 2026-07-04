/**
 * eBay Trading API module (shared-SKU multi-listing feature).
 *
 * Purpose-built for OAuth (IAF-token) auth + per-market Site IDs +
 * multi-variation AddFixedPriceItem. Distinct from the legacy
 * `eBayAPIProvider` singleton in providers/ebay.provider.ts, which uses a
 * static Auth'n'Auth token + fixed Site ID and is left untouched.
 */

const SITE_ID_BY_MARKET: Record<string, string> = {
  IT: '101',
  DE: '77',
  FR: '71',
  ES: '186',
  UK: '3',
}

export function siteIdForMarket(market: string): string {
  const id = SITE_ID_BY_MARKET[(market ?? '').toUpperCase()]
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

export function buildReviseInventoryStatusXml(input: {
  itemId: string
  sku: string
  quantity: number
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <InventoryStatus>
    <ItemID>${escapeXml(input.itemId)}</ItemID>
    <SKU>${escapeXml(input.sku)}</SKU>
    <Quantity>${Math.max(0, Math.trunc(input.quantity))}</Quantity>
  </InventoryStatus>
</ReviseInventoryStatusRequest>`
}

export interface TradingVariation {
  sku: string
  price: number
  quantity: number
  specifics: Record<string, string>
}
export interface AddFixedPriceItemInput {
  title: string
  description: string
  categoryId: string
  conditionId: string
  country: string
  currency: string
  listingDuration?: string
  variationSpecificNames: string[]
  variations: TradingVariation[]
  pictureUrls?: string[]
  variationPictures?: { axisName: string; byValue: Record<string, string[]> }
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
      return `      <Variation>
        <SKU>${escapeXml(v.sku)}</SKU>
        <StartPrice>${v.price}</StartPrice>
        <Quantity>${Math.max(0, Math.trunc(v.quantity))}</Quantity>
        <VariationSpecifics>${specifics}</VariationSpecifics>
      </Variation>`
    })
    .join('\n')

  // VariationSpecificsSet: distinct values per axis, preserving first-seen order.
  const setXml = input.variationSpecificNames
    .map((n) => {
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
    const sets = Object.entries(input.variationPictures.byValue)
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
    <Title>${escapeXml(input.title)}</Title>
    <Description><![CDATA[${input.description.replace(/]]>/g, ']]]]><![CDATA[>')}]]></Description>
    <PrimaryCategory><CategoryID>${escapeXml(input.categoryId)}</CategoryID></PrimaryCategory>
    <ConditionID>${escapeXml(input.conditionId)}</ConditionID>
    <Country>${escapeXml(input.country)}</Country>
    <Currency>${escapeXml(input.currency)}</Currency>
    <ListingDuration>${escapeXml(duration)}</ListingDuration>
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
}
export interface TradingCallResult {
  ack: string
  itemId?: string
  errors: string[]
  raw: string
}

function tradingEndpoint(): string {
  return process.env.EBAY_SANDBOX === 'true'
    ? 'https://api.sandbox.ebay.com/ws/api.dll'
    : 'https://api.ebay.com/ws/api.dll'
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

  const res = await fetch(tradingEndpoint(), {
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
  })

  if (!res.ok) throw new Error(`eBay ${callName} HTTP ${res.status}`)
  const raw = await res.text()
  const ack = raw.match(/<Ack>([^<]+)<\/Ack>/)?.[1] ?? 'Unknown'
  const itemId = raw.match(/<ItemID>([^<]+)<\/ItemID>/)?.[1]
  const errors = [...raw.matchAll(/<(?:ShortMessage|LongMessage)>([^<]+)<\/(?:ShortMessage|LongMessage)>/g)].map(
    (m) => m[1],
  )
  if (ack === 'Failure') {
    throw new Error(`eBay ${callName} Failure: ${errors[0] ?? 'unknown'}`)
  }
  return { ack, itemId, errors, raw }
}

export async function addFixedPriceItem(
  input: AddFixedPriceItemInput,
  ctx: { oauthToken: string; market: string },
): Promise<{ itemId: string }> {
  const siteId = siteIdForMarket(ctx.market)
  const xml = buildAddFixedPriceItemXml(input)
  const res = await callTradingApi('AddFixedPriceItem', xml, { oauthToken: ctx.oauthToken, siteId })
  if (!res.itemId) throw new Error('eBay AddFixedPriceItem succeeded but returned no ItemID')
  return { itemId: res.itemId }
}

export async function reviseInventoryStatus(
  input: { itemId: string; sku: string; quantity: number },
  ctx: { oauthToken: string; market: string },
): Promise<void> {
  const siteId = siteIdForMarket(ctx.market)
  const xml = buildReviseInventoryStatusXml(input)
  await callTradingApi('ReviseInventoryStatus', xml, { oauthToken: ctx.oauthToken, siteId })
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
