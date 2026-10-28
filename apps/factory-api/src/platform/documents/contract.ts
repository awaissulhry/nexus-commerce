import { z } from 'zod'
import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES, DOCUMENT_TYPES } from '@nexus/factory-domain/documents/model'

/**
 * The documents routes' contracts (plan A1 §3.9; GAP-008). The preview answers with the PDF itself (an attachment,
 * stored nowhere); issued documents are stored files, downloaded through the files routes.
 */
export const sampleContract = defineContract({
  querystring: input({
    companyId: id(),
    type: z.enum(DOCUMENT_TYPES),
    language: z.enum(DOCUMENT_LANGUAGES).default('it'),
  }),
  response: {},
})
