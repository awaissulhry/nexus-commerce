/**
 * P6 — `isOffListError` must recognise the REAL off-list messages of every validator, and nothing else. Each message is
 * produced by its own validator here, so a wording change there fails this test instead of silently turning a flag
 * back into a refusal (or a refusal into a flag).
 */
import { expect, it } from 'vitest'
import Ajv2019 from 'ajv/dist/2019.js'
import { validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { isOffListError, validateChannelValue } from './validate-channel-value.js'

it('recognises each validator’s own off-list message', () => {
  const channel = validateChannelValue({ fieldKey: 'voltage', label: 'Voltage', selectionOnly: true, options: ['A', 'B'], maxLength: null } as never, 'C')
  expect(channel.errors).toHaveLength(1)
  expect(isOffListError(channel.errors[0])).toBe(true)

  const ajv = new (Ajv2019 as unknown as new (o: object) => { compile: (s: object) => ((v: unknown) => boolean) & { errors?: Array<{ message?: string }> } })({ allErrors: true, strict: false })
  const validate = ajv.compile({ type: 'string', enum: ['A', 'B'] })
  expect(validate('C')).toBe(false)
  expect(isOffListError(`Voltage: ${validate.errors![0].message}.`)).toBe(true)

  const shopify = validateShopifyField({ type: 'single_line_text_field', validations: [{ name: 'choices', value: '["Level 1"]' }] }, 'Level 9')
  expect(shopify).not.toBeNull()
  expect(isOffListError(shopify!)).toBe(true)
})

it('does not excuse any other finding', () => {
  const tooLong = validateChannelValue({ fieldKey: 'color', label: 'Colour', maxLength: 5, options: null } as never, 'TOOLONG')
  for (const message of [...tooLong.errors, 'Brand is required by Amazon · IT', 'Colour takes at most 5 characters', 'must be number', 'must NOT have more than 1 items']) {
    expect(isOffListError(message), message).toBe(false)
  }
})
