import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { id: string; userId: string; surface: string; payload: unknown; createdAt: Date; updatedAt: Date }
const db = vi.hoisted(() => ({ rows: [] as Row[], serial: 0, raceOnCreate: false }))

vi.mock('../../db.js', () => {
  const byKey = (userId: string, surface: string) => db.rows.find((r) => r.userId === userId && r.surface === surface) ?? null
  const userSheetLayout = {
    findUnique: vi.fn(async ({ where }: { where: { userId_surface: { userId: string; surface: string } } }) =>
      structuredClone(byKey(where.userId_surface.userId, where.userId_surface.surface))),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => structuredClone(db.rows.find((r) => r.id === where.id)!)),
    create: vi.fn(async ({ data }: { data: Pick<Row, 'userId' | 'surface' | 'payload'> }) => {
      if (db.raceOnCreate || byKey(data.userId, data.surface)) throw Object.assign(new Error('duplicate'), { code: 'P2002' })
      const row = { ...data, id: `l${++db.serial}`, createdAt: new Date(), updatedAt: new Date(Date.now() + db.serial) }
      db.rows.push(row)
      return structuredClone(row)
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; userId: string; updatedAt: Date }; data: Partial<Row> }) => {
      const row = db.rows.find((r) => r.id === where.id && r.userId === where.userId && r.updatedAt.getTime() === where.updatedAt.getTime())
      if (!row) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    }),
  }
  return { default: { userSheetLayout } }
})

const { readUserSheetLayout, writeUserSheetLayout } = await import('./user-sheet-layout.service.js')

/** A minimal valid "Current layout" payload (schema 3, plus the pick). */
const layout = (columns: string[], extra: Record<string, unknown> = {}) => ({
  v: 3, kind: 'columns', columns, columnOrder: columns, lockedColumns: [], groupOrder: ['sheet:offer-identity'], groupOverrides: {}, picked: { kind: 'custom' }, ...extra,
})
const SURFACE = 'product-edit:layout:EBAY'

beforeEach(() => { db.rows = []; db.serial = 0; db.raceOnCreate = false })

describe('a person\'s own sheet layout (the same in every business profile)', () => {
  it('is created, read back and replaced — always the signed-in user\'s, never another person\'s', async () => {
    expect(await readUserSheetLayout('owner', SURFACE)).toEqual([])
    const created = await writeUserSheetLayout('owner', { surface: SURFACE, filters: layout(['name']) })
    expect(created).toMatchObject({ name: 'Current layout', surface: SURFACE, filters: layout(['name']) })
    const replaced = await writeUserSheetLayout('owner', { surface: SURFACE, filters: layout(['name', 'price'], { columnWidths: { name: 240 }, density: 'cozy' }), expectedUpdatedAt: created.updatedAt })
    expect(new Date(replaced.updatedAt).getTime()).toBeGreaterThan(new Date(created.updatedAt).getTime())
    expect((await readUserSheetLayout('owner', SURFACE))[0].filters).toMatchObject({ columns: ['name', 'price'], columnWidths: { name: 240 }, density: 'cozy' })
    expect(await readUserSheetLayout('someone-else', SURFACE)).toEqual([])
  })

  it('refuses a write that names an older version, or creates over an existing record (another tab) — 409', async () => {
    const created = await writeUserSheetLayout('owner', { surface: SURFACE, filters: layout(['name']) })
    await writeUserSheetLayout('owner', { surface: SURFACE, filters: layout(['price']), expectedUpdatedAt: created.updatedAt })
    await expect(writeUserSheetLayout('owner', { surface: SURFACE, filters: layout(['sku']), expectedUpdatedAt: created.updatedAt })).rejects.toMatchObject({ status: 409 })
    await expect(writeUserSheetLayout('owner', { surface: SURFACE, filters: layout(['sku']) })).rejects.toMatchObject({ status: 409 })
    db.rows = []; db.raceOnCreate = true
    await expect(writeUserSheetLayout('owner', { surface: SURFACE, filters: layout(['sku']) })).rejects.toMatchObject({ status: 409 })
  })

  it('takes one layout per sheet, never a per-market or unknown surface, and only a valid layout', async () => {
    await expect(readUserSheetLayout('owner', 'product-edit:layout:EBAY:IT')).rejects.toMatchObject({ status: 400 })
    await expect(writeUserSheetLayout('owner', { surface: 'products', filters: layout(['name']) })).rejects.toMatchObject({ status: 400 })
    await expect(writeUserSheetLayout('owner', { surface: 'product-edit:layout:master', filters: { v: 3, kind: 'columns', columns: ['name'] } })).rejects.toMatchObject({ status: 400 })
    await expect(writeUserSheetLayout('owner', { surface: SURFACE, filters: layout(['name'], { density: 'huge' }) })).rejects.toMatchObject({ status: 400 })
    expect(await writeUserSheetLayout('owner', { surface: 'product-edit:layout:master', filters: layout(['name']) })).toMatchObject({ surface: 'product-edit:layout:master' })
  })
})
