import { describe, expect, it } from 'vitest'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { withTicketCodes } from './codes'

/**
 * withTicketCodes (codes.ts) without a database: the codes are the tenant's BUNDLE counter's (platform/numbering
 * allocateScanIds): under the tenant's `factory.scan-ids` lock for BUNDLE, after the highest block, as one ONLINE block
 * written in the command's own transaction, for the floor too. The database side (the guard trigger, two sites at once)
 * is in platform/numbering/scan-ids.pg.vitest.test.ts and the bundles' PostgreSQL tests.
 */

const tenantId = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const tag = tenantTag(tenantId)
const refOf = (text: string) => {
  const scan = parseScanId(text, { tenantTag: tag, types: ['BUNDLE'] })
  return scan.ok ? scan.ref : -1
}

const floorCaller = (audience = 'floor'): CommandCaller => ({
  factoryContext: { audience, tenantId, actorId: 'a', siteId: 's', deviceId: 'd', grants: [], requestId: 'r-1' } as unknown as CommandCaller['factoryContext'],
  withClient: () => Promise.reject(new Error('withTicketCodes reads nothing outside the command')),
})

/** A transaction whose highest BUNDLE block ends at `highest`; records the statements and the block written. */
function txWithHighest(highest: number | null) {
  const statements: string[] = []
  const blocks: Record<string, unknown>[] = []
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => statements.push(`${strings.join('?')} ${values.join(',')}`),
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push(`${strings.join('?')} ${values.join(',')}`)
      return [{ highest }]
    },
    numberBlock: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        blocks.push(data)
        return { id: data.id }
      },
    },
  } as unknown as CommandTx
  return { tx, statements, blocks }
}

describe('ticket codes for bundles', () => {
  it("take the next BUNDLE numbers of the tenant's counter, under its lock, as one ONLINE block in the command", async () => {
    const { tx, statements, blocks } = txWithHighest(40)
    const codes = await withTicketCodes(floorCaller(), (ticketCodes) => ticketCodes.take(tx, 3))
    expect(codes.map(refOf)).toEqual([41, 42, 43])
    expect(statements[0]).toContain('factory.scan-ids')
    expect(statements[0]).toContain(`${tenantId},BUNDLE`)
    expect(statements[1]).toContain('max("toRef")')
    expect(blocks).toEqual([expect.objectContaining({ kind: 'BUNDLE', purpose: 'ONLINE', fromRef: 41, toRef: 43, deviceId: null, requestId: 'r-1' })])
    // The first codes of a tenant start at 1.
    expect((await withTicketCodes(floorCaller('office'), (ticketCodes) => ticketCodes.take(txWithHighest(null).tx, 1))).map(refOf)).toEqual([1])
  })

  it('are made for a tenant only', async () => {
    await expect(withTicketCodes(floorCaller('platform'), async () => 'never')).rejects.toBeInstanceOf(ConflictError)
  })
})
