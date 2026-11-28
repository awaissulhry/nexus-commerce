import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CHANGES_SECTIONS, dayTimeOf, WAITING_ALIASES } from './layout'

// F-OC-101 (order CHANGES tab, W1): the shell — four sections in the Production kit's room container (in place, L6), the older
// addresses landing on Waiting, every time with a day.

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('F-OC-101: four sections, top to bottom, each its own file and address', () => {
  it('Waiting · Can it still change? · What changed · Customer\'s agreement (O2 = A: the freeze second)', () => {
    expect(CHANGES_SECTIONS).toEqual(['waiting', 'freeze', 'history', 'confirmation'])
    expect(WAITING_ALIASES).toEqual(['still-to-do', 'work-order-changes'])
  })

  it('the tab is its layout only: the kit\'s room container, the four sections in their order, nothing else drawn there', () => {
    const tab = source('./view/ChangesTab.tsx')
    expect(tab).toContain('<div className="fw-pt fw-oc">')
    const order = ['<WaitingSection ', '<FreezeSection ', '<HistorySection ', '<AgreementSection '].map((part) => tab.indexOf(part))
    expect(order.every((at) => at > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    for (const gone of ['<RequestsSection', '<StillToDo', '<DocumentsTab', '<ChangesDepth', 'function History(']) expect(tab, gone).not.toContain(gone)
    // Each section carries its own address.
    // W2 / W3: every section is the Production kit's Section (L6), at its own address.
    expect(source('./view/FreezeSection.tsx')).toContain('<Section id="freeze"')
    expect(source('./view/HistorySection.tsx')).toContain('<Section id="history"')
    expect(source('./view/AgreementSection.tsx')).toContain('<Section id="confirmation"')
    expect(source('./view/WaitingSection.tsx')).toContain('<Section id="waiting"')
  })

  it('the Production kit is reused in place (L6): Waiting draws with its Section, reading and failed parts; no copy of the kit', () => {
    const waiting = source('./view/WaitingSection.tsx')
    expect(waiting).toContain("from '../../../../../../lib/record-sections/Kit'") // owb-b5 (w5.1): the kit moved to lib, unchanged
    expect(waiting).toContain('<PartReading rows={3} height={44} />')
    expect(waiting).toContain('<PartFailed part={title} problem={waiting.problem} onRetry={() => actions?.onRetryProduction?.()} />')
    // owb-b5 (w5.1): the kit takes the tab's own address (a shared part names no office type); no copy is left at the old place.
    expect(source('../../../../../lib/record-sections/Kit.tsx')).toContain('export function Section({ id, title, answer, asOf, buttons, info, more, children }: { id: string /* owb-b5 (w5.1)')
    expect(() => source('../view/production/Kit.tsx')).toThrow()
  })

  it('the stylesheet: the groups are their own size container, rows by the room they have (never @media), tokens only', () => {
    const css = source('./view/changes.css')
    expect(css).toContain('container: grp / inline-size')
    expect(css).toContain('@container grp (min-width: 560px)')
    expect(css).toContain('@container grp (min-width: 1100px)')
    expect(css).not.toMatch(/@media[^{]*width/)
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/)
  })
})

describe('F-OC-101: every time with a day', () => {
  it('a time of the read\'s own day is "today"; any other day says its day; no read time: the day always', () => {
    const at = '2026-11-21T09:42:00Z' // 10:42 in Rome
    expect(dayTimeOf(at, '2026-11-21T17:00:00Z', 'en')).toEqual({ today: true, date: '21/11/2026', time: '10:42' })
    expect(dayTimeOf(at, '2026-11-22T09:00:00Z', 'en')).toEqual({ today: false, date: '21/11/2026', time: '10:42' })
    expect(dayTimeOf(at, null, 'it').today).toBe(false)
    // The site's zone, not UTC: 23:30 UTC on the 21st is the 22nd in Rome.
    expect(dayTimeOf('2026-11-21T23:30:00Z', '2026-11-22T08:00:00Z', 'en')).toMatchObject({ today: true, date: '22/11/2026', time: '00:30' })
  })

  // F-OM-101: the Money tab's ONE group, moneyTab, comes after it (the next lane's words go at the end).
  it('the tab\'s words are ONE group, changesTab, at the end of orders.json in both languages (then moneyTab)', () => {
    for (const locale of ['en', 'it'] as const) {
      const words = JSON.parse(source(`../../../../../../messages/${locale}/orders.json`)) as Record<string, unknown>
      expect(Object.keys(words).slice(-2), locale).toEqual(['changesTab', 'moneyTab'])
    }
  })
})
