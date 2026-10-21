/**
 * Owner item 7 — a tool's secret arguments are sealed where a request is stored, opened only in the door, and masked in
 * every record and view (secret-args.ts). The env key here (no KMS): the same envelope code the channel tokens use.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from './tool-types.js'

const TOOLS: Record<string, Pick<AgentTool, 'name' | 'secretArgs'>> = {
  'boost-code': { name: 'boost-code', secretArgs: ['adCode'] },
  'lookup-codes': { name: 'lookup-codes', secretArgs: ['adCodes'] },
  'set-price': { name: 'set-price' },
}
vi.mock('./tool-registry.js', () => ({ getTool: (name: string) => TOOLS[name] }))
// The in-app assistant's loop (tool-loop.service.ts): the gate and the offered tools stand in; Anthropic is never called.
const gate = vi.hoisted(() => ({ runOrQueueTool: vi.fn(async () => ({ ok: true, mode: 'queued', approvalId: 'approval-1', preview: {} })) }))
vi.mock('./approval-gate.service.js', () => gate)
vi.mock('./call-tool.js', () => ({ toolsFor: () => [] }))

import { __test as cryptoTest } from '../../lib/crypto.js'
import { isSealed, maskSecretArgs, openSecretArgs, sealSecretArgs, SECRET_MASK } from './secret-args.js'
import { runToolLoop } from './tool-loop.service.js'

const boost = TOOLS['boost-code']
const lookup = TOOLS['lookup-codes']
/** A made-up key for this run only (never a real one); KMS stays unset, so the v1 env-key envelope is used. */
const madeUpKey = () => randomBytes(32).toString('base64')
const noKey = () => {
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', undefined)
  cryptoTest.resetKeyCache()
}

beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {}) // the once-per-process "no KMS, env key" notice
})
beforeEach(() => {
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', madeUpKey())
  vi.stubEnv('NEXUS_KMS_KEY_ID', undefined)
  cryptoTest.resetKeyCache()
})
afterAll(() => {
  vi.unstubAllEnvs()
  cryptoTest.resetKeyCache()
  vi.restoreAllMocks()
})

describe('seal — where a request is stored', () => {
  it('replaces only the secret argument, with a blob that does not carry it', async () => {
    const sealed = await sealSecretArgs(boost, { adCode: 'CODE_abc123', name: 'Creator boost' })
    expect(sealed.name).toBe('Creator boost')
    expect(isSealed(sealed.adCode)).toBe(true)
    expect(sealed.adCode).toEqual({ __enc: expect.stringMatching(/^v1:/) })
    expect(JSON.stringify(sealed)).not.toContain('CODE_abc123')
  })

  it('is idempotent: a sealed value is kept as it is (an unticked plan, an edit, stores the same blob)', async () => {
    const once = await sealSecretArgs(boost, { adCode: 'CODE_abc123' })
    const twice = await sealSecretArgs(boost, once)
    expect(twice).toBe(once)
  })

  it('a call with no secret value is the same object and needs no key (every other tool is unchanged)', async () => {
    noKey()
    const args = { productId: 'p1', price: 12 }
    expect(await sealSecretArgs(TOOLS['set-price'], args)).toBe(args)
    const noCode = { name: 'x' }
    expect(await sealSecretArgs(boost, noCode)).toBe(noCode)
  })

  it('without a key it refuses to store, and the message carries no value', async () => {
    noKey()
    const out = sealSecretArgs(boost, { adCode: 'CODE_abc123' })
    await expect(out).rejects.toThrow(/could not encrypt its secret argument adCode/)
    await expect(out).rejects.not.toThrow(/CODE_abc123/)
  })
})

describe('open — in the door, right before the tool reads them', () => {
  it('gives back the value, a list too', async () => {
    const sealed = await sealSecretArgs(lookup, { adCodes: ['A1', 'B2'], view: 'lookup' })
    expect(await openSecretArgs(lookup, sealed)).toEqual({ adCodes: ['A1', 'B2'], view: 'lookup' })
  })

  it('passes a plain value as it is (a request stored before item 7)', async () => {
    const old = { adCode: 'CODE_old' }
    expect(await openSecretArgs(boost, old)).toBe(old)
  })

  it('a blob it cannot open stops the run, naming no value', async () => {
    await expect(openSecretArgs(boost, { adCode: { __enc: 'v1:AAAA.BBBB.CCCC' } })).rejects.toThrow(/boost-code: its secret argument adCode could not be decrypted \(bad_format\)\. Nothing was run\./)
  })

  it('a blob made under another key is refused (the authentication tag)', async () => {
    const sealed = await sealSecretArgs(boost, { adCode: 'CODE_abc123' })
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', madeUpKey())
    cryptoTest.resetKeyCache()
    await expect(openSecretArgs(boost, sealed)).rejects.toThrow(/could not be decrypted/)
  })
})

describe('mask — what a record or a view keeps', () => {
  it('a secret argument, sealed or not, is the mask; the rest is kept', async () => {
    expect(maskSecretArgs('boost-code', { adCode: 'CODE_abc123', name: 'x' })).toEqual({ adCode: SECRET_MASK, name: 'x' })
    expect(maskSecretArgs(boost, await sealSecretArgs(boost, { adCode: 'CODE_abc123' }))).toEqual({ adCode: SECRET_MASK })
  })

  it('a change plan\'s steps, each by its own tool', () => {
    const args = { title: 'Boosts', steps: [{ tool: 'boost-code', args: { adCode: 'CODE_abc123' } }, { tool: 'set-price', args: { price: 12 } }] }
    expect(maskSecretArgs('submit-change-plan', args)).toEqual({
      title: 'Boosts',
      steps: [{ tool: 'boost-code', args: { adCode: SECRET_MASK } }, { tool: 'set-price', args: { price: 12 } }],
    })
    expect(JSON.stringify(args)).toContain('CODE_abc123') // the caller's own object is not touched
  })

  it('nothing secret: the same object (every other record is written as before)', () => {
    const args = { price: 12 }
    expect(maskSecretArgs('set-price', args)).toBe(args)
    const plan = { title: 'Prices', steps: [{ tool: 'set-price', args }] }
    expect(maskSecretArgs('submit-change-plan', plan)).toBe(plan)
    expect(maskSecretArgs('unknown-tool', args)).toBe(args)
  })
})

describe('mask — the in-app assistant\'s run steps (tool-loop.service.ts)', () => {
  it('a tool call it made is on the run with the mask; the gate gets the value, to seal where it stores it', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'made-up-test-key') // fetch is a stand-in below: nothing leaves this test
    const replies = [
      { stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 'tu-1', name: 'boost-code', input: { adCode: 'CODE_abc123', name: 'x' } }] },
      { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Asked for it.' }] },
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => replies.shift() })))
    try {
      const out = await runToolLoop({ model: 'test-model', system: '', messages: [{ role: 'user', content: 'boost it' }], principal: {} as never, agentRunId: 'run-1' })
      expect(out.steps.filter((step) => step.type === 'tool')).toEqual([expect.objectContaining({ name: 'boost-code', args: { adCode: SECRET_MASK, name: 'x' } })])
      expect(JSON.stringify(out.steps)).not.toContain('CODE_abc123')
      expect(gate.runOrQueueTool).toHaveBeenCalledWith('boost-code', { adCode: 'CODE_abc123', name: 'x' }, expect.anything(), 'run-1')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
