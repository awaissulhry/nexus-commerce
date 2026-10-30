import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  activateContract,
  compareContract,
  createListContract,
  customersContract,
  deleteVersionContract,
  editVersionContract,
  getListContract,
  getVersionContract,
  listListsContract,
  moveListContract,
  nextVersionContract,
  setPricesContract,
  updateListContract,
} from './contract'
import { createList, getList, listLists, moveList, setCustomers, updateList } from './lists'
import { manifest } from './manifest'
import { activateVersion, compareVersions, deleteVersion, editVersion, getVersion, nextVersion, setPrices } from './versions'

/**
 * Customer price lists (B-W2a-19; SAL-165; design sales.pricelists): the lists with their state and tiles, one list with
 * its versions, customers and the lists that fall back to it; a new list (its first DRAFT version), an edit, archive,
 * reactivate; its customers; its versions: make the next one (prices copied), edit a draft's days or an active one's
 * end, delete a draft, set a draft's prices, activate it from a day (the one before ends the day before), compare two.
 * A quote line reads its list price through the customer's list (modules/sales/quotes lines.ts).
 */
export default defineRoutes('sales.pricelists', manifest, async (app) => {
  app.get('/sales/price-lists', { schema: listListsContract }, async (request) => listLists(request, request.query))

  app.get('/sales/price-lists/:listId', { schema: getListContract }, async (request) => getList(request, request.params.listId))

  app.post('/sales/price-lists', { schema: createListContract }, async (request, reply) => reply.code(201).send(await createList(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/sales/price-lists/:listId', { schema: updateListContract }, async (request) => updateList(request, request.params.listId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/price-lists/:listId/archive', { schema: moveListContract }, async (request) => moveList(request, request.params.listId, 'archive', request.body, idempotencyKeyFrom(request)))

  app.post('/sales/price-lists/:listId/reactivate', { schema: moveListContract }, async (request) => moveList(request, request.params.listId, 'reactivate', request.body, idempotencyKeyFrom(request)))

  app.post('/sales/price-lists/:listId/customers', { schema: customersContract }, async (request) => setCustomers(request, request.params.listId, 'add', request.body, idempotencyKeyFrom(request)))

  app.post('/sales/price-lists/:listId/customers/remove', { schema: customersContract }, async (request) => setCustomers(request, request.params.listId, 'remove', request.body, idempotencyKeyFrom(request)))

  app.post('/sales/price-lists/:listId/versions', { schema: nextVersionContract }, async (request, reply) => reply.code(201).send(await nextVersion(request, request.params.listId, request.body, idempotencyKeyFrom(request))))

  app.get('/sales/price-lists/:listId/versions/:versionId', { schema: getVersionContract }, async (request) => getVersion(request, request.params.listId, request.params.versionId))

  app.patch('/sales/price-lists/:listId/versions/:versionId', { schema: editVersionContract }, async (request) => editVersion(request, request.params.listId, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.delete('/sales/price-lists/:listId/versions/:versionId', { schema: deleteVersionContract }, async (request) => deleteVersion(request, request.params.listId, request.params.versionId, request.query, idempotencyKeyFrom(request)))

  app.put('/sales/price-lists/:listId/versions/:versionId/entries', { schema: setPricesContract }, async (request) => setPrices(request, request.params.listId, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/price-lists/:listId/versions/:versionId/activate', { schema: activateContract }, async (request) => activateVersion(request, request.params.listId, request.params.versionId, request.body, idempotencyKeyFrom(request)))

  app.get('/sales/price-lists/:listId/versions/:versionId/compare', { schema: compareContract }, async (request) => compareVersions(request, request.params.listId, request.params.versionId, request.query.with))
})
