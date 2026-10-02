/**
 * MCP full control T4 (docs/mcp-full-control/sections/03-content.md §4.4) — `GET /api/terminology` keeps its exact
 * answer after its query moved into services/ai/terminology.service.ts (the route and Claude's content-guidelines tool
 * share it). Every filter the route takes is read here, on a real PostgreSQL (PGlite): no brand, `*`, a brand (its
 * rows and the all-brand defaults), `__none__` (defaults only), a marketplace in any case, and both together. The
 * answers are pinned in full — rows, order, count — so a refactor that drifts shows here.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client, prisma: state.db.client }
})

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import terminologyRoutes from './terminology.routes.js'

const BUSINESS = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
let app: FastifyInstance
const rows: Record<string, string> = {}

beforeAll(async () => {
  app = Fastify()
  app.addHook('preHandler', (_request, _reply, done) => withWorkspace(BUSINESS, done))
  await app.register(terminologyRoutes, { prefix: '/api' })
  await app.ready()
  await withWorkspace(BUSINESS, async () => {
    for (const [key, brand, marketplace, language, preferred, avoid] of [
      ['itDefault', null, 'IT', 'it', 'Giacca', ['Giubbotto']],
      ['itBrand', 'Test Brand', 'IT', 'it', 'Guanti', ['Manopole']],
      ['deDefault', null, 'DE', 'de', 'Jacke', []],
      ['deBrand', 'Test Brand', 'DE', 'de', 'Handschuhe', ['Fäustlinge']],
      ['otherBrand', 'Other Brand', 'IT', 'it', 'Casco', ['Elmetto']],
    ] as const) {
      rows[key] = (await prisma.terminologyPreference.create({ data: { brand, marketplace, language, preferred, avoid: [...avoid], context: `${key} context` } })).id
    }
  })
}, 120_000)
afterAll(async () => { await app?.close(); await state.db?.close() }, 60_000)

const list = async (query: string) => {
  const response = await app.inject({ method: 'GET', url: `/api/terminology${query}` })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as { items: Array<Record<string, unknown>>; count: number }
}
const idsOf = (body: { items: Array<Record<string, unknown>> }) => body.items.map((item) => Object.keys(rows).find((key) => rows[key] === item.id))

describe('GET /api/terminology — the same answer for every filter', () => {
  it.each([
    ['no filter: every row, by marketplace, then brand, then preferred word', '', ['deBrand', 'deDefault', 'otherBrand', 'itBrand', 'itDefault']],
    ['brand=*: every row', '?brand=*', ['deBrand', 'deDefault', 'otherBrand', 'itBrand', 'itDefault']],
    ['a brand: its own rows and the all-brand defaults', '?brand=Test%20Brand', ['deBrand', 'deDefault', 'itBrand', 'itDefault']],
    ['brand=__none__: the all-brand defaults only', '?brand=__none__', ['deDefault', 'itDefault']],
    ['a marketplace, in any case', '?marketplace=it', ['otherBrand', 'itBrand', 'itDefault']],
    ['a brand on a marketplace', '?brand=Test%20Brand&marketplace=DE', ['deBrand', 'deDefault']],
  ])('%s', async (_name, query, expected) => {
    const body = await list(query)
    expect(idsOf(body)).toEqual(expected)
    expect(body.count).toBe(expected.length)
  })

  it('each item is the stored row, every column', async () => {
    const { items } = await list('?brand=__none__&marketplace=IT')
    const stored = await withWorkspace(BUSINESS, () => prisma.terminologyPreference.findUniqueOrThrow({ where: { id: rows.itDefault } }))
    expect(items).toEqual([JSON.parse(JSON.stringify(stored))])
  })
})
