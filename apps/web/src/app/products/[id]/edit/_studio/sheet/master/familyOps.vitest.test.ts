/**
 * The studio's attach and promote verbs send one Idempotency-Key per intent. The key slot lives
 * with the verb and its subject (`familyOps` has no component to hold it), so a retry after a lost
 * response reuses it, and a different product never inherits it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://api.test' }))

import { familyOps } from './familyOps'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const ATTACHED = { success: true, attached: 1, errors: [], parentId: 'p' }

function stubFetch(...answers: Array<Response | Error>) {
  const sent: Array<{ url: string; key: string | null; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, key: new Headers(init.headers).get('Idempotency-Key'), body: JSON.parse(String(init.body)) })
    const answer = answers.shift()
    if (!answer) throw new Error('unexpected request')
    if (answer instanceof Error) throw answer
    return answer
  }))
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('familyOps attach', () => {
  it('retries a lost response with the same key and starts a new command after it lands', async () => {
    const sent = stubFetch(new TypeError('Failed to fetch'), json(200, ATTACHED), json(200, ATTACHED))
    await expect(familyOps.attach('parent-a', ['c1'])).rejects.toThrow('Failed to fetch')
    await expect(familyOps.attach('parent-a', ['c1'])).resolves.toEqual(ATTACHED)
    await familyOps.attach('parent-a', ['c2'])
    expect(sent.map((s) => s.url)).toEqual(Array(3).fill('http://api.test/api/pim/attach-to-parent'))
    const [first, retry, next] = sent.map((s) => s.key)
    expect(first).toBeTruthy()
    expect(retry).toBe(first)
    expect(next).toBeTruthy()
    expect(next).not.toBe(first)
  })

  it('does not carry a pending key to another parent', async () => {
    const sent = stubFetch(new TypeError('Failed to fetch'), json(200, ATTACHED))
    await expect(familyOps.attach('parent-b', ['c1'])).rejects.toThrow()
    await familyOps.attach('parent-c', ['c1'])
    expect(sent[1]!.key).not.toBe(sent[0]!.key)
  })

  it('says a 409 is the earlier attempt still running, and keeps the key for the retry', async () => {
    const sent = stubFetch(
      json(409, { error: 'The same request is still running. Wait for its result before sending it again.' }),
      json(200, ATTACHED),
    )
    await expect(familyOps.attach('parent-d', ['c1'])).rejects.toThrow('Your earlier attach request is still running on the server.')
    await familyOps.attach('parent-d', ['c1'])
    expect(sent[1]!.key).toBe(sent[0]!.key)
  })

  it('passes a route’s own 409 through in the server’s words', async () => {
    stubFetch(json(409, { error: 'GALE-JACKET is itself a child — pick a top-level parent' }))
    await expect(familyOps.attach('parent-e', ['c1'])).rejects.toThrow('GALE-JACKET is itself a child — pick a top-level parent')
  })
})

describe('familyOps promote', () => {
  it('explains a 422 and sends the corrected request under a new key', async () => {
    const sent = stubFetch(
      new TypeError('Failed to fetch'),
      json(422, { error: 'This Idempotency-Key was already used for a different request.' }),
      json(200, { success: true, productId: 'solo-a' }),
    )
    await expect(familyOps.promote('solo-a', 'Size', ['Size'])).rejects.toThrow('Failed to fetch')
    await expect(familyOps.promote('solo-a', 'Color', ['Color'])).rejects.toThrow(
      'This promote request was not applied: an earlier attempt with different values already reached the server',
    )
    await expect(familyOps.promote('solo-a', 'Color', ['Color'])).resolves.toEqual({ success: true, productId: 'solo-a' })
    expect(sent.map((s) => s.url)).toEqual(Array(3).fill('http://api.test/api/pim/promote-to-parent'))
    expect(sent[1]!.key).toBe(sent[0]!.key)
    expect(sent[2]!.key).not.toBe(sent[1]!.key)
  })
})

describe('verbs the API does not deduplicate', () => {
  it('send no Idempotency-Key', async () => {
    const sent = stubFetch(json(200, { success: true, detached: 1 }))
    await familyOps.unlink(['c1'], 'p')
    expect(sent[0]!.key).toBeNull()
  })
})
