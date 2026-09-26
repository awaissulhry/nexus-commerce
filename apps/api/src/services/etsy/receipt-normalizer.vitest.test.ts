/**
 * CX Etsy E1 — the pure receipt normaliser: every refusal, the status mapping, the no-regress
 * status merge and Etsy's Money. Field names are Etsy's OpenAPI v3 `ShopReceipt` /
 * `ShopReceiptTransaction` / `Money` (fetched 2026-09-23).
 */
import { describe, expect, it } from 'vitest'
import type { OrderStatus } from '@prisma/client'
import {
  ETSY_MAX_LINE_QUANTITY,
  ETSY_RECEIPT_STATUSES,
  centsToDecimal,
  mapEtsyStatus,
  mergeStatus,
  normalizeEtsyMoney,
  normalizeEtsyReceipt,
  type EtsyReceiptBinding,
  type EtsyReceiptRefusalCode,
} from './receipt-normalizer.js'
import { shouldPreserveTerminalStatus } from '../order-status-guards.js'

const SHOP = '10000001'
const SELLER = '900000001' // the account's USER id — deliberately not the shop id
const RECEIPT = 3344556677
const binding: EtsyReceiptBinding = { shopId: SHOP, sellerUserId: SELLER }
const eur = (amount: unknown, divisor: unknown = 100, currency_code: unknown = 'EUR') => ({ amount, divisor, currency_code })

type Json = Record<string, any>
const transaction = (over: Json = {}): Json => ({
  transaction_id: 9001, receipt_id: RECEIPT, seller_user_id: Number(SELLER), buyer_user_id: 77,
  title: 'Leather wallet', listing_id: 1234, product_id: 5678, sku: 'WALLET-BRN', quantity: 2,
  price: eur(1999), shipping_cost: eur(500), created_timestamp: 1_758_000_000, paid_timestamp: 1_758_000_100,
  shipped_timestamp: null, is_digital: false, ...over,
})
const receipt = (over: Json = {}): Json => ({
  receipt_id: RECEIPT, receipt_type: 0, seller_user_id: Number(SELLER), buyer_user_id: 77,
  buyer_email: 'buyer@example.test', name: 'A Buyer', first_line: 'Via Roma 1', second_line: null,
  city: 'Milano', state: null, zip: '20100', country_iso: 'IT', formatted_address: 'Via Roma 1\n20100 Milano',
  status: 'paid', is_paid: true, is_shipped: false,
  created_timestamp: 1_758_000_000, create_timestamp: 1_758_000_000, updated_timestamp: 1_758_000_500, update_timestamp: 1_758_000_500,
  grandtotal: eur(4498), subtotal: eur(3998), total_price: eur(3998), total_shipping_cost: eur(500),
  total_tax_cost: eur(0), total_vat_cost: eur(0), discount_amt: eur(0), gift_wrap_price: eur(0),
  transactions: [transaction()], refunds: [], shipments: [], ...over,
})

const refusalOf = (input: unknown, b: EtsyReceiptBinding = binding) => {
  const result = normalizeEtsyReceipt(input, b)
  expect(result.ok, 'expected a refusal, got a receipt').toBe(false)
  return (result as Extract<typeof result, { ok: false }>).refusal
}
const receiptOf = (input: unknown, b: EtsyReceiptBinding = binding) => {
  const result = normalizeEtsyReceipt(input, b)
  expect((result as { refusal?: unknown }).refusal, 'expected a receipt, got a refusal').toBeUndefined()
  return (result as Extract<typeof result, { ok: true }>).receipt
}

describe('a well-formed paid receipt', () => {
  it('normalises ids, money, lines, status and the address without changing a value', () => {
    const r = receiptOf(receipt())
    expect(r).toMatchObject({
      receiptId: String(RECEIPT), shopId: SHOP, sellerUserId: SELLER, buyerUserId: '77',
      etsyStatus: 'paid', status: 'PROCESSING', isPaid: true, isShipped: false,
      createdAt: 1_758_000_000, updatedAt: 1_758_000_500, currencyCode: 'EUR',
      buyer: { name: 'A Buyer', email: 'buyer@example.test' },
      shippingAddress: { firstLine: 'Via Roma 1', secondLine: null, city: 'Milano', zip: '20100', countryIso: 'IT' },
      checks: { linesMatchTotalPrice: true, shippedLines: 0, zeroQuantityLines: [], unreadableMoney: [] },
    })
    expect(r.grandTotal).toEqual({ decimal: '44.98', cents: 4498n, amount: 4498, divisor: 100, currencyCode: 'EUR' })
    expect(r.lines).toEqual([{
      transactionId: '9001', listingId: '1234', etsyProductId: '5678', sku: 'WALLET-BRN', title: 'Leather wallet',
      quantity: 2, unitPrice: { decimal: '19.99', cents: 1999n, amount: 1999, divisor: 100, currencyCode: 'EUR' },
      lineTotal: '39.98', shippingCost: { decimal: '5.00', cents: 500n, amount: 500, divisor: 100, currencyCode: 'EUR' },
      paidAt: 1_758_000_100, shippedAt: null, isDigital: false, stockEligible: true,
    }])
  })

  it('reports — does not refuse — a total_price that is not Σ price × quantity', () => {
    expect(receiptOf(receipt({ total_price: eur(3997) })).checks.linesMatchTotalPrice).toBe(false)
    expect(receiptOf(receipt({ total_price: undefined })).checks.linesMatchTotalPrice).toBeNull()
  })

  it('adds line money exactly: 10¢ + 20¢ is 30¢, not 0.30000000000000004', () => {
    const r = receiptOf(receipt({
      grandtotal: eur(30), subtotal: eur(30), total_price: eur(30), total_shipping_cost: eur(0),
      transactions: [transaction({ transaction_id: 1, quantity: 1, price: eur(10), shipping_cost: eur(0) }), transaction({ transaction_id: 2, quantity: 1, price: eur(20), shipping_cost: eur(0) })],
    }))
    expect(r.checks.linesMatchTotalPrice).toBe(true)
    expect(r.lines.map((line) => line.lineTotal)).toEqual(['0.10', '0.20'])
  })

  it('multiplies exactly: 3 × 0.07 is 0.21', () => {
    const r = receiptOf(receipt({ total_price: eur(21), transactions: [transaction({ quantity: 3, price: eur(7) })] }))
    expect(r.lines[0].lineTotal).toBe('0.21')
    expect(r.checks.linesMatchTotalPrice).toBe(true)
  })

  it('accepts the legacy timestamp spelling alone, and optional nulls', () => {
    const r = receiptOf(receipt({ created_timestamp: undefined, updated_timestamp: undefined, transactions: [transaction({ listing_id: null, product_id: null, sku: null, shipping_cost: null })] }))
    expect(r.createdAt).toBe(1_758_000_000)
    expect(r.lines[0]).toMatchObject({ listingId: null, etsyProductId: null, sku: null, shippingCost: null })
  })

  it('accepts an unpaid receipt with no transactions (nothing was bought yet)', () => {
    expect(receiptOf(receipt({ status: 'open', is_paid: false, transactions: [] })).status).toBe('AWAITING_PAYMENT')
    expect(receiptOf(receipt({ status: 'canceled', is_paid: false, transactions: undefined })).lines).toEqual([])
  })

  it('binds by the seller USER id: a receipt without seller_user_id is checked by the shop path only', () => {
    expect(receiptOf(receipt({ seller_user_id: undefined })).sellerUserId).toBeNull()
  })
})

/**
 * A REAL getShopReceipt response, published by an Etsy developer in etsy/open-api discussion #1356
 * (https://github.com/etsy/open-api/discussions/1356, receipt from Oct 2024; saved as evidence
 * etsy-real-receipt-discussion-1356.txt). Every value is verbatim except ids and personal fields,
 * which are synthetic here (marked `// redacted`; the transaction ids too: this repository is public).
 * It is what proved that Etsy sends "Completed" — capitalised — where the schema says "completed".
 */
const REAL_RECEIPT_ID = 3_512_345_678 // redacted
const realReceipt = (): Json => ({
  receipt_id: REAL_RECEIPT_ID, receipt_type: 0, seller_user_id: Number(SELLER), seller_email: 'seller@example.test', // redacted
  buyer_user_id: 88, buyer_email: null, name: 'Redacted Name', first_line: 'Redacted street', second_line: '', // redacted
  city: 'Redacted', state: 'NY', zip: '10001', status: 'Completed', formatted_address: 'Redacted', country_iso: 'US', // redacted (not status/country)
  payment_method: 'cc', payment_email: null, message_from_payment: null, message_from_seller: 'Redacted', message_from_buyer: '',
  is_shipped: true, is_paid: true, create_timestamp: 1728449563, created_timestamp: 1728449563, update_timestamp: 1728484312, updated_timestamp: 1728484312,
  is_gift: true, gift_message: '', gift_sender: '',
  grandtotal: { amount: 2127, divisor: 100, currency_code: 'USD' }, subtotal: { amount: 1350, divisor: 100, currency_code: 'USD' },
  total_price: { amount: 1350, divisor: 100, currency_code: 'USD' }, total_shipping_cost: { amount: 0, divisor: 100, currency_code: 'USD' },
  total_tax_cost: { amount: 95, divisor: 100, currency_code: 'USD' }, total_vat_cost: { amount: 0, divisor: 100, currency_code: 'USD' },
  discount_amt: { amount: 0, divisor: 100, currency_code: 'USD' }, gift_wrap_price: { amount: 0, divisor: 100, currency_code: 'USD' },
  shipments: [{ receipt_shipping_id: 1001, shipment_notification_timestamp: 1728489600, carrier_name: 'USPS', tracking_code: 'REDACTED' }], // redacted id
  transactions: [
    { transaction_id: 1_000_000_001, title: 'Redacted', description: 'Redacted', seller_user_id: Number(SELLER), buyer_user_id: 88, // redacted
      create_timestamp: 1728449563, created_timestamp: 1728449563, paid_timestamp: 1728449581, shipped_timestamp: 1728484312, quantity: 1,
      listing_image_id: 5001, receipt_id: REAL_RECEIPT_ID, is_digital: false, file_data: '', listing_id: 6001, sku: 'RIBBON-5Y', product_id: 7001, // redacted
      transaction_type: 'listing', price: { amount: 700, divisor: 100, currency_code: 'USD' }, shipping_cost: { amount: 0, divisor: 100, currency_code: 'USD' },
      variations: [{ property_id: 513, value_id: 1, formatted_name: 'Ribbon length', formatted_value: '5 Yards' }],
      product_data: [{ property_id: 513, property_name: 'Length', scale_id: 9, scale_name: 'Yards', value_ids: [1], values: ['5'] }],
      shipping_profile_id: 8001, min_processing_days: 1, max_processing_days: 3, shipping_method: null, shipping_upgrade: null, expected_ship_date: 1728489600, buyer_coupon: 0, shop_coupon: 0 },
    { transaction_id: 1_000_000_002, title: 'Redacted', description: 'Redacted', seller_user_id: Number(SELLER), buyer_user_id: 88, // redacted
      create_timestamp: 1728449563, created_timestamp: 1728449563, paid_timestamp: 1728449581, shipped_timestamp: 1728484312, quantity: 1,
      listing_image_id: 5002, receipt_id: REAL_RECEIPT_ID, is_digital: false, file_data: '', listing_id: 6002, sku: 'RIBBON-5Y-GG', product_id: 7002, // redacted
      transaction_type: 'listing', price: { amount: 650, divisor: 100, currency_code: 'USD' }, shipping_cost: { amount: 0, divisor: 100, currency_code: 'USD' },
      variations: [{ property_id: 513, value_id: 1, formatted_name: 'Ribbon length', formatted_value: '5 Yards' }, { property_id: 514, value_id: 2, formatted_name: 'Primary fabric type', formatted_value: 'Grosgrain' }],
      product_data: [], shipping_profile_id: 8001, min_processing_days: 1, max_processing_days: 3, shipping_method: null, shipping_upgrade: null, expected_ship_date: 1728489600, buyer_coupon: 0, shop_coupon: 0 },
  ],
  refunds: [],
})

describe('a real Etsy receipt (discussion #1356)', () => {
  it('normalises: "Completed" is shipped, money is exact, the lines add up to total_price', () => {
    const r = receiptOf(realReceipt(), { shopId: SHOP, sellerUserId: SELLER, expectedReceiptId: String(REAL_RECEIPT_ID) })
    expect(r).toMatchObject({
      etsyStatus: 'completed', etsyStatusRaw: 'Completed', status: 'SHIPPED', isPaid: true, isShipped: true, currencyCode: 'USD',
      buyer: { email: null }, shippingAddress: { secondLine: '' },
      checks: { linesMatchTotalPrice: true, shippedLines: 2, zeroQuantityLines: [], unreadableMoney: [] },
    })
    expect(r.grandTotal.decimal).toBe('21.27')
    expect(r.lines.map((line) => [line.transactionId, line.unitPrice.decimal, line.lineTotal])).toEqual([['1000000001', '7.00', '7.00'], ['1000000002', '6.50', '6.50']])
  })

  it('is refused when bound to another seller (the binding still holds on a real shape)', () => {
    expect(refusalOf(realReceipt(), { shopId: SHOP, sellerUserId: '42' }).code).toBe('seller_mismatch')
  })
})

describe('Etsy Money — exact, integer and string arithmetic only', () => {
  it.each([
    [1999, 100, '19.99'],
    [1990, 100, '19.90'],
    [1, 100, '0.01'],
    [0, 100, '0.00'],
    [5, 10, '0.50'],
    [1999, 10, '199.90'],
    [7, 1, '7.00'],
    [1999, 1, '1999.00'],
    [999_999_999_999, 100, '9999999999.99'],
  ])('%i / %i is "%s", keeping the raw minor units', (amount, divisor, decimal) => {
    expect(normalizeEtsyMoney(eur(amount, divisor), 'm')).toMatchObject({ decimal, amount, divisor, currencyCode: 'EUR' })
  })

  it('formats hundredths with a sign and padding', () => {
    expect([centsToDecimal(0n), centsToDecimal(5n), centsToDecimal(-105n), centsToDecimal(123456789n)]).toEqual(['0.00', '0.05', '-1.05', '1234567.89'])
  })

  const moneyRefusal = (money: unknown): EtsyReceiptRefusalCode => refusalOf(receipt({ grandtotal: money })).code
  it.each([
    ['divisor 1000 (three decimals)', eur(19990, 1000), 'money_divisor_unsupported'],
    ['divisor 0', eur(1999, 0), 'money_divisor_unsupported'],
    ['divisor 3', eur(1999, 3), 'money_divisor_unsupported'],
    ['divisor as a string', eur(1999, '100'), 'money_divisor_unsupported'],
    ['a negative amount', eur(-1), 'money_invalid'],
    ['a float amount', eur(19.99), 'money_invalid'],
    ['a float-looking string amount', eur('19.99'), 'money_invalid'],
    ['an integer-looking string amount', eur('1999'), 'money_invalid'],
    ['an exponent string amount', eur('1e3'), 'money_invalid'],
    ['NaN', eur(Number.NaN), 'money_invalid'],
    ['Infinity', eur(Number.POSITIVE_INFINITY), 'money_invalid'],
    ['an unsafe integer', eur(2 ** 53), 'money_invalid'],
    ['a lower-case currency', eur(1999, 100, 'eur'), 'money_invalid'],
    ['no currency', { amount: 1999, divisor: 100 }, 'money_invalid'],
    ['not an object', 19.99, 'money_invalid'],
    ['an array', [1999, 100, 'EUR'], 'money_invalid'],
    ['a receipt total too large for Decimal(12,2)', eur(1_000_000_000_000), 'money_exceeds_column'],
    ['no grandtotal', undefined, 'money_missing'],
  ])('refuses %s', (_name, money, code) => {
    expect(moneyRefusal(money)).toBe(code)
  })

  it('refuses a unit price too large for OrderItem.price Decimal(10,2), and a line total too large for Decimal(12,2)', () => {
    expect(refusalOf(receipt({ transactions: [transaction({ quantity: 1, price: eur(10_000_000_000) })] }))).toMatchObject({ code: 'money_exceeds_column', path: 'transactions[0].price' })
    expect(refusalOf(receipt({ transactions: [transaction({ quantity: 999, price: eur(9_999_999_999) })] }))).toMatchObject({ code: 'money_exceeds_column', path: 'transactions[0].price' })
  })

  it.each([
    ['a line price', { transactions: [transaction({ price: eur(1999, 100, 'USD') })] }, 'transactions[0].price'],
    ['a line shipping cost', { transactions: [transaction({ shipping_cost: eur(500, 100, 'USD') })] }, 'transactions[0].shipping_cost'],
    ['a receipt subtotal', { subtotal: eur(3998, 100, 'GBP') }, 'subtotal'],
    ['a refund', { refunds: [{ amount: eur(100, 100, 'USD'), created_timestamp: 1_758_000_600, status: 'ok' }] }, 'refunds[0].amount'],
    ['a second line price', { total_price: undefined, transactions: [transaction(), transaction({ transaction_id: 9002, price: eur(1999, 100, 'USD') })] }, 'transactions[1].price'],
  ])('refuses mixed currencies: %s', (_name, over, path) => {
    expect(refusalOf(receipt(over))).toMatchObject({ code: 'money_currency_mixed', path })
  })

  it('refuses a divisor 1000 line price — a stored value (OrderItem.price)', () => {
    expect(refusalOf(receipt({ transactions: [transaction({ price: eur(19990, 1000) })] }))).toMatchObject({ code: 'money_divisor_unsupported', path: 'transactions[0].price' })
  })

  // Review fix: the schema allows divisor 0 and any currency string, and Nexus never stores these
  // values in a column. An unreadable OPTIONAL amount is reported, never a reason to drop an order.
  it.each([
    ['gift_wrap_price divisor 0', { gift_wrap_price: eur(0, 0) }, 'gift_wrap_price', 'money_divisor_unsupported'],
    ['discount_amt empty currency', { discount_amt: eur(0, 100, '') }, 'discount_amt', 'money_invalid'],
    ['total_vat_cost divisor 1000', { total_vat_cost: eur(0, 1000) }, 'total_vat_cost', 'money_divisor_unsupported'],
    ['subtotal negative', { subtotal: eur(-1) }, 'subtotal', 'money_invalid'],
    ['total_price a string', { total_price: eur('3998') }, 'total_price', 'money_invalid'],
    ['total_shipping_cost not an object', { total_shipping_cost: 5 }, 'total_shipping_cost', 'money_invalid'],
    ['total_tax_cost divisor 0', { total_tax_cost: eur(0, 0) }, 'total_tax_cost', 'money_divisor_unsupported'],
    ['a line shipping_cost divisor 0', { transactions: [transaction({ shipping_cost: eur(0, 0) })] }, 'transactions[0].shipping_cost', 'money_divisor_unsupported'],
    ['a negative refund amount', { refunds: [{ amount: eur(-5) }] }, 'refunds[0].amount', 'money_invalid'],
    ['a refund with no amount', { refunds: [{}] }, 'refunds[0].amount', 'money_missing'],
    ['refunds not a list', { refunds: 'none' }, 'refunds', 'money_invalid'],
  ])('reports, does not refuse, an unreadable optional amount: %s', (_name, over, path, code) => {
    const r = receiptOf(receipt(over as Json))
    expect(r.checks.unreadableMoney).toEqual([expect.objectContaining({ path, code })])
    expect(r.grandTotal.decimal).toBe('44.98')
  })
})

describe('every refusal is named', () => {
  it.each<[string, unknown, EtsyReceiptBinding | undefined, EtsyReceiptRefusalCode, string]>([
    ['a binding with no shop', receipt(), { shopId: '', sellerUserId: SELLER }, 'binding_invalid', 'binding'],
    ['a binding with no seller', receipt(), { shopId: SHOP, sellerUserId: null as unknown as string }, 'binding_invalid', 'binding'],
    ['a binding with a non-canonical seller', receipt(), { shopId: SHOP, sellerUserId: '0900000001' }, 'binding_invalid', 'binding'],
    ['an event naming another shop', receipt(), { ...binding, claimedShopId: '12345' }, 'shop_mismatch', 'shop_id'],
    ['null', null, undefined, 'not_a_receipt', 'receipt'],
    ['an array', [receipt()], undefined, 'not_a_receipt', 'receipt'],
    ['a string', 'receipt', undefined, 'not_a_receipt', 'receipt'],
    ['receipt_id 0', receipt({ receipt_id: 0 }), undefined, 'receipt_id_invalid', 'receipt_id'],
    ['receipt_id negative', receipt({ receipt_id: -3 }), undefined, 'receipt_id_invalid', 'receipt_id'],
    ['receipt_id fractional', receipt({ receipt_id: 1.5 }), undefined, 'receipt_id_invalid', 'receipt_id'],
    ['receipt_id as a string', receipt({ receipt_id: String(RECEIPT) }), undefined, 'receipt_id_invalid', 'receipt_id'],
    ['receipt_id beyond 2^53', receipt({ receipt_id: 2 ** 53 }), undefined, 'receipt_id_invalid', 'receipt_id'],
    ['receipt_id missing', receipt({ receipt_id: undefined }), undefined, 'receipt_id_invalid', 'receipt_id'],
    ['another receipt than the event named', receipt(), { ...binding, expectedReceiptId: '42' }, 'receipt_id_mismatch', 'receipt_id'],
    ['another seller on the receipt', receipt({ seller_user_id: Number(SHOP) }), undefined, 'seller_mismatch', 'seller_user_id'],
    ['another seller on a line', receipt({ transactions: [transaction({ seller_user_id: 42 })] }), undefined, 'seller_mismatch', 'transactions[0].seller_user_id'],
    ['a bad seller id', receipt({ seller_user_id: '900000001' }), undefined, 'id_invalid', 'seller_user_id'],
    ['a bad buyer id', receipt({ buyer_user_id: 0 }), undefined, 'id_invalid', 'buyer_user_id'],
    ['a negative listing id', receipt({ transactions: [transaction({ listing_id: -1 })] }), undefined, 'id_invalid', 'transactions[0].listing_id'],
    ['a bad Etsy product id', receipt({ transactions: [transaction({ product_id: -1 })] }), undefined, 'id_invalid', 'transactions[0].product_id'],
    ['a bad transaction id', receipt({ transactions: [transaction({ transaction_id: 0 })] }), undefined, 'id_invalid', 'transactions[0].transaction_id'],
    ['a missing transaction id', receipt({ transactions: [transaction({ transaction_id: undefined })] }), undefined, 'id_invalid', 'transactions[0].transaction_id'],
    ['an unknown status', receipt({ status: 'shipped' }), undefined, 'status_unknown', 'status'],
    ['a missing status', receipt({ status: undefined }), undefined, 'status_unknown', 'status'],
    ['a status that is not a string', receipt({ status: 3 }), undefined, 'status_unknown', 'status'],
    ['no created time', receipt({ created_timestamp: undefined, create_timestamp: undefined }), undefined, 'timestamp_invalid', 'created_timestamp'],
    ['no updated time', receipt({ updated_timestamp: undefined, update_timestamp: undefined }), undefined, 'timestamp_invalid', 'updated_timestamp'],
    ['a created time before 2000', receipt({ created_timestamp: 946_684_799 }), undefined, 'timestamp_invalid', 'created_timestamp'],
    ['a fractional updated time', receipt({ updated_timestamp: 1_758_000_500.5 }), undefined, 'timestamp_invalid', 'updated_timestamp'],
    ['a millisecond-looking string time', receipt({ created_timestamp: '1758000000' }), undefined, 'timestamp_invalid', 'created_timestamp'],
    ['disagreeing time spellings', receipt({ create_timestamp: 1_758_000_001 }), undefined, 'timestamp_invalid', 'created_timestamp'],
    ['a bad line shipped time', receipt({ transactions: [transaction({ shipped_timestamp: -1 })] }), undefined, 'timestamp_invalid', 'transactions[0].shipped_timestamp'],
    ['created after updated', receipt({ created_timestamp: 1_758_000_501, create_timestamp: 1_758_000_501 }), undefined, 'created_after_updated', 'updated_timestamp'],
    ['transactions not a list', receipt({ transactions: { 0: transaction() } }), undefined, 'transactions_invalid', 'transactions'],
    ['a transaction that is not an object', receipt({ transactions: [null] }), undefined, 'transactions_invalid', 'transactions[0]'],
    ['is_paid with no transactions', receipt({ status: 'open', is_paid: true, transactions: [] }), undefined, 'paid_without_transactions', 'transactions'],
    ['status paid with transactions absent', receipt({ is_paid: false, transactions: undefined }), undefined, 'paid_without_transactions', 'transactions'],
    ['status completed with no transactions', receipt({ status: 'completed', transactions: [] }), undefined, 'paid_without_transactions', 'transactions'],
    ['a line from another receipt', receipt({ transactions: [transaction({ receipt_id: 42 })] }), undefined, 'transaction_receipt_mismatch', 'transactions[0].receipt_id'],
    ['a line that names no receipt', receipt({ transactions: [transaction({ receipt_id: undefined })] }), undefined, 'transaction_receipt_mismatch', 'transactions[0].receipt_id'],
    ['a duplicated transaction', receipt({ transactions: [transaction(), transaction()] }), undefined, 'duplicate_transaction', 'transactions[1].transaction_id'],
    ['quantity -1', receipt({ transactions: [transaction({ quantity: -1 })] }), undefined, 'quantity_invalid', 'transactions[0].quantity'],
    ['quantity 1.5', receipt({ transactions: [transaction({ quantity: 1.5 })] }), undefined, 'quantity_invalid', 'transactions[0].quantity'],
    ['quantity as a string', receipt({ transactions: [transaction({ quantity: '2' })] }), undefined, 'quantity_invalid', 'transactions[0].quantity'],
    ['quantity above Etsy\'s 999', receipt({ transactions: [transaction({ quantity: ETSY_MAX_LINE_QUANTITY + 1 })] }), undefined, 'quantity_invalid', 'transactions[0].quantity'],
    ['quantity missing', receipt({ transactions: [transaction({ quantity: undefined })] }), undefined, 'quantity_invalid', 'transactions[0].quantity'],
    ['a line with no price', receipt({ transactions: [transaction({ price: undefined })] }), undefined, 'money_missing', 'transactions[0].price'],
  ])('refuses %s', (_name, input, b, code, path) => {
    expect(refusalOf(input, b ?? binding)).toMatchObject({ code, path })
  })

  it('keeps a quantity-0 line (the schema allows it), flagged and never eligible for stock', () => {
    const r = receiptOf(receipt({ total_price: undefined, transactions: [transaction({ quantity: 0 }), transaction({ transaction_id: 9002 })] }))
    expect(r.lines.map((line) => [line.transactionId, line.quantity, line.stockEligible, line.lineTotal])).toEqual([['9001', 0, false, '0.00'], ['9002', 2, true, '39.98']])
    expect(r.checks.zeroQuantityLines).toEqual(['9001'])
  })

  it('reads listing_id 0 (the schema allows it) as no listing', () => {
    expect(receiptOf(receipt({ transactions: [transaction({ listing_id: 0 })] })).lines[0].listingId).toBeNull()
  })

  it.each([['Paid', 'paid', 'PROCESSING'], ['Completed', 'completed', 'SHIPPED'], ['  Canceled ', 'canceled', 'CANCELLED'], ['PAYMENT PROCESSING', 'payment processing', 'AWAITING_PAYMENT'], ['Fully Refunded', 'fully refunded', 'REFUNDED']])(
    'reads Etsy\'s status without regard to case or surrounding space: %j', (raw, etsyStatus, status) => {
      const r = receiptOf(receipt({ status: raw, ...(etsyStatus === 'completed' || etsyStatus === 'fully refunded' ? { is_shipped: true } : {}) }))
      expect(r).toMatchObject({ etsyStatus, etsyStatusRaw: raw, status })
    })

  it('accepts the upper quantity bound itself', () => {
    expect(receiptOf(receipt({ total_price: undefined, transactions: [transaction({ quantity: ETSY_MAX_LINE_QUANTITY })] })).lines[0].quantity).toBe(999)
  })

  it('accepts an event that named the account\'s own shop and this receipt', () => {
    expect(receiptOf(receipt(), { ...binding, claimedShopId: SHOP, expectedReceiptId: String(RECEIPT) }).receiptId).toBe(String(RECEIPT))
  })

  it('never puts buyer data into a refusal message', () => {
    const refusal = refusalOf(receipt({ seller_user_id: 42, buyer_email: 'secret@example.test', name: 'Secret Name' }))
    expect(refusal.message).not.toMatch(/secret/i)
  })
})

describe('Etsy status → Nexus status', () => {
  const lines = (...shipped: Array<number | null>) => shipped.map((shippedAt) => ({ shippedAt }))
  it.each<[string, boolean, Array<number | null>, OrderStatus]>([
    ['open', false, [], 'AWAITING_PAYMENT'],
    ['payment processing', false, [null], 'AWAITING_PAYMENT'],
    ['paid', false, [null, null], 'PROCESSING'],
    ['paid', false, [1_758_000_900, null], 'PARTIALLY_SHIPPED'],
    ['paid', false, [1_758_000_900, 1_758_000_900], 'SHIPPED'],
    ['paid', true, [null], 'SHIPPED'],
    ['completed', false, [null], 'SHIPPED'],
    ['completed', true, [1_758_000_900], 'SHIPPED'],
    ['canceled', false, [null], 'CANCELLED'],
    ['canceled', true, [1_758_000_900], 'CANCELLED'],
    ['fully refunded', true, [1_758_000_900], 'REFUNDED'],
    ['partially refunded', false, [null], 'PROCESSING'],
    ['partially refunded', false, [1_758_000_900, null], 'PARTIALLY_SHIPPED'],
    ['partially refunded', true, [null], 'SHIPPED'],
  ])('%s (is_shipped=%s, lines shipped %j) → %s', (status, isShipped, shipped, expected) => {
    expect(mapEtsyStatus(status as (typeof ETSY_RECEIPT_STATUSES)[number], isShipped, lines(...shipped))).toBe(expected)
  })

  it('maps through the whole receipt, including per-line shipped times', () => {
    const r = receiptOf(receipt({ transactions: [transaction({ transaction_id: 1, shipped_timestamp: 1_758_000_900 }), transaction({ transaction_id: 2 })], total_price: undefined }))
    expect(r.status).toBe('PARTIALLY_SHIPPED')
    expect(r.checks.shippedLines).toBe(1)
  })

  it('knows exactly Etsy\'s seven documented statuses', () => {
    expect([...ETSY_RECEIPT_STATUSES].sort()).toEqual(['canceled', 'completed', 'fully refunded', 'open', 'paid', 'partially refunded', 'payment processing'])
  })
})

describe('mergeStatus — a stored status never regresses', () => {
  const ALL: OrderStatus[] = ['PENDING', 'AWAITING_PAYMENT', 'PROCESSING', 'ON_HOLD', 'PARTIALLY_SHIPPED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED', 'REFUNDED']
  const S: Record<string, OrderStatus> = { PE: 'PENDING', AW: 'AWAITING_PAYMENT', PR: 'PROCESSING', OH: 'ON_HOLD', PS: 'PARTIALLY_SHIPPED', SH: 'SHIPPED', DE: 'DELIVERED', RT: 'RETURNED', CA: 'CANCELLED', RF: 'REFUNDED' }
  // Row = stored status, column = incoming status (same order as ALL), cell = what is stored after.
  // Written out by hand, not derived from the rank table, so a wrong rank cannot agree with itself.
  const EXPECTED: Record<string, string> = {
    PE: 'PE AW PR OH PS SH DE RT CA RF',
    AW: 'AW AW PR OH PS SH DE RT CA RF',
    PR: 'PR PR PR PR PS SH DE RT CA RF',
    OH: 'OH OH OH OH PS SH DE RT CA RF',
    PS: 'PS PS PS PS PS SH DE RT CA RF',
    SH: 'SH SH SH SH SH SH DE RT CA RF',
    DE: 'DE DE DE DE DE DE DE RT CA RF',
    RT: 'RT RT RT RT RT RT RT RT CA RF',
    CA: 'CA CA CA CA CA CA CA CA CA RF',
    RF: 'RF RF RF RF RF RF RF RF RF RF',
  }
  it.each(Object.keys(EXPECTED))('stored %s, every incoming status', (row) => {
    const expected = EXPECTED[row].split(' ').map((cell) => S[cell])
    expect(ALL.map((incoming) => mergeStatus(S[row], incoming))).toEqual(expected)
  })

  it('names the headline case: SHIPPED never goes back to PROCESSING, CANCELLED never reopens', () => {
    expect(mergeStatus('SHIPPED', 'PROCESSING')).toBe('SHIPPED')
    expect(mergeStatus('CANCELLED', 'PROCESSING')).toBe('CANCELLED')
    expect(mergeStatus('PROCESSING', 'SHIPPED')).toBe('SHIPPED')
  })

  it('takes the incoming status for an order not stored yet', () => {
    for (const status of ALL) {
      expect(mergeStatus(null, status)).toBe(status)
      expect(mergeStatus(undefined, status)).toBe(status)
    }
  })

  it('agrees with the O.7 terminal guard wherever that guard says "keep what is stored"', () => {
    for (const existing of ALL) for (const incoming of ALL) {
      if (shouldPreserveTerminalStatus(existing, incoming)) expect(mergeStatus(existing, incoming)).toBe(existing)
    }
  })

  it('covers every value of the OrderStatus enum', async () => {
    const { OrderStatus: Enum } = await import('@prisma/client')
    expect(Object.values(Enum).sort()).toEqual([...ALL].sort())
  })
})
