/**
 * P6.6 — Amazon SP-API sign-in: apply D1, and retire the environment token.
 *
 * ## R-2 first, because it gates D1
 *
 * R-2 asked whether two Amazon posts change decision D1 (private app or public).
 * Read 2026-09-21:
 *
 * | source | says |
 * |---|---|
 * | Amazon's **Authorization Limits** page | *"Private applications are available only to your organization … Self-authorization only. Maximum of **10** self-authorizations."* Public: 25 OAuth authorizations while unlisted, unlimited once listed |
 * | **Simplified Authorization** (2026) | one-click approval **on an SPN service listing page**, for providers listed on the Selling Partner Network |
 *
 * 🟢 **D1 = A (private) is confirmed.** Simplified Authorization is a mechanism for
 * listing a service so *other people's* sellers can approve it. Nexus is the Owner's
 * own tool for the Owner's own seller accounts, so it does not apply, and the private
 * limit of 10 self-authorizations is far above the two business profiles in use.
 *
 * ⚠️ One plan claim not confirmed: D1's summary says a public app must *"re-authorize
 * every 365 days"*. Amazon's authorization-limits page states **no** re-authorization
 * interval. Absence on that page is not proof it exists nowhere, so it is flagged, not
 * corrected — and it does not affect the decision, which is Private either way.
 *
 * ## Where the env token actually stands (measured 2026-09-21)
 *
 * | | |
 * |---|---|
 * | **Production** | already off it — `seedEnvManagedConnections: persisted Amazon authorization exists — skipping env synthesis {"existingId":"cmothu9bo…"}` in the deploy log at 08:35 UTC |
 * | **Development** | still on it — its one Amazon row is `managedBy: 'env'` |
 * | dev row's status | 🔴 `isActive: true` **and** `authStatus: 'disconnected'` at once |
 * | `importAmazonEnvironmentAuthorization` (D1=A's mechanism) | **already built**, reachable from the connect route |
 *
 * ## Why this announces instead of deleting
 *
 * Deleting the fallback is one line with the largest blast radius available: if the
 * stored grant is ever unusable, every Amazon SP-API call stops. The production
 * database cannot be read from this session, so *"the stored grant works"* is an
 * inference from the app functioning, not a measurement.
 *
 * So the env token announces itself **once per process**, which turns *"is anything
 * still on the env path?"* into a question the production logs answer — and
 * `NEXUS_AMAZON_ENV_TOKEN=off` is the retirement, one variable, once they are quiet.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const warnings: Array<[string, unknown]> = []
vi.mock('../utils/logger.js', () => ({
  logger: {
    warn: (m: string, d?: unknown) => warnings.push([m, d]),
    info: vi.fn(), error: vi.fn(), debug: vi.fn(),
  },
}))

const { useAmazonEnvToken, __amazonEnvTokenTest } = await import('./amazon-sp-client.js')

const SRC = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(SRC, p), 'utf8')

beforeEach(() => {
  warnings.length = 0
  // The announcement is deliberately once-per-PROCESS, so without this the second
  // test would pass for the wrong reason — a mutation removing the warning entirely
  // would still look "once".
  __amazonEnvTokenTest.reset()
  vi.stubEnv('AMAZON_REFRESH_TOKEN', 'Atzr|env-token')
  vi.stubEnv('NEXUS_AMAZON_ENV_TOKEN', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('useAmazonEnvToken (P6.6)', () => {
  it('returns the token and ANNOUNCES it', () => {
    expect(useAmazonEnvToken('test')).toBe('Atzr|env-token')
    expect(warnings[0]?.[0]).toMatch(/STILL USING the environment refresh token/)
    expect(warnings[0]?.[1]).toMatchObject({ retireWith: 'NEXUS_AMAZON_ENV_TOKEN=off' })
  })

  it('announces ONCE per process, not once per call', () => {
    // It sits on the money path. A per-call line buries itself, and the question it
    // answers is yes/no, not how many.
    useAmazonEnvToken('a'); useAmazonEnvToken('b'); useAmazonEnvToken('c')
    expect(warnings).toHaveLength(1)
  })

  it('says nothing when there is no env token to use', () => {
    vi.stubEnv('AMAZON_REFRESH_TOKEN', '')
    expect(useAmazonEnvToken('test')).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('REFUSES when retired, with a sentence naming what to do instead', () => {
    vi.stubEnv('NEXUS_AMAZON_ENV_TOKEN', 'off')
    expect(() => useAmazonEnvToken('test')).toThrow(/retired/)
    expect(() => useAmazonEnvToken('test')).toThrow(/revocable grant/)
  })

  it('the refusal beats the token — the switch is not advisory', () => {
    vi.stubEnv('NEXUS_AMAZON_ENV_TOKEN', 'off')
    let returned: string | undefined = 'not-thrown'
    try { returned = useAmazonEnvToken('test') } catch { returned = undefined }
    expect(returned).toBeUndefined()
  })
})

describe('both env-token paths go through it (P6.6)', () => {
  const client = read('lib/amazon-sp-client.ts')

  it('the SDK client and the token minter both use the accessor', () => {
    expect(client).toContain("useAmazonEnvToken('getAmazonSpClient')")
    expect(client).toContain("useAmazonEnvToken('getAmazonAccessToken')")
  })

  it('no path reads the env var raw any more, except the accessor and the configured check', () => {
    const code = client.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    const raw = code.filter((l) => l.includes('process.env.AMAZON_REFRESH_TOKEN'))
    // Two: the accessor itself, and `isConfigured`, which asks whether a token EXISTS
    // rather than using one — announcing there would fire on a health check.
    expect(raw).toHaveLength(2)
  })
})

describe('the boot seeder (P6.6)', () => {
  const index = read('index.ts')

  it('does not synthesise an env-managed row once the token is retired', () => {
    // An env row created at boot is a credential nothing can revoke, rotate or date —
    // the opposite of where D1 = A puts it.
    expect(index).toContain('if (process.env.NEXUS_AMAZON_ENV_TOKEN === "off") {')
    expect(index).toContain('not synthesising an Amazon row')
  })

  it('still refuses to recreate a row when a stored grant exists (untouched)', () => {
    // Production relies on this: an oauth row of ANY status blocks env synthesis, so a
    // restart cannot undo the operator's disconnect.
    expect(index).toContain('persisted Amazon authorization exists — skipping env synthesis')
  })
})

describe('D1 = A is already implemented (P6.6 — the counterweight)', () => {
  it('the self-authorization importer exists and is reachable', () => {
    const importer = read('services/cx/connectors/amazon-sp/self-authorization.ts')
    expect(importer).toContain('export async function importAmazonEnvironmentAuthorization(')
    expect(importer).toContain('storeGrant')
    expect(read('routes/cx-connect.routes.ts')).toContain('await importAmazonEnvironmentAuthorization({')
  })

  it('the connect mode reflects the private-app flow', () => {
    // D1 = A: Amazon gives a private app no website redirect flow, so the UI must not
    // offer one. `self_authorization` is that distinction.
    expect(read('routes/connections.routes.ts')).toContain("'self_authorization'")
  })
})
