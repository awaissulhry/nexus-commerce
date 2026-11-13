import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { checkOptions } from './check'
import {
  addEffectContract,
  addValueContract,
  checkContract,
  createGroupContract,
  getGroupContract,
  groupStatusContract,
  lineOptionContract,
  listGroupsContract,
  offerContract,
  removeEffectContract,
  setPriceContract,
  setRulesContract,
  styleOptionsContract,
  updateEffectContract,
  updateGroupContract,
  updateValueContract,
  valueStatusContract,
  withdrawContract,
} from './contract'
import { addEffect, removeEffect, setPrice, updateEffect } from './effects'
import { createGroup, getGroup, listGroups, moveGroup, updateGroup } from './groups'
import { setLineOption } from './lines'
import { manifest } from './manifest'
import { offerGroup, readStyleOptions, withdrawOffer } from './offers'
import { setRules } from './rule-set'
import { addValue, moveValue, updateValue } from './values'
// B-W2b-374 (XF3:05): OptionGroup.takes.
import { defineContract } from '@nexus/factory-domain/core/contracts'
import { takesBody, takesParams, takesView } from '@nexus/factory-domain/product/options/takes'
import { readTakes, setTakes } from './takes'

/**
 * Options and configuration rules (B-W2b-229; PRD-081, PRD-206, PRD-207, PRD-208, PRD-211; design products.options SCR-114,
 * screens B-W2b-242): the option library (groups, values with free-text rules, requires and excludes rules, effects and the
 * price surcharge), the styles that offer a group, a draft BOM line only for an option, and THE check of a choice of options
 * W2b-5's configurator calls (./check.ts checkStyleOptions).
 */
export default defineRoutes('product.options', manifest, async (app) => {
  const key = idempotencyKeyFrom
  app.get('/product/option-groups', { schema: listGroupsContract }, async (request) => listGroups(request, request.query))
  app.get('/product/option-groups/:groupId', { schema: getGroupContract }, async (request) => ({ group: await getGroup(request, request.params.groupId) }))
  app.post('/product/option-groups', { schema: createGroupContract }, async (request, reply) => reply.code(201).send({ group: await createGroup(request, request.body, key(request)) }))
  app.patch('/product/option-groups/:groupId', { schema: updateGroupContract }, async (request) => ({ group: await updateGroup(request, request.params.groupId, request.body, key(request)) }))
  app.post('/product/option-groups/:groupId/archive', { schema: groupStatusContract }, async (request) => ({ group: await moveGroup(request, request.params.groupId, 'archive', request.body, key(request)) }))
  app.post('/product/option-groups/:groupId/restore', { schema: groupStatusContract }, async (request) => ({ group: await moveGroup(request, request.params.groupId, 'restore', request.body, key(request)) }))

  app.post('/product/option-groups/:groupId/values', { schema: addValueContract }, async (request, reply) => reply.code(201).send({ group: await addValue(request, request.params.groupId, request.body, key(request)) }))
  app.patch('/product/option-groups/:groupId/values/:valueId', { schema: updateValueContract }, async (request) => ({
    group: await updateValue(request, request.params.groupId, request.params.valueId, request.body, key(request)),
  }))
  app.post('/product/option-groups/:groupId/values/:valueId/archive', { schema: valueStatusContract }, async (request) => ({
    group: await moveValue(request, request.params.groupId, request.params.valueId, 'archive', request.body, key(request)),
  }))
  app.post('/product/option-groups/:groupId/values/:valueId/restore', { schema: valueStatusContract }, async (request) => ({
    group: await moveValue(request, request.params.groupId, request.params.valueId, 'restore', request.body, key(request)),
  }))

  app.put('/product/option-groups/:groupId/rules', { schema: setRulesContract }, async (request) => ({ group: await setRules(request, request.params.groupId, request.body, key(request)) }))

  app.post('/product/option-groups/:groupId/values/:valueId/effects', { schema: addEffectContract }, async (request, reply) =>
    reply.code(201).send({ group: await addEffect(request, request.params.groupId, request.params.valueId, request.body, key(request)) }),
  )
  app.patch('/product/option-groups/:groupId/values/:valueId/effects/:effectId', { schema: updateEffectContract }, async (request) => ({
    group: await updateEffect(request, request.params.groupId, request.params.valueId, request.params.effectId, request.body, key(request)),
  }))
  app.delete('/product/option-groups/:groupId/values/:valueId/effects/:effectId', { schema: removeEffectContract }, async (request) => ({
    group: await removeEffect(request, request.params.groupId, request.params.valueId, request.params.effectId, request.query.version, key(request)),
  }))
  app.put('/product/option-groups/:groupId/values/:valueId/price', { schema: setPriceContract }, async (request) => ({
    group: await setPrice(request, request.params.groupId, request.params.valueId, request.body, key(request)),
  }))

  app.get('/product/styles/:styleId/options', { schema: styleOptionsContract }, async (request) => ({ options: await readStyleOptions(request, request.params.styleId) }))
  app.put('/product/styles/:styleId/options/:groupId', { schema: offerContract }, async (request) => ({ options: await offerGroup(request, request.params.styleId, request.params.groupId, request.body, key(request)) }))
  app.post('/product/styles/:styleId/options/:groupId/withdraw', { schema: withdrawContract }, async (request) => withdrawOffer(request, request.params.styleId, request.params.groupId, request.body, key(request)))
  app.post('/product/styles/:styleId/options/check', { schema: checkContract }, async (request) => ({ check: await checkOptions(request, request.params.styleId, request.body) }))

  app.put('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/option', { schema: lineOptionContract }, async (request) =>
    setLineOption(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.body, key(request)),
  )
  // B-W2b-374 (XF3:05)
  app.get('/product/option-groups/:groupId/takes', { schema: defineContract({ params: takesParams, response: { 200: takesView } }) }, async (request) => readTakes(request, request.params.groupId))
  app.put('/product/option-groups/:groupId/takes', { schema: defineContract({ params: takesParams, body: takesBody, response: { 200: takesView } }) }, async (request) => setTakes(request, request.params.groupId, request.body, key(request)))
})
