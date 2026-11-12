import type { ItemEntry } from '../api'
import { ENTRIES, SITE } from '../params/demo'
import { itemRowsOf, rowKeyOf } from '../params/model'
import type { SizeRunModel } from './view/SizeRunView'

/**
 * B-W2b-335 — made-up rows for the SCR-127 W2b cases (never real data): the demo items of B-W2a-59 with planning rules — the
 * cowhide in fixed lots of 105 m² with 2 days to use it, the mesh in periods of 14 days, the thread by its min/max limits,
 * the knee slider (a component) with 2 % scrap and 98 % yield — and a demo jacket SKU (a finished garment) planned by style
 * and colour.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = '2026-10-29T09:42:00.000Z'

const JACKET_SKU: ItemEntry['item'] = { id: uid('5906', 9), code: 'DEMO-JKT-01-BLK-52', name: 'Demo jacket black 52', kind: 'FINISHED', tracking: 'NONE', baseUom: 'PCS', colours: [] }

const withRules = (entry: ItemEntry, rules: Record<string, unknown>): ItemEntry => ({ ...entry, parameters: entry.parameters.map((row, index) => (index === 0 ? { ...row, ...rules } : row)) })

export const RULE_ENTRIES: readonly ItemEntry[] = [
  withRules(ENTRIES[0]!, { method: 'ORDERS', reorderPoint: null, lotSize: null, lotSizing: 'FIXED', fixedLotQty: '105.0000', delayDays: 2 }),
  ENTRIES[1]!,
  withRules(ENTRIES[2]!, { lotSizing: 'PERIOD', lotPeriodDays: 14 }),
  ENTRIES[3]!,
  withRules(ENTRIES[4]!, { lotSizing: 'MIN_MAX' }),
  withRules(ENTRIES[5]!, { scrapPct: '2.00', yieldPct: '98.00' }),
  {
    item: JACKET_SKU,
    defaults: { sourcing: 'MAKE', supplier: null, leadTimeDays: null, purchaseUom: 'PCS', minOrderQty: null, orderMultiple: null },
    parameters: [
      {
        id: uid('5905', 9),
        siteId: SITE.id,
        item: { id: JACKET_SKU.id, code: JACKET_SKU.code, name: JACKET_SKU.name, baseUom: 'PCS' },
        colour: null,
        method: 'ORDERS',
        source: null,
        supplier: null,
        makeSite: null,
        buyLeadTimeDays: null,
        makeLeadTimeDays: 10,
        safetyLeadTimeDays: null,
        safetyStock: null,
        reorderPoint: null,
        lotSize: null,
        minStock: null,
        maxStock: null,
        minOrderQty: null,
        orderMultiple: null,
        maxOrderQty: null,
        note: null,
        lotSizing: 'LOT_FOR_LOT',
        fixedLotQty: null,
        lotPeriodDays: null,
        planLevel: 'STYLE_COLOUR',
        scrapPct: '2.00',
        yieldPct: '98.00',
        delayDays: null,
        version: 2,
        updatedAt: at,
      },
    ],
  },
]

export const RULE_ROWS = itemRowsOf(RULE_ENTRIES)
export const COWHIDE_KEY = RULE_ROWS[0]!.key
export const MESH_KEY = rowKeyOf(RULE_ENTRIES[2]!.item.id, null)
export const SLIDER_KEY = rowKeyOf(RULE_ENTRIES[5]!.item.id, null)
export const JACKET_KEY = rowKeyOf(JACKET_SKU.id, null)

/** The site's size run as read: two size groups. */
export const SIZE_RUN: SizeRunModel = { load: { status: 'ready' }, values: { sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['44', '46', '48'], ['50', '52', '54', '56']] }, canManage: true, dialog: null, notice: null }
