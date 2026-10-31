import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { createViewContract, deleteViewContract, getViewContract, listViewsContract, updateViewContract } from './contract'
import { manifest } from './manifest'
import { createView, getView, listViews, removeView, updateView } from './views'
// B-W2b-13: bulk edit with preview and inline edit (the autoloader loads only this folder's routes file).
import { applyBulk, previewBulk } from './bulk/bulk'
import { applyBulkContract, previewBulkContract } from './bulk/contract'
// B-W2b-24 (Z12:07): my default view of a list.
import { clearPersonalDefaultContract, setPersonalDefaultContract } from './defaults/contract'
import { clearPersonalDefault, setPersonalDefault } from './defaults/defaults'

/**
 * Saved views of the Office's lists (B-W2a-23; PLT-163; design shell.lists):
 *   GET    /views?listKey=   the reader's views of one list, the one it opens on, the roles to share with, the export
 *   POST   /views            a new view (views.save; everyone / a role's default: views.manage)
 *   GET    /views/:id        one view the reader sees (a shared link)
 *   PATCH  /views/:id        its name, sharing or what it keeps
 *   DELETE /views/:id        removed (?version=)
 *   POST   /views/bulk/preview   B-W2b-13: old → new per selected row, or why not (nothing written)
 *   POST   /views/bulk/apply     B-W2b-13: each row through its record's own command (bulk edit, Undo, one cell)
 *   PUT    /views/:id/personal-default   B-W2b-24: my default view of the list (my own view; the old default loses it)
 *   DELETE /views/:id/personal-default   B-W2b-24: no longer my default (?version=)
 */
export default defineRoutes('views', manifest, async (app) => {
  app.get('/views', { schema: listViewsContract }, async (request) => listViews(request, request.query.listKey))
  app.post('/views', { schema: createViewContract }, async (request, reply) => reply.code(201).send({ view: await createView(request, request.body, idempotencyKeyFrom(request)) }))
  app.get('/views/:viewId', { schema: getViewContract }, async (request) => getView(request, request.params.viewId))
  app.patch('/views/:viewId', { schema: updateViewContract }, async (request) => ({ view: await updateView(request, request.params.viewId, request.body, idempotencyKeyFrom(request)) }))
  app.delete('/views/:viewId', { schema: deleteViewContract }, async (request) => removeView(request, request.params.viewId, request.query.version, idempotencyKeyFrom(request)))
  // B-W2b-13
  app.post('/views/bulk/preview', { schema: previewBulkContract }, async (request) => previewBulk(request, request.body))
  app.post('/views/bulk/apply', { schema: applyBulkContract }, async (request) => applyBulk(request, request.body, idempotencyKeyFrom(request)))
  // B-W2b-24 (Z12:07): my default view of a list.
  app.put('/views/:viewId/personal-default', { schema: setPersonalDefaultContract }, async (request) => setPersonalDefault(request, request.params.viewId, request.body.version, idempotencyKeyFrom(request)))
  app.delete('/views/:viewId/personal-default', { schema: clearPersonalDefaultContract }, async (request) => clearPersonalDefault(request, request.params.viewId, request.query.version, idempotencyKeyFrom(request)))
})
