import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { failedRead, PEOPLE_ANSWER_ID, PEOPLE_SECTIONS, READING, readsSettled, readyRead } from './model'

/**
 * F-CA-fx5 (customer page › PEOPLE & ADDRESSES tab, lane ca-; the walk 30-walk.md W-03, W-05, W-08; 18-lead-settles Z26) — a section
 * door lands under the record's sticky band and stays there when a later read lands; the refused page sends no People read; the
 * Personal data ⓘ holds the keys sentence like the other three.
 */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('W-03 (Z26): a section door lands under the record header, and does not jump when a later read lands', () => {
  it('our anchors take the record frame\'s own band size (tokens before it measures), never a px; the kit stays as it is', () => {
    const css = uncommented(source('../view/people/people.css'))
    expect(css).toContain('.fw-ca { --fw-ca-land: var(--fw-rcf-top, calc(var(--nds-space-48) + var(--nds-space-16))); }')
    // Every section of the tab and the answer line above them: the tab's own ids, direct children of its root.
    const anchors = [PEOPLE_ANSWER_ID, ...PEOPLE_SECTIONS].map((id) => `#${id}`).join(', ')
    expect(css).toContain(`.fw-ca > :is(${anchors}) { scroll-margin-top: var(--fw-ca-land); }`)
    // A row's own address (a chip, "In People ↑", Copy link) lands on the same line.
    expect(css).toMatch(/\.fw-ca-row \{[^}]*scroll-margin-top: var\(--fw-ca-land\);[^}]*\}/)
    expect(css).not.toMatch(/scroll-margin-top:\s*\d+px/)
    // The name we lean on is the record frame's: its band + 16 px, measured (the docked thread starts on the same line).
    const frame = source('../../../../_shared/record-frame/RecordFrame.tsx')
    expect(frame).toContain('const top = (band?.getBoundingClientRect().height ?? 0) + 16')
    expect(frame).toContain("element.style.setProperty('--fw-rcf-top', `${Math.round(top)}px`)")
    // The section kit is used in place, never edited: its 4 px margin stays (ours wins on our ids).
    expect(source('../../../../../lib/record-sections/record-sections.css')).toContain('.fw-pt-sec { container: sec / inline-size; min-width: 0; scroll-margin-top: var(--nds-space-4); }') // owb-b5 (w5.1): the kit's rules moved with it
    expect(source('../view/people/PeopleTab.tsx')).toContain('<div className="fw-pt fw-ca">')
  })

  it('the reads are settled only when every read the reader makes has answered — ready or failed; one not asked yet still reads', () => {
    expect(readsSettled([readyRead(1), failedRead('problem.read.internal'), null])).toBe(true)
    expect(readsSettled([])).toBe(true)
    expect(readsSettled([readyRead(1), READING])).toBe(false)
    expect(readsSettled([null, { status: 'loading' }])).toBe(false)
    // A read this reader does not make (null: no measurements right, no portal right) never holds the arrival.
    expect(readsSettled([readyRead(1), null, null])).toBe(true)
  })

  it('the arrival lands once more when the tab\'s reads settle — never after the reader moved (their place wins)', () => {
    const tab = source('./use-people-tab.ts')
    // The anchor the door asked for is kept from the first landing…
    expect(tab).toContain('landing.current = target // F-CA-fx5: lands again once the reads settle (below)')
    expect(tab.indexOf('landing.current = target')).toBeLessThan(tab.indexOf('requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ block: \'start\' }))'))
    // …every read of the tab counts (one not asked yet = reading; a read the reader does not make = null)…
    expect(tab).toContain('const settled = readsSettled([usage ?? READING, riders ?? READING, can.measurements ? (profiles ?? READING) : null, input.privacy ?? READING, can.portal && !portal.model.access && !portal.model.problem ? READING : null])')
    // …a wheel, a touch, a key or a press of the reader forgets it…
    expect(tab).toContain("const kinds = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const")
    expect(tab).toMatch(/const moved = \(\) => \{\s*landing\.current = null\s*\}/)
    // …and it lands once: the anchor is forgotten before the scroll, and on leaving the tab.
    const settle = tab.slice(tab.indexOf('const target = landing.current'), tab.indexOf('// ---- end F-CA-fx5'))
    expect(settle).toContain('if (!on || !settled || !target) return')
    expect(settle.indexOf('landing.current = null')).toBeLessThan(settle.indexOf('scrollIntoView'))
    expect(settle).toContain('}, [on, settled])')
    expect(tab).toMatch(/if \(!on\) \{\s*arrived\.current = false\s*landing\.current = null \/\/ F-CA-fx5/)
  })
})

describe('W-05: the refused page (no parties.view) sends no People read', () => {
  it('the contacts\' privacy is read only by who may read the customer — the record\'s own right; still only on People', () => {
    const depth = source('../../depth/use-depth.ts')
    expect(depth).toContain("const readsCustomer = session.permissions.includes('parties.view')")
    expect(depth).toContain('const loadPrivacy = useCallback(() => (readsCustomer ? readOne(() => readPrivacy(api, partyId), setPrivacy) : Promise.resolve()), [api, partyId, readOne, readsCustomer])')
    // The ONE place the privacy route is called: behind the right (the first read, the live re-reads, Try again and a 409 all pass here).
    expect(depth.match(/readPrivacy\(api/g)).toHaveLength(1)
    expect(depth).toContain("else if (tab === 'people') void loadPrivacy()")
    // The record's own right is the same name (PartyRecord: the refused page reads it).
    expect(source('../../../../parties/_shared/PartyRecord.tsx')).toContain("view: held.has('parties.view'),")
  })
})

describe('W-08: every section\'s ⓘ holds its meaning and the keys sentence — Personal data too', () => {
  it('the four sections\' info say the keys (one ⓘ per section, no key hint elsewhere)', () => {
    for (const file of ['PeopleSection.tsx', 'AddressesSection.tsx', 'RidersSection.tsx', 'PrivacySection.tsx']) {
      const view = source(`../view/people/${file}`)
      const start = view.indexOf('const info = (')
      expect(start, file).toBeGreaterThan(-1)
      const info = view.slice(start, view.indexOf('</>', start))
      expect(info, file).toContain("<p>{say(said('keys'))}</p>")
      expect(view.match(/said\('keys'\)/g), file).toHaveLength(1)
    }
  })
})
