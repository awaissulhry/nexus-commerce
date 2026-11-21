import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { order } from '../../_demo/fixtures'
import type { Work } from '../overview/api'
import { WORK } from '../overview/fixtures'
import { specRowsOf, specTone, STYLES_READ_MAX, styleIdsOf, type StylePart } from './specs'

// F-PT-401 (order PRODUCTION tab, W4): "What we make it to" — Our pattern: one row per style and pinned revision, its state in words.

const so = order('IN_PRODUCTION')
const styleId = so.lines[0]!.styleId
const rev = (revision: number, status: string, over: Record<string, unknown> = {}) => ({ id: `r${revision}`, revision, status, changeNote: null, releasedAt: null, ...over }) as never
const read = (...revisions: never[]): ReadonlyMap<string, StylePart> => new Map([[styleId, { value: { revisions }, problem: null }]])
const withPin = (revision: number | null, status = 'RELEASED') => ({ ...so, lines: so.lines.map((line) => ({ ...line, styleRevision: revision === null ? null : { revision, status } })) })
type Spec = NonNullable<Work['workOrders'][number]['spec']>
const work = (spec: Spec | null, number = 'WO-00021'): Work['workOrders'] => [{ ...WORK.workOrders[0]!, number, spec }]

describe('F-PT-401: the pattern a style is made to', () => {
  it('in force: the pin is the released revision; one row per style and pinned revision (B33)', () => {
    const rows = specRowsOf(withPin(3), [], read(rev(3, 'RELEASED')))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ styleId, state: { kind: 'inForce', revision: 3 }, needsDecision: false, read: 'read', releasedId: 'r3' })
    expect(specTone(rows[0]!.state)).toBe('success')
    const split = { ...so, lines: so.lines.map((line, index) => ({ ...line, styleRevision: { revision: index === 0 ? 2 : 3, status: index === 0 ? 'OBSOLETE' : 'RELEASED' } })) }
    if (so.lines.length > 1) expect(specRowsOf(split, [], read(rev(2, 'OBSOLETE'), rev(3, 'RELEASED'))).map((row) => row.state.kind)).toEqual(['replaced', 'inForce'])
  })

  it('replaced (B35): by the one in force, with its day and its change note; it needs a decision', () => {
    const [row] = specRowsOf(withPin(2, 'OBSOLETE'), [], read(rev(2, 'OBSOLETE'), rev(3, 'RELEASED', { releasedAt: '2026-11-12T09:00:00Z', changeNote: 'Knee pad pocket 2 cm lower' })))
    expect(row!.state).toEqual({ kind: 'replaced', revision: 2, by: 3, on: '2026-11-12' })
    expect(row!.changeNote).toEqual({ revision: 3, note: 'Knee pad pocket 2 cm lower' })
    expect(row!.needsDecision).toBe(true)
    expect(specTone(row!.state)).toBe('warning')
  })

  it('withdrawn: nothing in force (danger); a draft pin is "not approved yet"', () => {
    expect(specRowsOf(withPin(2, 'OBSOLETE'), [], read(rev(2, 'OBSOLETE')))[0]!.state).toEqual({ kind: 'withdrawn', revision: 2 })
    expect(specRowsOf(withPin(4, 'DRAFT'), [], read(rev(3, 'RELEASED')))[0]!.state).toEqual({ kind: 'notApproved', revision: 4 })
  })

  it('not fixed (B34): the work order that uses one names it; else the one in force the work order will take; else nothing known', () => {
    const uses = work({ revision: { revision: 3, status: 'RELEASED' }, state: 'CURRENT', newer: null, decision: null }, 'WO-00311')
    expect(specRowsOf(withPin(null), uses, new Map())[0]!.state).toEqual({ kind: 'notFixedUses', workOrder: 'WO-00311', revision: 3 })
    expect(specRowsOf(withPin(null), [], read(rev(3, 'RELEASED')))[0]!.state).toEqual({ kind: 'notFixedWill', revision: 3 })
    expect(specRowsOf(withPin(null), [], new Map())[0]!.state).toEqual({ kind: 'notFixed' })
  })

  it('a work order on an older pattern, with the change order’s decision or none yet; a shared work order is never named', () => {
    const older = work({ revision: { revision: 2, status: 'OBSOLETE' }, state: 'NEWER_RELEASED', newer: { revision: 3, releasedOn: '2026-11-12' }, decision: { disposition: 'FINISH_OLD', changeOrder: 'ECO-0004' } })
    const [row] = specRowsOf(withPin(3), older, read(rev(3, 'RELEASED')))
    expect(row!.older).toEqual([{ id: WORK.workOrders[0]!.id, number: 'WO-00021', revision: 2, newer: { revision: 3, on: '2026-11-12' }, decision: { disposition: 'FINISH_OLD', changeOrder: 'ECO-0004' } }])
    expect(row!.needsDecision).toBe(false)
    const undecided = work({ revision: { revision: 2, status: 'OBSOLETE' }, state: 'NEWER_RELEASED', newer: { revision: 3, releasedOn: null }, decision: null })
    expect(specRowsOf(withPin(3), undecided, read(rev(3, 'RELEASED')))[0]!.needsDecision).toBe(true)
    const shared = [{ ...undecided[0]!, sharedWithOtherCustomers: true }]
    expect(specRowsOf(withPin(3), shared, read(rev(3, 'RELEASED')))[0]!.older).toEqual([])
  })

  it('without the style read (no product.styles.view): the pin’s own status and the newer one a work order names; each style alone', () => {
    const older = work({ revision: { revision: 2, status: 'OBSOLETE' }, state: 'NEWER_RELEASED', newer: { revision: 3, releasedOn: '2026-11-12' }, decision: null })
    expect(specRowsOf(withPin(2, 'OBSOLETE'), older, new Map())[0]!).toMatchObject({ state: { kind: 'replaced', revision: 2, by: 3, on: '2026-11-12' }, read: 'none' })
    expect(specRowsOf(withPin(3), [], new Map([[styleId, { value: null, problem: 'problem.read.unavailable' }]]))[0]!.read).toBe('failed')
    expect(specRowsOf(withPin(3), [], new Map([[styleId, { value: null, problem: null }]]))[0]!.read).toBe('reading')
    expect(STYLES_READ_MAX).toBe(10)
    expect(styleIdsOf(so)).toEqual({ ids: [styleId], more: 0 })
  })
})

describe('F-PT-401 / 402: the section', () => {
  it('reads when it comes into view (L6), opens the pack in the ONE viewer, asks a design change only with its right (L11)', () => {
    const view = readFileSync(new URL('../view/production/MakeToSection.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<Section id="specs"')
    expect(view).toContain('new IntersectionObserver(')
    expect(view).toContain('actions.onOpenOrderFile?.(file.openId, event.currentTarget)')
    expect(view).toContain('model.specCan?.changeRequest ?')
    expect(view).not.toMatch(/Spec v|onOpenFile\b/)
    const container = readFileSync(new URL('../OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("useStyleSpecs(api, specsOrder, specStyles.ids, mayStyles && specsSeen && tab === 'production')")
    expect(container).toContain('onOpenOrderFile: orderFilesHost.onOpen')
    expect(container).toContain("if (parts.includes('files') && tabRef.current === 'production') packRef.current.again()")
    expect(readFileSync(new URL('../view/ProductionTab.tsx', import.meta.url), 'utf8')).not.toMatch(/SpecsCard|TechPackCard/)
  })

  it('its words exist in both languages, "Pattern v{n}" (L1), never "Spec v"', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['title', 'packNewerShort', 'ourTitle', 'noStyle', 'changeNote', 'older', 'olderNoDay', 'olderNoNewer', 'decision', 'noDecision', 'disposition.FINISH_OLD', 'disposition.REWORK', 'disposition.SCRAP', 'disposition.HOLD', 'partStyle', 'versions', 'askChange', 'packTitle', 'noPack', 'packNewer', 'askCustomer', 'infoBody', 'state.inForce', 'state.replaced', 'state.replacedNoDay', 'state.replacedNoNumber', 'state.withdrawn', 'state.notFixedUses', 'state.notFixedWill']) expect(t(`productionTab.specs.${key}`), `${locale} ${key}`).not.toBe(`productionTab.specs.${key}`)
      expect(t('productionTab.specs.state.inForce', { revision: 3 }), locale).toBe(locale === 'en' ? 'Pattern v3 · in force' : 'Cartamodello v3 · in vigore')
      expect(t('productionTab.specs.state.replaced', { revision: 2, by: 3, date: '12/11/2026' }), locale).toMatch(/v2.*v3.*12\/11\/2026/)
      expect(t('productionTab.specs.packTitle'), locale).toMatch(/customer|cliente/i)
      expect(t('productionTab.specs.styles', { count: 3 }), locale).toMatch(/3/)
    }
  })
})
