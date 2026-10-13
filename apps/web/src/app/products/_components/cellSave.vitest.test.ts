/**
 * The product grid's inline cells (/catalog/organize): a second field of the same row is sent at the version the first
 * save left, not at the row's stale read, so it is never refused by this grid's own write. The stub server checks
 * If-Match the way PATCH /api/products/:id does (409 VERSION_CONFLICT with currentVersion) and answers `version`.
 */
import { describe, expect, it } from 'vitest'
import { cellSave, saveProductCell, type CellPatchReply } from './cellSave'

const PRODUCT = 'product-test-1'

function stubServer(start: number) {
  const server = {
    version: start,
    row: {} as Record<string, unknown>,
    sent: [] as Array<number | undefined>,
    patch(body: Record<string, unknown>) {
      return async (ifMatch: number | undefined): Promise<CellPatchReply> => {
        server.sent.push(ifMatch)
        await Promise.resolve()
        if (ifMatch !== undefined && ifMatch !== server.version) {
          return { ok: false, status: 409, json: { error: 'Product version mismatch — another change landed first', code: 'VERSION_CONFLICT', currentVersion: server.version } }
        }
        Object.assign(server.row, body)
        server.version += 1
        return { ok: true, status: 200, json: { id: PRODUCT, ...server.row, version: server.version } }
      }
    },
  }
  return server
}

describe('product grid inline cells — one save line', () => {
  it('brand, then product type on the same row: both saved while the row still shows its old version', async () => {
    const server = stubServer(3)
    const save = cellSave()
    const row = { id: PRODUCT, version: 3 } // the grid's read: the refetch has not landed
    expect(await saveProductCell(save, row.id, row.version, server.patch({ brand: 'Acme' }))).toEqual({ kind: 'saved' })
    expect(await saveProductCell(save, row.id, row.version, server.patch({ productType: 'HELMET' }))).toEqual({ kind: 'saved' })
    expect(server.sent).toEqual([3, 4])
    expect(server.row).toEqual({ brand: 'Acme', productType: 'HELMET' })
  })

  it('two commits in quick succession go one at a time', async () => {
    const server = stubServer(1)
    const save = cellSave()
    const results = await Promise.all([
      saveProductCell(save, PRODUCT, 1, server.patch({ brand: 'Acme' })),
      saveProductCell(save, PRODUCT, 1, server.patch({ productType: 'GLOVES' })),
    ])
    expect(results).toEqual([{ kind: 'saved' }, { kind: 'saved' }])
    expect(server.sent).toEqual([1, 2])
  })

  it('a change by anyone else is still a conflict, and a newer read is followed', async () => {
    const server = stubServer(1)
    const save = cellSave()
    expect(await saveProductCell(save, PRODUCT, 1, server.patch({ brand: 'Acme' }))).toEqual({ kind: 'saved' })
    server.version += 1 // someone else's write: version 3
    expect(await saveProductCell(save, PRODUCT, 1, server.patch({ productType: 'BAG' }))).toEqual({ kind: 'conflict', currentVersion: 3 })
    // The refetch brings version 3: the next save goes out at it.
    expect(await saveProductCell(save, PRODUCT, 3, server.patch({ productType: 'BAG' }))).toEqual({ kind: 'saved' })
  })

  it('a row without a version is sent without If-Match, and a lost connection is a failure', async () => {
    const save = cellSave()
    const sent: Array<number | undefined> = []
    const lost = await saveProductCell(save, PRODUCT, undefined, async (ifMatch) => { sent.push(ifMatch); throw new Error('Failed to fetch') })
    expect(sent).toEqual([undefined])
    expect(lost).toEqual({ kind: 'failed', message: 'Failed to fetch' })
  })
})
