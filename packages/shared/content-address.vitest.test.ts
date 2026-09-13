/**
 * LX.FIN (R-LX-25) — `sharedContentAddress`, the ONE derivation of a shared content write's address.
 *
 * The arm that fires today is the one the two catalogue surfaces failed: a write with NO address.
 * Both halves are asserted here — the validator's refusal (what the drawer and the lens measured as
 * 400 on 2026-09-13) and the helper's answer, so a surface cannot pass one and fail the other.
 */
import { describe, expect, it } from 'vitest'
import { contentAddress, sharedContentAddress } from './content-language'

describe('sharedContentAddress', () => {
  it('is the language tier for a non-primary language, and survives the validator unchanged', () => {
    expect(sharedContentAddress('de')).toEqual({ tier: 'language', language: 'de' })
    // The round trip is the property that matters: every surface's body goes through `contentAddress`.
    expect(contentAddress(sharedContentAddress('de'), 'Translation')).toEqual({ tier: 'language', language: 'de' })
  })

  it('is the SOURCE tier when the language IS the primary one — the shared primary text is not a translation row', () => {
    expect(sharedContentAddress('it', 'it')).toEqual({ tier: 'source' })
    expect(sharedContentAddress('IT', 'it-IT')).toEqual({ tier: 'source' })
    expect(contentAddress(sharedContentAddress('it', 'it'), 'Content')).toEqual({ tier: 'source' })
  })

  it('normalises a regional tag to the language, at both arguments', () => {
    expect(sharedContentAddress('de-AT')).toEqual({ tier: 'language', language: 'de' })
    expect(sharedContentAddress('de_DE', 'it')).toEqual({ tier: 'language', language: 'de' })
  })

  it('a caller that does not know the primary language gets the language tier, never a guess', () => {
    expect(sharedContentAddress('it')).toEqual({ tier: 'language', language: 'it' })
    expect(sharedContentAddress('it', null)).toEqual({ tier: 'language', language: 'it' })
  })

  it('refuses an unusable language rather than inventing one', () => {
    expect(() => sharedContentAddress('')).toThrow()
    expect(() => sharedContentAddress('deutsch1')).toThrow()
  })

  it('🔴 POSITIVE CONTROL — the arm the two surfaces hit: no address at all is a 400', () => {
    const refused = (value: unknown, label: string) => {
      try { contentAddress(value, label); return null } catch (error) { return error as Error & { statusCode?: number } }
    }
    const drawer = refused(undefined, 'Translation')
    expect(drawer?.statusCode).toBe(400)
    expect(drawer?.message).toBe('Translation needs a ContentAddress before it can be saved.')
    const lens = refused(undefined, 'Content')
    expect(lens?.statusCode).toBe(400)
    expect(lens?.message).toBe('Content needs a ContentAddress before it can be saved.')
    // …and the fixed bodies are NOT refused, in the same run.
    expect(refused(sharedContentAddress('de'), 'Translation')).toBeNull()
    expect(refused(sharedContentAddress('de', 'it'), 'Content')).toBeNull()
  })
})
