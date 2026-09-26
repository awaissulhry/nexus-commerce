import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { FakeKms, FAKE_KMS_KEY_ID } from '../test-support/fake-kms.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

const state = vi.hoisted(() => ({ runs: [] as Array<Record<string, any>>, credentials: [] as Array<Record<string, unknown>>, writes: vi.fn() }))
vi.mock('../db.js', () => ({ default: {
  cronRun: {
    create: async ({ data }: any) => { const row = { id: String(state.runs.length), ...data }; state.runs.push(row); return row },
    update: async ({ where, data }: any) => Object.assign(state.runs.find(row => row.id === where.id)!, data),
  },
  channelConnection: { findMany: async () => state.credentials, updateMany: state.writes },
  channelApp: { findMany: async () => [] },
} }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../utils/trace-log.js', () => ({ logTraceEvent: vi.fn() }))
vi.mock('../services/cx/events.service.js', () => ({ recordConnectionEvent: vi.fn(), SYSTEM_ACTOR: { kind: 'system' } }))
const crypto = await import('../lib/crypto.js')
const maintenance = await import('./cx-credentials-rotate.job.js')
const owned = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const runCredentialsPreflight = () => owned(maintenance.runCredentialsPreflight)
const runCredentialsRotate = () => owned(maintenance.runCredentialsRotate)
let fake: FakeKms
beforeEach(() => {
  state.runs = []; state.credentials = []; state.writes.mockReset()
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64')); vi.stubEnv('NEXUS_KMS_KEY_ID', FAKE_KMS_KEY_ID)
  crypto.__test.resetKeyCache(); crypto.__cryptoTest.resetDekCache()
  fake = new FakeKms(); crypto.__cryptoTest.setKmsClient(fake as never)
})
afterEach(() => vi.unstubAllEnvs())

it('records a successful configured-key preflight as SUCCESS', async () => {
  expect(await runCredentialsPreflight()).toContain('ok mode=kms')
  expect(state.runs[0]).toMatchObject({ jobName: 'cx-credentials-preflight', status: 'SUCCESS' })
})

it('records a configured-key preflight fallback as FAILED through the actual CronRun wrapper', async () => {
  fake.failGenerate = true
  await expect(runCredentialsPreflight()).rejects.toThrow('NOT being used')
  expect(state.runs).toHaveLength(1)
  expect(state.runs[0]).toMatchObject({ jobName: 'cx-credentials-preflight', status: 'FAILED' })
})
it('records a refused rotation as FAILED without any credential write', async () => {
  state.credentials.push({ id: 'owned', workspaceId: LEGACY_WORKSPACE_ID, credentialsEnc: 'retained-old-envelope' })
  fake.failGenerate = true
  await expect(runCredentialsRotate()).rejects.toThrow('REFUSED')
  expect(state.runs[0]).toMatchObject({ jobName: 'cx-credentials-rotate', status: 'FAILED' })
  expect(state.writes).not.toHaveBeenCalled()
})
it('records an incomplete per-item rotation as FAILED rather than a successful summary', async () => {
  state.credentials.push({ id: 'owned', workspaceId: LEGACY_WORKSPACE_ID, credentialsEnc: 'broken-envelope' })
  await expect(runCredentialsRotate()).rejects.toThrow('failed=1')
  expect(state.runs[0]).toMatchObject({ status: 'FAILED', errorMessage: expect.stringContaining('INCOMPLETE') })
  expect(state.runs[0].errorMessage).not.toContain('broken-envelope')
  expect(state.writes).not.toHaveBeenCalled()
})
