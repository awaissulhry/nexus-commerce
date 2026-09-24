import { expect, it } from 'vitest'
import { foreignOwnTextIssues } from './foreign-own-text.js'

/** A-32 (R-30) — a listing's own text that is the product's primary-language text, on a market with another language. */
const product = { name: 'XAVIA REGAL Giacca Da Moto', description: 'Giacca da moto in tessuto', bulletPoints: ['Impermeabile', 'Traspirante'] }
const pinned = { followMasterTitle: false, followMasterDescription: false, followMasterBulletPoints: false }
const de = { channel: 'AMAZON', marketplace: 'DE', marketLanguages: ['de'], primary: 'it', product }

it('🔴 names a DE listing whose pinned title is the Italian product title', () => {
  const issues = foreignOwnTextIssues({ ...de, listing: { ...pinned, title: product.name } })
  expect(issues).toEqual([{ field: 'title', message: "This Amazon · DE listing's own title is the Italian text, and it would go out as German. Give it German text, or let it follow the product." }])
})

it('🔴 names a pinned description and pinned bullets the same way, and a child pinned to its PARENT\'s text', () => {
  expect(foreignOwnTextIssues({ ...de, listing: { ...pinned, description: product.description, bulletPointsOverride: product.bulletPoints } }).map(i => i.field))
    .toEqual(['description', 'bulletPoints'])
  expect(foreignOwnTextIssues({ ...de, product: { name: 'child' }, parent: product, listing: { ...pinned, title: product.name } }).map(i => i.field)).toEqual(['title'])
})

it('control: a German pinned title is not named', () => {
  expect(foreignOwnTextIssues({ ...de, listing: { ...pinned, title: 'XAVIA REGAL Motorradjacke' } })).toEqual([])
})

it('control: on a market that speaks the primary language (Amazon·IT), the Italian text is right', () => {
  expect(foreignOwnTextIssues({ ...de, marketplace: 'IT', marketLanguages: ['it'], listing: { ...pinned, title: product.name } })).toEqual([])
})

it('control: a FOLLOWING listing is not named — the resolver omits the missing language (R-LX-6)', () => {
  expect(foreignOwnTextIssues({ ...de, listing: { followMasterTitle: true, title: product.name } })).toEqual([])
})

it('control: bullets in another order, or an empty own title, are not the same text', () => {
  expect(foreignOwnTextIssues({ ...de, listing: { ...pinned, title: '', bulletPointsOverride: [...product.bulletPoints].reverse() } })).toEqual([])
})
