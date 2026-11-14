import { integrityAnswer, integrityQuery, integrityRunBody } from '@nexus/factory-domain/accounting/integrity/contracts'
import { defineContract } from '@nexus/factory-domain/core/contracts'

/** The route contracts of the integrity checks (B-W2b-408): the shapes are factory-domain's accounting/integrity/contracts. */

export const integrityContract = defineContract({ querystring: integrityQuery, response: { 200: integrityAnswer } })
export const runIntegrityContract = defineContract({ body: integrityRunBody, response: { 201: integrityAnswer } })
