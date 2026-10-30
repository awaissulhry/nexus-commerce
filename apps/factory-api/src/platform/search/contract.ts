import { defineContract } from '@nexus/factory-domain/core/contracts'
import { rebuildAnswer, rebuildBody, searchAnswer, searchQuery } from '@nexus/factory-domain/search/contracts'

/**
 * Global search (B-W2a-32; PLT-153; design shell.search). The shapes are factory-domain's search/contracts, shared with
 * the web (the palette and the All results page check every answer with them).
 */
export const searchContract = defineContract({
  querystring: searchQuery,
  response: { 200: searchAnswer },
})

export const rebuildContract = defineContract({
  body: rebuildBody,
  response: { 202: rebuildAnswer },
})
