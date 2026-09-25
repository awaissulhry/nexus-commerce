import { describe, expect, it } from 'vitest'
import { compareEbayContent, parseEbayItemContent } from './ebay-content-compare.js'

/** PLAN A-39 slice b2 (R-43) — the eBay title / item-specifics parser and compare. Pure. */

const GETITEM = `<?xml version="1.0" encoding="UTF-8"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item>
<ItemID>111</ItemID><Title>Giacca FAM &amp; Racing</Title>
<ItemSpecifics>
  <NameValueList><Name>Marca</Name><Value>Xavia Racing</Value><Source>ItemSpecific</Source></NameValueList>
  <NameValueList><Name>Caratteristiche</Name><Value>Ventilata</Value><Value>Impermeabile</Value><Value>Protezioni CE</Value></NameValueList>
  <NameValueList><Name>Tipo</Name><Value>Giacca</Value></NameValueList>
</ItemSpecifics>
<Variations><Variation><SKU>FAM-NERO-M</SKU><VariationSpecifics><NameValueList><Name>Colore</Name><Value>Nero</Value></NameValueList></VariationSpecifics></Variation>
<VariationSpecificsSet><NameValueList><Name>Taglia</Name><Value>M</Value><Value>L</Value></NameValueList></VariationSpecificsSet></Variations>
<SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus></Item></GetItemResponse>`

describe('parseEbayItemContent', () => {
  it('keeps EVERY value of a multi-value aspect, decodes entities, and never reads variation specifics', () => {
    const got = parseEbayItemContent(GETITEM)
    expect(got.title).toBe('Giacca FAM & Racing')
    expect(got.itemSpecifics).toEqual({ Marca: ['Xavia Racing'], Caratteristiche: ['Ventilata', 'Impermeabile', 'Protezioni CE'], Tipo: ['Giacca'] })
    expect(got.itemSpecifics).not.toHaveProperty('Colore')
    expect(got.itemSpecifics).not.toHaveProperty('Taglia')
  })

  it('an answer with no title or specifics reads as null / empty (never as a value)', () => {
    expect(parseEbayItemContent('<Item><ItemID>1</ItemID></Item>')).toEqual({ title: null, itemSpecifics: {} })
  })

  it('reads XML structure rather than apparent tags inside description CDATA', () => {
    const xml = '<Item><Description><![CDATA[<Title>Not the title</Title><ItemSpecifics><NameValueList><Name>Fake</Name><Value>Wrong</Value></NameValueList></ItemSpecifics>]]></Description><Title><![CDATA[Real & title]]></Title><ItemSpecifics><NameValueList><Name>Materiale</Name><Value>Caf&#xE9;</Value></NameValueList></ItemSpecifics></Item>'
    expect(parseEbayItemContent(xml)).toEqual({ title: 'Real & title', itemSpecifics: { Materiale: ['Café'] } })
  })

  it('reads namespace-prefixed Trading content and refuses malformed XML', () => {
    expect(parseEbayItemContent('<e:Item xmlns:e="urn:ebay:apis:eBLBaseComponents"><e:Title>Real title</e:Title></e:Item>')).toEqual({ title: 'Real title', itemSpecifics: {} })
    expect(() => parseEbayItemContent('<Item><Title>Broken</Item>')).toThrow(/XML/i)
  })
})

const theirs = parseEbayItemContent(GETITEM)
const ours = (over: Partial<{ title: string; itemSpecifics: Record<string, string | string[]> }> = {}) => ({
  title: 'Giacca FAM & Racing',
  itemSpecifics: { Marca: 'Xavia Racing', Caratteristiche: ['Ventilata', 'Impermeabile', 'Protezioni CE'] },
  ...over,
})

describe('compareEbayContent', () => {
  it('identical — even with the values reordered, extra spaces and a different aspect-name case — compares clean', () => {
    const r = compareEbayContent(ours({ title: '  Giacca  FAM & Racing ', itemSpecifics: { marca: 'Xavia  Racing', CARATTERISTICHE: ['Protezioni CE', 'Ventilata', 'Impermeabile'] } }), theirs)
    expect(r.differing).toEqual([])
    expect(r.compared).toEqual(['title', 'aspect:marca', 'aspect:CARATTERISTICHE'])
  })

  it('a seeded title difference is one entry, with both values', () => {
    const r = compareEbayContent(ours({ title: 'Giacca FAM Racing 2026' }), theirs)
    expect(r.differing).toEqual([{ field: 'title', ours: 'Giacca FAM Racing 2026', theirs: 'Giacca FAM & Racing' }])
  })

  it('one value of a multi-value aspect different is an entry on that aspect', () => {
    const r = compareEbayContent(ours({ itemSpecifics: { Marca: 'Xavia Racing', Caratteristiche: ['Ventilata', 'Impermeabile', 'Riflettente'] } }), theirs)
    expect(r.differing).toEqual([{ field: 'aspect:Caratteristiche', ours: ['Impermeabile', 'Riflettente', 'Ventilata'], theirs: ['Impermeabile', 'Protezioni CE', 'Ventilata'] }])
  })

  it('an aspect we send that eBay does not hold is drift (theirs null)', () => {
    const r = compareEbayContent(ours({ itemSpecifics: { Marca: 'Xavia Racing', Caratteristiche: ['Ventilata', 'Impermeabile', 'Protezioni CE'], Materiale: 'Pelle' } }), theirs)
    expect(r.differing).toEqual([{ field: 'aspect:Materiale', ours: ['Pelle'], theirs: null }])
  })

  it('an aspect only eBay holds is NOT compared (we do not send it), and is not drift', () => {
    const r = compareEbayContent(ours(), theirs)
    expect(r.differing).toEqual([])
    expect(r.compared).not.toContain('aspect:Tipo')
    expect(r.notCompared).toEqual([{ field: 'aspect:Tipo', reason: 'we do not send this aspect' }])
  })

  it('no title of ours is not compared (never compared as an empty title)', () => {
    const r = compareEbayContent(ours({ title: '  ' }), theirs)
    expect(r.compared).not.toContain('title')
    expect(r.notCompared).toContainEqual({ field: 'title', reason: 'no title of ours' })
  })
})
