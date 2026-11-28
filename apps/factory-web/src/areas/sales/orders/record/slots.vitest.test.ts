import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CustomerStructurePart } from '../../../production/order-structures/parts/CustomerStructurePart'
import { OrderStructurePart } from '../../../production/order-structures/parts/OrderStructurePart'
import { FromTheFloorPart } from '../../../production/baskets/parts/FromTheFloorPart'
import { OrderTeamPart } from '../../../production/teams/parts/OrderTeamPart'
import { RouteOfEachLinePart } from '../../../products/_shared/parts/RouteOfEachLinePart'
import { PlaceScanCodeWindow } from './print/PlaceScanCodeWindow'
import { PrintAgainWindow } from './print/PrintAgainWindow'
import { PrintStartWindow } from './print/PrintStartWindow'
import { ShipWholeOrderWindow } from './shipments/ShipWholeOrderWindow'
import { WarehouseLegWindow } from './shipments/WarehouseLegWindow'

/**
 * owb-b5 (w5.5; _owb-b-common settle 8) — the slot stubs the base placed for the sessions after it: each has its FINAL export name and
 * props, names its owner in its header and draws nothing until the owner fills its own file. The four order parts are mounted once in
 * the office order page's Production tab in the design's order (From the floor after the baskets; Order structure · Team · Route of
 * each line after the tab's sections), the customer part once on the customer page's Terms & requirements tab (last); the five
 * windows are mounted nowhere yet (S2 mounts them from the band and the tabs in its own files).
 *
 * An owner who fills its stub sets its row's `filled` to true (the "draws nothing" check then leaves it); a session that mounts a
 * window adds its file to the row's `mounts`.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8')
const PRODUCTION_TAB = 'areas/sales/orders/record/view/ProductionTab.tsx'
const TERMS_TAB = 'areas/sales/customers/record/view/terms/TermsTab.tsx'
/** owb-of5 step 1: the band's ONE act opens these three windows, mounted once for the order page. */
const BAND_ACTS = 'areas/sales/orders/record/band/ActWindows.tsx'

const windowProps = { open: true, onClose: () => undefined, companyId: 'company-1', orderId: 'order-1' }
const part = { companyId: 'company-1', orderId: 'order-1' }

const STUBS = [
  { path: 'areas/sales/orders/record/print/PrintStartWindow.tsx', name: 'PrintStartWindow', owner: 'S3 (owb-ss4)', draw: () => PrintStartWindow(windowProps), mounts: [BAND_ACTS] as string[], filled: true /* owb-ss4 */ },
  { path: 'areas/sales/orders/record/print/PrintAgainWindow.tsx', name: 'PrintAgainWindow', owner: 'S3 (owb-ss4)', draw: () => PrintAgainWindow(windowProps), mounts: ['areas/production/baskets/BasketsBoardPage.tsx'] as string[], filled: true /* owb-ss4 */ },
  { path: 'areas/sales/orders/record/print/PlaceScanCodeWindow.tsx', name: 'PlaceScanCodeWindow', owner: 'S3 (owb-ss4)', draw: () => PlaceScanCodeWindow(windowProps), mounts: [] as string[], filled: false },
  { path: 'areas/sales/orders/record/shipments/ShipWholeOrderWindow.tsx', name: 'ShipWholeOrderWindow', owner: 'S3 (owb-ss3)', draw: () => ShipWholeOrderWindow(windowProps), mounts: [BAND_ACTS] as string[], filled: true /* owb-ss3 */ },
  { path: 'areas/sales/orders/record/shipments/WarehouseLegWindow.tsx', name: 'WarehouseLegWindow', owner: 'S3 (owb-ss3)', draw: () => WarehouseLegWindow({ ...windowProps, act: 'SEND_ON' }), mounts: [BAND_ACTS] as string[], filled: true /* owb-ss3 */ },
  { path: 'areas/production/teams/parts/OrderTeamPart.tsx', name: 'OrderTeamPart', owner: 'S3 (owb-ss7)', draw: () => OrderTeamPart(part), mounts: [PRODUCTION_TAB], filled: true /* owb-ss7 7.3 */ },
  { path: 'areas/production/order-structures/parts/OrderStructurePart.tsx', name: 'OrderStructurePart', owner: 'S3 (owb-ss8)', draw: () => OrderStructurePart(part), mounts: [PRODUCTION_TAB], filled: false },
  { path: 'areas/production/order-structures/parts/CustomerStructurePart.tsx', name: 'CustomerStructurePart', owner: 'S3 (owb-ss8)', draw: () => CustomerStructurePart({ companyId: 'company-1', partyId: 'party-1' }), mounts: [TERMS_TAB], filled: false },
  { path: 'areas/products/_shared/parts/RouteOfEachLinePart.tsx', name: 'RouteOfEachLinePart', owner: 'S4 (owb-pd6)', draw: () => RouteOfEachLinePart(part), mounts: [PRODUCTION_TAB], filled: true /* owb-pd6 step 6.4: filled */ },
  { path: 'areas/production/baskets/parts/FromTheFloorPart.tsx', name: 'FromTheFloorPart', owner: 'S5 (owb-fl9)', draw: () => FromTheFloorPart(part), mounts: [PRODUCTION_TAB], filled: true },
] as const

function filesOf(folder: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(folder)) {
    const path = join(folder, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') out.push(...filesOf(path))
    } else if (/\.tsx$/.test(name)) out.push(path)
  }
  return out
}

describe('owb-b5 w5.5: the slot stubs', () => {
  it('each stub exists with its final export name and props type, and names its owner in its header', () => {
    for (const stub of STUBS) {
      const text = read(stub.path)
      expect(text, stub.path).toContain(`SLOT — owner: ${stub.owner}`)
      expect(text, stub.path).toContain(`export function ${stub.name}(`)
      expect(text, stub.path).toContain(`export interface ${stub.name}Props {`)
    }
    // The props the sessions' briefs name.
    expect(read('areas/sales/orders/record/shipments/WarehouseLegWindow.tsx')).toContain("readonly act: 'ARRIVED' | 'SEND_ON'")
    expect(read('areas/production/order-structures/parts/CustomerStructurePart.tsx')).toContain('readonly partyId: string')
    for (const stub of STUBS.filter((each) => each.name.endsWith('Window'))) for (const prop of ['readonly open: boolean', 'readonly onClose: () => void', 'readonly companyId: string', 'readonly orderId: string']) expect(read(stub.path), `${stub.name} ${prop}`).toContain(prop)
  })

  it('an empty stub draws nothing (null)', () => {
    for (const stub of STUBS) if (!stub.filled) expect(stub.draw(), stub.name).toBeNull()
  })

  it('each is mounted where its row says, once; the five windows nowhere yet (S2 mounts them)', () => {
    const files = filesOf(SRC).filter((file) => !/\.vitest\.test\./.test(file))
    for (const stub of STUBS) {
      const mounted = files.filter((file) => readFileSync(file, 'utf8').includes(`<${stub.name} `)).map((file) => relative(SRC, file).split(sep).join('/'))
      expect(mounted.sort(), stub.name).toEqual([...stub.mounts].sort())
      for (const mount of stub.mounts) expect(read(mount).match(new RegExp(`<${stub.name} `, 'g'))?.length, `${stub.name} in ${mount}`).toBe(1)
    }
  })

  it('the Production tab: From the floor right after the baskets; Order structure · Team · Route of each line after Materials', () => {
    const tab = read(PRODUCTION_TAB)
    const at = (name: string) => tab.indexOf(`<${name} `)
    expect(at('FromTheFloorPart')).toBeGreaterThan(at('WorkOrdersSection'))
    expect(at('FromTheFloorPart')).toBeLessThan(at('DatesSection'))
    expect(at('OrderStructurePart')).toBeGreaterThan(at('MaterialsSection'))
    expect(at('OrderTeamPart')).toBeGreaterThan(at('OrderStructurePart'))
    expect(at('RouteOfEachLinePart')).toBeGreaterThan(at('OrderTeamPart'))
    for (const name of ['FromTheFloorPart', 'OrderStructurePart', 'OrderTeamPart', 'RouteOfEachLinePart']) expect(tab, name).toContain(`<${name} companyId={order.companyId} orderId={order.id} />`)
  })

  it('the customer page: "How its orders are handled" last on Terms & requirements, with the company the page works in', () => {
    const tab = read(TERMS_TAB)
    expect(tab.indexOf('<CustomerStructurePart ')).toBeGreaterThan(tab.indexOf('<IdentitySection '))
    expect(tab).toContain('{companyId ? <CustomerStructurePart companyId={companyId} partyId={model.partyId} /> : null}')
    expect(read('areas/sales/customers/record/CustomerRecord.tsx')).toContain('companyId={session.company?.id ?? null /* owb-b5 (w5.5): S3\'s slot */}')
  })
})
