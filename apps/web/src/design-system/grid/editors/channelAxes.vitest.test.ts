/**
 * Sheet pop-up P3 A2 — the channel pop-up's rules (`channelAxes.ts`), pure, and the save request a draft built by them
 * produces through the ONE variation writer (`variationThemeWrite`). Made-up family only.
 */
import { describe, expect, it } from 'vitest'
import type { VariationThemeCell } from '../renderers/variationTheme'
import {
  CHANNEL_AXES_COPY, channelAxisGapHint, channelAxisOrigin, channelAxisValues, channelSetChangeHeld, freeNameRefusal, newAttributeDoneLine, newAttributeHeld,
  ownAxisKeyFor, ownNameRefusal, remainingOwnCandidates, remainingSharedAxes, usesChannelAxesLayout, withOwnAxisSource, withOwnChannelAxis,
  withOwnSharedAxis, withSharedAxis, withoutAxis,
} from './channelAxes'
import { variationThemeWrite } from './sheetWriter'

const NECK = 'own:channel:scollatura'
const FIT = { field: 'fit', label: 'Fit', filled: 3, of: 4, values: ['Slim', 'Regular'] }

const EBAY: VariationThemeCell = {
  axes: [
    { axisKey: 'color', familyKey: 'Colore', label: 'Color', channelName: 'Colore', target: 'Colore', included: true },
    { axisKey: 'size', familyKey: 'Taglia', label: 'Size', channelName: 'Taglia', target: 'Taglia', included: false },
  ],
  theme: null,
  source: { kind: 'derived', ruleLabel: null, category: null, label: 'Derived from the family axes' },
  candidates: {
    kind: 'aspects', limit: 5, schemaFetchedAt: null, state: 'ok',
    items: ['Taglia', 'Colore', 'Scollatura'].map((code) => ({ code, label: code, coversAll: false, drops: [], deprecated: false, required: false })),
  },
  masterCandidates: null,
  dropped: ['size'],
  collisions: null,
  locked: null,
  ownCandidates: [{ axisKey: NECK, name: 'Scollatura', label: 'Neckline', filled: 2, of: 4 }],
  ownNames: { allowed: true, maxLength: 40, reason: null, refused: [{ name: 'Marca', reason: 'eBay lists Marca for this category, but not for variations.' }] },
  valueSummary: { Colore: { values: ['Rosso', 'Blu'], filled: 3, of: 4 } },
  write: { endpoint: 'projection', expectedVersion: 7, aliasKey: '', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'acct-1' } },
  writable: true,
  writeBlockedReason: null,
  vocabulary: { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' },
  separator: ' · ',
}

describe('which cell opens the channel layout', () => {
  it('eBay, Etsy and (A4) Shopify do; Amazon (its theme), master and the dock adapter (no write) do not', () => {
    expect(usesChannelAxesLayout(EBAY)).toBe(true)
    expect(usesChannelAxesLayout({ ...EBAY, write: { ...EBAY.write!, coordinate: { ...EBAY.write!.coordinate, channel: 'ETSY' } } })).toBe(true)
    expect(usesChannelAxesLayout({ ...EBAY, write: { ...EBAY.write!, coordinate: { ...EBAY.write!.coordinate, channel: 'SHOPIFY' } } })).toBe(true)
    expect(usesChannelAxesLayout({ ...EBAY, write: { ...EBAY.write!, coordinate: { ...EBAY.write!.coordinate, channel: 'AMAZON' } } })).toBe(false)
    expect(usesChannelAxesLayout({ ...EBAY, candidates: { ...EBAY.candidates!, kind: 'theme-enum' } })).toBe(false)
    expect(usesChannelAxesLayout({ ...EBAY, masterCandidates: [] })).toBe(false)
    expect(usesChannelAxesLayout({ ...EBAY, write: null })).toBe(false)
  })
})

describe('adding and removing, as drafts', () => {
  it('an eBay aspect goes in last under its eBay name, and leaves the candidate list', () => {
    const next = withOwnChannelAxis(EBAY, EBAY.ownCandidates![0])
    expect(next.axes.at(-1)).toEqual({ axisKey: NECK, familyKey: NECK, label: 'Neckline', channelName: 'Scollatura', target: 'Scollatura', included: true, own: { from: 'channel', field: 'scollatura', custom: false } })
    expect(remainingOwnCandidates(next)).toEqual([])
  })

  it('a typed name goes in with its Shared attribute; a name eBay lists is not "custom"', () => {
    expect(withOwnSharedAxis(EBAY, '  Vestibilità ', FIT).axes.at(-1)).toEqual({ axisKey: ownAxisKeyFor('shared', 'fit'), familyKey: 'own:shared:fit', label: 'Vestibilità',
      channelName: 'Vestibilità', target: 'Vestibilità', included: true, own: { from: 'shared', field: 'fit', custom: true } })
    expect(withOwnSharedAxis(EBAY, 'scollatura', FIT).axes.at(-1)!.own!.custom).toBe(false)
  })

  it('a Shared axis not delivered here waits in "+ Add" and comes back last; removing a Shared axis only drops it here', () => {
    expect(remainingSharedAxes(EBAY).map((a) => a.axisKey)).toEqual(['size'])
    const back = withSharedAxis(EBAY, 'size')
    expect(back.axes.map((a) => [a.axisKey, a.included])).toEqual([['color', true], ['size', true]])
    expect(withoutAxis(back, 'color').axes.map((a) => [a.axisKey, a.included])).toEqual([['color', false], ['size', true]])
  })

  it('removing a channel-only axis deletes it from the draft', () => {
    const withNeck = withOwnChannelAxis(EBAY, EBAY.ownCandidates![0])
    expect(withoutAxis(withNeck, NECK).axes.some((a) => a.familyKey === NECK)).toBe(false)
  })
})

describe('the refusals a typed name meets before anything is saved', () => {
  const refuse = (name: string, hasSource = true) => ownNameRefusal(EBAY, name, hasSource, 'eBay')
  it('in the order an operator meets them, each in the save\'s own words', () => {
    expect(refuse('  ')).toBe(CHANNEL_AXES_COPY.nameMissing('specific'))
    expect(refuse('x'.repeat(41))).toBe(CHANNEL_AXES_COPY.nameTooLong('eBay', 'specific', 40))
    expect(refuse('marca')).toBe('eBay lists Marca for this category, but not for variations.')
    expect(refuse('COLORE')).toBe(CHANNEL_AXES_COPY.duplicate)
    expect(refuse('Stile', false)).toBe(CHANNEL_AXES_COPY.sourceMissing)
    expect(refuse('Stile')).toBeNull()
    expect(refuse('x'.repeat(40))).toBeNull()
  })

  it('a dropped Shared axis\'s name is free again — only delivered names collide', () => {
    expect(refuse('Taglia')).toBeNull()
  })
})

describe('what a row says', () => {
  it('where the axis comes from', () => {
    expect(channelAxisOrigin(EBAY.axes[0], 'eBay')).toBe('from Shared: Color')
    const neck = withOwnChannelAxis(EBAY, EBAY.ownCandidates![0]).axes.at(-1)!
    expect(channelAxisOrigin(neck, 'eBay')).toBe('only on eBay')
    const fit = withOwnSharedAxis(EBAY, 'Vestibilità', FIT).axes.at(-1)!
    expect(channelAxisOrigin(fit, 'eBay', [FIT])).toBe('your name · not in eBay’s search filters · values from Fit')
    expect(channelAxisOrigin(fit, 'eBay')).toBe('your name · not in eBay’s search filters · values from fit')
    expect(channelAxisOrigin({ ...fit, own: { ...fit.own!, custom: true } }, 'Etsy', [FIT])).toBe('your name · values from Fit')
  })

  it('its values and empty variants: the server summary, else what the pop-up knows before a save', () => {
    expect(channelAxisValues(EBAY, EBAY.axes[0])).toEqual({ values: ['Rosso', 'Blu'], empty: 1 })
    const fit = withOwnSharedAxis(EBAY, 'Vestibilità', FIT).axes.at(-1)!
    expect(channelAxisValues(EBAY, fit, [FIT])).toEqual({ values: ['Slim', 'Regular'], empty: 1 })
    expect(channelAxisValues(EBAY, fit)).toBeNull()
    const neck = withOwnChannelAxis(EBAY, EBAY.ownCandidates![0]).axes.at(-1)!
    expect(channelAxisValues(EBAY, neck)).toEqual({ values: [], empty: 2 })
  })

  it('where to fill the empty values', () => {
    expect(channelAxisGapHint(EBAY.axes[0])).toBe('Fill the Colore column on the variant rows.')
    const fit = withOwnSharedAxis(EBAY, 'Vestibilità', FIT).axes.at(-1)!
    expect(channelAxisGapHint(fit, [FIT])).toBe('Fill Fit on the Shared product.')
  })

  it('a live listing holds every set change with the server\'s own sentence', () => {
    expect(channelSetChangeHeld(EBAY)).toBeNull()
    expect(channelSetChangeHeld({ ...EBAY, locked: { reason: 'Live — changing the set relists it.', externalId: 'x', setChangeIs: 'relist', orderChangeAllowed: true } }))
      .toBe('Live — changing the set relists it.')
  })

  it('an add choice has one spoken name with a break between its parts (its spans ran together as "Taglia0 of 8 filled")', () => {
    const c = EBAY.ownCandidates![0]
    expect(CHANNEL_AXES_COPY.addOption(c.name, CHANNEL_AXES_COPY.filled(c.filled, c.of))).toBe('Add Scollatura, 2 of 4 filled')
    expect(CHANNEL_AXES_COPY.addOption('Size', CHANNEL_AXES_COPY.notHere('specific'))).toBe('Add Size, not a specific here')
    expect(CHANNEL_AXES_COPY.notHere('option')).toBe('not an option here')
  })
})

describe('P3 A4 — a Shopify option\'s free name', () => {
  const SHOP: VariationThemeCell = {
    ...EBAY,
    candidates: { kind: 'free', items: [], limit: 3, schemaFetchedAt: null, state: 'freeform' },
    ownCandidates: [],
    ownNames: { allowed: true, maxLength: 255, reason: null },
    vocabulary: { axisNoun: 'option', axisNounPlural: 'options', sectionTitle: 'Options' },
    write: { ...EBAY.write!, coordinate: { ...EBAY.write!.coordinate, channel: 'SHOPIFY', market: 'GLOBAL' } },
  }

  it('empty, too long, or another delivered option\'s name is refused; a dropped option\'s name is free', () => {
    const color = SHOP.axes[0]
    expect(freeNameRefusal(SHOP, color, 'Shopify')).toBeNull()
    expect(freeNameRefusal(SHOP, { ...color, target: '  ' }, 'Shopify')).toBe('Name this option.')
    expect(freeNameRefusal({ ...SHOP, ownNames: { allowed: true, maxLength: 5, reason: null } }, { ...color, target: 'Colours' }, 'Shopify'))
      .toBe('Shopify option names are at most 5 characters.')
    const withFit = withOwnSharedAxis(SHOP, 'Fit', FIT)
    const fit = withFit.axes.at(-1)!
    expect(freeNameRefusal(withFit, { ...fit, target: 'colore' }, 'Shopify')).toBe(CHANNEL_AXES_COPY.duplicate)
    /* Taglia is not delivered here (dropped), so its name is free for another option */
    expect(freeNameRefusal(withFit, { ...fit, target: 'Taglia' }, 'Shopify')).toBeNull()
  })
})

describe('P3 A3 — "New attribute"', () => {
  const OK = { allowed: true, reason: null, familyLabel: 'Sliders', familyProducts: 2 }

  it('is held with the server\'s reason first (no family, no permission), then the checks every typed name meets', () => {
    const noFamily = 'This product has no family, so a new attribute has nowhere to go. Choose a family on the Shared product first.'
    expect(newAttributeHeld(EBAY, { ...OK, allowed: false, reason: noFamily }, 'Stile', 'eBay')).toBe(noFamily)
    expect(newAttributeHeld(EBAY, { ...OK, allowed: false, reason: null }, 'Stile', 'eBay')).toBe(CHANNEL_AXES_COPY.noPermission)
    expect(newAttributeHeld(EBAY, OK, '  ', 'eBay')).toBe('Name this specific.')
    expect(newAttributeHeld(EBAY, OK, 'x'.repeat(41), 'eBay')).toBe('eBay specific names are at most 40 characters.')
    expect(newAttributeHeld(EBAY, OK, 'marca', 'eBay')).toBe('eBay lists Marca for this category, but not for variations.')
    expect(newAttributeHeld(EBAY, OK, 'colore', 'eBay')).toBe(CHANNEL_AXES_COPY.duplicate)
    /* the attribute IS the source, so "Choose where the values come from." never holds it */
    expect(newAttributeHeld(EBAY, OK, 'Stile', 'eBay')).toBeNull()
  })

  it('says before the write where it goes, who else gets the column, and that Esc does not take it back', () => {
    expect(CHANNEL_AXES_COPY.createLine('Stile', 'Sliders', 2)).toBe(
      'Creates “Stile” (per variant, text) in the family “Sliders” — 2 products get this empty column. It is created now: Esc does not remove it.')
    expect(CHANNEL_AXES_COPY.createLine('Stile', 'Sliders', 1)).toContain('1 product gets this empty column')
  })

  it('a created or placed attribute joins "Values from" once, and the pop-up says what happened', () => {
    const made = { field: 'stile', label: 'Stile', filled: 0, of: 4, values: [] }
    expect(withOwnAxisSource([FIT], made)).toEqual([FIT, made])
    expect(withOwnAxisSource([FIT, made], { ...made, of: 5 })).toEqual([FIT, { ...made, of: 5 }])
    expect(newAttributeDoneLine('created')).toBe(CHANNEL_AXES_COPY.created)
    expect(newAttributeDoneLine('placed')).toBe(CHANNEL_AXES_COPY.placed)
    expect(newAttributeDoneLine('present')).toBe(CHANNEL_AXES_COPY.present)
  })
})

describe('the save request a channel draft produces (the one variation writer)', () => {
  it('sends the channel-only axes under their keys and names, in the draft order', () => {
    const draft = withOwnSharedAxis(withOwnChannelAxis(EBAY, EBAY.ownCandidates![0]), 'Vestibilità', FIT)
    const write = variationThemeWrite({ kind: 'variationTheme' }, EBAY, draft)
    expect(write.send).toBe(true)
    if (!write.send) return
    expect(write.body.mapping).toEqual([
      { axisKey: 'Colore', target: 'Colore', order: 0 },
      { axisKey: NECK, target: 'Scollatura', order: 1 },
      { axisKey: 'own:shared:fit', target: 'Vestibilità', order: 2 },
    ])
    expect(write.query).toEqual({ channel: 'EBAY', market: 'IT', accountId: 'acct-1', aliasKey: '' })
  })

  it('removing the last channel-only axis is a set change too; opening and closing sends nothing', () => {
    const withNeck = { ...withOwnChannelAxis(EBAY, EBAY.ownCandidates![0]) }
    const removed = variationThemeWrite({ kind: 'variationTheme' }, withNeck, withoutAxis(withNeck, NECK))
    expect(removed.send && removed.change.kind).toBe('set')
    expect(variationThemeWrite({ kind: 'variationTheme' }, EBAY, EBAY).send).toBe(false)
  })
})
