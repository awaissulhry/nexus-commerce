import { describe, expect, it } from 'vitest'
import { ProviderError } from './gateway'
import { ledgerSummary, scrubText, secretStrings, SUMMARY_MAX_BYTES } from './redact'

// What the call ledger keeps of a request or an answer: secrets and personal data removed, size capped.

describe('ledgerSummary', () => {
  it('redacts secret keys at any depth and keeps the shape', () => {
    expect(ledgerSummary({ apiKey: 'k-123456', nested: { client_secret: 'abcdef', authorization: 'Bearer xyz' }, status: 'queued' })).toEqual({
      apiKey: '[redacted]',
      nested: { client_secret: '[redacted]', authorization: '[redacted]' },
      status: 'queued',
    })
  })

  it('removes personal data by key and e-mail addresses anywhere', () => {
    expect(
      ledgerSummary({
        to: ['ada@example.com'],
        recipient: { firstName: 'Ada', city: 'Milano' },
        address_line_1: 'Via Esempio 1',
        vatNumber: 'IT00000000000',
        note: 'reply to ops@example.com please',
        empty: '',
      }),
    ).toEqual({ to: '[personal]', recipient: '[personal]', address_line_1: '[personal]', vatNumber: '[personal]', note: 'reply to [email] please', empty: '' })
  })

  it("removes the account's own secret values from every string, and parses a JSON text first", () => {
    const secrets = secretStrings({ apiKey: 'sk_test_value_42', region: 'eu', short: 'ab' })
    expect(secrets).toEqual(['sk_test_value_42'])
    expect(ledgerSummary('{"echo":"used sk_test_value_42 here"}', secrets)).toEqual({ echo: 'used [redacted] here' })
    expect(ledgerSummary('plain text with sk_test_value_42', secrets)).toBe('plain text with [redacted]')
    expect(scrubText('sk_test_value_42 for a@b.it', secrets)).toBe('[redacted] for [email]')
  })

  it('caps a summary at 8 KiB and says so; nothing becomes undefined', () => {
    const big = ledgerSummary({ items: Array.from({ length: 20 }, (_, index) => `item-${index}-${'x'.repeat(1_000)}`) }) as { truncated: boolean; bytes: number; preview: string }
    expect(big.truncated).toBe(true)
    expect(big.bytes).toBeGreaterThan(SUMMARY_MAX_BYTES)
    expect(big.preview.length).toBe(SUMMARY_MAX_BYTES)
    expect(ledgerSummary(undefined)).toBeUndefined()
    expect(ledgerSummary('')).toBeUndefined()
    expect(ledgerSummary(Buffer.from('raw'))).toBe('[binary]')
  })
})

describe('ProviderError', () => {
  it('is retryable for a 429, a 5xx or no status, and final for another 4xx unless said otherwise', () => {
    expect(new ProviderError('x', { httpStatus: 429 }).retryable).toBe(true)
    expect(new ProviderError('x', { httpStatus: 503 }).retryable).toBe(true)
    expect(new ProviderError('x').retryable).toBe(true)
    expect(new ProviderError('x', { httpStatus: 400 }).retryable).toBe(false)
    expect(new ProviderError('x', { httpStatus: 409, retryable: true }).retryable).toBe(true)
  })
})
