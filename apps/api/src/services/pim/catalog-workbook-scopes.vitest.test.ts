import { beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
vi.mock('../../db.js', () => ({ default: { productFamily: { findUnique: vi.fn() }, channelConnection: { findUnique: vi.fn() }, marketplace: { findFirst: vi.fn() } } }))
vi.mock('./catalog-transfer-plan.js', () => ({ MANAGED_FIELDS: new Set(), managedChannelField: () => false, transferContracts: () => ({
  master: async () => [{ key: 'name', label: 'Name', kind: 'text', storage: 'column', requiredBy: [], editable: true }],
  channel: async (_channel: string, _market: string, category: string) => {
    if (category === 'UNKNOWN') throw new Error('No cached category schema')
    return { fields: [], schemaVersion: 'v1', fetchedAt: '2026-09-07' }
  },
}) }))
import prisma from '../../db.js'
import { catalogWorkbookTemplate, channelWorkbookField, masterWorkbookField } from './catalog-workbook-scopes.js'
const destination = { channel: 'AMAZON', accountId: 'a', marketplace: 'IT', category: 'COAT' }
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.productFamily.findUnique).mockResolvedValue({ code: 'jackets' } as never)
  vi.mocked(prisma.channelConnection.findUnique).mockResolvedValue({ channelType: 'AMAZON', marketplace: null, isActive: true } as never)
  vi.mocked(prisma.marketplace.findFirst).mockImplementation(async ({ where }: any) => ({ languages: [where.code === 'DE' ? 'de' : 'it'], language: 'en' }) as never)
})
describe('workbook template destination safety', () => {
  it('retains strict and suggested choice rules, character limits and units from field contracts', () => {
    const master = { key: 'color', label: 'Color', kind: 'text', editable: true, requiredBy: [], options: ['blue'], maxLength: 80, unitOptions: ['grams'] }
    expect(masterWorkbookField({ ...master, mode: 'strict' } as never)).toMatchObject({ selectionOnly: true, maxLength: 80, unitOptions: ['grams'] })
    expect(masterWorkbookField({ ...master, mode: 'open' } as never).selectionOnly).toBe(false)
    expect(masterWorkbookField(master as never).selectionOnly).toBeUndefined()
    for (const selectionOnly of [true, false]) expect(channelWorkbookField({ fieldKey: 'color', editable: true, selectionOnly, options: ['blue'] } as never)).toMatchObject({ selectionOnly, options: ['blue'] })
  })
  it('includes canonical marketplace languages even when omitted by the client and a legacy database default differs', async () => {
    const buffer = await catalogWorkbookTemplate({ market: 'IT', familyId: 'jackets', locales: [' EN-GB ', 'en-gb'], channels: [destination, { ...destination, marketplace: 'DE' }] })
    const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer as never)
    expect(book.worksheets.filter(s => s.name.startsWith('Content ')).map(s => s.name)).toEqual(['Content en-gb', 'Content it', 'Content de'])
    expect(book.getWorksheet('Nexus workbook')!.getSheetValues().flat()).toContain('AMAZON IT 1')
  })
  it('rejects the same destination despite different key order, whitespace or channel case before reading the database', async () => {
    await expect(catalogWorkbookTemplate({ market: 'IT', familyId: 'jackets', channels: [destination, { category: ' COAT ', marketplace: 'it', accountId: 'a', channel: 'amazon' }] })).rejects.toThrow('duplicate destination')
    expect(prisma.productFamily.findUnique).not.toHaveBeenCalled()
  })
  it('rejects an inactive account or a marketplace outside its restriction', async () => {
    vi.mocked(prisma.channelConnection.findUnique).mockResolvedValue({ channelType: 'AMAZON', marketplace: 'DE', isActive: true } as never)
    await expect(catalogWorkbookTemplate({ market: 'IT', familyId: 'jackets', channels: [destination] })).rejects.toThrow('active account')
    vi.mocked(prisma.channelConnection.findUnique).mockResolvedValue({ channelType: 'AMAZON', marketplace: null, isActive: false } as never)
    await expect(catalogWorkbookTemplate({ market: 'IT', familyId: 'jackets', channels: [destination] })).rejects.toThrow('active account')
  })
  it('does not generate a partial file when a category definition is unavailable', async () => {
    await expect(catalogWorkbookTemplate({ market: 'IT', familyId: 'jackets', channels: [destination, { ...destination, category: 'UNKNOWN' }] })).rejects.toThrow('No cached category schema')
  })
  it('reports malformed destinations without crashing on null or non-string values', async () => {
    for (const bad of [null, { ...destination, category: 123 }]) await expect(catalogWorkbookTemplate({ market: 'IT', familyId: 'jackets', channels: [bad as never] })).rejects.toThrow('Each destination needs')
  })
  it('counts automatically included languages toward the limit', async () => {
    await expect(catalogWorkbookTemplate({ market: 'IT', familyId: 'jackets', locales: Array.from({ length: 30 }, (_, i) => `en-x${i}`), channels: [destination] })).rejects.toThrow('including the languages')
  })
})
