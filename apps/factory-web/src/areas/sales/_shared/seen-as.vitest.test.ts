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

/**
 * F-CP-148 (customer page plan C4, the money wall: Owner O1 "Sales sees no price", O2/O3; follow-up 5) — the design index's "Seen as"
 * cases of every money screen, and the design data's Sales role: a Sales worker sees no price, no margin, no credit value (B-CP-011), on
 * every screen the design index draws. These tests read the cases (their data), the walk at 375 / 1440 / 1920, light and dark, draws them.
 */

const caseOf = <M>(screen: { cases: readonly { id: string; model: M }[] }, id: string): M => {
  const found = screen.cases.find((item) => item.id === id)
  if (!found) throw new Error(`no design case ${id}`)
  return found.model
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
