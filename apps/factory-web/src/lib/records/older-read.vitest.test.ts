import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { olderRead } from './older-read'

/**
 * fx-10 / fx-11 (end check): a record page never goes back to an older read of its record. GitHub run 44446419997's browser flow
 * (08-buy): the purchase order page's live re-read left 8 ms after line 10's save, read version 2 and answered after the save's
 * version 3; line 20's save then sent version 2 and was refused (409). Every record page with the same live re-read (an event →
 * the record read again) and a version in its answer applies the one rule where that read lands.
 */

const AREAS = fileURLToPath(new URL('../../areas/', import.meta.url))
const read = (path: string) => readFileSync(join(AREAS, path), 'utf8')
const IMPORT = /import \{ olderRead \} from '(\.\.\/)+lib\/records\/older-read'/

/** The pages whose record re-read goes through `setValue` (it answers false for an older read, and the read stops there). */
const THROUGH_SET_VALUE: ReadonlyArray<{ page: string; type: string; read: string }> = [
  { page: 'purchasing/orders/record/OrderRecord.tsx', type: 'PurchaseOrder', read: 'getOrder(api, orderId)' },
  { page: 'purchasing/subcontracting/record/SubcontractRecord.tsx', type: 'SubcontractOrder', read: 'getOrder(api, orderId)' },
  { page: 'production/work-orders/record/WorkOrderRecord.tsx', type: 'WorkOrder', read: 'getWorkOrder(api, workOrderId)' },
  { page: 'finance/invoices/record/InvoiceRecord.tsx', type: 'Invoice', read: 'getInvoice(api, invoiceId)' },
  { page: 'finance/payables/record/SupplierInvoiceRecord.tsx', type: 'SupplierInvoice', read: 'getInvoice(api, invoiceId)' },
  { page: 'warehouse/shipments/record/ShipmentRecord.tsx', type: 'Shipment', read: 'getShipment(api, shipmentId)' },
  { page: 'sales/orders/record/OrderRecord.tsx', type: 'Order', read: 'getOrder(api, orderId)' },
]

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The pages that take their record read in place (the held record is the state's own, or the page's ref): where it lands. */
const IN_PLACE: ReadonlyArray<{ page: string; lands: RegExp }> = [
  { page: 'finance/payments/record/PaymentRecord.tsx', lands: /const next = await getPayment\(api, paymentId\)[\s\S]{0,400}?if \(olderRead\(current\.current, next\)\) return\s+current\.current = next/ },
  { page: 'purchasing/claims/record/ClaimRecord.tsx', lands: /const next = await getClaim\(api, claimId\)[\s\S]{0,400}?setClaim\(\(held\) => \(held\.status === 'ready' && olderRead\(held\.value, next\) \? held : \{ status: 'ready', value: next \}\)\)/ },
  { page: 'production/cutting/orders/record/CutOrderRecord.tsx', lands: /const value = await getCutOrder\(api, cutOrderId\)[\s\S]{0,400}?setRecord\(\(held\) => \(held\.value && olderRead\(held\.value\.cutOrder, value\.cutOrder\) \? held : \{ status: 'ready', value, problem: null \}\)\)/ },
  { page: 'warehouse/counts/record/CountRecord.tsx', lands: /const next = await countRecord\(api, countId\)[\s\S]{0,400}?setRecord\(\(held\) => \(held\.status === 'ready' && olderRead\(held\.value, next\) \? held : \{ status: 'ready', value: next \}\)\)/ },
  { page: 'warehouse/receipts/record/ReceiptRecord.tsx', lands: /const takeRead = useCallback\(\(next: Receipt\) => setReceipt\(\(held\) => \(held\.status === 'ready' && olderRead\(held\.value, next\) \? held : \{ status: 'ready', value: next \}\)\), \[\]\)/ },
  // The customer's record (and the supplier's: one shared hook) reads the party here.
  { page: 'parties/_shared/PartyRecord.tsx', lands: /const next = await getParty\(api, partyId\)[\s\S]{0,400}?setParty\(\(held\) => \(olderRead\(held, next\) \? held : next\)\)/ },
]

/** The pages with the same live re-read whose answer carries no record version (a list, a board, counts): nothing to keep. */
const NO_RECORD_VERSION: Readonly<Record<string, string>> = {
  'admin/privacy/requests/DataRequests.tsx': 'a list of requests',
  'admin/privacy/requests/DepthDuties.tsx': 'two counts',
  'admin/privacy/retention/RetentionRules.tsx': 'a list of rules',
  'admin/security/SecurityPage.tsx': 'the security facts and a list of roles',
  'planning/allocation/AllocationPage.tsx': 'a board, set only by its reads (the newest read asked wins)',
  'planning/capacity/CapacityPage.tsx': 'a board (the newest read asked wins)',
  'planning/exceptions/ExceptionsPage.tsx': 'a list (the newest read asked wins)',
  'planning/milestones/MilestonesPage.tsx': 'a list (the newest read asked wins)',
  'planning/mrp/PlanPage.tsx': 'the latest plan run and its lines (the newest read asked wins)',
  'plant/requests/RequestsPage.tsx': 'a list (the newest read asked wins)',
  'production/dispatch/DispatchPage.tsx': "a day's board, set only by its reads (the newest read asked wins)",
  'production/reports/ReportsPage.tsx': 'a daily report, read only',
  'production/wip/FloorNowPage.tsx': 'counts and lists',
  'warehouse/receipts/inbound/InboundBoard.tsx': 'a board (the newest read asked wins)',
  'warehouse/shipments/list/ShipmentsPage.tsx': 'lists (the newest read asked wins)',
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.test.') ? [path] : []
  })
}

describe('fx-11: a record page never goes back to an older read of its record', () => {
  it('an older version of the same record is an older read; the same or a newer version, another record or none is not', () => {
    const held = { id: 'po-1', version: 3 }
    expect(olderRead(held, { id: 'po-1', version: 2 })).toBe(true)
    expect(olderRead(held, { id: 'po-1', version: 3 })).toBe(false)
    expect(olderRead(held, { id: 'po-1', version: 4 })).toBe(false)
    expect(olderRead(held, { id: 'po-2', version: 1 })).toBe(false)
    expect(olderRead(null, { id: 'po-1', version: 1 })).toBe(false)
    expect(olderRead(undefined, { id: 'po-1', version: 1 })).toBe(false)
  })

  it('is one rule: no page or area keeps its own copy', () => {
    const copies = sources(fileURLToPath(new URL('../../', import.meta.url))).filter((path) => /function olderRead\b/.test(readFileSync(path, 'utf8')))
    expect(copies.map((path) => relative(fileURLToPath(new URL('../../', import.meta.url)), path))).toEqual(['lib/records/older-read.ts'])
  })

  for (const { page, type, read: readCall } of THROUGH_SET_VALUE) {
    it(`${page} drops such a read: it keeps the write’s answer and sends its version`, () => {
      const container = read(page)
      expect(container).toMatch(IMPORT)
      const setValue = new RegExp(`const setValue = useCallback\\(\\(next: ${type}\\): boolean => \\{([\\s\\S]*?)\\n {2}\\}, \\[\\]\\)`).exec(container)?.[1] ?? ''
      expect(setValue).toMatch(/if \(olderRead\(current\.current, next\)\) return false[\s\S]*current\.current = next/)
      // The page's own re-read stops there: no "changed" cleared, no parts read again for a record it did not take.
      expect(container).toMatch(new RegExp(`const next = await ${escape(readCall)}\\s+if \\(!setValue\\(next\\)\\) return`))
    })
  }

  for (const { page, lands } of IN_PLACE) {
    it(`${page} drops such a read where its record read lands`, () => {
      const container = read(page)
      expect(container).toMatch(IMPORT)
      expect(container).toMatch(lands)
    })
  }

  it('the receipt page takes both of its record reads through the rule', () => {
    const container = read('warehouse/receipts/record/ReceiptRecord.tsx')
    expect(container.match(/takeRead\(await getReceipt\(api, receiptId\)\)/g)).toHaveLength(2)
    expect(container).not.toMatch(/setReceipt\(\{ status: 'ready', value: await getReceipt\(/)
  })

  it('every page with a live re-read of its record is listed: it applies the rule, or its answer carries no record version', () => {
    const listed = new Set([...THROUGH_SET_VALUE.map((entry) => entry.page), ...IN_PLACE.map((entry) => entry.page), ...Object.keys(NO_RECORD_VERSION)])
    const live = sources(AREAS)
      .filter((path) => readFileSync(path, 'utf8').includes('useCoalesced(() => void load()'))
      .map((path) => relative(AREAS, path))
    expect(live.filter((page) => !listed.has(page))).toEqual([])
    // A page left out still has the pattern (else it leaves the list).
    for (const page of Object.keys(NO_RECORD_VERSION)) expect(live).toContain(page)
  })
})
