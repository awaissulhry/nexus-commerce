import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * F-CA-fx5 (customer page › PEOPLE & ADDRESSES tab, lane ca-; the walk 30-walk.md W-03, W-05, W-08; 18-lead-settles Z26) — a section
 * door lands under the record's sticky band and stays there when a later read lands; the refused page sends no People read; the
 * Personal data ⓘ holds the keys sentence like the other three.
 */

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

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
