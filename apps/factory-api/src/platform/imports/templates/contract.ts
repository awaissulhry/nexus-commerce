import { z } from 'zod'
import { defineContract, input } from '@nexus/factory-domain/core/contracts'
import { NUMBER_FORMATS } from '@nexus/factory-domain/imports/cells'

/** GET /imports/importers/:importerKey/template (B-W2a-41; PLT-177): a file (CSV or Excel), no JSON body. */
export const templateContract = defineContract({
  params: input({ importerKey: z.string().min(3).max(100).regex(/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/) }),
  querystring: input({ format: z.enum(['csv', 'xlsx']).optional(), numberFormat: z.enum(NUMBER_FORMATS).optional() }),
  response: {},
})
