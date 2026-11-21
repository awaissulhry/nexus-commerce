import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// fx9 (30-walk.md re-walk on 9be63759b9: #10 partly, N1–N5): the last small polish of the order PRODUCTION tab.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = source('../view/production/production.css')
/** The body of the one block that opens with `head`. */
const blockOf = (head: string) => {
  const at = css.indexOf(head)
  expect(at, head).toBeGreaterThan(-1)
  return css.slice(at, css.indexOf('\n}', at))
}

describe('fx9 #10: Work orders at M — one row shape', () => {
  it('number and Ask on the first line, status and tags on the second, on EVERY row (720–1279 px of the tab)', () => {
    expect(blockOf('@container pt (min-width: 720px) and (max-width: 1279px) {')).toContain('.fw-pt-c-no > .fw-pt-inline > .fw-pt-wo-id { flex-basis: 100%; }')
    const view = source('../view/production/WorkOrdersSection.tsx')
    // The number group and the status are siblings in the cell's first line, so the rule above moves the status for every row alike.
    const id = view.indexOf('<span className="fw-pt-wo-id">')
    expect(view.lastIndexOf('<span className="fw-pt-inline">', id)).toBeGreaterThan(-1)
    expect(view.indexOf('<Pill tone={WO_TONE[row.status]', id)).toBeGreaterThan(id)
  })
})

describe('fx9 N1, N3: Materials’ missing rows', () => {
  it('N1: one set of columns for every row — the list is the grid, each row its subgrid; the doors cell is on every row', () => {
    const wide = blockOf('@container sec (min-width: 640px) {')
    expect(wide).toContain('.fw-pt-miss { display: grid; grid-template-columns: minmax(0, 1fr) minmax(9rem, auto) minmax(0, auto); }')
    expect(wide).toContain('.fw-pt-miss-row { grid-column: 1 / -1; grid-template-columns: subgrid; }')
    const view = source('../view/production/MaterialsSection.tsx')
    // Both kinds of row (the customer's goods, what we buy) draw the doors cell, empty or not.
    expect(view.match(/<span className="fw-pt-miss-do">/g)?.length).toBe(2)
    expect(view).not.toMatch(/\? <span className="fw-pt-miss-do">/)
  })

  it('N3: one divider above "From the customer" — the last row draws none, the block below draws its own', () => {
    expect(css).toContain('.fw-pt-miss-row:last-child { border-bottom: 0; }')
    expect(css).toMatch(/\.fw-pt-mat \{[^}]*border-top: 1px solid var\(--nds-border-subtle\)/)
  })
})

describe('fx9 N2: no ⋯ and no column that hold nothing new (Read-only)', () => {
  it('a step ⋯ whose only item is "Open in Planning ›" is not drawn when the step’s name opens the step', () => {
    const view = source('../view/production/StepsBlock.tsx')
    expect(view).toContain("const items = opens && all.every((item) => item.id === 'planning') ? [] : all")
    expect(view).toContain('{items.length > 0 ? <LineMenuButton')
  })

  it('By line draws its Actions column only when a row has a Discuss door or a ⋯', () => {
    const view = source('../view/production/DatesSection.tsx')
    expect(view).toContain('const mayDiscuss = !!frame?.discuss && model.people?.mayNote !== false')
    expect(view).toContain('const withActs = mayDiscuss || !!model.can.manage')
    // The head and every row's cell follow the same rule, so the columns never shift.
    expect(view.match(/\{withActs \? \(/g)?.length).toBe(2)
    expect(view).toMatch(/\{withActs \? \(\s*<th scope="col" className="fw-pt-x">/)
    expect(view).toMatch(/\{withActs \? \(\s*<td className="fw-pt-x">/)
  })
})

describe('fx9 N4, N5: the window’s title and the Make-to doors', () => {
  it('N4: the title wraps between its parts, never inside a record number', () => {
    expect(css).toContain('.nds-modal.detail .nds-modal-h .t .fw-pt-dt-t > span { white-space: nowrap; }')
    expect(source('../view/production/WorkOrderDetail.tsx')).toContain("<span>{number}</span> <span>{t('productionTab.detail.forOrder', { order })}</span>")
  })

  it('N5: "Versions & changes ›" and "Ask for a design change…" sit 16 px apart as one group', () => {
    expect(css).toMatch(/\.fw-pt-move-doors \{[^}]*column-gap: var\(--nds-space-16\)/)
  })
})
