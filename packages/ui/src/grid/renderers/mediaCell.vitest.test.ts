import { describe, expect, it } from 'vitest'

import { mediaCellAcceptsDrop, mediaCellClasses, mediaCellState, mediaCellTitle, mediaRenditionWidth, type MediaCellValue } from './mediaCell'

const v = (over: Partial<MediaCellValue> = {}): MediaCellValue => ({ src: 'https://res.cloudinary.com/x/image/upload/a.jpg', ...over })

describe('mediaCellState — precedence is about what the operator must deal with first', () => {
  it('a picture with nothing wrong is ready', () => {
    expect(mediaCellState(v())).toBe('ready')
  })

  it('no value and no src are both empty', () => {
    expect(mediaCellState(null)).toBe('empty')
    expect(mediaCellState(undefined)).toBe('empty')
    expect(mediaCellState(v({ src: null }))).toBe('empty')
  })

  /**
   * A refusal means the picture on screen is not the picture on the server. Nothing outranks that —
   * not a warning, not a pending save, not a lock.
   */
  it('a refusal outranks everything', () => {
    expect(mediaCellState(v({ refused: 'Too small', warn: 'w', pending: true, locked: true }))).toBe('refused')
    // Even with no src: the operator's attempt failed and the tile must say so, not read as empty.
    expect(mediaCellState(v({ src: null, refused: 'Upload failed' }))).toBe('refused')
  })

  it('a warning outranks a pending save — it survives the save', () => {
    expect(mediaCellState(v({ warn: 'Wrong ratio', pending: true }))).toBe('warned')
  })

  it('pending outranks locked, and locked outranks ready', () => {
    expect(mediaCellState(v({ pending: true, locked: true }))).toBe('pending')
    expect(mediaCellState(v({ locked: true }))).toBe('locked')
  })

  /** An empty locked slot reads as "nothing here" — the truth — not as a picture that failed. */
  it('an empty locked slot is empty, not locked', () => {
    expect(mediaCellState(v({ src: null, locked: true }))).toBe('empty')
  })

  /**
   * ⚠ A KNOWN-UNREACHABLE STATE, asserted so it is known rather than discovered (ruling #80).
   *
   * `warn` on a cell with no `src` never renders: a warning here is a judgement about a PICTURE
   * ("too small", "wrong ratio") and there is no picture to judge. A warning about the ABSENCE of
   * one belongs to the matrix, which knows what the row is supposed to have — PES.7 surfaces it
   * there as a contradiction count. This test exists so the next person who sets `warn` on an empty
   * cell finds out why it does not show, instead of debugging the renderer.
   */
  it('a warn on a cell with no picture is deliberately unreachable', () => {
    expect(mediaCellState(v({ src: null, warn: 'Required slot is empty' }))).toBe('empty')
    // …while a REFUSAL on an src-less cell IS reachable: a failed upload leaves nothing behind, and
    // the tile must still say the attempt failed rather than read as an untouched slot.
    expect(mediaCellState(v({ src: null, refused: 'Upload failed' }))).toBe('refused')
  })
})

describe('mediaCellClasses', () => {
  it('carries the state and, separately, the provenance', () => {
    expect(mediaCellClasses(v({ provenance: 'inherited' }))).toEqual(['nds-media-cell', 'nds-media-is-ready', 'nds-media-prov-inherited'])
  })

  it('maps the two camelCase provenance states onto kebab classes', () => {
    expect(mediaCellClasses(v({ provenance: 'inheritedOverride' }))).toContain('nds-media-prov-inherited-override')
    expect(mediaCellClasses(v({ provenance: 'aiStale' }))).toContain('nds-media-prov-ai-stale')
  })

  it('adds no provenance class for a row’s own picture — most tiles get no extra ink', () => {
    expect(mediaCellClasses(v({ provenance: 'own' }))).toEqual(['nds-media-cell', 'nds-media-is-ready'])
  })

  it('carries the channel’s publish answer when there is one', () => {
    expect(mediaCellClasses(v({ publish: 'failed' }))).toContain('nds-media-publish-failed')
    expect(mediaCellClasses(v({ publish: null }))).not.toContain('nds-media-publish-null')
  })
})

describe('mediaCellTitle', () => {
  it('says nothing at all for an absent value — no empty bubble', () => {
    expect(mediaCellTitle(null)).toBe('')
  })

  it('follows the same precedence as the state', () => {
    expect(mediaCellTitle(v({ refused: 'The channel refused it', warn: 'w' }))).toBe('The channel refused it')
    expect(mediaCellTitle(v({ warn: 'Below 1000px' }))).toBe('Below 1000px')
    expect(mediaCellTitle(v({ pending: true }))).toMatch(/not saved/i)
    expect(mediaCellTitle(v({ locked: true }))).toMatch(/synced from the channel/i)
  })

  it('distinguishes an empty slot that CAN take an image from one that cannot', () => {
    expect(mediaCellTitle(v({ src: null }))).toBe('No image yet')
    expect(mediaCellTitle(v({ src: null, locked: true }))).toMatch(/cannot take one/i)
  })

  it('joins the provenance sentence with the publish state', () => {
    const t = mediaCellTitle(v({ publish: 'live' }), 'Inherited from GALE-JACKET')
    expect(t).toContain('Inherited from GALE-JACKET')
    expect(t).toContain('Live on the channel')
  })
})

describe('mediaCellAcceptsDrop', () => {
  it('an empty slot takes a drop; a locked one does not', () => {
    expect(mediaCellAcceptsDrop(v({ src: null }))).toBe(true)
    expect(mediaCellAcceptsDrop(v({ locked: true }))).toBe(false)
  })

  /** Dropping onto a refusal stacks a second unsaved change on a cell that never reconciled the first. */
  it('a refused tile does not take a drop', () => {
    expect(mediaCellAcceptsDrop(v({ refused: 'nope' }))).toBe(false)
  })

  it('an absent value is an empty droppable slot', () => {
    expect(mediaCellAcceptsDrop(null)).toBe(true)
  })
})

describe('mediaRenditionWidth', () => {
  /**
   * 🔴 The measurement behind the rule: a bare Cloudinary URL served a 2250×2250 original (1.6MB)
   * into a 165px tile where the sized rendition is 18KB — 87× — and a MATRIX multiplies that by
   * rows × columns.
   */
  it('asks for more than the box, for retina, but never the original', () => {
    expect(mediaRenditionWidth(165)).toBe(330)
    expect(mediaRenditionWidth(96)).toBe(192)
  })

  it('is bounded at both ends, so no tile asks for something absurd', () => {
    expect(mediaRenditionWidth(4)).toBe(48)
    expect(mediaRenditionWidth(4000)).toBe(1200)
  })

  it('clamps a silly dpr rather than trusting it', () => {
    expect(mediaRenditionWidth(100, 0)).toBe(100)
    expect(mediaRenditionWidth(100, 99)).toBe(300)
  })
})
