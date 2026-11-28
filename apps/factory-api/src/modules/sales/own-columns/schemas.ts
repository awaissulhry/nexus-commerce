import { z } from 'zod'
import { id, output } from '@nexus/factory-domain/core/contracts'
import { OWN_COLUMN_KINDS } from '@nexus/factory-domain/sales/own-columns/rules'

/**
 * The answer shapes of the customer's own columns (owb- order workflow, S1 po1.4; the S1 build's FIXED Shape), shared by the
 * own-columns routes (./contract.ts), the draft record (../portal-ordering/contract.ts), the portal order record and the sheet
 * (../portal-orders/contract.ts). Schemas only: no import of a contract (no import cycle).
 */

/** OwnColumn: a column of the customer (closed: kept with its values, no new use). */
export const ownColumn = output({ id: id(), name: z.string(), kind: z.enum(OWN_COLUMN_KINDS), choices: z.array(z.string()), closed: z.boolean(), version: z.number().int() })
/** OwnValue: a NUMBER as decimal text ("12.5"), a DATE 'YYYY-MM-DD', a cleared value null. */
export const ownValue = output({ columnId: id(), value: z.union([z.string(), z.number(), z.boolean()]).nullable(), version: z.number().int() })
/** RecordOwnColumns: the columns ON a record in its order, and lineId → columnId → value. */
export const recordOwnColumns = output({ used: z.array(ownColumn), values: z.record(z.string(), z.record(z.string(), ownValue)) })
