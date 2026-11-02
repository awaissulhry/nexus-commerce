import { describe, expect, it } from 'vitest'
import type { GateReader } from './gate'
import { workerGate, workerGatesFor, workersAmong } from './worker-gate'

const NAMES = new Map([['w1', 'Made-up Worker']])

describe('who did a piece of work, as an office read tells it (Statuto art. 4 c.1; GATE-LABOUR)', () => {
  it('with the gate not open: no name, no id, and the record says a person is on it', () => {
    const who = workerGate(false)
    expect(who.lookup(['w1', null, undefined])).toEqual([])
    expect(who.id('w1')).toBeNull()
    expect(who.person('w1', NAMES)).toBeNull()
    expect(who.name('w1', NAMES)).toBeNull()
    expect(who.hidden('w1')).toBe(true)
  })

  it('with the gate open: the worker, as the read answered before', () => {
    const who = workerGate(true)
    expect(who.lookup(['w1', null, undefined])).toEqual(['w1'])
    expect(who.id('w1')).toBe('w1')
    expect(who.person('w1', NAMES)).toEqual({ id: 'w1', name: 'Made-up Worker' })
    expect(who.name('w1', NAMES)).toBe('Made-up Worker')
    expect(who.hidden('w1')).toBe(false)
  })

  it('a row that names nobody (a site that records the station) is not hidden: there is nobody to hide', () => {
    for (const open of [false, true]) {
      const who = workerGate(open)
      expect(who.person(null, NAMES)).toBeNull()
      expect(who.id(null)).toBeNull()
      expect(who.hidden(null)).toBe(false)
      expect(who.hidden(undefined)).toBe(false)
    }
  })

  it('an author column: a worker follows the gate, an office user stays, nobody is nobody (B-W2b-F4)', () => {
    expect(workerGate(false).author('w1', true)).toEqual({ id: null, hidden: true })
    expect(workerGate(true).author('w1', true)).toEqual({ id: 'w1', hidden: false })
    for (const open of [false, true]) {
      expect(workerGate(open).author('u1', false)).toEqual({ id: 'u1', hidden: false })
      expect(workerGate(open).author(null, true)).toEqual({ id: null, hidden: false })
    }
  })
})

describe('the gate of every site of a list (B-W2b-F4)', () => {
  const NOW = new Date(Date.now() - 60_000)
  const readerOf = (openSites: readonly string[]) => {
    const asked: string[] = []
    const peopleLegalGate = {
      findFirst: async ({ where }: { where: { siteId: string } }) => {
        asked.push(where.siteId)
        return openSites.includes(where.siteId) ? { purpose: 'PERFORMANCE', switchedOnAt: NOW, switchedOffAt: null, basis: 'UNION_AGREEMENT', basisReference: 'SAMPLE', noticeId: 'n', dpiaId: 'd' } : null
      },
    }
    return { asked, db: { peopleLegalGate } as unknown as GateReader }
  }

  it('reads each site once, however many rows name it', async () => {
    const { asked, db } = readerOf(['s1'])
    await workerGatesFor(db, ['s1', 's2', 's1', 's1', null, undefined, 's2'])
    expect(asked.sort()).toEqual(['s1', 's2'])
  })

  it('answers per site, and a site it did not read, or no site, is not open', async () => {
    const gates = await workerGatesFor(readerOf(['s1']).db, ['s1', 's2'])
    expect(gates.at('s1').open).toBe(true)
    expect(gates.at('s2').open).toBe(false)
    expect(gates.at('s3').open).toBe(false)
    expect(gates.at(null).open).toBe(false)
  })

  it('reads no gate for a list with nobody on it', async () => {
    const { asked, db } = readerOf(['s1'])
    await workerGatesFor(db, [])
    expect(asked).toEqual([])
  })

  it('tells the workers among ids, and asks nothing for none', async () => {
    const asked: unknown[] = []
    const db = { worker: { findMany: async (query: { where: { id: { in: string[] } } }) => (asked.push(query.where.id.in), [{ id: 'w1' }]) } } as never
    expect([...(await workersAmong(db, ['w1', 'u1', 'w1', null, undefined]))]).toEqual(['w1'])
    expect(asked).toEqual([['w1', 'u1']])
    expect((await workersAmong(db, [null])).size).toBe(0)
    expect(asked).toHaveLength(1)
  })
})
