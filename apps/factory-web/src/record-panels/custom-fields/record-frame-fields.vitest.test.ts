import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RECORD_OF_MODEL } from './model'

/**
 * B-TH-280 — the record's custom-fields section (B-W2b-431, SCR-520) back on the record pages: the old record panels drew it above
 * their tabs, and the TH-6 record frames dropped it with them. RecordCustomFields is the container; each page whose record type takes
 * custom fields passes it to RecordFrame's `fields` slot on its FIRST tab only (the body column's end; the print view prints it too).
 */

const SRC = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, SRC), 'utf8')

/** Every page of a record type that takes custom fields: its container, its view (the frame's mount), the type and its first tab. */
const PAGES = [
  { container: 'areas/parties/_shared/PartyRecord.tsx', view: 'areas/parties/_shared/view/PartyRecordView.tsx', type: 'config.recordType', model: 'Party', first: 'overview' },
  { container: 'areas/sales/quotes/record/QuoteRecord.tsx', view: 'areas/sales/quotes/record/view/QuoteRecordView.tsx', type: "'Quote'", model: 'Quote', first: 'lines' },
  { container: 'areas/sales/orders/record/OrderRecord.tsx', view: 'areas/sales/orders/record/view/OrderRecordView.tsx', type: "'SalesOrder'", model: 'SalesOrder', first: 'lines' },
  { container: 'areas/products/styles/record/StyleRecord.tsx', view: 'areas/products/styles/record/view/StyleRecordView.tsx', type: "'Style'", model: 'Style', first: 'overview' },
  { container: 'areas/purchasing/orders/record/OrderRecord.tsx', view: 'areas/purchasing/orders/record/view/OrderRecordView.tsx', type: "'PurchaseOrder'", model: 'PurchaseOrder', first: 'lines' },
  { container: 'areas/warehouse/lots/record/LotRecord.tsx', view: 'areas/warehouse/lots/record/view/LotRecordView.tsx', type: "'Lot'", model: 'Lot', first: 'overview' },
  { container: 'areas/production/work-orders/record/WorkOrderRecord.tsx', view: 'areas/production/work-orders/record/view/WorkOrderRecordView.tsx', type: "'WorkOrder'", model: 'WorkOrder', first: 'overview' },
] as const

describe('B-TH-280 — every record page that takes custom fields shows them again, at the end of its first tab', () => {
  it('the pages cover every record type of the fields registry that has a record-frame page (Item has none)', () => {
    const covered = new Set<string>(PAGES.map((page) => page.model))
    for (const model of Object.keys(RECORD_OF_MODEL).filter((one) => one !== 'Item')) expect(covered.has(model), model).toBe(true)
  })

  for (const page of PAGES) {
    it(`${page.container}: RecordCustomFields of the record on '${page.first}' only, through the view to RecordFrame`, () => {
      const container = read(page.container)
      expect(container).toContain("record-panels/custom-fields/RecordCustomFields'")
      expect(container.match(/<RecordCustomFields /g)?.length).toBe(1)
      expect(container).toContain(`tab === '${page.first}' ? <RecordCustomFields record={{ type: ${page.type}, id: `)
      expect(container).toMatch(/fields=\{fields \/\* B-TH-280 \*\/\}|fields=\{value && tab === /)
      const view = read(page.view)
      expect(view).toContain('fields?: ReactNode')
      expect(view).toMatch(/fields=\{fields \/\* B-TH-280/)
    })
  }

  it('the work order only hands the slot down to RecordFrame: no tab body draws it (agreement T1: the production lane’s bodies)', () => {
    const view = read('areas/production/work-orders/record/view/WorkOrderRecordView.tsx')
    // WorkOrderRecordView → WorkOrderRecord → ReadyRecord → RecordFrame, and nowhere else.
    expect(view.match(/fields=\{fields/g)?.length).toBe(3)
    expect(view.match(/fields=\{fields \/\* B-TH-280 \*\/\}/g)?.length).toBe(1)
  })
})

describe('B-TH-280 — RecordCustomFields, the container', () => {
  const source = readFileSync(new URL('./RecordCustomFields.tsx', import.meta.url), 'utf8')

  it('draws the section with the same hook and view the old panels used; nothing at all when there is no section', () => {
    expect(source).toContain('useCustomFields({ api, record: key, title, people, files })')
    expect(source).toContain('<CustomFieldsPanel model={section.model} actions={actions} />')
    expect(source).toContain('if (!section.model) return null')
  })

  it('reads the people only with threads.post and the files only with files.read — and only when Edit is pressed', () => {
    expect(source).toContain("session.permissions.includes('threads.post')")
    expect(source).toContain("session.permissions.includes('files.read')")
    expect(source).toMatch(/if \(mayPeople\) \{\s*listPeople\(api, key\)/)
    expect(source).toMatch(/if \(mayFiles\) \{\s*listFiles\(api, key\)/)
    expect(source).toMatch(/onEdit: \(\) => \{\s*readChoices\(\)\s*section\.actions\.onEdit\?\.\(\)/)
    // Without files.read a file field says so (null), never an empty list that looks like "no files".
    expect(source).toContain('useState<readonly Choice[] | null>(mayFiles ? [] : null)')
  })
})
