import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { rebuildContract, searchContract } from './contract'
import { manifest } from './manifest'
import { requestRebuild } from './rebuild-request'
import { searchRecords } from './search'

/**
 * Global search (B-W2a-32; PLT-153; design shell.search):
 *   GET  /search?q=&type=&limit=&offset=   the reader's records by number and name, typos forgiven (./search.ts)
 *   POST /search/rebuild                   the tenant's index read again from its records, by the worker (202)
 * The index itself is written by the worker's handlers (./indexing.ts), one indexer per record type (./indexers/).
 */
export default defineRoutes('search', manifest, async (app) => {
  app.get('/search', { schema: searchContract }, async (request) => searchRecords(request, request.query))
  app.post('/search/rebuild', { schema: rebuildContract }, async (request, reply) => reply.code(202).send(await requestRebuild(request, request.body, idempotencyKeyFrom(request))))
})
