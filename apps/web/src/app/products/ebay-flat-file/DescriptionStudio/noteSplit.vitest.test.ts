/**
 * DS-6 — theme-note splitting.
 *
 * The bug this locks down: the Studio rendered a theme's whole `notes` string
 * inside a warning Banner. The built-in "Xavia Modernist" note is ~2,000
 * characters of design record, so the banner grew taller than the pane holding
 * it and painted over the push dock underneath — the operator saw two texts
 * stacked on each other and a wall of amber where a warning should have been.
 *
 * The split has to keep the ⚠ flags (the actionable part that gates a live
 * push) visible in FULL while the record folds behind a disclosure. Losing a
 * flag would be worse than the wall of text.
 *
 * Run: npx vitest run src/app/products/ebay-flat-file/DescriptionStudio/themeNote.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { splitThemeNote, noteIsFlagged } from './noteSplit'

// Verbatim shape of the real built-in note (abridged in the middle only).
const MODERNIST_NOTE =
  "Operator-designed 'Modernist' (Claude design, 2026-07-27) — CSS verbatim from the design file. " +
  'OMITTED (no live data — never fabricate): price row, seller stats, cross-sell cards. ' +
  '⚠ Italian copy (recesso 14 giorni / garanzia 2 anni / CE) mirrors the D10 draft — operator sign-off required before setting as default.'

describe('splitThemeNote', () => {
  it('pulls every ⚠ segment out as a flag and keeps the rest as detail', () => {
    const { flags, detail } = splitThemeNote(MODERNIST_NOTE)
    expect(flags).toHaveLength(1)
    expect(flags[0]).toBe(
      'Italian copy (recesso 14 giorni / garanzia 2 anni / CE) mirrors the D10 draft — operator sign-off required before setting as default.',
    )
    expect(detail).toContain("Operator-designed 'Modernist'")
    expect(detail).toContain('OMITTED')
    // The marker itself is stripped from the flag (the UI re-adds it).
    expect(flags[0]).not.toContain('⚠')
  })

  it('keeps MULTIPLE flags — a second warning can never be swallowed by the first', () => {
    const { flags, detail } = splitThemeNote('Context here. ⚠ First warning. ⚠ Second warning.')
    expect(flags).toEqual(['First warning.', 'Second warning.'])
    expect(detail).toBe('Context here.')
  })

  it('no ⚠ → no flags, the whole note is detail (rendered as a clamped headline)', () => {
    const { flags, detail } = splitThemeNote('Minimal single-column: title, body, gallery, specs, policies.')
    expect(flags).toEqual([])
    expect(detail).toBe('Minimal single-column: title, body, gallery, specs, policies.')
  })

  it('a note that is ONLY a flag leaves no detail behind', () => {
    const { flags, detail } = splitThemeNote('⚠ Draft legal copy — do not set as default.')
    expect(flags).toEqual(['Draft legal copy — do not set as default.'])
    expect(detail).toBe('')
  })

  it('empty / null / whitespace notes produce nothing to render', () => {
    for (const v of ['', '   ', null, undefined]) {
      expect(splitThemeNote(v)).toEqual({ flags: [], detail: '' })
    }
  })

  it('never loses text: flags + detail together cover the whole note', () => {
    const { flags, detail } = splitThemeNote(MODERNIST_NOTE)
    const recombined = [detail, ...flags].join(' ').replace(/\s+/g, ' ')
    const original = MODERNIST_NOTE.replace(/⚠/g, '').replace(/\s+/g, ' ').trim()
    expect(recombined).toBe(original)
  })
})

describe('noteIsFlagged — the draft-copy gate', () => {
  it('matches exactly what the push confirmation escalates on', () => {
    expect(noteIsFlagged(MODERNIST_NOTE)).toBe(true)
    expect(noteIsFlagged('plain note')).toBe(false)
    expect(noteIsFlagged(null)).toBe(false)
    expect(noteIsFlagged(undefined)).toBe(false)
  })

  it('agrees with splitThemeNote — flagged iff there is at least one flag', () => {
    for (const note of [MODERNIST_NOTE, 'plain note', '⚠ x', '', null]) {
      expect(noteIsFlagged(note)).toBe(splitThemeNote(note).flags.length > 0)
    }
  })
})
