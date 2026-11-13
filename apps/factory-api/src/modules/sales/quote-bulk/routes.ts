import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { bulkSizesContract, fillLinesContract, pasteLinesContract } from './contract'
import { fillLines } from './fill'
import { manifest } from './manifest'
import { pasteLines } from './paste'
import { bulkSizes } from './sizes'

/**
 * Quote speed-ups for big size runs (B-W2b-302; SAL-160, SAL-269, QT2:01): paste lines from a sheet, change a size run on many
 * lines at once, fill lines from a size curve or a prepack — each shown first (`preview: true`) and written in one command.
 */
export default defineRoutes('sales.quoteBulk', manifest, async (app) => {
  app.post('/sales/quotes/:quoteId/lines/paste', { schema: pasteLinesContract }, async (request) => pasteLines(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/lines/sizes', { schema: bulkSizesContract }, async (request) => bulkSizes(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/quotes/:quoteId/lines/fill', { schema: fillLinesContract }, async (request) => fillLines(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))
})
