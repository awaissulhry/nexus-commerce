import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'

// scripts/factory/check-integration-calls.mjs, proven on plants: each test copies the source folders the guard reads
// into a temporary root, plants one file, and runs the guard on it.

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))
const GUARD = join(REPO, 'scripts/factory/check-integration-calls.mjs')
const SCANNED = ['apps/factory-api/src', 'packages/factory-db/src', 'packages/factory-db/seed', 'packages/factory-domain/src', 'packages/db-kit/src']
const SKIP = /(?:^|\/)(?:node_modules|dist|generated)(?:\/|$)/
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tree(plants: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'factory-integration-calls-'))
  roots.push(root)
  for (const part of SCANNED) cpSync(join(REPO, part), join(root, part), { recursive: true, filter: (source) => !SKIP.test(source.slice(REPO.length)) })
  for (const [path, text] of Object.entries(plants)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return root
}

const guard = (root?: string) => {
  const run = spawnSync(process.execPath, [GUARD, ...(root ? [root] : [])], { encoding: 'utf8' })
  return { status: run.status, output: `${run.stdout}${run.stderr}` }
}

const MODULE = 'apps/factory-api/src/modules/sales/quote-mail.ts'

describe('check-integration-calls', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('passes on the repository and on an untouched copy', () => {
    expect(guard()).toMatchObject({ status: 0, output: expect.stringMatching(/^check-integration-calls: ok/) })
    expect(guard(tree()).status).toBe(0)
  })

  it.each<[string, Record<string, string>, RegExp]>([
    ['a global fetch() in a module', { [MODULE]: "export const send = () => fetch('https://api.example.com/v1/send', { method: 'POST' })\n" }, /quote-mail\.ts:1 {2}calls fetch\(\)/],
    ['globalThis.fetch()', { [MODULE]: "export const send = () => globalThis.fetch('https://api.example.com')\n" }, /calls globalThis\.fetch\(\)/],
    ['an AWS SDK import', { [MODULE]: "import { SESv2Client } from '@aws-sdk/client-sesv2'\nexport const client = new SESv2Client({})\n" }, /imports @aws-sdk\/client-sesv2/],
    ['the Stripe SDK in factory-db', { 'packages/factory-db/src/payments.ts': "import Stripe from 'stripe'\nexport const stripe = new Stripe('x')\n" }, /packages\/factory-db\/src\/payments\.ts:1 {2}imports stripe/],
    ['node:https in a platform folder', { 'apps/factory-api/src/platform/outbox/notify.ts': "import { request } from 'node:https'\nexport { request }\n" }, /imports node:https/],
    ['an undici import split over lines', { [MODULE]: "import {\n  request,\n} from 'undici'\nexport { request }\n" }, /quote-mail\.ts:1 {2}imports undici/],
    ['a dynamic import of axios', { [MODULE]: "export const load = () => import('axios')\n" }, /imports axios/],
    ['a require of http', { [MODULE]: "const http = require('http')\nmodule.exports = http\n" }, /requires http/],
    ['a re-export of an SDK', { [MODULE]: "export { KMSClient } from '@aws-sdk/client-kms'\n" }, /re-exports @aws-sdk\/client-kms/],
    ['a WebSocket client', { [MODULE]: "export const open = () => new WebSocket('wss://example.com')\n" }, /opens new WebSocket/],
    ['an SDK in the domain package', { 'packages/factory-domain/src/sales/vies.ts': "import soap from 'soap'\nexport { soap }\n" }, /imports soap/],
    ['an SDK in the secrets folder outside the KMS provider', { 'apps/factory-api/src/platform/secrets/other.ts': "import { KMSClient } from '@aws-sdk/client-kms'\nexport { KMSClient }\n" }, /secrets\/other\.ts:1 {2}imports @aws-sdk\/client-kms/],
  ])('fails on %s', (_label, plants, expected) => {
    const result = guard(tree(plants))
    expect(result.status).toBe(1)
    expect(result.output).toMatch(expected)
  })

  it.each<[string, Record<string, string>]>([
    ['the gateway itself', { 'apps/factory-api/src/platform/gateway/http.ts': "import { request } from 'undici'\nexport const go = () => fetch('https://example.com')\n" }],
    ['an adapter', { 'apps/factory-api/src/adapters/sendcloud/client.ts': "export const go = () => fetch('https://panel.sendcloud.sc/api/v2/parcels')\n" }],
    ['a type-only import', { [MODULE]: "import type { IncomingMessage } from 'node:http'\nimport { type Agent } from 'node:https'\nexport type X = IncomingMessage | Agent\n" }],
    ['fetch in a comment or a string, and a method named fetch', { [MODULE]: "// fetch('https://example.com')\nexport const text = \"fetch('x')\"\nexport const go = (client: { fetch(q: string): void }) => client.fetch('q')\n" }],
    ['a test file and test support', { 'apps/factory-api/src/modules/sales/quote.vitest.test.ts': "import { get } from 'node:http'\nexport { get }\n", 'apps/factory-api/src/modules/sales/testing.ts': "import { get } from 'node:http'\nexport { get }\n" }],
  ])('allows %s', (_label, plants) => {
    expect(guard(tree(plants))).toMatchObject({ status: 0 })
  })
})
