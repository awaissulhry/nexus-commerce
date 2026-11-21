import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import type { WorkOrderOwn } from '../overview/api'
import { sizeTableOf } from './work-detail'

// fx5 (the look-only walk on :3300, 30-walk.md §Problems): the tab never widens the page, matches the picture, says one thing once.

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = () => source('../view/production/production.css')

describe('fx5 #1, #8, #9: the page never scrolls sideways; Discuss only for who may write', () => {
  it('#1: a tooltip the reader does not see is not in the layout; row-end doors open towards the row’s start (packages/ui untouched)', () => {
    expect(css()).toContain('.fw-pt .nds-tooltip:not(:hover):not(:focus-within) > .tip { display: none; }')
    expect(source('../view/Discuss.tsx')).toContain('tooltipAlign={align}')
    expect(source('../view/production/DatesSection.tsx')).toContain("target={{ kind: 'SalesOrderLine', id: row.lineId }} align=\"end\"")
    // The fix is ours: the whole page is never clipped to hide it.
    expect(css()).not.toMatch(/fw-office-page[^{]*\{[^}]*overflow/)
  })

  it('#9 (L7): no Discuss door and no "Discuss this date" without threads.post; #8: a wrapped name starts at the left', () => {
    expect(source('../view/production/ProblemsSection.tsx')).toContain('const mayDiscuss = model.people?.mayNote !== false')
    // fx9: the check is named once (mayDiscuss) and guards the line's Discuss door.
    expect(source('../view/production/DatesSection.tsx')).toContain('const mayDiscuss = !!frame?.discuss && model.people?.mayNote !== false')
    expect(source('../view/production/DatesSection.tsx')).toContain('mayDiscuss ? <DiscussDoor')
    expect(source('../view/production/StepsBlock.tsx')).toContain("frame?.discuss && model.people?.mayNote !== false ? [{ id: 'discuss'")
    expect(css()).toMatch(/\.fw-pt-link \{[^}]*text-align: start;/)
  })
})

describe('fx5 #4, #5: Production now as the picture; paired sections without a hole', () => {
  it('#4: the stage is ONE horizontal segmented bar (the same steps as Overview’s strip) and each count has its share', () => {
    const now = source('../view/production/NowSection.tsx')
    expect(now).toContain('function StageBar(')
    expect(now).toContain('const steps = stageSteps(strip)')
    expect(now).not.toContain('<StageStrip ')
    expect(now).toContain("t('productionTab.now.countOf', { count: entry.value, of: pieces.of })")
    expect(css()).toContain('.fw-pt-segs { list-style: none; margin: 0; padding: 0; display: flex; min-width: 0; }')
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['orders']).orders!)('productionTab.now.countOf', { count: 40, of: 160 }), locale).toMatch(/40.*160/)
  })

  it('#5: the card in a paired section stretches to the pair’s height', () => {
    expect(css()).toContain('.fw-pt-pairs > .fw-pt-sec > .nds-card { flex: 1 1 auto; }')
  })
})

describe('fx5 #14: the small things', () => {
  const cell = (size: string, quantity: number): NonNullable<WorkOrderOwn['cells']>[number] => ({ id: `c-${size}`, salesOrderLineId: 'l1', size, quantity, cut: quantity })

  it('the detail’s sizes in wearing order (50 · 52 · 54, never as they came)', () => {
    expect(sizeTableOf([cell('52', 2), cell('50', 2), cell('54', 1)])?.sizes).toEqual(['50', '52', '54'])
    expect(sizeTableOf([cell('L', 2), cell('S', 2), cell('M', 1)])?.sizes).toEqual(['S', 'M', 'L'])
  })

  it('a completed work order has no due-date field; a final check keeps one row shape; the detail’s lines sit together', () => {
    expect(source('../view/production/WorkOrdersSection.tsx')).toContain("shown.inline && row.status !== 'COMPLETED' ? (")
    expect(source('../view/production/ProblemsSection.tsx')).toContain('<li key={check.key} className="fw-pt-qrow">')
    expect(css()).toContain('.fw-pt-qrow { display: grid; grid-template-columns: minmax(0, 1fr) auto;')
    expect(source('../view/production/WorkOrderDetail.tsx')).toContain('<div className="fw-pt-dt-lines">')
  })
})
