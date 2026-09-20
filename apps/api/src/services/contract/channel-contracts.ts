/**
 * P1.8 (docs/channel-connections/FINAL-PLAN.md, section 13.7) — what the nightly contract run checks.
 *
 * The point is to notice a CHANNEL change before it reaches a live listing: our fixture tests only
 * replay answers we recorded ourselves, so a field a channel renames or drops stays green here and red
 * on the seller's account. These checks ask the real channel, on its sandbox, and read the shape of the
 * answer.
 *
 * Two hard rules, enforced by the runner (`contract-run.service.ts`), not by good intentions:
 *   1. every check is a READ or the channel's own DRY RUN (eBay `Verify…`, Amazon `VALIDATION_PREVIEW`),
 *      so a contract run can never change a listing anywhere;
 *   2. every call goes to a SANDBOX host. A channel with no sandbox host is reported as not configured,
 *      never as green.
 */
import type { GatewayChannel } from '../gateway/vocabulary.js'

export interface ContractContext {
  /** The sandbox account this channel's checks run as. */
  accountId: string
  /** Amazon only: the sandbox seller id. */
  sellerId?: string
}

export interface ContractCheck {
  channel: GatewayChannel
  /** Stable name, also the ledger operation: `ebay.getInventoryItems`. */
  name: string
  what: 'read' | 'dry-run write'
  /** The PRODUCTION url; the runner moves it to the channel's sandbox host and refuses if there is none. */
  url: (ctx: ContractContext) => string
  method?: 'GET' | 'POST'
  headers?: (ctx: ContractContext) => Record<string, string>
  body?: (ctx: ContractContext) => string
  /** The shape the answer must have. Return a sentence when it does not; null when the contract holds. */
  assert: (answer: { status: number; text: string; json: <T = unknown>() => T | null }) => string | null
}

const hasKeys = (value: unknown, keys: string[]): boolean =>
  !!value && typeof value === 'object' && keys.every((key) => key in (value as Record<string, unknown>))

export const CHANNEL_CONTRACTS: ContractCheck[] = [
  {
    channel: 'EBAY',
    name: 'ebay.getInventoryItems',
    what: 'read',
    url: () => 'https://api.ebay.com/sell/inventory/v1/inventory_item?limit=1',
    assert: ({ status, json }) => {
      if (status !== 200) return `eBay answered HTTP ${status} to the inventory read.`
      const body = json<{ inventoryItems?: unknown[]; total?: number; size?: number }>()
      if (!body || (body.inventoryItems === undefined && body.total === undefined && body.size === undefined)) {
        return 'eBay inventory read no longer returns inventoryItems / total / size.'
      }
      return null
    },
  },
  {
    channel: 'EBAY',
    name: 'ebay.verifyAddFixedPriceItem',
    what: 'dry-run write',
    url: () => 'https://api.ebay.com/ws/api.dll',
    method: 'POST',
    headers: () => ({ 'X-EBAY-API-CALL-NAME': 'VerifyAddFixedPriceItem', 'Content-Type': 'text/xml' }),
    // Deliberately a minimal item: eBay answers Failure with the fields it wants, which is exactly the
    // contract we want to watch. A changed error vocabulary shows up here first.
    body: () => `<?xml version="1.0" encoding="utf-8"?>
<VerifyAddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><Item><Title>Nexus contract run</Title></Item></VerifyAddFixedPriceItemRequest>`,
    assert: ({ status, text }) => {
      if (status !== 200) return `eBay answered HTTP ${status} to the dry-run add.`
      if (!/<Ack>(Success|Warning|Failure)<\/Ack>/.test(text)) return 'eBay Verify answer carries no <Ack> — the Trading contract changed.'
      // `<Fees/>` is self-closing on a clean verify, `<Fees>` carries entries — both are the contract.
      if (!/<Errors[\s>]|<ItemID>|<Fees[\s/>]/.test(text)) return 'eBay Verify answer carries neither errors nor fees — the Trading contract changed.'
      return null
    },
  },
  {
    channel: 'AMAZON_SP',
    name: 'amazon.getMarketplaceParticipations',
    what: 'read',
    url: () => 'https://sellingpartnerapi-eu.amazon.com/sellers/v1/marketplaceParticipations',
    assert: ({ status, json }) => {
      if (status !== 200) return `Amazon answered HTTP ${status} to the participations read.`
      const body = json<{ payload?: unknown }>()
      if (!hasKeys(body, ['payload'])) return 'Amazon participations answer has no payload — the SP-API contract changed.'
      return null
    },
  },
  {
    channel: 'AMAZON_ADS',
    name: 'ads.listProfiles',
    what: 'read',
    url: () => 'https://advertising-api-eu.amazon.com/v2/profiles',
    assert: ({ status, json }) => {
      if (status !== 200) return `Amazon Ads answered HTTP ${status} to the profiles read.`
      if (!Array.isArray(json())) return 'Amazon Ads profiles no longer answers with a list.'
      return null
    },
  },
]

/**
 * Shopify and Etsy, stated rather than silently missing:
 *  - Shopify has no sandbox host. A development store is an ordinary connected account, so its checks
 *    need the Owner to name that account; until then the runner reports it as not configured.
 *  - Etsy has no sandbox at all (the plan's answer: a test listing on the real shop, marked "test",
 *    which is a decision for the Owner, not something this run may create).
 */
export const CHANNELS_WITHOUT_SANDBOX: Array<{ channel: GatewayChannel; reason: string }> = [
  { channel: 'SHOPIFY', reason: 'Shopify has no sandbox host: name a development-store account for the contract run.' },
  { channel: 'ETSY', reason: 'Etsy has no sandbox. The plan asks for a test listing on the real shop, marked "test" — your decision, not this run\'s.' },
]
