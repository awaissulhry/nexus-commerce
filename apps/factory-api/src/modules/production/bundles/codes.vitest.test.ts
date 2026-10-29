import { describe, expect, it } from 'vitest'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { formatScanId, parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { withTicketCodes } from './codes'

/**
 * withTicketCodes (codes.ts) without a database: the tenant-wide highest code read as the tenant's system caller, the
 * caller's own view read again under the lock, the codes run on from the higher one, and a code another site took (the
 * unique key, P2002) runs the write again from a fresh read, at most four times.
 */

const tenantId = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const tag = tenantTag(tenantId)
const code = (ref: number) => formatScanId({ type: 'BUNDLE', tenantTag: tag, ref })
const refOf = (text: string) => {
  const scan = parseScanId(text, { tenantTag: tag, types: ['BUNDLE'] })
  return scan.ok ? scan.ref : -1
}

/** A floor caller whose every client answers the "highest code" query from `highest()`; records who asked. */
function callerWith(highest: () => number | null) {
  const asked: string[] = []
  const caller: CommandCaller = {
    factoryContext: { audience: 'floor', tenantId, actorId: 'a', siteId: 's', deviceId: 'd', grants: [], requestId: 'r' } as unknown as CommandCaller['factoryContext'],
    async withClient(work) {
      asked.push(String((this as CommandCaller).factoryContext?.audience))
      const value = highest()
      return work({ $queryRaw: async () => (value === null ? [] : [{ code: code(value) }]) } as never)
    },
  }
  return { caller, asked }
}

const txSeeing = (ref: number | null) => {
  const locks: string[] = []
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray) => locks.push(strings.join('?')),
    $queryRaw: async () => (ref === null ? [] : [{ code: code(ref) }]),
  } as unknown as CommandTx
  return { tx, locks }
}

describe('ticket codes for bundles (until the floor numbering step)', () => {
  it("reads the tenant's highest code as the system caller and runs on from the higher of it and the caller's own view", async () => {
    const { caller, asked } = callerWith(() => 40)
    const { tx, locks } = txSeeing(12)
    const codes = await withTicketCodes(caller, (ticketCodes) => ticketCodes.take(tx, 3))
    expect(codes.map(refOf)).toEqual([41, 42, 43])
    expect(asked).toEqual(['system'])
    expect(locks.join(' ')).toContain('factory.bundle-code')
    // The caller's site made one since the system read: its view wins.
    expect((await withTicketCodes(callerWith(() => 40).caller, (ticketCodes) => ticketCodes.take(txSeeing(44).tx, 1))).map(refOf)).toEqual([45])
    expect((await withTicketCodes(callerWith(() => null).caller, (ticketCodes) => ticketCodes.take(txSeeing(null).tx, 1))).map(refOf)).toEqual([1])
  })

  it('runs the write again from a fresh read when another site took the codes (unique key), at most four times', async () => {
    let highest = 40
    const { caller, asked } = callerWith(() => highest)
    let tries = 0
    const codes = await withTicketCodes(caller, async (ticketCodes) => {
      tries++
      const taken = await ticketCodes.take(txSeeing(null).tx, 1)
      if (tries === 1) {
        highest = 41
        throw Object.assign(new Error('Unique constraint failed on the fields: (`tenantId`,`code`)'), { code: 'P2002' })
      }
      return taken
    })
    expect(tries).toBe(2)
    expect(asked).toEqual(['system', 'system'])
    expect(codes.map(refOf)).toEqual([42])
    let always = 0
    await expect(
      withTicketCodes(callerWith(() => 1).caller, async () => {
        always++
        throw Object.assign(new Error('taken'), { code: 'P2002' })
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(always).toBe(4)
    // Any other failure is the write's own: never run again.
    let once = 0
    await expect(
      withTicketCodes(callerWith(() => 1).caller, async () => {
        once++
        throw new Error('the printer caught fire')
      }),
    ).rejects.toThrow('the printer caught fire')
    expect(once).toBe(1)
  })
})
