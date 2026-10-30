import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { createViewContract, deleteViewContract, getViewContract, listViewsContract, updateViewContract } from './contract'
import { manifest } from './manifest'
import { createView, getView, listViews, removeView, updateView } from './views'

/**
 * Saved views of the Office's lists (B-W2a-23; PLT-163; design shell.lists):
 *   GET    /views?listKey=   the reader's views of one list, the one it opens on, the roles to share with, the export
 *   POST   /views            a new view (views.save; everyone / a role's default: views.manage)
 *   GET    /views/:id        one view the reader sees (a shared link)
 *   PATCH  /views/:id        its name, sharing or what it keeps
 *   DELETE /views/:id        removed (?version=)
 */
export default defineRoutes('views', manifest, async (app) => {
  app.get('/views', { schema: listViewsContract }, async (request) => listViews(request, request.query.listKey))
  app.post('/views', { schema: createViewContract }, async (request, reply) => reply.code(201).send({ view: await createView(request, request.body, idempotencyKeyFrom(request)) }))
  app.get('/views/:viewId', { schema: getViewContract }, async (request) => getView(request, request.params.viewId))
  app.patch('/views/:viewId', { schema: updateViewContract }, async (request) => ({ view: await updateView(request, request.params.viewId, request.body, idempotencyKeyFrom(request)) }))
  app.delete('/views/:viewId', { schema: deleteViewContract }, async (request) => removeView(request, request.params.viewId, request.query.version, idempotencyKeyFrom(request)))
})
