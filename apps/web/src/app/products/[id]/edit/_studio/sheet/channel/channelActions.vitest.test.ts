/**
 * PES.3 — the channel verbs' refusals, which are the part that must never lie.
 */
import { describe, expect, it } from 'vitest'

import { AVAILABLE, actionLabel } from '@/design-system/grid/actions/registry'
import { tidyServerMessage } from './rows'

import { CHANNEL_VERB_PERMISSION, offerToggle, openRecordAction, permissionRefusal, type ChannelActionDeps } from './channelActions'
import type { ChannelSheetRow } from './types'

describe('permission refusals name the RIGHT permission (ruling #123)', () => {
  it('names products.edit, not a channels permission', () => {
    // Measured against permissions-manifest.ts:412 — `/api/products` prefix, so a CHANNEL verb
    // needs a PRODUCTS permission. Guessing by subject matter names the wrong one.
    expect(CHANNEL_VERB_PERMISSION).toBe('products.edit')
    expect(permissionRefusal('denied')).toContain('products.edit')
  })

  it('distinguishes NOT SIGNED IN from genuinely lacking it', () => {
    const noSession = permissionRefusal('no-session')!
    const denied = permissionRefusal('denied')!
    expect(noSession).not.toBe(denied)
    // The local-dev case must say so, or a developer reads a missing cookie as a permission defect.
    expect(noSession).toMatch(/not a permission problem/i)
    expect(denied).toMatch(/lacks/i)
  })

  it('says it is still checking rather than guessing', () => {
    expect(permissionRefusal('checking')).toMatch(/checking/i)
  })

  it('refuses nothing once granted', () => {
    expect(permissionRefusal('granted')).toBeNull()
  })
})

describe('the drawer has a way in (#135)', () => {
  /**
   * The drawer was mounted on the channel scope, wired to the registry and able to resolve any row
   * — and unreachable, because nothing offered to open it. A surface that exists only for the
   * person who built it has not shipped.
   */
  const deps = (openRecord: (id: string) => void): ChannelActionDeps => ({
    permission: 'granted',
    channel: 'EBAY',
    marketplace: 'IT',
    scopeLabel: 'eBay · IT',
    aliases: [],
    siblingMarkets: [],
    pickMarkets: async () => null,
    openRecord,
    openRecordId: null,
  })

  const variant = { rowId: 'primary:p1', rowKind: 'variant' } as unknown as ChannelSheetRow
  const band = { rowId: 'primary:band', rowKind: 'band' } as unknown as ChannelSheetRow

  it('is offered on a listing row', () => {
    expect(openRecordAction(deps(() => {})).available([variant])).toEqual(AVAILABLE)
  })

  it('is HIDDEN on an alias band — a group header is not a record', () => {
    // Not disabled: a band has no record to show, so the verb does not apply at all. Offering it
    // greyed out would ask the operator to work out why a header has no detail.
    expect(openRecordAction(deps(() => {})).available([band]).kind).toBe('hidden')
  })

  it('opens the row it was given, and nothing else', () => {
    const opened: string[] = []
    return openRecordAction(deps((id) => opened.push(id)))
      .run([variant])
      .then((r) => {
        expect(r.ok).toBe(true)
        expect(opened).toEqual(['primary:p1'])
      })
  })

  it('hides itself on the record already open — the drawer is the only surface today', () => {
    const d = deps(() => {})
    expect(openRecordAction({ ...d, openRecordId: 'primary:p1' }).available([variant]).kind).toBe('hidden')
  })

  it('needs no permission — reading a record is not products.edit', () => {
    const d = deps(() => {})
    expect(openRecordAction({ ...d, permission: 'no-session' }).available([variant])).toEqual(AVAILABLE)
  })
})

describe('#327·10 — a server sentence never ends mid-clause', () => {
  /**
   * Measured on Amazon·PL: `Unknown market "AMAZON:PL". This platform has: ` — 47 characters ending
   * in a colon that promises a list and delivers nothing, rendered on the surface that replaced the
   * listing wizard. A sentence stopping at a colon reads as a truncated bug report.
   */
  it('drops dangling punctuation and closes the sentence', () => {
    expect(tidyServerMessage('Unknown market "AMAZON:PL". This platform has: '))
      .toBe('Unknown market "AMAZON:PL". This platform has.')
  })

  it('leaves a well-formed message alone', () => {
    expect(tidyServerMessage('eBay refused this write.')).toBe('eBay refused this write.')
  })

  it('does not invent a full stop for an empty message', () => {
    expect(tidyServerMessage('   ')).toBe('')
  })
})

describe('#363 — the offer verb words itself from the SELECTION', () => {
  /**
   * The reason the resolver takes ROWS and not a count: with 2 of 3 paused, "Activate 3 offers"
   * is a lie about one of them. Only the verb knows which rows it would actually touch.
   */
  const deps2 = (): ChannelActionDeps => ({
    permission: 'granted', channel: 'EBAY', marketplace: 'IT', scopeLabel: 'eBay · IT',
    aliases: [], siblingMarkets: [], pickMarkets: async () => null,
    openRecord: () => {}, openRecordId: null,
  })
  const r = (offerActive: boolean | null) =>
    ({ rowId: `r${Math.random()}`, rowKind: 'variant', aliasId: null,
       listing: offerActive === null ? null : { offerActive } }) as unknown as ChannelSheetRow

  const labelFor = (rows: ChannelSheetRow[]) => actionLabel(offerToggle(deps2()), rows)

  it('says "Pause N offers" when every selected offer is active', () => {
    expect(labelFor([r(true), r(true), r(true)])).toBe('Pause 3 offers on eBay · IT')
  })

  it('says "Activate N offers" when every selected offer is paused', () => {
    expect(labelFor([r(false), r(false)])).toBe('Activate 2 offers on eBay · IT')
  })

  it('🔴 names the SUBSET on a mixed selection — the sentence a fixed string could not produce', () => {
    // 2 paused of 3: "Activate 3 offers" would be a lie about the active one.
    expect(labelFor([r(false), r(false), r(true)])).toBe('Activate 2 of 3 offers on eBay · IT')
  })

  it('falls back to the bare verb when no selected row has a listing', () => {
    expect(labelFor([r(null)])).toBe('Pause offer on eBay · IT')
  })

  it('the label and the availability agree — both read the same plan', () => {
    const rows = [r(false), r(false), r(true)]
    expect(labelFor(rows)).toContain('Activate 2 of 3')
    expect(offerToggle(deps2()).available(rows)).toEqual(AVAILABLE)
  })

  it('refuses only an EVEN split, where neither verb is more useful', () => {
    const a = offerToggle(deps2()).available([r(true), r(false)])
    expect(a.kind).toBe('disabled')
    expect((a as { reason: string }).reason).toMatch(/even split/)
  })
})
