/**
 * Settings › PIM › Families — two quick drags: each is one request, the second waits for the first, no read paints the
 * old order while a drag is in flight, and the page reads once after the last drag. `fetch` is a stub server that keeps
 * the family's order and answers the PUT /api/families/:id/attribute-order route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { familySave, sendAttributeOrder } from './familySave'

const FAMILY = 'family-test-1'
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

type Held = Array<() => void>
const server = {
  order: ['fa-a', 'fa-b', 'fa-c'],
  puts: [] as string[][],
  holdPuts: false,
  heldPuts: [] as Held,
  inFlight: 0,
  maxInFlight: 0,
}
const hold = (on: boolean, line: Held) => (on ? new Promise<void>((resolve) => line.push(resolve)) : Promise.resolve())

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://127.0.0.1:8080') // never a real host: fetch is the stub below
  Object.assign(server, { order: ['fa-a', 'fa-b', 'fa-c'], puts: [], holdPuts: false, heldPuts: [], inFlight: 0, maxInFlight: 0 })
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    expect(url).toMatch(new RegExp(`/api/families/${FAMILY}/attribute-order$`))
    expect(init?.method).toBe('PUT')
    const ids = JSON.parse(init!.body!).familyAttributeIds as string[]
    server.puts.push(ids)
    server.inFlight += 1
    server.maxInFlight = Math.max(server.maxInFlight, server.inFlight)
    await hold(server.holdPuts, server.heldPuts)
    server.order = [...ids]
    server.inFlight -= 1
    return { ok: true, status: 200, json: async () => ({ familyId: FAMILY }) }
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

function page() {
  const painted: string[][] = []
  const reads: Array<{ release: () => void }> = []
  let holdReads = false
  const save = familySave<string[]>({
    read: async () => {
      const snapshot = [...server.order] // taken when the read reaches the server
      if (holdReads) await new Promise<void>((resolve) => reads.push({ release: resolve }))
      return snapshot
    },
    paint: (order) => { painted.push(order) },
    readFailed: () => { throw new Error('no read should fail here') },
  })
  return { save, painted, reads, holdReadsFrom: (on: boolean) => { holdReads = on } }
}

describe('family attribute order — one request per drag, one at a time', () => {
  it('two quick drags: the second waits for the first, and the page reads once, after the last', async () => {
    const p = page()
    server.holdPuts = true
    const first = p.save.write(() => sendAttributeOrder(FAMILY, ['fa-b', 'fa-a', 'fa-c']))
    const second = p.save.write(() => sendAttributeOrder(FAMILY, ['fa-c', 'fa-b', 'fa-a']))
    await flush()
    expect(server.puts).toEqual([['fa-b', 'fa-a', 'fa-c']]) // the second drag waits
    server.heldPuts.shift()!()
    await flush()
    expect(server.puts).toHaveLength(2)
    expect(p.painted).toEqual([]) // no re-read between the two drags
    server.heldPuts.shift()!()
    await Promise.all([first, second])
    await flush()
    expect(server.maxInFlight).toBe(1)
    expect(server.order).toEqual(['fa-c', 'fa-b', 'fa-a'])
    expect(p.painted).toEqual([['fa-c', 'fa-b', 'fa-a']])
  })

  it('a read that started before a drag never paints the old order over it', async () => {
    const p = page()
    p.holdReadsFrom(true)
    const before = p.save.refresh() // e.g. the reload after a "required" toggle
    p.holdReadsFrom(false)
    server.holdPuts = true
    const drag = p.save.write(() => sendAttributeOrder(FAMILY, ['fa-c', 'fa-a', 'fa-b']))
    await flush()
    p.reads.shift()!.release() // the old order answers while the drag is in flight
    await before
    expect(p.painted).toEqual([])
    server.heldPuts.shift()!()
    await drag
    await flush()
    expect(p.painted).toEqual([['fa-c', 'fa-a', 'fa-b']])
  })

  it('the read after drag 1, landing after drag 2 has saved, never paints drag 1’s order', async () => {
    const p = page()
    p.holdReadsFrom(true)
    const drag1 = p.save.write(() => sendAttributeOrder(FAMILY, ['fa-b', 'fa-a', 'fa-c']))
    await flush() // drag 1 saved; its read is out with drag 1's order
    expect(p.reads).toHaveLength(1)
    const drag2 = p.save.write(() => sendAttributeOrder(FAMILY, ['fa-c', 'fa-b', 'fa-a']))
    await flush() // drag 2 saved; its own read is out too
    expect(p.reads).toHaveLength(2)
    p.reads[0].release() // drag 1's read lands now, after drag 2 has settled
    await flush()
    expect(p.painted).toEqual([]) // painting it would put drag 1's order back under drag 2
    p.reads[1].release()
    await Promise.all([drag1, drag2])
    expect(p.painted).toEqual([['fa-c', 'fa-b', 'fa-a']])
  })

  it('a refused drag says why, and the page reads the server’s order again', async () => {
    const p = page()
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 409, json: async () => ({ error: 'The attributes of this family changed after the page read them.' }) }))
    await expect(p.save.write(() => sendAttributeOrder(FAMILY, ['fa-a']))).rejects.toThrow('changed after the page read them')
    await flush()
    expect(p.painted).toEqual([['fa-a', 'fa-b', 'fa-c']])
  })
})
