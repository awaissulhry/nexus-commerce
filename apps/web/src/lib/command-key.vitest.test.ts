/**
 * The Idempotency-Key lifecycle the web runs against the API's durable command receipts
 * (`apps/api/src/lib/command-idempotency.ts`): one key per intent, kept while the outcome is
 * unknown, dropped once a response settles it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CommandKey,
  IDEMPOTENCY_KEY_HEADER,
  REUSED_ERROR,
  RUNNING_ERROR_PREFIX,
  commandConflict,
  commandConflictMessage,
  commandKeyFor,
  keepsKey,
  sendCommand,
} from './command-key'

const RUNNING_BODY = { error: 'The same request is still running. Wait for its result before sending it again.' }
const REUSED_BODY = { error: 'This Idempotency-Key was already used for a different request.' }

/** Keys k1, k2, … in minting order, so a test can say exactly which key went out. */
function counter() {
  let n = 0
  return () => `k${++n}`
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('commandConflict', () => {
  it('reads the idempotency layer’s 409 and 422 by their words, not by status alone', () => {
    expect(commandConflict(409, RUNNING_BODY)).toBe('running')
    expect(commandConflict(422, REUSED_BODY)).toBe('reused')
    // A route's own 409s are answers from the command itself, not the key layer.
    expect(commandConflict(409, { error: 'Wizard is already submitted.' })).toBeNull()
    expect(commandConflict(409, { error: 'GALE-JACKET is itself a child — pick a top-level parent' })).toBeNull()
    expect(commandConflict(422, { error: 'Unprocessable' })).toBeNull()
    expect(commandConflict(200, RUNNING_BODY)).toBeNull()
    expect(commandConflict(409, null)).toBeNull()
  })

  it('keeps the key only while the command may still be running or may have run unseen', () => {
    expect(keepsKey(409, RUNNING_BODY)).toBe(true)
    expect(keepsKey(502, null)).toBe(true)
    expect(keepsKey(503, null)).toBe(true)
    expect(keepsKey(504, null)).toBe(true)
    expect(keepsKey(200, {})).toBe(false)
    expect(keepsKey(201, {})).toBe(false)
    expect(keepsKey(422, REUSED_BODY)).toBe(false)
    expect(keepsKey(409, { error: 'Wizard is already submitted.' })).toBe(false)
    expect(keepsKey(400, { error: 'productId required' })).toBe(false)
    expect(keepsKey(500, { error: 'boom' })).toBe(false)
  })

  it('tells the operator what happened and what the next press does', () => {
    expect(commandConflictMessage('running', 'attach request')).toBe(
      'Your earlier attach request is still running on the server. Wait a few seconds, then try again: repeating the same request will not run it twice.',
    )
    expect(commandConflictMessage('reused', 'publish request')).toBe(
      'This publish request was not applied: an earlier attempt with different values already reached the server and has finished or is still running. Check the current state first; trying again sends your current values as a new request.',
    )
  })
})

describe('CommandKey', () => {
  it('mints one key per intent and reuses it until a response settles it', () => {
    const slot = new CommandKey(counter())
    expect(slot.pending).toBeNull()
    expect(slot.take()).toBe('k1')
    expect(slot.take()).toBe('k1') // no response yet: a retry is the same intent
    slot.settle('k1', 200, {})
    expect(slot.pending).toBeNull()
    expect(slot.take()).toBe('k2') // the next deliberate press is a new command
  })

  it.each([
    ['a 409 while the first attempt runs', 409, RUNNING_BODY, 'k1'],
    ['a gateway timeout', 504, null, 'k1'],
    ['a 422 for a different request', 422, REUSED_BODY, 'k2'],
    ['a route’s own 409', 409, { error: 'Wizard is already submitted.' }, 'k2'],
    ['a validation 400', 400, { error: 'productIds required' }, 'k2'],
    ['a server error the API answered itself', 500, { error: 'boom' }, 'k2'],
  ])('after %s, keeps or drops the key accordingly', (_label, status, body, next) => {
    const slot = new CommandKey(counter())
    const key = slot.take()
    slot.settle(key, status, body)
    expect(slot.take()).toBe(next)
  })

  it('does not let an older attempt drop a newer key', () => {
    const slot = new CommandKey(counter())
    const first = slot.take()
    slot.settle(first, 200, {})
    const second = slot.take()
    slot.settle(first, 200, {}) // a late answer to the first intent
    expect(slot.pending).toBe(second)
  })

  it('mints UUIDs by default', () => {
    expect(new CommandKey().take()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('commandKeyFor', () => {
  it('gives the same verb on the same subject one slot, and anything else its own', () => {
    expect(commandKeyFor('pim-attach:parent-1')).toBe(commandKeyFor('pim-attach:parent-1'))
    expect(commandKeyFor('pim-attach:parent-1')).not.toBe(commandKeyFor('pim-attach:parent-2'))
    expect(commandKeyFor('pim-attach:p')).not.toBe(commandKeyFor('pim-promote:p'))
  })
})

describe('sendCommand', () => {
  function stubFetch(...answers: Array<Response | Error>) {
    const calls: Array<{ url: string; init: RequestInit; key: string | null }> = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, key: new Headers(init.headers).get(IDEMPOTENCY_KEY_HEADER) })
      const answer = answers.shift()
      if (!answer) throw new Error('unexpected request')
      if (answer instanceof Error) throw answer
      return answer
    })
    vi.stubGlobal('fetch', fetcher)
    return calls
  }

  const init: RequestInit = { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }

  it('sends the intent’s key with the caller’s own headers and options intact', async () => {
    const calls = stubFetch(json(200, { ok: true }))
    const sent = await sendCommand(new CommandKey(counter()), 'http://api.test/api/x', init)
    expect(sent.response.status).toBe(200)
    expect(sent.body).toEqual({ ok: true })
    expect(sent.conflict).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.key).toBe('k1')
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/json')
    expect(calls[0]!.init.credentials).toBe('include')
    expect(calls[0]!.init.body).toBe('{"a":1}')
  })

  it('retries a lost response with the same key, then starts a new command after it completes', async () => {
    const calls = stubFetch(new TypeError('Failed to fetch'), json(200, { replicated: 4 }), json(200, { replicated: 1 }))
    const slot = new CommandKey(counter())
    await expect(sendCommand(slot, 'http://api.test/api/x', init)).rejects.toThrow('Failed to fetch')
    expect(slot.pending).toBe('k1')
    await sendCommand(slot, 'http://api.test/api/x', init) // the retry: replayed or run once
    await sendCommand(slot, 'http://api.test/api/x', init) // a new deliberate press
    expect(calls.map((c) => c.key)).toEqual(['k1', 'k1', 'k2'])
  })

  it('keeps the key through a 409 “still running” and reports it', async () => {
    const calls = stubFetch(json(409, RUNNING_BODY), json(200, { success: true }))
    const slot = new CommandKey(counter())
    const first = await sendCommand(slot, 'http://api.test/api/x', init)
    expect(first.conflict).toBe('running')
    const second = await sendCommand(slot, 'http://api.test/api/x', init)
    expect(second.conflict).toBeNull()
    expect(calls.map((c) => c.key)).toEqual(['k1', 'k1'])
    expect(slot.pending).toBeNull()
  })

  it('drops the key after a 422, so the corrected request goes out as a new command', async () => {
    const calls = stubFetch(new TypeError('Failed to fetch'), json(422, REUSED_BODY), json(200, { success: true }))
    const slot = new CommandKey(counter())
    await expect(sendCommand(slot, 'http://api.test/api/x', init)).rejects.toThrow()
    const refused = await sendCommand(slot, 'http://api.test/api/x', { ...init, body: '{"a":2}' })
    expect(refused.conflict).toBe('reused')
    await sendCommand(slot, 'http://api.test/api/x', { ...init, body: '{"a":2}' })
    expect(calls.map((c) => c.key)).toEqual(['k1', 'k1', 'k2'])
  })

  it('hands back a null body when the answer is not JSON', async () => {
    stubFetch(new Response('<html>Bad gateway</html>', { status: 502 }))
    const slot = new CommandKey(counter())
    const sent = await sendCommand(slot, 'http://api.test/api/x', init)
    expect(sent.body).toBeNull()
    expect(sent.conflict).toBeNull()
    expect(slot.pending).toBe('k1') // the proxy answered; the API may still be running it
  })
})

/**
 * The contract with the API, read from its source: the words `commandConflict` matches, and the
 * routes that honour a key. Every web caller of those routes must send one through `sendCommand`.
 */
describe('the API’s command receipts', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const api = readFileSync(path.join(root, 'apps/api/src/lib/command-idempotency.ts'), 'utf8')

  it('still answers with the words the web recognises', () => {
    expect(api).toContain(`'${RUNNING_ERROR_PREFIX}`)
    expect(api).toContain(`'${REUSED_ERROR}'`)
  })

  const scopes = api.match(/const COMMAND_SCOPES[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? ''
  const routes = [...scopes.matchAll(/'(\/api\/[^']+)'\s*:/g)].map((m) => m[1]!)

  it('honours a key on exactly the routes the web keys', () => {
    expect(routes.sort()).toEqual([
      '/api/categories/schema/download',
      '/api/listing-wizard/:id/submit',
      '/api/pim/attach-to-parent',
      '/api/pim/category-workspace/EBAY/site-assignments',
      '/api/pim/promote-to-parent',
    ])
  })

  it('is called from the web only through sendCommand', () => {
    const src = path.join(root, 'apps/web/src')
    const files = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !f.endsWith('.vitest.test.ts'))
    // `:id` is any interpolated segment: `/api/listing-wizard/${wizardId}/submit`.
    const patterns = routes.map((r) => new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:id/g, '\\$\\{[^}]+\\}') + '(?![\\w-])'))
    const callers = files.filter((f) => {
      const text = readFileSync(path.join(src, f), 'utf8')
      return patterns.some((p) => p.test(text))
    })
    // A positive control: the walk found the callers this change keys.
    expect(callers.length).toBeGreaterThanOrEqual(5)
    for (const file of callers) {
      expect(readFileSync(path.join(src, file), 'utf8'), file).toMatch(/\bsendCommand\b/)
    }
  })
})
