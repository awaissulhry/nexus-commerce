/**
 * P6 — `isOffListError` must recognise the REAL off-list messages of every validator, and nothing else. Each message is
 * produced by its own validator here, so a wording change there fails this test instead of silently turning a flag
 * back into a refusal (or a refusal into a flag).
 *
 * E3 (2026-10-05) — every validator now says it with `offListMessage`; the wordings stored before that (findings,
 * readiness rows, raw Ajv output) must still read as off-list, so they are pinned too.
 */
import { expect, it } from 'vitest'
import Ajv2019 from 'ajv/dist/2019.js'
import { validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { amazonSpecFromDefinition } from '../channel-specs/amazon.js'
import { evaluateSchemaRequirements, registerCatalogueSchema } from './schema-requirements.js'
import { optionVerdict } from './cell-formula.service.js'
import { isOffListError, validateChannelValue } from './validate-channel-value.js'

it('recognises each validator’s own off-list message (E3 wording)', () => {
  const field = { fieldKey: 'voltage', label: 'Voltage', selectionOnly: true, options: ['A', 'B'], maxLength: null } as never
  const onEbay = validateChannelValue(field, 'C', 'EBAY')
  expect(onEbay.errors).toEqual(['Voltage: "C" is not on eBay\'s list. eBay may refuse it. Allowed: A, B.'])
  expect(isOffListError(onEbay.errors[0])).toBe(true)
  const noChannel = validateChannelValue(field, 'C')
  expect(noChannel.errors).toEqual(['Voltage: "C" is not one of this column\'s options. Allowed: A, B.'])
  expect(isOffListError(noChannel.errors[0])).toBe(true)
  const list = validateChannelValue({ fieldKey: 'fits', label: 'Fits', selectionOnly: true, options: ['A', 'B'], shape: 'list', maxLength: null } as never, ['A', 'X', 'Y'], 'AMAZON')
  expect(list.errors).toEqual(['Fits: "X", "Y" are not on Amazon\'s list. Amazon may refuse them. Allowed: A, B.'])
  expect(isOffListError(list.errors[0])).toBe(true)

  // The schema's enum, through the real requirement evaluator.
  const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'TEST', schemaDefinition: { type: 'object', properties: {
    voltage: { type: 'array', items: { type: 'object', properties: { value: { type: 'string', enum: ['A', 'B'] } }, required: ['value'] } } } } })
  const catalogue = {}
  registerCatalogueSchema(catalogue, spec)
  const issue = evaluateSchemaRequirements(catalogue, { voltage: 'C' }).issues[0]
  expect(issue.message).toMatch(/: "C" is not on Amazon's list\. Amazon may refuse it\. Allowed: A, B\.$/)
  expect(isOffListError(issue.message)).toBe(true)

  // A formula result: stored, and named.
  const formula = optionVerdict({ column: { label: 'Voltage', options: ['A', 'B'] }, catalogueField: { options: ['A', 'B'], selectionOnly: true }, value: 'C', channel: 'EBAY' })
  if (!formula.ok) throw new Error('an off-list formula result was refused')
  expect(formula.warning).toBe('Voltage: "C" is not on eBay\'s list. Saved as it is. eBay may refuse it. Allowed: A, B.')
  expect(isOffListError(formula.warning!)).toBe(true)

  const shopify = validateShopifyField({ type: 'single_line_text_field', validations: [{ name: 'choices', value: '["Level 1"]' }] }, 'Level 9')
  expect(shopify).not.toBeNull()
  expect(isOffListError(shopify!)).toBe(true)
})

it('still recognises the wordings stored before E3 — they stay flags', () => {
  const ajv = new (Ajv2019 as unknown as new (o: object) => { compile: (s: object) => ((v: unknown) => boolean) & { errors?: Array<{ message?: string }> } })({ allErrors: true, strict: false })
  const validate = ajv.compile({ type: 'string', enum: ['A', 'B'] })
  expect(validate('C')).toBe(false)
  for (const message of [
    `Voltage: ${validate.errors![0].message}.`,
    `Voltage: ${validate.errors![0].message} (A, B).`,
    'Season contains an unaccepted value. Allowed values: Estate · Inverno · Tutte le stagione.',
    'Season: Season contains an unaccepted value. Allowed values: Estate.',
  ]) expect(isOffListError(message), message).toBe(true)
})

it('does not excuse any other finding', () => {
  const tooLong = validateChannelValue({ fieldKey: 'color', label: 'Colour', maxLength: 5, options: null } as never, 'TOOLONG')
  const deprecated = validateChannelValue({ fieldKey: 'color', label: 'Colour', selectionOnly: true, options: ['Red'], deprecatedOptions: ['Red'], maxLength: null } as never, 'Red', 'EBAY')
  for (const message of [...tooLong.errors, ...deprecated.errors, 'Brand is required by Amazon · IT', 'Colour takes at most 5 characters', 'must be number', 'must NOT have more than 1 items']) {
    expect(isOffListError(message), message).toBe(false)
  }
})
