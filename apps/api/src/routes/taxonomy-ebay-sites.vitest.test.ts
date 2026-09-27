import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * "Fill other eBay sites" — the four routes: wiring (query, body, actor, errors) and their rule in the permission
 * manifest. The services are stubbed; their behaviour is covered beside them.
 */
const m = vi.hoisted(() => ({ coverage: vi.fn(), suggestions: vi.fn(), apply: vi.fn(), undo: vi.fn() }))
vi.mock('../services/pim/mapping/ebay-site-suggestions.service.js', () => ({ ebaySiteCoverage: m.coverage, ebaySiteSuggestions: m.suggestions }))
vi.mock('../services/pim/mapping/ebay-site-assignments.service.js', () => ({ applyEbaySiteAssignments: m.apply, undoEbaySiteAssignments: m.undo }))
vi.mock('../services/taxonomy/repository.js', () => ({ taxonomyHistory: vi.fn(), listTaxonomySources: vi.fn(), readTaxonomyRequirements: vi.fn(), requestTaxonomyRefresh: vi.fn(), searchTaxonomy: vi.fn() }))
vi.mock('../services/taxonomy/category-workspace.js', () => ({ categoryDirectory: vi.fn(), categoryAssignments: vi.fn(), categoryChangeImpact: vi.fn(), applyCategoryCommand: vi.fn(), CategoryTreeError: class extends Error { status = 400 } }))
vi.mock('@nexus/database/workspace-context', () => ({ workspaceContext: () => ({ actorUserId: 'operator' }) }))

import taxonomyRoutes from './taxonomy.routes.js'
import { TaxonomyError } from '../services/taxonomy/model.js'
import { permissionForRoute } from '../lib/auth/permissions-manifest.js'
import { FEATURES } from '@nexus/shared/permissions'

const app = Fastify()
beforeAll(async () => { await app.register(taxonomyRoutes, { prefix: '/api' }); await app.ready() })
afterAll(() => app.close())
beforeEach(() => vi.resetAllMocks())

describe('routes', () => {
  it('GET site-suggestions passes the category and maps a refusal to its status', async () => {
    m.suggestions.mockResolvedValue({ categoryId: 'jackets', sites: [] })
    const ok = await app.inject({ method: 'GET', url: '/api/pim/category-workspace/EBAY/site-suggestions?categoryId=jackets' })
    expect(ok.statusCode).toBe(200)
    expect(m.suggestions).toHaveBeenCalledWith('jackets')
    m.suggestions.mockRejectedValue(new TaxonomyError('Category no longer exists.', 404))
    const gone = await app.inject({ method: 'GET', url: '/api/pim/category-workspace/EBAY/site-suggestions?categoryId=gone' })
    expect(gone.statusCode).toBe(404)
    expect(gone.json()).toEqual({ error: 'Category no longer exists.' })
  })

  it('GET site-coverage answers the fillable rows', async () => {
    m.coverage.mockResolvedValue({ sites: ['DE', 'IT'], fillable: {} })
    const res = await app.inject({ method: 'GET', url: '/api/pim/category-workspace/EBAY/site-coverage' })
    expect(res.json()).toEqual({ sites: ['DE', 'IT'], fillable: {} })
  })

  it('POST saves and DELETE undoes, each with the body and the acting user', async () => {
    m.apply.mockResolvedValue({ results: [] })
    m.undo.mockResolvedValue({ results: [] })
    const body = { categoryId: 'jackets', assignments: [{ market: 'DE', channelCategoryId: '177117' }] }
    expect((await app.inject({ method: 'POST', url: '/api/pim/category-workspace/EBAY/site-assignments', payload: body })).statusCode).toBe(200)
    expect(m.apply).toHaveBeenCalledWith(body, 'operator')
    const undo = { categoryId: 'jackets', assignments: [{ market: 'DE', channelCategoryId: '177117', assignedAt: '2026-09-27T10:00:00.000Z' }] }
    expect((await app.inject({ method: 'DELETE', url: '/api/pim/category-workspace/EBAY/site-assignments', payload: undo })).statusCode).toBe(200)
    expect(m.undo).toHaveBeenCalledWith(undo, 'operator')
  })
})

it('every route sits under the same rule as the workspace reads and its apply: PIM management', () => {
  for (const [method, path] of [
    ['GET', '/api/pim/category-workspace/:channel/:market/assignments'],
    ['POST', '/api/pim/category-workspace/apply'],
  ]) expect(permissionForRoute(method, path)).toBe(FEATURES.pimManage)
  expect(permissionForRoute('GET', '/api/pim/category-workspace/EBAY/site-suggestions')).toBe(FEATURES.pimManage)
  expect(permissionForRoute('GET', '/api/pim/category-workspace/EBAY/site-coverage')).toBe(FEATURES.pimManage)
  expect(permissionForRoute('POST', '/api/pim/category-workspace/EBAY/site-assignments')).toBe(FEATURES.pimManage)
  expect(permissionForRoute('DELETE', '/api/pim/category-workspace/EBAY/site-assignments')).toBe(FEATURES.pimManage)
})
