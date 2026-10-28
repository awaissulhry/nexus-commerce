import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FACTORY_ENV_FILE, loadFactoryEnv, parseFactoryEnv, readFactoryVariables } from './env'

const LOCAL = {
  FACTORY_ENV: 'local',
  FACTORY_DATABASE_URL: 'postgresql://postgres@127.0.0.1:5442/factory_w9_01',
  FACTORY_REDIS_URL: 'redis://127.0.0.1:6399',
}
const REMOTE_DATABASE = 'postgresql://factory_runtime:hunter2@db.example.com:5432/factory'
const REMOTE_REDIS = 'redis://default:hunter2@cache.example.com:6379'

const folders: string[] = []
function variablesFile(content: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'factory-env-'))
  folders.push(folder)
  const file = join(folder, 'variables')
  writeFileSync(file, content)
  return file
}
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('the env file', () => {
  it('is apps/factory-api/.env, never the repository root', () => {
    const workspace = dirname(dirname(fileURLToPath(import.meta.url)))
    expect(FACTORY_ENV_FILE).toBe(join(workspace, '.env'))
    expect(workspace.endsWith(join('apps', 'factory-api'))).toBe(true)
  })

  it('takes only FACTORY_ variables from the file, and the process environment wins', () => {
    const file = variablesFile(
      [
        'FACTORY_ENV=local',
        'FACTORY_PORT=8191',
        'DATABASE_URL=postgresql://prod.example.com/nexus',
        'REDIS_URL=redis://prod.example.com',
        'SECRET_KEY=x',
      ].join('\n'),
    )
    const variables = readFactoryVariables({ file, processEnv: { FACTORY_PORT: '8192', PATH: '/bin' } })
    expect(variables).toEqual({ FACTORY_ENV: 'local', FACTORY_PORT: '8192' })
  })

  it('works without a file (Railway sets the variables in the process)', () => {
    const variables = readFactoryVariables({ file: join(tmpdir(), 'factory-env-missing', 'variables'), processEnv: LOCAL })
    expect(variables).toEqual(LOCAL)
  })
})

describe('refusals', () => {
  it('refuses a missing FACTORY_ENV', () => {
    const { FACTORY_ENV: _unused, ...rest } = LOCAL
    expect(() => parseFactoryEnv(rest, undefined)).toThrow(/FACTORY_ENV/)
  })

  it('refuses an unknown FACTORY_ENV', () => {
    expect(() => parseFactoryEnv({ ...LOCAL, FACTORY_ENV: 'dev' }, undefined)).toThrow(/FACTORY_ENV/)
  })

  it('never falls back to the unprefixed Commerce variables', () => {
    const file = variablesFile('FACTORY_ENV=local\nDATABASE_URL=postgresql://127.0.0.1/x\nREDIS_URL=redis://127.0.0.1')
    expect(() => loadFactoryEnv({ file, processEnv: {} })).toThrow(/FACTORY_DATABASE_URL/)
  })

  it.each(['local', 'test'])('refuses a remote database with FACTORY_ENV=%s, without printing the password', (name) => {
    const run = () => parseFactoryEnv({ ...LOCAL, FACTORY_ENV: name, FACTORY_DATABASE_URL: REMOTE_DATABASE }, undefined)
    expect(run).toThrow(/FACTORY_DATABASE_URL points at db\.example\.com:5432\/factory/)
    expect(run).not.toThrow(/hunter2/)
  })

  it.each(['local', 'test'])('refuses a remote Redis with FACTORY_ENV=%s', (name) => {
    expect(() => parseFactoryEnv({ ...LOCAL, FACTORY_ENV: name, FACTORY_REDIS_URL: REMOTE_REDIS }, undefined)).toThrow(
      /FACTORY_REDIS_URL points at cache\.example\.com:6379/,
    )
  })

  it('refuses a host parameter that sends a loopback URL elsewhere', () => {
    const url = 'postgresql://postgres@127.0.0.1:5442/factory_test?host=db.example.com'
    expect(() => parseFactoryEnv({ ...LOCAL, FACTORY_DATABASE_URL: url }, undefined)).toThrow(/loopback/)
  })

  it.each(['production', 'staging'])('refuses FACTORY_ENV=%s off Railway', (name) => {
    const variables = { FACTORY_ENV: name, FACTORY_DATABASE_URL: REMOTE_DATABASE, FACTORY_REDIS_URL: REMOTE_REDIS }
    expect(() => parseFactoryEnv(variables, undefined)).toThrow(/runs only on Railway/)
    expect(() => parseFactoryEnv(variables, '')).toThrow(/runs only on Railway/)
  })

  it('does not let the file pretend to be Railway', () => {
    const file = variablesFile(
      `FACTORY_ENV=production\nFACTORY_DATABASE_URL=${REMOTE_DATABASE}\nFACTORY_REDIS_URL=${REMOTE_REDIS}\nRAILWAY_ENVIRONMENT=production`,
    )
    expect(() => loadFactoryEnv({ file, processEnv: {} })).toThrow(/runs only on Railway/)
  })
})

describe('accepted', () => {
  it('local, on loopback, with defaults', () => {
    expect(parseFactoryEnv(LOCAL, undefined)).toEqual({ ...LOCAL, FACTORY_HOST: '127.0.0.1', FACTORY_PORT: 8190 })
  })

  it('production on Railway, with remote hosts', () => {
    const env = loadFactoryEnv({
      file: join(tmpdir(), 'factory-env-missing', 'variables'),
      processEnv: {
        FACTORY_ENV: 'production',
        FACTORY_DATABASE_URL: REMOTE_DATABASE,
        FACTORY_REDIS_URL: REMOTE_REDIS,
        FACTORY_PORT: '8080',
        RAILWAY_ENVIRONMENT: 'production',
      },
    })
    expect(env.FACTORY_HOST).toBe('::')
    expect(env.FACTORY_PORT).toBe(8080)
    expect(Object.isFrozen(env)).toBe(true)
  })
})
