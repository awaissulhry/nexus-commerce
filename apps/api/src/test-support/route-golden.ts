/**
 * MCP full control P3 — a route's answer, byte for byte, before and after its reads move into a service.
 *
 * A characterization test records what a route answers (status and the raw body Fastify sends) over fixed fixtures
 * in a real PostgreSQL (PGlite, `formulaDatabase()`), into a golden file next to the test. The golden is written by
 * the route as it was BEFORE the move; after the move the same request must give the same bytes. A golden that is
 * missing in CI fails (vitest does not write snapshots under CI), so the recorded answer is the contract.
 *
 * The clock is fixed (`GOLDEN_NOW`, Date only: timers stay real) so windows like "the last 24 hours" and stamps like
 * `generatedAt` are the same on every run. Fixtures carry fixed ids and dates.
 *
 * Business profiles: the suite runs once with them off and once with `NEXUS_WORKSPACES_ENABLED=1`; each mode has its
 * own golden. With them on, every request runs inside the fixtures' business, as the workspace hook would enter it.
 */
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify'
import { expect, vi } from 'vitest'
import { LEGACY_WORKSPACE_ID, withWorkspace, type WorkspaceContext } from '../lib/workspace-context.js'

/** The fixed "now" of every golden. */
export const GOLDEN_NOW = new Date('2026-09-15T10:00:00.000Z')

/** The business the fixtures live in, and every request runs in when profiles are on. */
export const GOLDEN_BUSINESS: WorkspaceContext = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }

export const profilesOn = () => process.env.NEXUS_WORKSPACES_ENABLED === '1'

/** Seed or read as the fixtures' business. */
export const inGoldenBusiness = <T>(work: () => Promise<T>): Promise<T> => withWorkspace(GOLDEN_BUSINESS, work)

/** Freeze Date at GOLDEN_NOW (timers stay real: the database driver needs them). Call in beforeAll. */
export function freezeGoldenClock(): void {
  vi.useFakeTimers({ toFake: ['Date'], now: GOLDEN_NOW })
}

/**
 * A Fastify app with these route plugins, as index.ts registers them (`prefix` per plugin), a signed-in person
 * (`authUser`) and, with profiles on, the fixtures' business entered for every request.
 */
export async function goldenApp(plugins: Array<{ plugin: FastifyPluginAsync | ((app: FastifyInstance) => Promise<void>); prefix?: string }>): Promise<FastifyInstance> {
  const app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    Object.assign(request, {
      authUser: { id: 'golden-person', email: 'golden@example.test', displayName: 'Golden Person', status: 'active', mfaRequired: false, twoFactorEnabledAt: null, permissionsVersion: 1, roleKeys: [] },
    })
    if (profilesOn()) withWorkspace(GOLDEN_BUSINESS, done)
    else done()
  })
  for (const { plugin, prefix } of plugins) await app.register(plugin as FastifyPluginAsync, prefix ? { prefix } : {})
  await app.ready()
  return app
}

/** A write's request, for a golden of a route that changes something (wave 3: writes moved into services). */
export interface GoldenRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  payload?: unknown
  /** Replaces what differs on every run (a created row's random id) before the comparison. */
  normalize?: (body: string) => string
}

/**
 * The route's answer to `url` (GET unless `request` says otherwise), checked against its golden
 * (`__golden__/<name>.<off|on>.txt` next to the test): the status line, then the raw body.
 */
export async function expectGolden(app: FastifyInstance, name: string, url: string, goldenDir: string, request: GoldenRequest = {}): Promise<void> {
  const response = await app.inject({
    method: request.method ?? 'GET',
    url,
    ...(request.payload === undefined ? {} : { payload: request.payload as never }),
  })
  const mode = profilesOn() ? 'on' : 'off'
  const body = request.normalize ? request.normalize(response.body) : response.body
  await expect(`${response.statusCode}\n${body}\n`).toMatchFileSnapshot(`${goldenDir}/${name}.${mode}.txt`)
}
