import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { keepBody, keepView } from '@nexus/factory-domain/costing/keep/contracts'

/** owb-pd3: POST /costing/styles/:styleId/revisions/:revisionId/keep — the answer is the view itself (web B's Keep window reads it so). */
export const keepContract = defineContract({
  params: input({ styleId: id(), revisionId: id() }),
  body: keepBody,
  response: { 200: keepView },
})
