/**
 * 2026-10-04 (fix C) — the sheet recognises the server's "required" sentences by the server's OWN words
 * (`REQUIRED_SENTENCE` in `channelCellProvenance.ts`): the wire carries `mapped.errors` as plain text, and the rule behind
 * each sentence (the resolver's `findings`) never leaves the API. This file pins the mirror to the API's source text, so
 * a reworded server sentence fails HERE — not silently on the sheet, where every empty required cell would go back to
 * wearing the attention mark.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isRequiredSentence, REQUIRED_SENTENCE } from './channelCellProvenance'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../../../../..')
const read = (path: string) => readFileSync(join(REPO, path), 'utf8')
const schema = read('apps/api/src/services/pim/mapping/schema-requirements.ts')
const resolver = read('apps/api/src/services/pim/mapping/resolve-batch.service.ts')

describe('the "required" sentences the sheet recognises are the API’s own', () => {
  it('the resolver still writes "Field \'<label>\' is required." for a required field with no value', () => {
    expect(resolver).toContain("`Field '${field.label}' is required.`")
    expect(isRequiredSentence("Field 'External Product ID' is required.")).toBe(true)
  })

  it('the category schema check still states its two reasons, and builds the sentence as "<reason>: <label>."', () => {
    // `schema-requirements.ts`: const reason = alternative ? '…' : conditional ? `Required by the category's condition…` : 'Required by the category schema'
    expect(schema).toContain("`Required by the category's condition for this product`")
    expect(schema).toContain("'Required by the category schema'")
    expect(REQUIRED_SENTENCE.schemaPrefixes).toEqual(["Required by the category's condition for this product: ", 'Required by the category schema: '])
    // The two message templates for a requirement: a field by its label, or a whole attribute (an envelope).
    expect(schema).toContain('`${reason}: ${label}${missing && path.length ? ` (${missing})` : \'\'}.`')
    expect(schema).toContain('`${reason}: the ${attribute} attribute${path.length ? ` needs ${missing}` : \'\'}.`')
    for (const [reason, tail] of [["Required by the category's condition for this product", 'External Product ID'], ['Required by the category schema', 'the taxonomy_id attribute']])
      expect(isRequiredSentence(`${reason}: ${tail}.`)).toBe(true)
  })

  it('an alternative and an attribute that lacks a part are NOT "required" — each asks for a different action', () => {
    expect(schema).toContain("'The category requires an allowed alternative; this option needs'")
    expect(isRequiredSentence('The category requires an allowed alternative; this option needs: External Product ID.')).toBe(false)
    // The envelope template with a missing part (`needs ${missing}`): a selector or a unit, not this cell's value.
    expect(isRequiredSentence('Required by the category schema: the item_weight attribute needs unit.')).toBe(false)
  })
})
