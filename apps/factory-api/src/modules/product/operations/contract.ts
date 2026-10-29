import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { createOperationBody, listOperationsQuery, operationRow, operationStatusBody, operationView, updateOperationBody } from '@nexus/factory-domain/product/routing/contracts'

/** The operation library routes' contracts (A2 SCR-049): the bodies and answers are factory-domain's product/routing/contracts. No money. */

const one = { 200: output({ operation: operationView }) }
const operation = input({ operationId: id() })

export const listOperationsContract = defineContract({
  querystring: listOperationsQuery,
  response: { 200: output({ operations: z.array(operationRow), nextCursor: z.string().nullable(), count: z.number().int() }) },
})
export const getOperationContract = defineContract({ params: operation, response: one })
export const createOperationContract = defineContract({ body: createOperationBody, response: { 201: output({ operation: operationView }) } })
export const updateOperationContract = defineContract({ params: operation, body: updateOperationBody, response: one })
export const archiveOperationContract = defineContract({ params: operation, body: operationStatusBody, response: one })
export const reactivateOperationContract = defineContract({ params: operation, body: operationStatusBody, response: one })
