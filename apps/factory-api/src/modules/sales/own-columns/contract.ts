import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { OWN_COLUMN_KINDS, OWN_COLUMN_LIMITS } from '@nexus/factory-domain/sales/own-columns/rules'
import { getRequestContract } from '../portal-ordering/contract'
import { ownColumn, ownValue, recordOwnColumns } from './schemas'

/**
 * The customer's own columns (owb- order workflow, S1 po1.4; the S1 build's FIXED Shape "OWN COLUMNS"). Names and values are the
 * customer's own words: never a price, never a person. A NUMBER value is decimal text ("12.5"), a DATE 'YYYY-MM-DD'.
 */

const version = z.number().int().min(1)

const columnBody = {
  name: z.string().trim().min(1).max(OWN_COLUMN_LIMITS.name),
  kind: z.enum(OWN_COLUMN_KINDS),
  choices: z.array(z.string().trim().min(1).max(OWN_COLUMN_LIMITS.choice)).max(OWN_COLUMN_LIMITS.choicesMax).nullish(),
}
const useBody = { columnIds: z.array(id()).max(OWN_COLUMN_LIMITS.perRecord + 1), dropValues: z.boolean().optional() }
const valueBody = input({
  line: input({ kind: z.enum(['REQUEST_LINE', 'ORDER_LINE']), id: id() }),
  columnId: id(),
  value: z.union([z.string().max(OWN_COLUMN_LIMITS.text + 100), z.number(), z.boolean()]).nullable(),
  version: version.optional(),
})
const columnParams = input({ columnId: id() })
const columns = output({ columns: z.array(ownColumn) })

export const portalColumnsContract = defineContract({ response: { 200: columns } })
export const portalNewColumnContract = defineContract({ body: input(columnBody), response: { 201: ownColumn } })
export const closeColumnContract = defineContract({ params: columnParams, body: input({ version }), response: { 200: ownColumn } })
export const requestColumnsContract = defineContract({ params: input({ requestId: id() }), body: input({ version, ...useBody }), response: getRequestContract.response })
export const orderColumnsContract = defineContract({ params: input({ orderId: id() }), body: input(useBody), response: { 200: output({ ownColumns: recordOwnColumns }) } })
export const valueContract = defineContract({ body: valueBody, response: { 200: ownValue } })

// The office's twins (the same bodies and answers; the customer named by the query or the body, or by the record).
export const officeColumnsContract = defineContract({ querystring: input({ partyId: id() }), response: { 200: columns } })
export const officeNewColumnContract = defineContract({ body: input({ partyId: id(), ...columnBody }), response: { 201: ownColumn } })
