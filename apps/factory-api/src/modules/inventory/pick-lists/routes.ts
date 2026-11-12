import { defineRoutes } from '../../../core/manifest'
import { walkContract, workOrderContract } from './contract'
import { manifest } from './manifest'
import { pickWalk } from './walk'

/**
 * The pick list by bin (B-W2b-298; SCM-212; design floor.pick "need", warehouse.picking pk-list and its PDF): one work order's
 * pick list as one walk through the store, or one walk for several work orders (rule 1). Its PICK task is the warehouse
 * inbox's (modules/inventory/tasks/sources/pick-lists.ts names the walk's first place).
 */
export default defineRoutes('inventory.pick-lists', manifest, async (app) => {
  app.get('/inventory/pick-lists/work-orders/:workOrderId', { schema: workOrderContract }, async (request) => pickWalk(request, [request.params.workOrderId]))

  app.get('/inventory/pick-lists/walk', { schema: walkContract }, async (request) =>
    pickWalk(
      request,
      request.query.workOrderIds
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== ''),
    ),
  )
})
