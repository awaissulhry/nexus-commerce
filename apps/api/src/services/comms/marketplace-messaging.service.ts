/**
 * MCP full control 07 O15 — writing to an Amazon or eBay buyer through the marketplace's own messaging (decision OD2 =
 * A: those buyers are never e-mailed directly). Both calls go through the channel gateway (hard rule 4) on the order's
 * own seller account; each has its own switch, and while it is off nothing is sent (a dry run, said in the preview).
 *
 *   - Amazon: SP-API Messaging. Amazon allows only its own message kinds per order; Nexus maps its templates to one
 *     (shipping-update → confirmOrderDetails, delay-apology → unexpectedProblem, address-check → confirmDeliveryDetails),
 *     asks Amazon which kinds this order allows (getMessagingActionsForOrder), and sends only an allowed one.
 *     Switch: NEXUS_ENABLE_AMAZON_MESSAGING=true.
 *   - eBay: Trading AddMemberMessageAAQToPartner — a message to the buyer of the order's item, in eBay Messages.
 *     Switch: NEXUS_ENABLE_EBAY_MESSAGING=true.
 *
 * Never throws past its boundary: the outcome comes back (SENT, DRY_RUN, FAILED with the channel's words).
 */

import { tryResolveConnection } from '../connection-resolver.service.js'
import { amazonSellerFetch } from '../gateway/amazon-sdk.js'
import { ebayTradingSend } from '../gateway/ebay.js'

export type MarketplaceSendOutcome = { outcome: 'SENT' | 'DRY_RUN' | 'FAILED'; providerRef: string | null; error: string | null }

/** The Amazon message kind each template is sent as (Amazon allows no free kind). */
export const AMAZON_MESSAGE_KINDS: Record<string, string> = {
  'shipping-update': 'confirmOrderDetails',
  'delay-apology': 'unexpectedProblem',
  'address-check': 'confirmDeliveryDetails',
}

export function amazonMessagingMode(): string {
  return process.env.NEXUS_ENABLE_AMAZON_MESSAGING === 'true'
    ? 'live: Amazon delivers it through Buyer-Seller Messaging'
    : 'dry run: Amazon is not called (NEXUS_ENABLE_AMAZON_MESSAGING off)'
}

export function ebayMessagingMode(): string {
  return process.env.NEXUS_ENABLE_EBAY_MESSAGING === 'true'
    ? 'live: eBay delivers it to the buyer\'s eBay Messages'
    : 'dry run: eBay is not called (NEXUS_ENABLE_EBAY_MESSAGING off)'
}

const dryRun = (): MarketplaceSendOutcome => ({ outcome: 'DRY_RUN', providerRef: null, error: null })
const failed = (error: string): MarketplaceSendOutcome => ({ outcome: 'FAILED', providerRef: null, error })

/**
 * One Amazon buyer message: the kind must be among the ones Amazon allows for this order now. `text` is the whole
 * message (Amazon adds its own frame).
 */
export async function sendAmazonMessage(input: { orderId: string; amazonOrderId: string; marketplaceId: string; kind: string; text: string }): Promise<MarketplaceSendOutcome> {
  if (process.env.NEXUS_ENABLE_AMAZON_MESSAGING !== 'true') return dryRun()
  try {
    const account = await tryResolveConnection({ orderId: input.orderId })
    if (!account) return failed('No Amazon seller account is linked to this order; nothing was sent.')
    const order = encodeURIComponent(input.amazonOrderId)
    const market = encodeURIComponent(input.marketplaceId)
    const actions = await amazonSellerFetch({ accountId: account.id, path: `/messaging/v1/orders/${order}?marketplaceIds=${market}`, operation: 'messaging.getMessagingActionsForOrder' })
    if (!actions.ok) return failed(`Amazon did not say which messages this order allows (HTTP ${actions.status}); nothing was sent.`)
    const listed = (await actions.json().catch(() => ({}))) as { _links?: { actions?: Array<{ name?: string; href?: string }> } }
    const allowed = (listed._links?.actions ?? []).map((a) => a.name ?? String(a.href ?? '').split('/').pop() ?? '')
    if (!allowed.includes(input.kind)) {
      return failed(`Amazon does not allow a "${input.kind}" message for this order now (it allows: ${allowed.join(', ') || 'none'}); nothing was sent.`)
    }
    const sent = await amazonSellerFetch({
      accountId: account.id, method: 'POST', path: `/messaging/v1/orders/${order}/messages/${encodeURIComponent(input.kind)}?marketplaceIds=${market}`,
      operation: `messaging.${input.kind}`, body: { text: input.text },
    })
    if (!sent.ok) return failed(`Amazon refused the message (HTTP ${sent.status}): ${(await sent.text().catch(() => '')).slice(0, 300)}`)
    return { outcome: 'SENT', providerRef: sent.headers.get('x-amzn-requestid'), error: null }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}

const TRADING_ENDPOINT = process.env.EBAY_SANDBOX === 'true' ? 'https://api.sandbox.ebay.com/ws/api.dll' : 'https://api.ebay.com/ws/api.dll'
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** One eBay member message to the buyer of the order's item (eBay Messages). */
export async function sendEbayMemberMessage(input: { orderId: string; itemId: string; buyerUserId: string; subject: string; body: string; siteId: string }): Promise<MarketplaceSendOutcome> {
  if (process.env.NEXUS_ENABLE_EBAY_MESSAGING !== 'true') return dryRun()
  try {
    const account = await tryResolveConnection({ orderId: input.orderId })
    if (!account) return failed('No eBay account is linked to this order; nothing was sent.')
    const { ebayAuthService } = await import('../ebay-auth.service.js')
    const token = await ebayAuthService.getValidToken(account.id)
    const request =
      '<?xml version="1.0" encoding="utf-8"?>'
      + '<AddMemberMessageAAQToPartnerRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
      + `<ItemID>${xml(input.itemId)}</ItemID>`
      + '<MemberMessage>'
      + `<Subject>${xml(input.subject.slice(0, 100))}</Subject>`
      + `<Body>${xml(input.body.slice(0, 2000))}</Body>`
      + '<QuestionType>General</QuestionType>'
      + `<RecipientID>${xml(input.buyerUserId)}</RecipientID>`
      + '</MemberMessage>'
      + '</AddMemberMessageAAQToPartnerRequest>'
    const res = await ebayTradingSend(account.id, TRADING_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-EBAY-API-CALL-NAME': 'AddMemberMessageAAQToPartner',
        'X-EBAY-API-COMPATIBILITY-LEVEL': process.env.EBAY_COMPAT_LEVEL || '1193',
        'X-EBAY-API-SITEID': input.siteId,
        'X-EBAY-API-IAF-TOKEN': token,
        'Content-Type': 'text/xml',
      },
      body: request,
    })
    const text = await res.text().catch(() => '')
    if (!res.ok || /<Ack>(Failure|PartialFailure)<\/Ack>/.test(text)) {
      const message = text.match(/<LongMessage>([^<]+)<\/LongMessage>/)?.[1] ?? text.match(/<ShortMessage>([^<]+)<\/ShortMessage>/)?.[1] ?? `HTTP ${res.status}`
      return failed(`eBay refused the message: ${message}`)
    }
    return { outcome: 'SENT', providerRef: text.match(/<CorrelationID>([^<]+)<\/CorrelationID>/)?.[1] ?? null, error: null }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}
