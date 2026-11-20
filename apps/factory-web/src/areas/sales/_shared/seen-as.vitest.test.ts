import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { ROLE_PERMISSIONS as COMPLAINTS_ROLES } from '../../quality/complaints/demo/fixtures'
import { designScreen as CUSTOMER } from '../customers/record/fixtures'
import { designScreen as ORDERS } from '../orders/list/fixtures'
import { designScreen as ORDER } from '../orders/record/fixtures'
import { canFor as returnsCan, ROLE_PERMISSIONS as RETURNS_ROLES } from '../returns/demo/fixtures'
import { designScreen as SECURITY } from '../../admin/security/fixtures'
// ---- B-CP-011 (follow-ups 17 + 20, cp-fx11): the orders', the price lists' and the customer page's design Sales
import { rolePermissions } from '../../../shell/design-data'
import { canOf as orderCan, ROLES as ORDER_ROLES } from '../orders/_demo/fixtures'
import { can as priceListCan, rolePerms } from '../pricelists/_demo/fixtures'
import { designScreen as PRICE_LIST } from '../pricelists/record/fixtures'
import { designScreen as PRICE_IMPORT } from '../pricelists/import/fixtures'
import { designScreen as PRICE_PRINT } from '../pricelists/print/fixtures'
import { designScreen as ORDER_CHANGES } from '../orders/record/changes/fixtures'
import { TERMS_CAN } from '../customers/_demo/fixtures'
import { MONEY_CAN } from '../customers/money/_demo/fixtures'
import { SALES_CAN } from '../customers/depth/_demo/fixtures'
// ---- end B-CP-011

/**
 * F-CP-148 (customer page plan C4, the money wall: Owner O1 "Sales sees no price", O2/O3; follow-up 5) — the design index's "Seen as"
 * cases of every money screen, and the design data's Sales role: a Sales worker sees no price, no margin, no credit value (B-CP-011), on
 * every screen the design index draws. These tests read the cases (their data), the walk at 375 / 1440 / 1920, light and dark, draws them.
 */

// F-CP-148 (end-check fix): a case's model as the test reads it (M: the few fields it checks), whatever the screen's own model type.
const caseOf = <M>(screen: { cases: readonly { id: string; model: unknown }[] }, id: string): M => {
  const found = screen.cases.find((item) => item.id === id)
  if (!found) throw new Error(`no design case ${id}`)
  return found.model as M
}
const money = (permissions: readonly string[]) => permissions.filter((permission) => permission.startsWith('money.'))

describe('follow-up 5: the design data’s Sales role holds no price grain (Owner O1, B-CP-011)', () => {
  it('the Sales template itself holds none', () => {
    expect(templateOf('sales')!.grains).toEqual([])
  })

  it('returns and complaints: the Sales role of their design data holds no money.* permission; the returns Sales can reads no price', () => {
    expect(money(RETURNS_ROLES.sales)).toEqual([])
    expect(money(COMPLAINTS_ROLES.sales)).toEqual([])
    expect(returnsCan('sales').price).toBe(false)
    // The price holders keep theirs (the control).
    expect(money(RETURNS_ROLES.owner)).toContain('money.price')
    expect(money(RETURNS_ROLES.finance)).toContain('money.price')
  })

  it('the sales settings’ Sales role is the template without grains (its table is the file’s own)', () => {
    const source = readFileSync(fileURLToPath(new URL('../settings/fixtures.ts', import.meta.url)), 'utf8')
    expect(source).toContain("sales: templatePermissions('sales'),")
    expect(source).not.toMatch(/sales: templatePermissions\('sales', \[/)
  })
})

describe('F-CP-148: "Seen as" — every office money screen as the Owner, a Sales worker and a Production manager (Brand Alpha: the portal’s own cases)', () => {
  type RecordCase = { record?: { can: { price: boolean } } }
  it('the order: the Sales worker’s Lines, Money and Files without the price grain; the Owner’s files and edit mode with it', () => {
    for (const id of ['sales-lines', 'money-sales', 'cp-148-files-sales']) expect(caseOf<RecordCase>(ORDER, id).record?.can.price, id).toBe(false)
    for (const id of ['cp-148-files-owner', 'cp-148-edit-owner', 'price-check']) expect(caseOf<RecordCase>(ORDER, id).record?.can.price, id).toBe(true)
    expect(caseOf<RecordCase>(ORDER, 'cp-148-files-manager').record?.can.price).toBe(false)
  })

  it('the order’s files with a PRICED lock: counted for the Sales worker and the Production manager (never named), named for the Owner', () => {
    type FilesCase = { record?: { files?: { read: { groups: { files: { name: string }[]; pricedLeftOut?: number }[] } | null } } }
    const groupsOf = (id: string) => caseOf<FilesCase>(ORDER, id).record?.files?.read?.groups ?? []
    for (const id of ['cp-148-files-sales', 'cp-148-files-manager']) {
      expect(groupsOf(id).reduce((sum, group) => sum + (group.pricedLeftOut ?? 0), 0), id).toBe(2)
      expect(JSON.stringify(groupsOf(id)), id).not.toMatch(/Conferma d’ordine|Ordine del cliente/)
    }
    expect(groupsOf('cp-148-files-owner').flatMap((group) => group.files.map((file) => file.name))).toEqual(expect.arrayContaining(['Conferma d’ordine SO-2026-0088 v1.pdf', 'Ordine del cliente PO-ESEMPIO-88.pdf']))
  })

  it('the customer page’s Work tab: the Production manager’s cases read no price and hold no orders.manage', () => {
    type WorkCase = { work?: { price?: boolean; role?: string }; can: { price?: boolean; ordersManage?: boolean } }
    for (const id of ['cp-148-work-manager', 'cp-148-work-not-equal-manager', 'cp-148-price-window-manager', 'cp-148-drafts-manager']) {
      const model = caseOf<WorkCase>(CUSTOMER, id)
      expect([model.work?.price, model.work?.role, model.can.price, model.can.ordersManage], id).toEqual([false, 'manager', false, false])
    }
  })

  it('Sales › Orders: the price term as the Owner (its chip), and held in one line for the Sales worker and the Production manager', () => {
    type ListCase = { list: { can: { price: boolean }; extra?: { priceMatch?: string } | null; priceHeld?: boolean } }
    expect(caseOf<ListCase>(ORDERS, 'cp-148-not-equal-owner').list).toMatchObject({ can: { price: true }, extra: { priceMatch: 'NOT_EQUAL' } })
    for (const id of ['cp-148-not-equal-sales', 'cp-148-not-equal-manager']) expect(caseOf<ListCase>(ORDERS, id).list, id).toMatchObject({ can: { price: false }, priceHeld: true })
  })

  it('Admin › Security: "Who sees prices" only for a price holder who views users; no card as Sales worker, Production manager or Finance', () => {
    type SecurityCase = { model: { priceHolders?: unknown }; permissions?: readonly string[] }
    for (const id of ['cp-148-prices-as-sales', 'cp-148-prices-as-manager', 'cp-148-prices-as-finance']) expect(caseOf<SecurityCase>(SECURITY, id).model.priceHolders, id).toBeUndefined()
    expect(caseOf<SecurityCase>(SECURITY, 'cp-148-prices-as-sales').permissions).not.toContain('money.price')
    expect(caseOf<SecurityCase>(SECURITY, 'cp-148-prices-as-manager').permissions).not.toContain('money.price')
  })
})

// ---- B-CP-011 (the money wall, Owner O1; follow-ups 17 + 20, cp-fx11): the design data's Sales is the real Sales role everywhere
describe('follow-ups 17 + 20: the orders’, the price lists’ and the customer page’s design Sales is the real Sales role (no grain)', () => {
  const PRICED = /"(unitPrice|netAmount|grossAmount|vatAmount|marginPct|brandPrice|priceDiff)"/

  it('the orders’ ROLES.sales and the price lists’ rolePerms(sales) are the template’s permissions: no money.*, no pricelists.manage', () => {
    expect(ORDER_ROLES.sales).toEqual(rolePermissions('sales'))
    expect(rolePerms('sales')).toEqual(rolePermissions('sales'))
    for (const permissions of [ORDER_ROLES.sales, rolePerms('sales')]) {
      expect(money(permissions)).toEqual([])
      expect(permissions).not.toContain('pricelists.manage')
    }
    expect(orderCan('sales')).toMatchObject({ price: false, margin: false, cost: false })
    expect(priceListCan('sales')).toMatchObject({ price: false, manage: false })
    // The price holders keep theirs (the control).
    expect(orderCan('owner')).toMatchObject({ price: true, margin: true })
    expect(priceListCan('owner')).toMatchObject({ price: true, manage: true })
  })

  it('the customer page’s Sales personas read no price: commercial terms, money, the customer in depth', () => {
    expect(TERMS_CAN.sales).toMatchObject({ price: false, listsManage: false })
    expect(MONEY_CAN.sales).toMatchObject({ price: false, creditLimits: false })
    expect(SALES_CAN).toMatchObject({ price: false, erase: false })
  })

  it('every Sales case of Sales › Orders reads no price: no price grain, no money field in its rows', () => {
    type ListCase = { role: string; list: { can: { price: boolean }; list: { items: unknown } } }
    const sales = ORDERS.cases.filter((item) => (item.model as ListCase).role === 'sales')
    expect(sales.length).toBeGreaterThan(40)
    for (const item of sales) {
      const { list } = item.model as ListCase
      expect(list.can.price, item.id).toBe(false)
      expect(JSON.stringify(list.list.items ?? null), item.id).not.toMatch(PRICED)
    }
  })

  it('every Sales case of the order and its changes reads no price; a Sales edit mode starts from what Sales reads (no price typed)', () => {
    type RecordCase = { role: string; record?: { can: { price: boolean }; order: { status: string; value?: unknown }; amend?: { lines: { price?: string }[] } | null }; draft?: { can: { price: boolean } } }
    const sales = [...ORDER.cases, ...ORDER_CHANGES.cases].filter((item) => (item.model as RecordCase).role === 'sales')
    expect(sales.length).toBeGreaterThan(80)
    for (const item of sales) {
      const { record, draft } = item.model as RecordCase
      if (record) {
        expect(record.can.price, item.id).toBe(false)
        expect(JSON.stringify(record.order.value ?? null), item.id).not.toMatch(PRICED)
        for (const line of record.amend?.lines ?? []) expect(line.price ?? '', item.id).toBe('')
      }
      if (draft) expect(draft.can.price, item.id).toBe(false)
    }
  })

  it('price lists: one "Seen as Sales" case per screen (record, import, PDF), each without the price grain', () => {
    type RoleCase = { role?: string; can?: { price: boolean }; record?: { can: { price: boolean } } }
    const salesIds = (screen: { cases: readonly { id: string; model: unknown }[] }) => screen.cases.filter((item) => (item.model as RoleCase).role === 'sales').map((item) => item.id)
    expect(salesIds(PRICE_LIST)).toEqual(['prices-sales'])
    expect(caseOf<RoleCase>(PRICE_LIST, 'prices-sales').record?.can.price).toBe(false)
    expect(salesIds(PRICE_IMPORT)).toEqual(['held-sales'])
    const salesCan = JSON.stringify(priceListCan('sales'))
    expect(PRICE_PRINT.cases.filter((item) => JSON.stringify((item.model as RoleCase).can) === salesCan).map((item) => item.id)).toEqual(['no-price'])
    expect(caseOf<RoleCase>(PRICE_PRINT, 'no-price').can?.price).toBe(false)
    expect(caseOf<RoleCase>(PRICE_PRINT, 'review').can?.price).toBe(true)
  })
})
// ---- end B-CP-011
