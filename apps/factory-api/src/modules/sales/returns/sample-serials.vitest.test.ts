import { describe, expect, it } from 'vitest'
import { sampleSerialProblems } from './sample-serials'
import type { Reader } from './store'

/** B-W2b-284: a return line's typed serial of a sample made for no order line is refused in words. Made-up serials only. */

const reader = (samples: { serial: string }[], asked: unknown[] = []): Reader =>
  ({
    garmentSerial: {
      findMany: async (query: { where: { serial: { in: string[] } } }) => {
        asked.push(query.where)
        return samples.filter((row) => query.where.serial.in.includes(row.serial)).map((row) => ({ serial: row.serial }))
      },
    },
  }) as unknown as Reader

describe('a sample serial on a return line (B-W2b-284)', () => {
  it('refuses a sample made for no order line, at its line, in words naming no work order (a customer reads them); any other serial passes', async () => {
    const db = reader([{ serial: 'DEMO-S-0001' }])
    const problems = await sampleSerialProblems(db, [
      { serial: 'demo-s-0001 ', path: 'body/lines/0/serial' },
      { serial: 'DEMO-SOLD-0002', path: 'body/lines/1/serial' },
      { serial: null, path: 'body/lines/2/serial' },
    ])
    expect(problems).toEqual([
      { path: 'body/lines/0/serial', message: 'Serial demo-s-0001 is a sample made for no order: it was never sold, so it does not come back on a return.' },
    ])
  })

  it('asks nothing when no serial is typed, and asks only cells of no order line', async () => {
    const asked: unknown[] = []
    expect(await sampleSerialProblems(reader([], asked), [{ serial: '  ', path: 'body/serial' }, { serial: undefined, path: 'body/serial' }])).toEqual([])
    expect(asked).toEqual([])
    await sampleSerialProblems(reader([], asked), [{ serial: 'Demo-1', path: 'body/serial' }])
    expect(asked).toEqual([{ serial: { in: ['Demo-1', 'DEMO-1'] }, workOrderSize: { salesOrderLineId: null } }])
  })
})
