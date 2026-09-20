/**
 * P2.2 — the ORDER_CHANGE parse, and the subscription specs.
 *
 * The fixture below is not invented. It is a real ORDER_CHANGE notification Amazon
 * sent this workspace, taken verbatim from the inbound ledger (2026-09-08). That
 * matters more than usual here: the defect was reading the payload one level too high,
 * and a hand-written fixture would have been written to match whichever shape the
 * author believed in — which is exactly the belief that was wrong.
 *
 * Measured over all 1,413 stored ORDER_CHANGE payloads before this fix, using the
 * parser's own expressions:
 *
 *   orderStatus     undefined  1413 / 1413
 *   marketplaceId   empty      1413 / 1413
 *   fulfillmentType 'MFN'      1413 / 1413   — the truth was AFN 1071, MFN 342
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const sent: any[] = []
let queueMessages: any[] = []

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    async send(command: any) {
      sent.push(command)
      return command.__kind === 'receive' ? { Messages: queueMessages } : {}
    }
  },
  ReceiveMessageCommand: class { __kind = 'receive'; constructor(public input: any) {} },
  DeleteMessageCommand: class { __kind = 'delete'; constructor(public input: any) {} },
}))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('./cx/amazon-secret-rotation.service.js', () => ({ credentialNotificationType: () => null }))

const { pollSqsMessages } = await import('./amazon-sqs.service.js')
const {
  payloadVersionFor, sqsNotificationSpecs, NEXUS_SP_API_NOTIFICATION_TYPES,
  NEXUS_SP_API_NOTIFICATION_SPECS,
} = await import('./amazon-notifications-boot.service.js')

/** Verbatim from WebhookEvent, channel AMAZON, eventType ORDER_CHANGE, 2026-09-08. */
const REAL_ORDER_CHANGE = {
  Payload: {
    OrderChangeNotification: {
      Summary: {
        OrderType: 'StandardOrder',
        OrderItems: [{ Quantity: 1, SellerSKU: 'GALE-JACKET-BLACK-MEN-L', OrderItemId: '67426468095802', SupplySourceId: null }],
        OrderStatus: 'Shipped',
        PurchaseDate: '2026-09-07T14:52:42.220Z',
        MarketplaceId: 'A1PA6795UKMFR9',
        OrderPrograms: [],
        FulfillmentType: 'AFN',
        ShippingPrograms: [],
        DestinationPostalCode: null,
      },
      SellerId: 'A1VRHKTGYO1JNU',
      AmazonOrderId: '303-3208227-5274706',
      OrderChangeType: 'OrderStatusChange',
      NotificationLevel: 'OrderLevel',
      OrderChangeTrigger: { ChangeReason: 'Order Status Change', TimeOfOrderChange: '2026-09-08T08:32:13.000Z' },
    },
  },
  EventTime: '2026-09-08T08:32:18.751Z',
  PayloadVersion: '1.0',
  NotificationType: 'ORDER_CHANGE',
  NotificationVersion: '1.0',
  NotificationMetadata: {
    PublishTime: '2026-09-08T08:32:19.859Z',
    ApplicationId: 'amzn1.sp.solution.0e31caaf-9a00-454d-b5dd-1d4459fc3cf8',
    NotificationId: '4ee13dc3-1059-57ae-90d9-f7d04d694e92',
    SubscriptionId: '8dd2f178-4bcb-4094-bbd2-d5fa1e112454',
  },
}

const envBefore = { ...process.env }
beforeEach(() => {
  sent.length = 0
  queueMessages = []
  process.env.AMAZON_SQS_QUEUE_URL = 'https://sqs.example/test'
  process.env.AWS_ACCESS_KEY_ID = 'test-key'
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'
})
afterEach(() => { process.env = { ...envBefore } })

describe('ORDER_CHANGE is read from where Amazon actually puts it', () => {
  it('parses a real notification: status, marketplace and AFN all arrive', async () => {
    queueMessages = [{ Body: JSON.stringify(REAL_ORDER_CHANGE), ReceiptHandle: 'rh-1', MessageId: 'sqs-msg-1' }]
    const [parsed] = await pollSqsMessages()

    expect(parsed.notification).toBeDefined()
    expect(parsed.notification!.amazonOrderId).toBe('303-3208227-5274706')
    // Each of these was undefined or a wrong default on every one of the 1,413 rows.
    expect(parsed.notification!.orderStatus).toBe('Shipped')
    expect(parsed.notification!.marketplaceId).toBe('A1PA6795UKMFR9')
    expect(parsed.notification!.purchaseDate).toBe('2026-09-07T14:52:42.220Z')
    // The one that mattered most: the old parser said MFN for this AFN order, and for
    // 1,071 others, which left an `if (fulfillmentType === 'AFN')` branch permanently
    // dead.
    expect(parsed.notification!.fulfillmentType).toBe('AFN')
    expect(parsed.notification!.sellerId).toBe('A1VRHKTGYO1JNU')
  })

  it('still reads the FLAT shape, so the retired ORDER_STATUS_CHANGE keeps working', async () => {
    // Amazon retired this type on 2026-07-29, but 1,013 of its rows are in the ledger
    // and a replay must still parse them.
    queueMessages = [{
      Body: JSON.stringify({
        NotificationType: 'ORDER_STATUS_CHANGE',
        Payload: { OrderStatusChangeNotification: { AmazonOrderId: '111-1', OrderStatus: 'Pending', MarketplaceId: 'A1PA6795UKMFR9', FulfillmentType: 'MFN', SellerId: 'S1' } },
      }),
      ReceiptHandle: 'rh-2', MessageId: 'sqs-msg-2',
    }]
    const [parsed] = await pollSqsMessages()
    expect(parsed.notification!.orderStatus).toBe('Pending')
    expect(parsed.notification!.fulfillmentType).toBe('MFN')
    expect(parsed.notification!.marketplaceId).toBe('A1PA6795UKMFR9')
  })

  it('carries the notification id Amazon assigned, for dedupe', async () => {
    queueMessages = [{ Body: JSON.stringify(REAL_ORDER_CHANGE), ReceiptHandle: 'rh-3', MessageId: 'sqs-msg-3' }]
    const [parsed] = await pollSqsMessages()
    // The poller keys the ledger row on this, falling back to the SQS MessageId. The
    // SQS id belongs to one SEND; a second publish of the same notification gets a new
    // one and would land as a second row.
    expect((parsed.rawPayload as any).NotificationMetadata.NotificationId).toBe('4ee13dc3-1059-57ae-90d9-f7d04d694e92')
    expect(parsed.messageId).toBe('sqs-msg-3')
  })
})

describe('subscription specs', () => {
  it('uses the version Amazon requires, not a constant', () => {
    // Amazon withdrew payload version 1.0 for this type on 2024-09-25, so the '1.0'
    // that was hardcoded for every type would be refused.
    expect(payloadVersionFor('LISTINGS_ITEM_ISSUES_CHANGE')).toBe('2023-12-13')
    expect(payloadVersionFor('ORDER_CHANGE')).toBe('1.0')
    // An unlisted type keeps the old behaviour rather than sending undefined.
    expect(payloadVersionFor('SOMETHING_UNLISTED')).toBe('1.0')
  })

  it('never offers an EventBridge-only type to the SQS destination', () => {
    const eventBridgeOnly = NEXUS_SP_API_NOTIFICATION_SPECS
      .filter((s) => !s.destinations.includes('SQS'))
      .map((s) => s.type)
    // A positive control: if this list is empty the assertion below proves nothing.
    expect(eventBridgeOnly.length).toBeGreaterThan(0)

    // Both arms. With the gate OFF only the six live types come back, so an
    // EventBridge-only type is excluded by its evidence and this check would pass even
    // if the destination filter were deleted — it has to be exercised with the gate ON,
    // which is the arm where the destination filter is the ONLY thing keeping an
    // impossible subscribe out.
    for (const gate of [undefined, 'true']) {
      if (gate) process.env.NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES = gate
      else delete process.env.NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES
      for (const type of eventBridgeOnly) {
        expect(NEXUS_SP_API_NOTIFICATION_TYPES).not.toContain(type)
        expect(sqsNotificationSpecs().map((s) => s.type)).not.toContain(type)
      }
    }
  })

  it('does not subscribe an unverified type until the Owner turns it on', () => {
    delete process.env.NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES
    const off = sqsNotificationSpecs().map((s) => s.type)
    // Creating a subscription is a live channel call and a production write.
    expect(off).not.toContain('LISTINGS_ITEM_ISSUES_CHANGE')
    expect(off).not.toContain('PRICING_HEALTH')
    expect(off).toContain('ORDER_CHANGE')
    expect(off).toEqual([...NEXUS_SP_API_NOTIFICATION_TYPES])

    process.env.NEXUS_AMAZON_SUBSCRIBE_NEW_TYPES = 'true'
    const on = sqsNotificationSpecs().map((s) => s.type)
    expect(on).toContain('LISTINGS_ITEM_ISSUES_CHANGE')
    expect(on).toContain('PRICING_HEALTH')
    // Still never the EventBridge-only ones — the gate opens the unverified types,
    // not the impossible ones.
    expect(on).not.toContain('BRANDED_ITEM_CONTENT_CHANGE')
    expect(on).not.toContain('LISTINGS_ITEM_STATUS_CHANGE')
  })

  it('keeps the six live types exactly as they were before P2.2', () => {
    expect([...NEXUS_SP_API_NOTIFICATION_TYPES]).toEqual([
      'ORDER_CHANGE',
      'FBA_OUTBOUND_SHIPMENT_STATUS',
      'FBA_INVENTORY_AVAILABILITY_CHANGES',
      'ANY_OFFER_CHANGED',
      'FEED_PROCESSING_FINISHED',
      'ACCOUNT_STATUS_CHANGED',
    ])
  })
})
