# eBay Shared-SKU — Phase 1: Trading-API Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested, OAuth-authenticated, per-market eBay **Trading API** module that can create a multi-variation fixed-price listing (`AddFixedPriceItem`, `InventoryTrackingMethod`=ItemID so `Variation.SKU` may repeat across listings) and update one variation's quantity by **(ItemID + SKU)** via `ReviseInventoryStatus`.

**Architecture:** A new, self-contained module `apps/api/src/services/ebay-trading-api.service.ts`. Pure XML builders + a thin HTTP caller. Auth is the existing OAuth token (`ebayAuthService.getValidToken`) passed via the `X-EBAY-API-IAF-TOKEN` header — NOT the legacy static Auth'n'Auth token or fixed Site ID used by the existing `eBayAPIProvider` singleton (`apps/api/src/providers/ebay.provider.ts`), which is left untouched. **Supersedes spec §5.2 ("extend ebay.provider.ts") and resolves §10.1 (auth) → IAF token.**

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `fetch`, vitest 4. No new dependencies.

**Scope boundary:** Phase 1 is the client only. NO database, NO `SharedListingMembership` model, NO fan-out wiring, NO flat-file UX — those are Phases 2–4. Phase 1 ships a unit-tested module callable in dry-run.

## Global Constraints

- **eBay only** — do not touch Amazon/Shopify code.
- **`InventoryTrackingMethod` = ItemID** — the default; NEVER emit `<InventoryTrackingMethod>SKU</InventoryTrackingMethod>`. This is what lets the same `Variation.SKU` repeat across listings.
- **Auth = OAuth IAF token** — every Trading call sets header `X-EBAY-API-IAF-TOKEN: <oauthToken>`; do NOT put `<eBayAuthToken>` in the XML body.
- **App headers from env** (verbatim names): `X-EBAY-API-DEV-NAME`=`EBAY_DEV_ID`, `X-EBAY-API-APP-NAME`=`EBAY_APP_ID`, `X-EBAY-API-CERT-NAME`=`EBAY_CERT_ID`, `X-EBAY-API-COMPATIBILITY-LEVEL`=`EBAY_COMPAT_LEVEL` (default `'1193'`), `X-EBAY-API-CALL-NAME`=the call, `X-EBAY-API-SITEID`=per-market site id.
- **Endpoint:** `EBAY_SANDBOX==='true'` → `https://api.sandbox.ebay.com/ws/api.dll`, else `https://api.ebay.com/ws/api.dll`.
- **Dry-run discipline (mirror `ebay.provider.ts` lines 391–444):** real call only when `NEXUS_EBAY_REAL_API==='true'`; otherwise non-production returns a simulated success, **production THROWS** (fail-loud — silent fake-success causes overselling).
- **Site IDs (Trading API):** IT=`101`, DE=`77`, FR=`71`, ES=`186`, UK=`3`.
- **Test runner:** vitest. Per-file run command: `cd apps/api && npx vitest run <relative-path>` (the `apps/api` package.json defines `"test": "vitest run"`). New test files use the `*.vitest.test.ts` suffix to match existing eBay tests.
- **No local Docker / scratch DB** — Phase 1 verifies via vitest (mocked fetch) + dry-run only; live sandbox verification is a manual step at the end.

---

### Task 1: Module scaffold — `siteIdForMarket` + `escapeXml`

**Files:**
- Create: `apps/api/src/services/ebay-trading-api.service.ts`
- Test: `apps/api/src/services/ebay-trading-api.service.vitest.test.ts`

**Interfaces:**
- Produces: `escapeXml(s: string): string`; `siteIdForMarket(market: string): string` (accepts `'IT'|'DE'|'FR'|'ES'|'UK'` case-insensitively; throws `Error` on unknown).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/ebay-trading-api.service.vitest.test.ts
import { describe, it, expect } from 'vitest'
import { escapeXml, siteIdForMarket } from './ebay-trading-api.service.js'

describe('escapeXml', () => {
  it('escapes XML metacharacters', () => {
    expect(escapeXml(`Tom & "Jerry" <b>'x'</b>`)).toBe(
      'Tom &amp; &quot;Jerry&quot; &lt;b&gt;&apos;x&apos;&lt;/b&gt;',
    )
  })
})

describe('siteIdForMarket', () => {
  it('maps the five EU markets to Trading-API site ids', () => {
    expect(siteIdForMarket('IT')).toBe('101')
    expect(siteIdForMarket('DE')).toBe('77')
    expect(siteIdForMarket('FR')).toBe('71')
    expect(siteIdForMarket('ES')).toBe('186')
    expect(siteIdForMarket('UK')).toBe('3')
  })
  it('is case-insensitive', () => {
    expect(siteIdForMarket('it')).toBe('101')
  })
  it('throws on an unknown market', () => {
    expect(() => siteIdForMarket('XX')).toThrow(/unknown eBay market/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts`
Expected: FAIL — cannot resolve `./ebay-trading-api.service.js` / exports not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/services/ebay-trading-api.service.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ebay-trading-api.service.ts apps/api/src/services/ebay-trading-api.service.vitest.test.ts
git commit -m "feat(ebay-trading): module scaffold — siteIdForMarket + escapeXml"
```

---

### Task 2: `buildReviseInventoryStatusXml` (variation-aware quantity)

**Files:**
- Modify: `apps/api/src/services/ebay-trading-api.service.ts`
- Test: `apps/api/src/services/ebay-trading-api.service.vitest.test.ts`

**Interfaces:**
- Consumes: `escapeXml` (Task 1).
- Produces: `buildReviseInventoryStatusXml(input: { itemId: string; sku: string; quantity: number }): string` — returns a `ReviseInventoryStatusRequest` whose `<InventoryStatus>` carries BOTH `<ItemID>` (identifies the listing) and `<SKU>` (identifies the variation) plus `<Quantity>`. No `<RequesterCredentials>` (IAF token is sent as a header).

- [ ] **Step 1: Write the failing test**

```ts
// append to ebay-trading-api.service.vitest.test.ts
import { buildReviseInventoryStatusXml } from './ebay-trading-api.service.js'

describe('buildReviseInventoryStatusXml', () => {
  const xml = buildReviseInventoryStatusXml({ itemId: '110556677', sku: 'LNR-BLK-M', quantity: 7 })

  it('targets the variation by ItemID + SKU', () => {
    expect(xml).toContain('<ItemID>110556677</ItemID>')
    expect(xml).toContain('<SKU>LNR-BLK-M</SKU>')
    expect(xml).toContain('<Quantity>7</Quantity>')
  })
  it('does not embed an auth token in the body (IAF header is used instead)', () => {
    expect(xml).not.toContain('eBayAuthToken')
    expect(xml).not.toContain('<RequesterCredentials>')
  })
  it('is a ReviseInventoryStatusRequest', () => {
    expect(xml).toContain('<ReviseInventoryStatusRequest')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts`
Expected: FAIL — `buildReviseInventoryStatusXml` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ebay-trading-api.service.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ebay-trading-api.service.ts apps/api/src/services/ebay-trading-api.service.vitest.test.ts
git commit -m "feat(ebay-trading): variation-aware ReviseInventoryStatus XML builder"
```

---

### Task 3: `buildAddFixedPriceItemXml` (multi-variation, ItemID tracking)

**Files:**
- Modify: `apps/api/src/services/ebay-trading-api.service.ts`
- Test: `apps/api/src/services/ebay-trading-api.service.vitest.test.ts`

**Interfaces:**
- Consumes: `escapeXml` (Task 1).
- Produces:
```ts
export interface TradingVariation {
  sku: string
  price: number
  quantity: number
  specifics: Record<string, string> // e.g. { Size: 'M', Color: 'Nero' }
}
export interface AddFixedPriceItemInput {
  title: string
  description: string
  categoryId: string
  conditionId: string          // e.g. '1000' (new)
  country: string              // ISO-2, e.g. 'IT'
  currency: string             // e.g. 'EUR'
  listingDuration?: string     // default 'GTC'
  variationSpecificNames: string[] // ordered axis names, e.g. ['Size','Color']
  variations: TradingVariation[]
  pictureUrls?: string[]                       // item-level gallery
  variationPictures?: { axisName: string; byValue: Record<string, string[]> }
  policies?: { fulfillmentPolicyId?: string; paymentPolicyId?: string; returnPolicyId?: string }
}
export function buildAddFixedPriceItemXml(input: AddFixedPriceItemInput): string
```
- Emits `<Variations>` containing one `<Variation>` per row (each with `<SKU>`, `<StartPrice>`, `<Quantity>`, `<VariationSpecifics>`), an optional `<Pictures>` block for one picture-axis, and a `<VariationSpecificsSet>` aggregating all distinct values per axis. Never emits `<InventoryTrackingMethod>`.

- [ ] **Step 1: Write the failing test**

```ts
// append to ebay-trading-api.service.vitest.test.ts
import { buildAddFixedPriceItemXml } from './ebay-trading-api.service.js'

describe('buildAddFixedPriceItemXml', () => {
  const xml = buildAddFixedPriceItemXml({
    title: 'Inner Liner & Pad',
    description: '<p>Liner</p>',
    categoryId: '57988',
    conditionId: '1000',
    country: 'IT',
    currency: 'EUR',
    variationSpecificNames: ['Size'],
    variations: [
      { sku: 'LNR-BLK-M', price: 49.9, quantity: 5, specifics: { Size: 'M' } },
      { sku: 'LNR-BLK-L', price: 49.9, quantity: 3, specifics: { Size: 'L' } },
    ],
    policies: { fulfillmentPolicyId: 'F1', paymentPolicyId: 'P1', returnPolicyId: 'R1' },
  })

  it('is an AddFixedPriceItemRequest with a GTC fixed-price item', () => {
    expect(xml).toContain('<AddFixedPriceItemRequest')
    expect(xml).toContain('<ListingDuration>GTC</ListingDuration>')
    expect(xml).toContain('<PrimaryCategory><CategoryID>57988</CategoryID></PrimaryCategory>')
  })
  it('NEVER sets InventoryTrackingMethod to SKU (keeps default ItemID)', () => {
    expect(xml).not.toContain('InventoryTrackingMethod')
  })
  it('emits one Variation per row with SKU + price + quantity + specifics', () => {
    expect(xml).toContain('<SKU>LNR-BLK-M</SKU>')
    expect(xml).toContain('<SKU>LNR-BLK-L</SKU>')
    expect(xml).toContain('<StartPrice>49.9</StartPrice>')
    expect(xml).toContain('<Quantity>5</Quantity>')
    expect(xml).toContain('<NameValueList><Name>Size</Name><Value>M</Value></NameValueList>')
  })
  it('aggregates distinct axis values in VariationSpecificsSet', () => {
    expect(xml).toMatch(/<VariationSpecificsSet>[\s\S]*<Name>Size<\/Name>[\s\S]*<Value>M<\/Value>[\s\S]*<Value>L<\/Value>[\s\S]*<\/VariationSpecificsSet>/)
  })
  it('wires seller profiles when policies are provided', () => {
    expect(xml).toContain('<ShippingProfileID>F1</ShippingProfileID>')
    expect(xml).toContain('<PaymentProfileID>P1</PaymentProfileID>')
    expect(xml).toContain('<ReturnProfileID>R1</ReturnProfileID>')
  })
  it('escapes the title', () => {
    expect(xml).toContain('<Title>Inner Liner &amp; Pad</Title>')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts`
Expected: FAIL — `buildAddFixedPriceItemXml` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ebay-trading-api.service.ts
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
    <Description><![CDATA[${input.description}]]></Description>
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ebay-trading-api.service.ts apps/api/src/services/ebay-trading-api.service.vitest.test.ts
git commit -m "feat(ebay-trading): AddFixedPriceItem multi-variation XML builder (ItemID tracking)"
```

---

### Task 4: `callTradingApi` — HTTP, IAF auth, dry-run, Ack/ItemID parse

**Files:**
- Modify: `apps/api/src/services/ebay-trading-api.service.ts`
- Test: `apps/api/src/services/ebay-trading-api.service.vitest.test.ts`

**Interfaces:**
- Produces:
```ts
export interface TradingCallContext { oauthToken: string; siteId: string }
export interface TradingCallResult { ack: string; itemId?: string; errors: string[]; raw: string }
export function callTradingApi(callName: string, xml: string, ctx: TradingCallContext): Promise<TradingCallResult>
```
- Real HTTP only when `NEXUS_EBAY_REAL_API==='true'`. Otherwise: non-prod returns `{ ack: 'Success', itemId: 'DRYRUN-<callName>', errors: [], raw: '' }`; prod throws. On real `<Ack>Failure</Ack>` throws with the `<ShortMessage>`/`<LongMessage>`. Parses `<ItemID>` for create calls.

- [ ] **Step 1: Write the failing test**

```ts
// append to ebay-trading-api.service.vitest.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { callTradingApi } from './ebay-trading-api.service.js'

describe('callTradingApi', () => {
  const ctx = { oauthToken: 'OAUTH123', siteId: '101' }
  const OLD = { ...process.env }
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { process.env = { ...OLD } })

  it('dry-run (no real-API) returns simulated success without calling fetch (non-prod)', async () => {
    process.env.NEXUS_EBAY_REAL_API = 'false'
    process.env.NODE_ENV = 'test'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const res = await callTradingApi('AddFixedPriceItem', '<x/>', ctx)
    expect(res.ack).toBe('Success')
    expect(res.itemId).toMatch(/^DRYRUN-/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('production without real-API throws (fail-loud)', async () => {
    process.env.NEXUS_EBAY_REAL_API = 'false'
    process.env.NODE_ENV = 'production'
    await expect(callTradingApi('AddFixedPriceItem', '<x/>', ctx)).rejects.toThrow(/NEXUS_EBAY_REAL_API/)
  })

  it('real call sends IAF token + site id headers and parses ItemID', async () => {
    process.env.NEXUS_EBAY_REAL_API = 'true'
    process.env.EBAY_APP_ID = 'APP'; process.env.EBAY_DEV_ID = 'DEV'; process.env.EBAY_CERT_ID = 'CERT'
    const body = '<AddFixedPriceItemResponse><Ack>Success</Ack><ItemID>110556677</ItemID></AddFixedPriceItemResponse>'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 200 }),
    )
    const res = await callTradingApi('AddFixedPriceItem', '<x/>', ctx)
    expect(res.ack).toBe('Success')
    expect(res.itemId).toBe('110556677')
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['X-EBAY-API-IAF-TOKEN']).toBe('OAUTH123')
    expect(headers['X-EBAY-API-SITEID']).toBe('101')
    expect(headers['X-EBAY-API-CALL-NAME']).toBe('AddFixedPriceItem')
  })

  it('real call throws on Ack=Failure with the short message', async () => {
    process.env.NEXUS_EBAY_REAL_API = 'true'
    const body = '<R><Ack>Failure</Ack><Errors><ShortMessage>Bad category</ShortMessage></Errors></R>'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    await expect(callTradingApi('AddFixedPriceItem', '<x/>', ctx)).rejects.toThrow(/Bad category/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts`
Expected: FAIL — `callTradingApi` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ebay-trading-api.service.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ebay-trading-api.service.ts apps/api/src/services/ebay-trading-api.service.vitest.test.ts
git commit -m "feat(ebay-trading): callTradingApi with IAF auth, per-market site id, dry-run + Ack parse"
```

---

### Task 5: `addFixedPriceItem` + `reviseInventoryStatus` composition wrappers

**Files:**
- Modify: `apps/api/src/services/ebay-trading-api.service.ts`
- Test: `apps/api/src/services/ebay-trading-api.service.vitest.test.ts`

**Interfaces:**
- Consumes: `buildAddFixedPriceItemXml`, `buildReviseInventoryStatusXml`, `callTradingApi`, `siteIdForMarket`.
- Produces:
```ts
export function addFixedPriceItem(input: AddFixedPriceItemInput, ctx: { oauthToken: string; market: string }): Promise<{ itemId: string }>
export function reviseInventoryStatus(input: { itemId: string; sku: string; quantity: number }, ctx: { oauthToken: string; market: string }): Promise<void>
```
- `addFixedPriceItem` resolves site id from `ctx.market`, builds + calls, returns `{ itemId }`; throws if the call succeeds but returns no ItemID. `reviseInventoryStatus` builds + calls; the call itself throws on Failure.

- [ ] **Step 1: Write the failing test**

```ts
// append to ebay-trading-api.service.vitest.test.ts
import { addFixedPriceItem, reviseInventoryStatus } from './ebay-trading-api.service.js'

describe('addFixedPriceItem / reviseInventoryStatus (dry-run composition)', () => {
  const base = { oauthToken: 'OAUTH', market: 'IT' }
  beforeEach(() => { process.env.NEXUS_EBAY_REAL_API = 'false'; process.env.NODE_ENV = 'test' })

  it('addFixedPriceItem returns the dry-run ItemID', async () => {
    const { itemId } = await addFixedPriceItem(
      {
        title: 'X', description: 'x', categoryId: '1', conditionId: '1000',
        country: 'IT', currency: 'EUR', variationSpecificNames: ['Size'],
        variations: [{ sku: 'A-M', price: 9.9, quantity: 1, specifics: { Size: 'M' } }],
      },
      base,
    )
    expect(itemId).toMatch(/^DRYRUN-/)
  })

  it('reviseInventoryStatus resolves without throwing in dry-run', async () => {
    await expect(
      reviseInventoryStatus({ itemId: '110', sku: 'A-M', quantity: 4 }, base),
    ).resolves.toBeUndefined()
  })

  it('addFixedPriceItem rejects an unknown market', async () => {
    await expect(
      addFixedPriceItem(
        { title: 'X', description: 'x', categoryId: '1', conditionId: '1000', country: 'IT', currency: 'EUR', variationSpecificNames: ['Size'], variations: [{ sku: 'A', price: 1, quantity: 1, specifics: { Size: 'M' } }] },
        { oauthToken: 'O', market: 'ZZ' },
      ),
    ).rejects.toThrow(/unknown eBay market/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts`
Expected: FAIL — wrappers not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to ebay-trading-api.service.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ebay-trading-api.service.ts apps/api/src/services/ebay-trading-api.service.vitest.test.ts
git commit -m "feat(ebay-trading): addFixedPriceItem + reviseInventoryStatus composition wrappers"
```

---

## Phase 1 exit verification (manual, after all tasks)

- [ ] `cd apps/api && npx vitest run src/services/ebay-trading-api.service.vitest.test.ts` — all green.
- [ ] `cd apps/api && npx tsc --noEmit` (or the repo's typecheck script) — no type errors.
- [ ] **Sandbox smoke (manual, optional, requires creds):** with `NEXUS_EBAY_REAL_API=true EBAY_SANDBOX=true` and a sandbox OAuth token, call `addFixedPriceItem` with a 2-variation fixture, then `VerifyAddFixedPriceItem` semantics via the sandbox; confirm the response `Ack` and that the **same `Variation.SKU` is accepted** (no uniqueness error) under `InventoryTrackingMethod=ItemID`. Confirm `ReviseInventoryStatus(ItemID, SKU, qty)` adjusts the variation. (Verifies the §3.4 "eBay adds sold to specified quantity" behavior before Phase 3 relies on it.)

## Notes for the executor
- Do NOT modify `apps/api/src/providers/ebay.provider.ts` — the legacy singleton stays as-is.
- Do NOT add DB models, fan-out, or flat-file changes — those are Phases 2–4.
- If the repo's vitest invocation differs (pnpm/turbo), use the equivalent per-file run; the `apps/api` `test` script is `vitest run`.
- The exact `AddFixedPriceItem` tag nesting (`Pictures` vs `VariationSpecificPictureSet`, profile element names) should be confirmed against the sandbox during the exit smoke; the builder structure here follows the AddFixedPriceItem reference. If sandbox rejects a tag, fix the builder + its unit test together.
