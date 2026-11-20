/**
 * B-OO-012 (order overview §6; review F5; Owner D8): ONE rule for how many records a sales order links to. The order page's tab
 * badges (Production, Shipments, Money) and its Linked records card both call it, so a badge and the card never disagree; the API
 * keeps no count of its own.
 *
 *   live only    every number counts the records that still stand; what was cancelled is counted apart (`cancelled`) and said
 *                in words by the caller ("· 1 cancelled"), never added in
 *   work orders  live = every one not CANCELLED, split into in work (RELEASED, IN_PROGRESS) · draft (DRAFT) · on hold (ON_HOLD) ·
 *                done (COMPLETED, CLOSED)
 *   shipments    live = every one not CANCELLED (a returned one stands: it shipped); lastDdt = the newest DDT of a live shipment —
 *                Nexus's own, or the paper one of a shipment made elsewhere (the newest by date; on the same day, the later in
 *                the chain)
 *   invoices     issued = every one past DRAFT (whatever SdI answered since: the number the Money badge always showed), and of
 *                them the credit notes (TD04) and the deposit invoices (TD02); drafts apart. An invoice is never cancelled: a
 *                credit note undoes it
 *   deposits     the deposit requests still OPEN; those CANCELLED apart
 *
 * Structural: the API's order read (`chain`) and the web's schema of it both fit. Pure.
 */

/** A delivery note as the order read names it: its number and its day. */
export interface DdtRef {
  readonly number: string
  readonly date: string
}

/** What the count reads of an order's record chain (the order read's `chain`; any extra field is ignored). */
export interface LinkChain {
  readonly workOrders: readonly { readonly status: string }[]
  readonly shipments: readonly {
    readonly id: string
    readonly status: string
    /** Nexus's live DDT of the shipment (null: none yet, or cancelled). */
    readonly ddt?: DdtRef | null | undefined
    /** The paper DDT of a shipment made elsewhere (null: none). */
    readonly externalDdt?: DdtRef | null | undefined
  }[]
  readonly invoices: readonly { readonly status: string; readonly docType: string }[]
  readonly depositRequests: readonly { readonly status: string }[]
}

export interface OrderLinkCounts {
  readonly workOrders: {
    /** Every work order not cancelled (= inWork + draft + onHold + done for the known states). */
    readonly live: number
    readonly inWork: number
    readonly draft: number
    readonly onHold: number
    readonly done: number
    readonly cancelled: number
  }
  readonly shipments: {
    /** Every shipment not cancelled. */
    readonly live: number
    readonly cancelled: number
    /** The newest DDT of a live shipment, with its shipment and whether it is a paper one (made elsewhere); null: none yet. */
    readonly lastDdt: (DdtRef & { readonly shipmentId: string; readonly external: boolean }) | null
  }
  readonly invoices: {
    /** Every invoice past DRAFT, of every type (credit notes and deposit invoices among them). */
    readonly issued: number
    readonly drafts: number
    /** Issued credit notes (TD04). */
    readonly creditNotes: number
    /** Issued deposit invoices (TD02). */
    readonly deposits: number
  }
  readonly depositRequests: {
    /** Still OPEN (asked, not paid, not waived). */
    readonly open: number
    readonly cancelled: number
  }
}

export const WORK_ORDER_IN_WORK: readonly string[] = Object.freeze(['RELEASED', 'IN_PROGRESS'])
export const WORK_ORDER_DONE: readonly string[] = Object.freeze(['COMPLETED', 'CLOSED'])
export const CREDIT_NOTE_DOC_TYPE = 'TD04'
export const DEPOSIT_INVOICE_DOC_TYPE = 'TD02'

const CANCELLED = 'CANCELLED'
const count = <T>(rows: readonly T[], test: (row: T) => boolean): number => rows.reduce((sum, row) => (test(row) ? sum + 1 : sum), 0)

/** The order's linked records, counted by the one rule (see the module's head). */
export function orderLinkCountsOf(chain: LinkChain): OrderLinkCounts {
  const workOrders = chain.workOrders.filter((row) => row.status !== CANCELLED)
  const shipments = chain.shipments.filter((row) => row.status !== CANCELLED)
  const issued = chain.invoices.filter((row) => row.status !== 'DRAFT')
  let lastDdt: OrderLinkCounts['shipments']['lastDdt'] = null
  for (const shipment of shipments) {
    for (const [ddt, external] of [[shipment.ddt, false], [shipment.externalDdt, true]] as const) {
      // The later in the chain wins a tie: `>=`.
      if (ddt && (lastDdt === null || ddt.date >= lastDdt.date)) lastDdt = { number: ddt.number, date: ddt.date, shipmentId: shipment.id, external }
    }
  }
  return {
    workOrders: {
      live: workOrders.length,
      inWork: count(workOrders, (row) => WORK_ORDER_IN_WORK.includes(row.status)),
      draft: count(workOrders, (row) => row.status === 'DRAFT'),
      onHold: count(workOrders, (row) => row.status === 'ON_HOLD'),
      done: count(workOrders, (row) => WORK_ORDER_DONE.includes(row.status)),
      cancelled: chain.workOrders.length - workOrders.length,
    },
    shipments: { live: shipments.length, cancelled: chain.shipments.length - shipments.length, lastDdt },
    invoices: {
      issued: issued.length,
      drafts: chain.invoices.length - issued.length,
      creditNotes: count(issued, (row) => row.docType === CREDIT_NOTE_DOC_TYPE),
      deposits: count(issued, (row) => row.docType === DEPOSIT_INVOICE_DOC_TYPE),
    },
    depositRequests: {
      open: count(chain.depositRequests, (row) => row.status === 'OPEN'),
      cancelled: count(chain.depositRequests, (row) => row.status === CANCELLED),
    },
  }
}
