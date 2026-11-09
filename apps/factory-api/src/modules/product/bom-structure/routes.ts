import { can } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_BOM_VIEW } from '@nexus/factory-domain/product/bom/permissions'
import { idempotencyKeyFrom } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { defineRoutes } from '../../../core/manifest'
import { explosionFor } from '../bom/explode'
import { contextOf, readRevisionFor, readStyleFor } from '../bom/store'
import { checkViewOf, loadStructure } from './check'
import { changeStructureContract, getCheckContract, getExplosionContract, getStructureContract, setLineStructureContract, usedInContract } from './contract'
import { manifest } from './manifest'
import { changeStructure, setLineStructure } from './structure'
import { readTree, structureViewOf, usedInOf } from './views'

/**
 * The structure of a style revision's BOM (product module, B-W2b-223; features PRD-077, PRD-078, PRD-087, PRD-106): sections
 * and group rows, sub-assemblies (a released revision of another style, walked to its deepest level), the BOM check with
 * every problem's cell, the multi-level explosion, and where a style is used as a sub-assembly. W1's BOM routes keep the
 * lines (product/bom); their writes, removal, copy, duplicate and release answer B-W2b-211's rules in words through this
 * module (guards.ts, copy.ts, check.ts).
 */
export default defineRoutes('product.bom-structure', manifest, async (app) => {
  app.get('/product/styles/:styleId/revisions/:revisionId/bom/structure', { schema: getStructureContract }, async (request) => {
    const { style, revision } = await readRevisionFor(request, request.params.styleId, request.params.revisionId)
    return { structure: await request.withClient(async (client) => structureViewOf(await loadStructure(client, style, revision), await readTree(client, revision.id))) }
  })

  app.get('/product/styles/:styleId/revisions/:revisionId/bom/check', { schema: getCheckContract }, async (request) => {
    const { style, revision } = await readRevisionFor(request, request.params.styleId, request.params.revisionId)
    return { check: await request.withClient(async (client) => checkViewOf(await loadStructure(client, style, revision))) }
  })

  app.get('/product/styles/:styleId/revisions/:revisionId/bom/explosion', { schema: getExplosionContract }, async (request) => ({
    explosion: await explosionFor(request, request.params.styleId, request.params.revisionId, request.query),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/bom/lines/:lineId/structure', { schema: setLineStructureContract }, async (request) => ({
    structure: await setLineStructure(request, request.params.styleId, request.params.revisionId, request.params.lineId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/styles/:styleId/revisions/:revisionId/bom/structure/change', { schema: changeStructureContract }, async (request) => ({
    structure: await changeStructure(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/product/styles/:styleId/used-in', { schema: usedInContract }, async (request) => {
    const { id, code, name, status } = await readStyleFor(request, request.params.styleId)
    const actor = actorOf(contextOf(request))
    return { usedIn: await request.withClient((client) => usedInOf(client, { id, code, name, status }, (companyId) => can(actor, PRODUCT_BOM_VIEW, { companyId }))) }
  })
})
