/**
 * The listing drawer's save line: two quick toggles both land (the second is sent at the version the first left, not
 * at the drawer's last read), a move by anyone else is still refused, and an older reload never paints over a newer one.
 * The stub server checks `expectedVersion` the way PATCH /api/listings/:id does and answers `{ listing: { version } }`.
 */
import { describe, expect, it } from 'vitest'
import { drawerSave, sendDrawerPatch, type DrawerPatchReply } from './drawer-save'

const LISTING = 'listing-test-1'

function stubServer(start = 1) {
  const server = {
    version: start,
    fields: {} as Record<string, unknown>,
    sent: [] as Array<number | undefined>,
    async patch(body: Record<string, unknown>): Promise<DrawerPatchReply> {
      const { expectedVersion, ...change } = body as { expectedVersion?: number }
      server.sent.push(expectedVersion)
      await Promise.resolve()
      if (expectedVersion !== undefined && expectedVersion !== server.version) {
        return { ok: false, status: 409, json: { error: 'This listing changed after you opened it.', currentVersion: server.version } }
      }
      Object.assign(server.fields, change)
      server.version += 1
      return { ok: true, status: 200, json: { ok: true, listing: { id: LISTING, version: server.version } } }
    },
  }
  return server
}

describe('listing drawer — one save line', () => {
  it('a second quick toggle is sent at the version the first left, and both land', async () => {
    const server = stubServer(1)
    const save = drawerSave()
    const shown = { version: 1 } // the drawer's last read: the reload has not landed yet
    const first = sendDrawerPatch(save, LISTING, () => shown.version, { followMasterPrice: false }, server.patch)
    const second = sendDrawerPatch(save, LISTING, () => shown.version, { followMasterTitle: false }, server.patch)
    expect(await first).toMatchObject({ ok: true })
    expect(await second).toMatchObject({ ok: true })
    expect(server.sent).toEqual([1, 2])
    expect(server.fields).toEqual({ followMasterPrice: false, followMasterTitle: false })
  })

  it('a toggle after the first answered, before its reload, is not refused', async () => {
    const server = stubServer(4)
    const save = drawerSave()
    expect(await sendDrawerPatch(save, LISTING, () => 4, { stockBuffer: 2 }, server.patch)).toMatchObject({ ok: true })
    expect(await sendDrawerPatch(save, LISTING, () => 4, { stockBuffer: 3 }, server.patch)).toMatchObject({ ok: true })
    expect(server.version).toBe(6)
  })

  it('a move by anyone else is still refused', async () => {
    const server = stubServer(1)
    const save = drawerSave()
    expect(await sendDrawerPatch(save, LISTING, () => 1, { followMasterPrice: false }, server.patch)).toMatchObject({ ok: true })
    server.version += 1 // another person's write
    const refused = await sendDrawerPatch(save, LISTING, () => 1, { followMasterPrice: true }, server.patch)
    expect(refused).toEqual({ ok: false, error: 'This listing changed after you opened it.' })
    // The reload brings the newer version; the next toggle goes out at it.
    expect(await sendDrawerPatch(save, LISTING, () => 3, { followMasterPrice: true }, server.patch)).toMatchObject({ ok: true })
  })

  it('a lost connection is a failed write, and the line goes on', async () => {
    const server = stubServer(1)
    const save = drawerSave()
    const lost = sendDrawerPatch(save, LISTING, () => 1, { stockBuffer: 1 }, async () => { throw new Error('Failed to fetch') })
    const next = sendDrawerPatch(save, LISTING, () => 1, { stockBuffer: 2 }, server.patch)
    expect(await lost).toEqual({ ok: false, error: 'Failed to fetch' })
    expect(await next).toMatchObject({ ok: true })
  })

  it('the reload of the first toggle never paints over the reload of the second', async () => {
    const save = drawerSave()
    let releaseFirst!: (v: { version: number }) => void
    const firstReload = save.line.read(() => new Promise<{ version: number }>((resolve) => { releaseFirst = resolve }))
    const secondReload = save.line.read(async () => ({ version: 3 }))
    expect(await secondReload).toMatchObject({ kind: 'fresh', value: { version: 3 } })
    releaseFirst({ version: 2 })
    expect(await firstReload).toEqual({ kind: 'stale' })
  })
})
