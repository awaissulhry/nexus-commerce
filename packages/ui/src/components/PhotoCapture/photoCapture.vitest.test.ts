import { readFileSync } from 'node:fs'
import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PhotoCapture, type PhotoCaptureProps } from './PhotoCapture'
import {
  CENTRE,
  DEFAULT_RADIUS,
  KEY_STEP,
  KEY_STEP_BIG,
  PHOTO_CAPTURE_WORDS as W,
  arrowHead,
  cameraProblemOf,
  describeMark,
  distance,
  fill,
  fitSize,
  keyStep,
  markFromDrag,
  markInPixels,
  marksCount,
  photoHeldReason,
  pointIn,
  positionOf,
  stepAfterShot,
  strokeOf,
  type KeyDraft,
  type PhotoMark,
} from './photoCaptureModel'

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9)

describe('photo capture rules (D21)', () => {
  it('a shot goes to markup, or to review when markup is off', () => {
    expect(stepAfterShot(true)).toBe('markup')
    expect(stepAfterShot(false)).toBe('review')
  })

  it("the camera's errors, in the part's terms", () => {
    expect(cameraProblemOf({ name: 'NotAllowedError' })).toBe('denied')
    expect(cameraProblemOf({ name: 'SecurityError' })).toBe('denied')
    expect(cameraProblemOf({ name: 'NotFoundError' })).toBe('unavailable')
    expect(cameraProblemOf({ name: 'OverconstrainedError' })).toBe('unavailable')
    expect(cameraProblemOf({ name: 'NotReadableError' })).toBe('busy')
    expect(cameraProblemOf(new Error('x'))).toBe('failed')
    expect(cameraProblemOf(undefined)).toBe('failed')
  })

  it('downscales to the long edge, never enlarges, whole px', () => {
    expect(fitSize(4032, 3024, 2048)).toEqual({ width: 2048, height: 1536 })
    expect(fitSize(3024, 4032, 2048)).toEqual({ width: 1536, height: 2048 })
    expect(fitSize(800, 600, 2048)).toEqual({ width: 800, height: 600 })
    expect(fitSize(0, 600)).toEqual({ width: 0, height: 0 })
    expect(fitSize(3, 9000, 100)).toEqual({ width: 1, height: 100 })
  })

  it('a drag draws an arrow or a circle; a tap draws the default circle, or an arrow pointing at the spot', () => {
    expect(markFromDrag('arrow', { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, 0.75)).toEqual({ kind: 'arrow', from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } })
    const circle = markFromDrag('circle', { x: 0.5, y: 0.5 }, { x: 0.7, y: 0.5 }, 0.75)
    expect(circle.kind).toBe('circle')
    if (circle.kind === 'circle') close(circle.radius, 0.2)
    expect(markFromDrag('circle', { x: 0.3, y: 0.3 }, { x: 0.301, y: 0.3 }, 0.75)).toEqual({ kind: 'circle', center: { x: 0.3, y: 0.3 }, radius: DEFAULT_RADIUS })
    const tapArrow = markFromDrag('arrow', { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.2 }, 1)
    expect(tapArrow.kind).toBe('arrow')
    if (tapArrow.kind === 'arrow') {
      expect(tapArrow.to).toEqual({ x: 0.8, y: 0.2 })
      // The tail comes from the side with more room: left of and below a top-right spot.
      expect(tapArrow.from.x).toBeLessThan(0.8)
      expect(tapArrow.from.y).toBeGreaterThan(0.2)
    }
    // Points off the photo are kept on it.
    expect(markFromDrag('arrow', { x: -1, y: 2 }, { x: 0.5, y: 0.5 }, 1)).toEqual({ kind: 'arrow', from: { x: 0, y: 1 }, to: { x: 0.5, y: 0.5 } })
  })

  it('distance is measured in shares of the width, so a circle stays round on a tall photo', () => {
    close(distance({ x: 0, y: 0 }, { x: 0, y: 0.5 }, 2), 1)
    close(distance({ x: 0, y: 0 }, { x: 0.3, y: 0 }, 2), 0.3)
  })

  it('keyboard: arrows move the crosshair (Shift further), Enter anchors then draws, Escape cancels', () => {
    const start: KeyDraft = { cursor: CENTRE, anchor: null }
    const right = keyStep(start, 'ArrowRight', { tool: 'arrow', aspect: 0.75 })
    expect(right.kind).toBe('moved')
    if (right.kind === 'moved') close(right.draft.cursor.x, 0.5 + KEY_STEP)
    const far = keyStep(start, 'ArrowUp', { shift: true, tool: 'arrow', aspect: 0.75 })
    if (far.kind === 'moved') close(far.draft.cursor.y, 0.5 - KEY_STEP_BIG)
    // Clamped at the edge.
    const edge = keyStep({ cursor: { x: 0, y: 0 }, anchor: null }, 'ArrowLeft', { tool: 'arrow', aspect: 1 })
    if (edge.kind === 'moved') expect(edge.draft.cursor.x).toBe(0)
    const anchored = keyStep(start, 'Enter', { tool: 'arrow', aspect: 0.75 })
    expect(anchored).toEqual({ kind: 'anchored', draft: { cursor: CENTRE, anchor: CENTRE } })
    if (anchored.kind !== 'anchored') return
    expect(keyStep(anchored.draft, ' ', { tool: 'arrow', aspect: 0.75 }).kind).toBe('tooShort')
    const moved = { ...anchored.draft, cursor: { x: 0.8, y: 0.8 } }
    const drawn = keyStep(moved, 'Enter', { tool: 'arrow', aspect: 0.75 })
    expect(drawn).toEqual({ kind: 'mark', draft: { cursor: { x: 0.8, y: 0.8 }, anchor: null }, mark: { kind: 'arrow', from: CENTRE, to: { x: 0.8, y: 0.8 } } })
    expect(keyStep(moved, 'Escape', { tool: 'arrow', aspect: 0.75 })).toEqual({ kind: 'cancelled', draft: { cursor: { x: 0.8, y: 0.8 }, anchor: null } })
    // Escape with nothing under way is left to the page (a dialog can close).
    expect(keyStep(start, 'Escape', { tool: 'arrow', aspect: 0.75 }).kind).toBe('ignored')
    expect(keyStep(start, 'a', { tool: 'arrow', aspect: 0.75 }).kind).toBe('ignored')
    const home = keyStep({ cursor: { x: 0.1, y: 0.1 }, anchor: null }, 'Home', { tool: 'circle', aspect: 1 })
    expect(home).toEqual({ kind: 'moved', draft: { cursor: CENTRE, anchor: null }, regionChanged: true })
  })

  it('says a region change only when the crosshair crosses a third', () => {
    const a = keyStep({ cursor: { x: 0.5, y: 0.5 }, anchor: null }, 'ArrowRight', { tool: 'arrow', aspect: 1 })
    expect(a.kind === 'moved' && a.regionChanged).toBe(false)
    const b = keyStep({ cursor: { x: 0.66, y: 0.5 }, anchor: null }, 'ArrowRight', { tool: 'arrow', aspect: 1 })
    expect(b.kind === 'moved' && b.regionChanged).toBe(true)
  })

  it('marks in words: an ordinal, the kind and a rough place', () => {
    expect(positionOf({ x: 0.1, y: 0.1 })).toBe('TopLeft')
    expect(positionOf(CENTRE)).toBe('Centre')
    expect(positionOf({ x: 0.9, y: 0.9 })).toBe('BottomRight')
    expect(describeMark({ kind: 'arrow', from: { x: 0.1, y: 0.1 }, to: CENTRE }, 0, W)).toBe('Arrow 1 from top left to centre')
    expect(describeMark({ kind: 'circle', center: { x: 0.9, y: 0.5 }, radius: 0.1 }, 1, W)).toBe('Circle 2 around right')
    expect(marksCount(0, W)).toBe('No marks yet')
    expect(marksCount(1, W)).toBe('1 mark')
    expect(marksCount(3, W)).toBe('3 marks')
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}')
  })

  it('geometry in the photo px: strokes thick enough to see, the arrowhead behind the tip', () => {
    const stroke = strokeOf(2048, 1536)
    expect(stroke.core).toBeGreaterThanOrEqual(3)
    expect(stroke.outline).toBe(stroke.core * 2)
    expect(strokeOf(100, 100).core).toBe(3)
    const [left, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 10)
    expect(left.x).toBeLessThan(100)
    expect(right.x).toBeLessThan(100)
    close(left.y, -right.y)
    expect(markInPixels({ kind: 'circle', center: CENTRE, radius: 0.1 }, 400, 300)).toEqual({ kind: 'circle', center: { x: 200, y: 150 }, radius: 40 })
    expect(pointIn(150, 75, { left: 100, top: 50, width: 200, height: 100 })).toEqual({ x: 0.25, y: 0.25 })
    expect(pointIn(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual(CENTRE)
  })

  it('Use photo is held: the app first, then busy, then no photo, then the app rule over the marks', () => {
    const base = { busy: false, hasPhoto: true, marks: [] as PhotoMark[], words: W }
    expect(photoHeldReason({ ...base, heldReason: 'No permission' })).toBe('No permission')
    expect(photoHeldReason({ ...base, busy: true })).toBe(W.preparing)
    expect(photoHeldReason({ ...base, hasPhoto: false })).toBe(W.cameraOff)
    expect(photoHeldReason({ ...base, rule: (marks) => (marks.length ? null : 'Mark the problem first') })).toBe('Mark the problem first')
    expect(photoHeldReason({ ...base, marks: [{ kind: 'circle', center: CENTRE, radius: 0.1 }], rule: (marks) => (marks.length ? null : 'x') })).toBeNull()
    expect(photoHeldReason(base)).toBeNull()
  })
})

const PHOTO = { src: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"/%3E', width: 400, height: 300 }
const part = (props: Partial<PhotoCaptureProps> = {}) => render(h(PhotoCapture, { label: 'Photo of the defect', onCapture: vi.fn(), ...props }))

describe('PhotoCapture markup (D21)', () => {
  it('capture: a named region, the faces hint, the guide, Start camera and Use a file; the camera is off until asked', () => {
    const out = part()
    expect(out).toContain('aria-label="Photo of the defect"')
    expect(out).toContain('data-step="capture"')
    expect(out).toContain('Keep faces out of the picture')
    expect(out).toContain('Fit the item inside the frame')
    expect(out).toContain('nds-photo-guide')
    expect(out).toContain('Start camera')
    expect(out).toContain('Use a file')
    expect(out).toContain('The camera is off. Start it, or use a file.')
    expect(out).toMatch(/<input[^>]*type="file"[^>]*accept="image\/\*"[^>]*capture="environment"/)
    // One always-mounted polite live region.
    expect(out.match(/aria-live="polite"/g)).toHaveLength(1)
    expect(out).not.toMatch(/\sdisabled=""/)
  })

  it('a blocked camera says so in words, offers Try again and keeps the file', () => {
    const out = part({ defaultCamera: 'denied' })
    expect(out).toContain(W.cameraDenied)
    expect(out).toContain('Try again')
    expect(out).toContain('Use a file')
    expect(part({ defaultCamera: 'unavailable' })).toContain(W.cameraUnavailable)
  })

  it('the silhouette guide and no faces line when the app says so', () => {
    const out = part({ guide: 'silhouette', facesHint: false })
    expect(out).toContain('Stand inside the outline')
    expect(out).toContain('<ellipse')
    expect(out).not.toContain('Keep faces out of the picture')
    expect(part({ guide: 'none' })).not.toContain('nds-photo-guide')
  })

  it('markup: the tools as pressed buttons, the surface with its instructions, the marks numbered and in words', () => {
    const marks: PhotoMark[] = [
      { kind: 'arrow', from: { x: 0.1, y: 0.1 }, to: CENTRE },
      { kind: 'circle', center: { x: 0.8, y: 0.8 }, radius: 0.1 },
    ]
    const out = part({ defaultPhoto: PHOTO, defaultMarks: marks, defaultTool: 'arrow' })
    expect(out).toContain('data-step="markup"')
    expect(out).toMatch(/aria-pressed="true"[^>]*>.*?Arrow/)
    expect(out).toMatch(/aria-pressed="false"[^>]*>.*?Circle/)
    expect(out).toMatch(/role="application"[^>]*tabindex="0"[^>]*aria-label="Mark the photo"[^>]*aria-describedby="/)
    expect(out).toContain('viewBox="0 0 400 300"')
    expect(out.match(/class="nds-photo-mark"/g)).toHaveLength(2)
    expect(out).toContain('2 marks')
    expect(out).toContain('<li>Arrow 1 from top left to centre</li>')
    expect(out).toContain('<li>Circle 2 around bottom right</li>')
    expect(out).toContain('alt="The photo to mark"')
    expect(out).toContain('Retake')
    expect(out).toContain('Use photo')
    // Undo and Clear can act: not held.
    expect(out).not.toContain(W.undoNothing)
  })

  it('with no marks, Undo and Clear are held with their reason; the app rule holds Use photo, said on screen', () => {
    const out = part({ defaultPhoto: PHOTO, useHeldReason: (marks) => (marks.length ? null : 'Circle the problem first') })
    expect(out).toContain(`aria-description="${W.undoNothing}"`)
    expect(out).toContain(`aria-description="${W.clearNothing}"`)
    expect(out).toMatch(/aria-description="Circle the problem first"[^>]*>.*?Use photo/)
    expect(out).toContain('nds-photo-note is-held')
    expect(out).toContain('No marks yet')
  })

  it('a keyboard mark under way: the crosshair, its anchor and the dashed preview', () => {
    const out = part({ defaultPhoto: PHOTO, defaultTool: 'circle', defaultKeyDraft: { cursor: { x: 0.6, y: 0.5 }, anchor: CENTRE } })
    expect(out).toContain('nds-photo-crosshair')
    expect(out).toContain('nds-photo-anchor')
    expect(out).toContain('nds-photo-mark is-preview')
    expect(out).toContain('stroke-dasharray')
  })

  it('markup off: the review step shows the photo and Use photo, no tools, no surface to draw on', () => {
    const out = part({ defaultPhoto: PHOTO, markup: false })
    expect(out).toContain('data-step="review"')
    expect(out).not.toContain('role="application"')
    expect(out).not.toContain('Mark with')
    expect(out).toContain('Use photo')
  })

  it("the app's held reason holds every action, said at rest", () => {
    const out = part({ defaultPhoto: PHOTO, heldReason: 'You may only look at this record' })
    expect(out).toContain('nds-photo-note is-held')
    expect(out.match(/aria-description="You may only look at this record"/g)?.length).toBeGreaterThanOrEqual(4)
    const capture = part({ heldReason: 'You may only look at this record' })
    expect(capture.match(/aria-description="You may only look at this record"/g)?.length).toBe(2)
  })

  it('every word comes from the app', () => {
    const out = part({
      words: { startCamera: 'Avvia fotocamera', useFile: 'Usa un file', facesHint: 'Niente volti nella foto', guideFrame: 'Tieni il pezzo nella cornice', cameraOff: 'Fotocamera spenta.' },
    })
    expect(out).toContain('Avvia fotocamera')
    expect(out).toContain('Usa un file')
    expect(out).toContain('Niente volti nella foto')
    expect(out).not.toContain('Start camera')
  })
})

describe('photo-capture.css (D21)', () => {
  const css = readFileSync(new URL('./photo-capture.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

  it('semantic tokens only: no raw colour, no numbered ramp', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/var\(--nds-(grey|blue|green|red|amber|purple|cyan)-[0-9]/)
    expect(css).not.toMatch(/rgba?\(/)
  })

  it('sizes from the density; a drag never scrolls; marks have a dark outline under a bright core; motion can be reduced', () => {
    expect(css).toMatch(/--nds-density-gap/)
    expect(css).toMatch(/\.nds-photo-surface \{[^}]*touch-action: none/)
    expect(css).toMatch(/\.nds-photo-mark-outline \{[^}]*--nds-tooltip-light-fg/)
    expect(css).toMatch(/\.nds-photo-mark-core \{[^}]*--nds-warning/)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })
})

describe('Commerce pages do not carry the photo capture (D21)', () => {
  it('the components barrel does not export this folder; it is its own entry point', () => {
    const barrel = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const code = barrel.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/PhotoCapture/)
    const entry = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(entry).toMatch(/export \{ PhotoCapture/)
  })

  it("no shared stylesheet carries the part's rules", () => {
    for (const sheet of ['primitives.css', 'components.css', 'patterns.css', 'a11y.css']) {
      const text = readFileSync(new URL(`../../styles/${sheet}`, import.meta.url), 'utf8')
      expect(text, sheet).not.toMatch(/photo-capture|nds-photo-/)
    }
  })
})
