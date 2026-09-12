/**
 * VP.4 — the channel projection's pure rules.
 *
 * `apps/web` vitest is NODE-only (no jsdom, no JSX), which is why every rule that matters on this
 * surface is a pure function in a `.ts` and not logic living inside a renderer. What is asserted
 * here is what a screenshot cannot show: the ROW ORDER, the chip COUNTS, the parse boundary's
 * refusals, and the §9 sentences character for character.
 *
 * 🔴 Each test states the arm it exercises. A test that would pass on an empty input is marked with
 * its positive control beside it — a green produced by having nothing to look at is the dangerous
 * kind (reference_control_must_target_the_branch).
 */
import { describe, expect, it } from 'vitest'

import type { ProjectionChild, ProjectionPage } from './types'
import { axisRank, chipRowIds, matchesSearch, projectionCounts, projectionRows } from './rows'
import { parseProjection } from './source'
import { planPin } from './pinValue'
import {
  axisNounPlural, dockSubtitle, mappedCount, mappingSentence, sameAsSharedNote, specificsHint,
  splitHint, splitPerAxisLabel, splitSingleLabel, usedCount,
} from './copy'
import type { ProjectionVocabulary } from './types'

/** The four channels' vocabularies, as VP.2's contract §1 table serves them. */
const EBAY: ProjectionVocabulary = { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' }
const ETSY: ProjectionVocabulary = { axisNoun: 'property', axisNounPlural: 'properties', sectionTitle: 'Properties' }
const AMAZON: ProjectionVocabulary = { axisNoun: 'theme', axisNounPlural: 'themes', sectionTitle: 'Variation theme' }

describe('rows — §3.3 order, inherited by §4.3', () => {
  it('puts the parent first and then follows the AXIS order, not the SKU order', () => {
    const page = projectionFixture()
    const rows = projectionRows(page)

    expect(rows).toHaveLength(page.children.length)
    /* VP.2's read carries no parent row yet, so the fixture has none and the grid is the variants
       alone — the surface supplies its own head row (see `ProjectionParent`). The arm for the
       parent-first order is the explicit-parent test below. */
    expect(rows[0].kind).toBe('variant')

    /* The axis order is Nero then Giallo, XXS then XS then S … so the first variant is Nero/XXS.
       An alphabetical SKU sort would put GALE-JACKET-BLACK-MEN-3XL first — that string comparison
       is the positive control below, and the two orders must NOT agree. */
    const skus = rows.map(r => r.child!.sku)
    expect(skus[0]).toBe('GALE-JACKET-BLACK-MEN-XXS')
    expect(skus[1]).toBe('GALE-JACKET-BLACK-MEN-XS')

    const alphabetical = [...skus].sort((a, b) => a.localeCompare(b))
    expect(alphabetical[0]).toBe('GALE-JACKET-BLACK-MEN-3XL')
    expect(skus).not.toEqual(alphabetical)
  })

  it('sorts every Nero before every Giallo — the first axis is the most significant', () => {
    const page = projectionFixture()
    const colours = projectionRows(page).map(r => r.child!.sharedAxisValues!.Colore)
    const firstGiallo = colours.indexOf('Giallo')
    expect(firstGiallo).toBe(10)
    expect(colours.slice(0, firstGiallo).every(c => c === 'Nero')).toBe(true)
    expect(colours.slice(firstGiallo).every(c => c === 'Giallo')).toBe(true)
  })

  it('puts a parent row FIRST when it is given one, and none when it is not', () => {
    const page = projectionFixture()
    expect(projectionRows(page)[0].kind).toBe('variant')
    const parent = {
      id: 'p', sku: 'GALE-JACKET', name: null, image: null, listings: 1,
      listing: { state: null, externalId: null },
    }
    const withParent = projectionRows(page, parent)
    expect(withParent).toHaveLength(page.children.length + 1)
    expect(withParent[0]).toMatchObject({ kind: 'parent', rowId: 'p' })
    expect(withParent[1].kind).toBe('variant')
  })

  it('ranks a value the axis does not declare LAST, not first', () => {
    const page = projectionFixture()
    const stranger = { ...page.children[0], sharedAxisValues: { Colore: 'Verde', Taglia: 'XXS' } }
    const rank = axisRank(page, stranger)
    expect(rank[0]).toBe(Number.MAX_SAFE_INTEGER)
    /* The positive control: a value the axis DOES declare ranks by position, so the MAX above is
       the unknown branch and not a rule that returns MAX for everything. */
    expect(rank[1]).toBe(0)
  })
})

describe('counts — §4.2 chips', () => {
  it('counts excluded variants, pinned ROWS and unmapped axes', () => {
    const counts = projectionCounts(projectionFixture())
    expect(counts.total).toBe(20)
    expect(counts.excluded).toBe(1)
    expect(counts.included).toBe(19)
    /* One child carries a pinned Colore in the fixture, so `pinned` is a count of ROWS. The arm
       that would break if it counted CELLS is a row with two pinned values; the assertion below
       builds one and holds the count at 1. */
    expect(counts.pinned).toBe(1)
    expect(counts.mappingErrors).toBe(0)
  })

  it('counts a row with two pinned values ONCE — the chip narrows to rows', () => {
    const page = projectionFixture()
    const [first, ...rest] = page.children
    const doubled = {
      ...first,
      values: {
        Colore: { value: 'x', source: 'pinned' as const },
        Taglia: { value: 'y', source: 'pinned' as const },
      },
    }
    expect(projectionCounts({ ...page, children: [doubled, ...rest] }).pinned).toBe(2)
  })

  it('counts an axis with no target as a mapping error', () => {
    const page = projectionFixture()
    const broken = { ...page, mapping: page.mapping.map((m, i) => i === 0 ? { ...m, target: null } : m) }
    expect(projectionCounts(broken).mappingErrors).toBe(1)
  })
})

describe('chip narrowing', () => {
  it('narrows to excluded rows, to pinned rows, and to NOTHING for a mapping error', () => {
    const page = projectionFixture()
    expect(chipRowIds(page, 'vp-excluded')?.size).toBe(1)
    expect(chipRowIds(page, 'vp-pinned')?.size).toBe(1)
    /* A mapping error is not a property of a row, so this returns null — "do not narrow" — rather
       than an empty set, which the grid would render as "no rows match". */
    expect(chipRowIds(page, 'vp-mapping-errors')).toBeNull()
    expect(chipRowIds(page, null)).toBeNull()
  })
})

describe('search — §4.2 Find', () => {
  it('matches a SKU, a name and an axis value, and an empty term matches everything', () => {
    const rows = projectionRows(projectionFixture())
    const row = rows[1]
    expect(matchesSearch(row, '')).toBe(true)
    expect(matchesSearch(row, 'yellow')).toBe(false)
    expect(matchesSearch(row, 'BLACK')).toBe(true)
    expect(matchesSearch(row, 'giacca')).toBe(true)
    expect(matchesSearch(row, 'nero')).toBe(true)
  })
})

describe('parseProjection — the ONE wire boundary', () => {
  const ok = () => JSON.parse(JSON.stringify(projectionFixture())) as Record<string, unknown>

  it('accepts the contract it was written against', () => {
    expect(() => parseProjection(ok())).not.toThrow()
  })

  it.each([
    ['no body', null],
    ['no version', { ...ok(), version: undefined }],
    ['no vocabulary', { ...ok(), vocabulary: undefined }],
    ['a vocabulary with no plural', { ...ok(), vocabulary: { axisNoun: 'specific' } }],
    ['no limits at all', { ...ok(), limits: undefined }],
    ['limits that are not numbers', { ...ok(), limits: { axes: '5', variants: 250, source: {} } }],
    ['no freeform flag', { ...ok(), freeform: undefined }],
    ['no split', { ...ok(), split: undefined }],
    ['a split with an unknown mode', { ...ok(), split: { ...ok().split as object, mode: 'per-value' } }],
    ['children that are not an array', { ...ok(), children: {} }],
    ['a child with no id', { ...ok(), children: [{ sku: 'X', included: true, values: {}, listing: {} }] }],
    ['a child whose `included` is a string', { ...ok(), children: [{ id: 'a', sku: 'X', included: 'yes', values: {}, listing: {} }] }],
  ])('refuses %s rather than returning a half page', (_name, body) => {
    expect(() => parseProjection(body)).toThrow(/incomplete/i)
  })

  it('does NOT substitute a default limit or axis noun — §4.5', () => {
    /* The refusal above is the whole point: a parser that defaulted `limits.axes` to 5 would put
       eBay's number on an Etsy coordinate, one layer below where anyone would look for it. */
    const noNoun = { ...ok(), vocabulary: { axisNoun: '', axisNounPlural: '', sectionTitle: '' } }
    expect(() => parseProjection(noNoun)).toThrow()
  })

  it('ACCEPTS null limits — "no limit we can source" is a contract value, not a shape error', () => {
    /* The discriminator against the test above: null passes, a string does not. Without this arm the
       parser could reject every Amazon coordinate and the refusal tests would still be green. */
    const amazon = { ...ok(), limits: { axes: 3, variants: null, source: { axes: 'the PT enum', variants: null } } }
    expect(() => parseProjection(amazon)).not.toThrow()
    expect(parseProjection(amazon).limits.variants).toBeNull()
  })
})

describe('copy — §9, verbatim', () => {
  it('takes the plural from the WIRE — `property` does not pluralise with + s', () => {
    expect(axisNounPlural(EBAY)).toBe('specifics')
    /* The arm that would break a client-side `+ s`: `propertys`. This is why VP.2 sends it. */
    expect(axisNounPlural(ETSY)).toBe('properties')
    /* The fallback branch, for a vocabulary that predates the field. */
    expect(axisNounPlural({ axisNoun: 'option', axisNounPlural: '' })).toBe('options')
  })

  it('writes the mapping band counts the way §9 writes them', () => {
    expect(mappedCount(2, 5, EBAY)).toBe('2 of 5 specifics')
    expect(usedCount(2, 5)).toBe('2 of 5 used')
  })

  it('DROPS a limit it has no source for rather than inventing one', () => {
    /* VP.2 contract §1: `null` = "no limit we can source". Amazon has no sourced variant cap.
       The positive control is the eBay line above — the same calls with a number print it. */
    expect(mappedCount(2, null, AMAZON)).toBe('2 themes')
    expect(usedCount(2, null)).toBe('2 used')
    expect(splitSingleLabel(19, null)).toBe('One listing — 19 variations')
    expect(specificsHint('Amazon', AMAZON, null))
      .toBe('Each shared axis becomes one Amazon theme. Drag to set the order buyers pick in.')
    expect(splitHint('Amazon', null, 2, AMAZON)).toBe('How this family lands on Amazon. Limits: 2 themes per listing.')
    expect(splitHint('Amazon', null, null, AMAZON)).toBe('How this family lands on Amazon.')
  })

  it('omits the "of N allowed" half when no variant cap is sourced', () => {
    expect(mappingSentence(1, 19, 20, null).allowed).toBeNull()
  })

  it('builds `One listing · 19 of 20 variants included · 20 of 250 allowed`', () => {
    const s = mappingSentence(1, 19, 20, 250)
    expect(s.listings).toBe('One listing')
    expect(`${s.listings} · ${s.included.count} ${s.included.of} · ${s.allowed!.count} ${s.allowed!.of}`)
      .toBe('One listing · 19 of 20 variants included · 20 of 250 allowed')
  })

  it('says "2 listings" when there are two', () => {
    expect(mappingSentence(2, 19, 20, 250).listings).toBe('2 listings')
  })

  it('drops a missing account from the dock sub-line instead of printing a dangling separator', () => {
    expect(dockSubtitle('GALE-JACKET', 20, 1, 'XAVIA Italia')).toBe('GALE-JACKET · 20 variants · 1 listing · XAVIA Italia')
    expect(dockSubtitle('GALE-JACKET', 20, 1, null)).toBe('GALE-JACKET · 20 variants · 1 listing')
    expect(dockSubtitle('GALE-JACKET', 1, 2, null)).toBe('GALE-JACKET · 1 variant · 2 listings')
  })

  it('writes §4.4.1 and §4.4.3 with the CHANNEL’s own words and limits', () => {
    expect(specificsHint('eBay', EBAY, 5))
      .toBe('Each shared axis becomes one eBay specific. Drag to set the order buyers pick in. eBay allows up to 5.')
    expect(splitHint('eBay', 250, 5, EBAY)).toBe('How this family lands on eBay. Limits: 250 variations, 5 specifics per listing.')
    expect(splitSingleLabel(19, 250)).toBe('One listing — 19 of 250 variations')
    expect(splitPerAxisLabel('Colore', 2, [9, 10])).toBe('One listing per Colore — 2 listings · 9 + 10')
    expect(sameAsSharedNote('Taglia', 10, 19)).toBe('Taglia · 10 values · same as shared · 19 included')
    /* The positive control for "the limits come from the wire": another channel's numbers AND its
       own noun produce another channel's sentence through the same call. */
    expect(splitHint('Etsy', 70, 2, ETSY)).toBe('How this family lands on Etsy. Limits: 70 variations, 2 properties per listing.')
  })
})

describe('the fixture is a FIXTURE, and behaves like the contract', () => {
  it('excludes exactly one child and marks it excluded, not draft', () => {
    const page = projectionFixture()
    const excluded = page.children.filter(c => !c.included)
    expect(excluded).toHaveLength(1)
    expect(excluded[0].listing.state).toBe('excluded')
    expect(excluded[0].listing.externalId).toBeNull()
  })

  it('counts INCLUDED variants per axis value — §4.4.2’s rule', () => {
    const page = projectionFixture()
    const taglia = page.axes!.find(a => a.key === 'Taglia')!
    /* XXS has two children (Nero and Giallo) and the Giallo one is excluded, so the count is 1
       while every other size counts 2. A count of CHILDREN would read 2 everywhere — that is the
       arm this assertion exists for. */
    expect(taglia.values.find(v => v.code === 'XXS')!.count).toBe(1)
    expect(taglia.values.find(v => v.code === 'M')!.count).toBe(2)
  })
})

describe('planPin — §4.3\'s one click, and what it refuses', () => {
  const page = projectionFixture()
  const child = page.children[0]
  const coordinate = page.coordinate

  it('offers a PIN on an inherited cell, and names the value and the coordinate', () => {
    const plan = planPin({
      child, axisKey: 'Colore', coordinate, inheritedValue: 'Nero',
      cell: { value: 'Nero', source: 'inherited', write: { field: 'attr_color', target: 'channelListing', verb: 'channel', version: 35 } },
    })
    expect(plan).toMatchObject({ intent: 'pin', heldReason: null })
    expect(plan.actionLabel).toBe(`Pin Nero on eBay · IT for ${child.sku}`)
  })

  it('offers a RESET on a pinned cell, and names the value it returns to', () => {
    const plan = planPin({
      child, axisKey: 'Colore', coordinate, inheritedValue: 'Nero',
      cell: { value: 'Giallo senape', source: 'pinned', write: { field: 'attr_color', target: 'channelListing', verb: 'channel', version: 35 } },
    })
    expect(plan).toMatchObject({ intent: 'reset', heldReason: null })
    expect(plan.actionLabel).toBe(`Reset ${child.sku} to the shared value Nero`)
  })

  it('passes the SERVER\'s sentence through when it cannot compute the landing value', () => {
    const plan = planPin({
      child, axisKey: 'Colore', coordinate, inheritedValue: undefined,
      inheritedValueUnknownReason: 'This cell is produced by a mapping rule, so a reset does not land on the master value.',
      cell: { value: 'Nero', source: 'pinned', write: { field: 'attr_color', target: 'channelListing', verb: 'channel', version: 35 } },
    })
    expect(plan.heldReason).toBe('This cell is produced by a mapping rule, so a reset does not land on the master value.')
  })

  it('🔴 REFUSES a reset when the server has not said where it would LAND', () => {
    /* The defect this caught, on live data: the projection reports `sharedAxisValues.Colore =
       "Nero"` while master's `color` is null, so a reset labelled "restore Nero" would have emptied
       a specific on a LIVE eBay listing. `undefined` = the server has not answered; `null` = it has
       answered "nothing". They are different sentences and both hold. The positive control is the
       reset test above, which has a landing value and IS offered. */
    const unknown = planPin({
      child, axisKey: 'Colore', coordinate, inheritedValue: undefined,
      cell: { value: 'Nero', source: 'pinned', write: { field: 'attr_color', target: 'channelListing', verb: 'channel', version: 35 } },
    })
    expect(unknown.heldReason).toMatch(/has not said which value this would fall back to/)
    expect(unknown.actionLabel).toBe('')

    const nothing = planPin({
      child, axisKey: 'Colore', coordinate, inheritedValue: null,
      cell: { value: 'Nero', source: 'pinned', write: { field: 'attr_color', target: 'channelListing', verb: 'channel', version: 35 } },
    })
    expect(nothing.intent).toBe('reset')
    /* `null` is the server ANSWERING "a reset empties this". Measured: that is every normal row on
       eBay·IT, and clearing a specific on a live listing is not what "reset" promises. */
    expect(nothing.heldReason).toMatch(/would CLEAR this/)
    expect(nothing.actionLabel).toBe('')
  })

  it('HOLDS with the SERVER\'s sentence when the server sent one', () => {
    const plan = planPin({
      child, axisKey: 'Colore', coordinate, inheritedValue: 'Nero',
      cell: { value: 'Nero', source: 'inherited', write: null, writeBlockedReason: 'This field is locked by the category schema.' },
    })
    expect(plan.heldReason).toBe('This field is locked by the category schema.')
  })

  it('HOLDS when the wire carries no write route — never guesses one', () => {
    /* `commitChannelRow`: "the write target comes from the CELL, not from this client". With no
       route there is no action at all, and the reason is on the control. */
    const plan = planPin({
      child, axisKey: 'Colore', coordinate, inheritedValue: 'Nero',
      cell: { value: 'Nero', source: 'inherited' },
    })
    expect(plan.heldReason).toMatch(/no write route/)
  })

  it('HOLDS a pin with nothing to pin', () => {
    const plan = planPin({
      child, axisKey: 'Colore', coordinate, inheritedValue: null,
      cell: { value: null, source: 'inherited', write: { field: 'attr_color', target: 'channelListing', verb: 'channel', version: 35 } },
    })
    expect(plan.heldReason).toMatch(/no value to pin/)
  })
})

const ITEM_ID = '257584954808'

/** Read from the sheet: 2 colours × 10 sizes, Italian values, in the order the axes are stored. */
const COLOURS = ['Nero', 'Giallo'] as const
const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'] as const

/** Read from the sheet — `GALE-JACKET-<BLACK|YELLOW>-MEN-<size>`, and the real child ids. */
const CHILD_IDS: Record<string, string> = {
  'Nero/3XL': 'cmokmy0jf0003pm0ppnu1b2yy', 'Nero/4XL': 'cmokmy0jt0004pm0p0gaufo1b',
  'Nero/5XL': 'cmokmy2ir005bpm0p0sm1rxx8', 'Nero/L': 'cmokmy0k70005pm0puvz2ucxu',
  'Nero/M': 'cmokmy0kl0006pm0p9auaundx', 'Nero/S': 'cmokmy0ky0007pm0p3vj7q0mh',
  'Nero/XL': 'cmokmy0lc0008pm0p2thzmlqq', 'Nero/XS': 'cmokmy0lr0009pm0p9yxk7ho0',
  'Nero/XXL': 'cmokmy0m9000apm0pm52rd77m', 'Nero/XXS': 'cmokmy0mm000bpm0pm7k7eke4',
  'Giallo/3XL': 'cmokmy0n4000cpm0ptkjitr0f', 'Giallo/4XL': 'cmokmy0ni000dpm0p2xvcpkma',
  'Giallo/5XL': 'cmokmy0o1000epm0pca79fbbf', 'Giallo/L': 'cmokmy0og000fpm0pdwckcnq0',
  'Giallo/M': 'cmokmy0ot000gpm0p4z5vwnoo', 'Giallo/S': 'cmokmy0p6000hpm0ptee51htd',
  'Giallo/XL': 'cmokmy0pk000ipm0pi8nl7pbn', 'Giallo/XS': 'cmokmy0py000jpm0pc2jcd5ul',
  'Giallo/XXL': 'cmokmy0qb000kpm0p06pmx2vt', 'Giallo/XXS': 'cmokmy0qp000lpm0p2yxw35ku',
}

const SKU_COLOUR: Record<string, string> = { Nero: 'BLACK', Giallo: 'YELLOW' }

/**
 * §4.1's sentence reads `**19** of 20 variants included` on the canvas, so the fixture excludes
 * exactly one child — and it is the one an operator would exclude, the smallest yellow size, not a
 * random row. §4.3's "excluded rows render their mapped values muted" has an arm because of it.
 */
const EXCLUDED = new Set(['Giallo/XXS'])

/** INVENTED (see the header): one pinned value, so the pin + 7% tint branch of §4.3 has an arm. */
const PINNED: Record<string, { axisKey: string; value: string }> = {
  'Giallo/M': { axisKey: 'Colore', value: 'Giallo senape' },
}

function child(colour: string, size: string): ProjectionChild {
  const key = `${colour}/${size}`
  const included = !EXCLUDED.has(key)
  const pin = PINNED[key]
  return {
    id: CHILD_IDS[key],
    sku: `GALE-JACKET-${SKU_COLOUR[colour]}-MEN-${size}`,
    name: 'XAVIA GALE Giacca Da Moto Da Uomo',
    image: null,
    sharedAxisValues: { Colore: colour, Taglia: size },
    included,
    values: {
      Colore: pin?.axisKey === 'Colore'
        ? { value: pin.value, source: 'pinned' }
        : { value: colour, source: 'inherited' },
      Taglia: { value: size, source: 'inherited' },
    },
    /* Read from the sheet: every child is on the one live ItemID, and every child carries an
       `imageUrls` error — so the honest state for an included child here is `needs-value`, not
       `listed`. An excluded child is `excluded` whatever else is true of it. */
    listing: included
      ? { state: 'needs-value', externalId: ITEM_ID }
      : { state: 'excluded', externalId: null },
    readiness: { pct: null, state: included ? 'errors' : null },
  }
}

function projectionFixture(): ProjectionPage {
  const children = COLOURS.flatMap(colour => SIZES.map(size => child(colour, size)))
  const includedOf = (axisKey: string, value: string) =>
    children.filter(c => c.included && c.sharedAxisValues?.[axisKey] === value).length
  return {
    /* The LISTING's version — `presentation-order` read 10 on this coordinate. §5.4's PATCH guards
       on it, and the parent product's version (54) is a different counter entirely. */
    version: 10,
    coordinate: {
      channel: 'EBAY',
      channelLabel: 'eBay',
      market: 'IT',
      accountId: 'cmr4aaqb00025nz016k18rup9',
      accountLabel: 'xaviaracing',
      aliasKey: '',
      label: 'eBay · IT',
    },
    vocabulary: { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' },
    /* Top-level, and PINNED to code on the server: `limits.source` names the file each number came
       from, so an operator hovering the count sees where 5 and 250 are enforced. */
    limits: {
      axes: 5,
      variants: 250,
      source: {
        axes: 'ebay-theme-axes.ts — parseThemeAxes truncates the declared theme at this many axes',
        variants: 'ebay-variation-preflight.ts — MAX_VARIANTS, the preflight that refuses a larger family',
      },
    },
    freeform: false,
    /* `Product.variationAxes` = ["Colore","Taglia"], both already mapped onto the eBay aspect of
       the same name — which is why the canvas draws `Colore → Colore`. */
    mapping: [
      { axisKey: 'Colore', axisLabel: 'Colore', target: 'Colore', order: 0 },
      { axisKey: 'Taglia', axisLabel: 'Taglia', target: 'Taglia', order: 1 },
    ],
    /* INVENTED: a plausible eBay clothing category aspect set. §4.5 — the real list comes from the
       eBay aspect services through VP.2, and the UI never hardcodes one. */
    targetOptions: [
      { code: 'Colore', label: 'Colore' },
      { code: 'Taglia', label: 'Taglia' },
      { code: 'Materiale', label: 'Materiale' },
      { code: 'Stile', label: 'Stile' },
      { code: 'Tipo di chiusura', label: 'Tipo di chiusura' },
    ],
    split: {
      mode: 'single',
      listings: [{ aliasKey: '', label: 'One listing', count: children.filter(c => c.included).length }],
      /* 🔴 Alias creation is inert until PES.5-ii (§4.4.3). The option renders and is HELD with
         this sentence on it — never a silent disable. */
      creatable: false,
      heldReason: 'Splitting into more than one listing is not available yet — the listing alias layer is still being deployed.',
    },
    /* The coordinate HAS a live listing (ItemID 257584954808 on every row), so §4.4.4's lock banner
       is on its real arm here, not on a synthetic one. */
    locked: {
      reason: 'Item 257584954808 is live with Colore and Taglia. Adding or removing a specific relists it; reordering and adding values do not.',
      lockedAxisKeys: ['Colore', 'Taglia'],
    },
    /* VP.2's read does NOT carry a parent row (REQUEST A6) — the fixture matches the wire rather
       than the proposal, so the surface's derived-parent path is the one this exercises. */
    children,
    order: {
      axes: ['Colore', 'Taglia'],
      valueOrder: { __dim0__: ['Nero', 'Giallo'], __dim1__: [...SIZES] },
      editorUrl: '/api/ebay/cockpit/presentation-order',
      writableHere: false,
      reason: 'The presentation order has its own editor, which guards it with a listing version and an input token. Saving it here would be a second writer for the same bytes.',
    },
    axes: [
      { key: 'Colore', label: 'Colore', values: COLOURS.map(v => ({ code: v, label: v, count: includedOf('Colore', v) })) },
      { key: 'Taglia', label: 'Taglia', values: SIZES.map(v => ({ code: v, label: v, count: includedOf('Taglia', v) })) },
    ],
  }
}

