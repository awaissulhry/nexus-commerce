/**
 * NAF.A2 — the local OpenAI-compatible provider.
 *
 * The contract under test is `LLMProvider`, nothing wider. Every case here
 * is either a wire-shape assertion (what we send / how we read the reply)
 * or a guard the plan's acceptance depends on — chiefly that cost is
 * exactly zero and that an unconfigured provider never reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocalProvider } from './local.provider.js'

const BASE = 'http://127.0.0.1:1234/v1'

/** A minimal OpenAI chat-completions reply. */
function reply(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'qwen3-14b',
      choices: [{ message: { role: 'assistant', content: '{"findings":[]}' } }],
      usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
      ...over,
    }),
    text: async () => '',
  } as unknown as Response
}

let fetchMock: ReturnType<typeof vi.fn>
const ENV_KEYS = [
  'NEXUS_LOCAL_AI_BASE_URL',
  'NEXUS_LOCAL_AI_MODEL',
  'NEXUS_LOCAL_AI_API_KEY',
  'NEXUS_LOCAL_AI_TIMEOUT_MS',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  fetchMock = vi.fn(async () => reply())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.unstubAllGlobals()
})

/** The parsed JSON body of the Nth fetch call. */
function bodyOf(call = 0): any {
  return JSON.parse(fetchMock.mock.calls[call]![1]!.body as string)
}

describe('LocalProvider — configuration', () => {
  it('is not configured without a base URL', () => {
    expect(new LocalProvider().isConfigured()).toBe(false)
  })

  it('is configured as soon as a base URL is present', () => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = BASE
    expect(new LocalProvider().isConfigured()).toBe(true)
  })

  it('reports the env model as its default, re-read per access', () => {
    const p = new LocalProvider()
    process.env.NEXUS_LOCAL_AI_MODEL = 'qwen3-14b'
    expect(p.defaultModel).toBe('qwen3-14b')
    process.env.NEXUS_LOCAL_AI_MODEL = 'mistral-small-3.2-24b'
    expect(p.defaultModel).toBe('mistral-small-3.2-24b')
  })

  it('never reaches the network when unconfigured', async () => {
    await expect(
      new LocalProvider().generate({ prompt: 'hi' }),
    ).rejects.toThrow(/NEXUS_LOCAL_AI_BASE_URL/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('LocalProvider — request shape', () => {
  beforeEach(() => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = BASE
    process.env.NEXUS_LOCAL_AI_MODEL = 'qwen3-14b'
  })

  it('POSTs the OpenAI chat-completions shape', async () => {
    await new LocalProvider().generate({
      prompt: 'evidence here',
      temperature: 0.2,
      maxOutputTokens: 5000,
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE}/chat/completions`)
    expect(init.method).toBe('POST')
    expect(bodyOf()).toMatchObject({
      model: 'qwen3-14b',
      messages: [{ role: 'user', content: 'evidence here' }],
      temperature: 0.2,
      max_tokens: 5000,
    })
  })

  it('normalises a trailing slash on the base URL to exactly one separator', async () => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = `${BASE}/`
    await new LocalProvider().generate({ prompt: 'x' })
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/chat/completions`)
  })

  it('honours an explicit model override over the env default', async () => {
    await new LocalProvider().generate({ prompt: 'x', model: 'gemma-3-12b-it' })
    expect(bodyOf().model).toBe('gemma-3-12b-it')
  })

  it('sends an Authorization header, defaulted when no key is set', async () => {
    await new LocalProvider().generate({ prompt: 'x' })
    const h = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>
    expect(h.authorization).toMatch(/^Bearer /)
    process.env.NEXUS_LOCAL_AI_API_KEY = 'sk-local'
    await new LocalProvider().generate({ prompt: 'x' })
    const h2 = fetchMock.mock.calls[1]![1]!.headers as Record<string, string>
    expect(h2.authorization).toBe('Bearer sk-local')
  })

  it('carries an abort signal so a stalled local generation cannot hang a run', async () => {
    await new LocalProvider().generate({ prompt: 'x' })
    expect(fetchMock.mock.calls[0]![1]!.signal).toBeDefined()
  })
})

describe('LocalProvider — jsonMode (D6: json_object only, never json_schema)', () => {
  beforeEach(() => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = BASE
  })

  it('asks for a JSON object when jsonMode is on', async () => {
    await new LocalProvider().generate({ prompt: 'x', jsonMode: true })
    expect(bodyOf().response_format).toEqual({ type: 'json_object' })
  })

  it('never sends a json_schema response_format', async () => {
    await new LocalProvider().generate({ prompt: 'x', jsonMode: true })
    expect(JSON.stringify(bodyOf())).not.toContain('json_schema')
  })

  it('omits response_format entirely when jsonMode is off', async () => {
    await new LocalProvider().generate({ prompt: 'x' })
    expect(bodyOf()).not.toHaveProperty('response_format')
  })
})

describe('LocalProvider — response handling', () => {
  beforeEach(() => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = BASE
    process.env.NEXUS_LOCAL_AI_MODEL = 'qwen3-14b'
  })

  it('returns the assistant content and maps usage', async () => {
    const res = await new LocalProvider().generate({ prompt: 'x' })
    expect(res.text).toBe('{"findings":[]}')
    expect(res.usage).toEqual({
      provider: 'local',
      model: 'qwen3-14b',
      inputTokens: 1234,
      outputTokens: 56,
      costUSD: 0,
    })
  })

  it('costs exactly zero however many tokens were burned', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ usage: { prompt_tokens: 900_000, completion_tokens: 400_000 } }),
    )
    const res = await new LocalProvider().generate({ prompt: 'x' })
    expect(res.usage.costUSD).toBe(0)
  })

  it("reports the server's model id over the requested one", async () => {
    fetchMock.mockResolvedValueOnce(reply({ model: 'qwen3-14b-mlx-4bit' }))
    const res = await new LocalProvider().generate({ prompt: 'x', model: 'qwen3-14b' })
    expect(res.usage.model).toBe('qwen3-14b-mlx-4bit')
  })

  it('falls back to the requested model when the reply omits one', async () => {
    fetchMock.mockResolvedValueOnce(reply({ model: undefined }))
    const res = await new LocalProvider().generate({ prompt: 'x', model: 'gemma-3-12b-it' })
    expect(res.usage.model).toBe('gemma-3-12b-it')
  })

  it('yields zero tokens rather than NaN when usage is absent', async () => {
    fetchMock.mockResolvedValueOnce(reply({ usage: undefined }))
    const res = await new LocalProvider().generate({ prompt: 'x' })
    expect(res.usage.inputTokens).toBe(0)
    expect(res.usage.outputTokens).toBe(0)
  })

  it('yields empty text rather than throwing on a null content', async () => {
    fetchMock.mockResolvedValueOnce(
      reply({ choices: [{ message: { role: 'assistant', content: null } }] }),
    )
    const res = await new LocalProvider().generate({ prompt: 'x' })
    expect(res.text).toBe('')
  })

  it('throws with status and body on a non-2xx', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => 'model "qwen3-14b" not found',
    } as unknown as Response)
    await expect(new LocalProvider().generate({ prompt: 'x' })).rejects.toThrow(
      /Local AI error 404.*not found/s,
    )
  })
})
