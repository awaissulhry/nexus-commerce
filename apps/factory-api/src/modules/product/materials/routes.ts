import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { addColour, updateColour } from './colours'
import {
  addColourContract,
  archiveMaterialContract,
  createMaterialContract,
  getMaterialContract,
  listMaterialsContract,
  reactivateMaterialContract,
  standardCostContract,
  updateColourContract,
  updateMaterialContract,
} from './contract'
import { manifest } from './manifest'
import { createMaterial, getMaterial, listMaterials, moveMaterial, setStandardCost, updateMaterial } from './materials'

/**
 * The material library (product module, B-W1-09; A2 SCR-047 "Materials & trims", SCR-048 "Material record"): leather,
 * textiles, linings, trims, protectors, labels and the parts we make, with their units and conversions, colours, make
 * or buy, tracking, Cr VI settings and standard purchase price. Imports go through platform/imports (importer
 * `product.materials`, ./importer.ts).
 */
export default defineRoutes('product.materials', manifest, async (app) => {
  app.get('/product/materials', { schema: listMaterialsContract }, async (request) => listMaterials(request, request.query))

  app.get('/product/materials/:materialId', { schema: getMaterialContract }, async (request) => ({ material: await getMaterial(request, request.params.materialId) }))

  app.post('/product/materials', { schema: createMaterialContract }, async (request, reply) =>
    reply.code(201).send({ material: await createMaterial(request, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/materials/:materialId', { schema: updateMaterialContract }, async (request) => ({
    material: await updateMaterial(request, request.params.materialId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/materials/:materialId/archive', { schema: archiveMaterialContract }, async (request) => ({
    material: await moveMaterial(request, request.params.materialId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/materials/:materialId/reactivate', { schema: reactivateMaterialContract }, async (request) => ({
    material: await moveMaterial(request, request.params.materialId, 'ACTIVE', request.body, idempotencyKeyFrom(request)),
  }))

  app.put('/product/materials/:materialId/standard-cost', { schema: standardCostContract }, async (request) => ({
    material: await setStandardCost(request, request.params.materialId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/product/materials/:materialId/colours', { schema: addColourContract }, async (request, reply) =>
    reply.code(201).send({ material: await addColour(request, request.params.materialId, request.body, idempotencyKeyFrom(request)) }),
  )

  app.patch('/product/materials/:materialId/colours/:colourId', { schema: updateColourContract }, async (request) => ({
    material: await updateColour(request, request.params.materialId, request.params.colourId, request.body, idempotencyKeyFrom(request)),
  }))
})
