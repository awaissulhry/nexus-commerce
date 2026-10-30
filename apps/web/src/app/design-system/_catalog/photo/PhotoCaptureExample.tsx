'use client'

import { useState, type CSSProperties } from 'react'

import { PhotoCapture, describeMark, PHOTO_CAPTURE_WORDS, type CapturedPhoto, type PhotoMark } from '@/design-system/components/PhotoCapture'
import { DensityProvider } from '@/design-system/lib/density'
import { SegmentedControl } from '@/design-system/primitives'

/*
 * 2026-10-30 — photo capture with markup (factory gap D21, `packages/ui/src/components/PhotoCapture`). A made-up photo of
 * a leather panel (an SVG drawn here: no real person, no real product). Verify: Camera — Start camera asks the browser
 * (no camera or a refusal is said in words, with Try again and Use a file); the outline guide and "Keep faces out of the
 * picture" are there before the camera starts. Markup — drag on the photo for an arrow or a circle, a tap marks a spot;
 * Tab to the photo: the arrow keys move a crosshair (Shift further), Enter sets the start, Enter again draws, Escape
 * cancels; Undo mark (⌘Z) and Clear marks are held with their reason when there is nothing to remove; each mark is
 * numbered and listed in words. Required — Use photo is held until a mark exists, the reason on screen. Use photo
 * prints what the app would get (nothing is uploaded). Floor tier and the phone width: the same part, sized by the
 * density. Light and dark, 1440 and 390.
 */

const PANEL = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 900'><rect width='1200' height='900' fill='dimgray'/><rect x='150' y='120' width='900' height='660' rx='40' fill='saddlebrown'/><path d='M150 450 H1050 M600 120 V780' stroke='wheat' stroke-width='10' stroke-dasharray='30 20'/><circle cx='780' cy='300' r='46' fill='peru'/><path d='M300 610 q 60 -46 120 0' stroke='tan' stroke-width='16' fill='none'/></svg>",
)}`
const PHOTO = { src: PANEL, width: 1200, height: 900 }
const MARKS: PhotoMark[] = [
  { kind: 'circle', center: { x: 0.65, y: 0.333 }, radius: 0.07 },
  { kind: 'arrow', from: { x: 0.18, y: 0.86 }, to: { x: 0.3, y: 0.68 } },
]

type Demo = 'camera' | 'markup' | 'required' | 'review' | 'floor' | 'phone'

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-16)' }
const note: CSSProperties = { margin: 0, fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text-2)' }
const frame: CSSProperties = { padding: 'var(--nds-space-16)', border: '1px solid var(--nds-border)', borderRadius: 'var(--nds-radius-lg)', background: 'var(--nds-surface)' }
const phone: CSSProperties = { ...frame, width: '100%', maxWidth: '24.375rem' }

function said(photo: CapturedPhoto): string {
  const kb = (blob: Blob | null) => (blob ? `${Math.round(blob.size / 1024).toLocaleString('en-GB')} kB` : 'none')
  const marks = photo.marks.map((mark, index) => describeMark(mark, index, PHOTO_CAPTURE_WORDS)).join('; ')
  return `The app got a ${photo.width}×${photo.height} JPEG (${kb(photo.photo)}) from the ${photo.source}, ${photo.marks.length} marks${marks ? ` (${marks})` : ''}, the marked copy: ${kb(photo.marked)}. Nothing was uploaded.`
}

export function PhotoCaptureExample() {
  const [demo, setDemo] = useState<Demo>('markup')
  const [result, setResult] = useState<string | null>(null)
  const onCapture = (photo: CapturedPhoto) => setResult(said(photo))
  const common = { label: 'Photo of the defect', onCapture, onCancel: () => setResult('Cancelled: the app closes the step.') }
  const body = (() => {
    if (demo === 'camera') return <PhotoCapture key="camera" {...common} />
    if (demo === 'markup') return <PhotoCapture key="markup" {...common} defaultPhoto={PHOTO} defaultMarks={MARKS} />
    if (demo === 'required')
      return <PhotoCapture key="required" {...common} defaultPhoto={PHOTO} useHeldReason={(marks) => (marks.length ? null : 'Circle the problem first')} />
    if (demo === 'review') return <PhotoCapture key="review" {...common} markup={false} defaultPhoto={PHOTO} />
    if (demo === 'floor')
      return (
        <DensityProvider value="floor">
          <PhotoCapture key="floor" {...common} defaultPhoto={PHOTO} defaultMarks={MARKS.slice(0, 1)} />
        </DensityProvider>
      )
    return (
      <DensityProvider value="comfortable">
        <div style={phone}>
          <PhotoCapture key="phone" {...common} guide="silhouette" />
        </div>
      </DensityProvider>
    )
  })()
  return (
    <section id="photo-capture-example" style={stack}>
      <SegmentedControl
        ariaLabel="Photo capture case"
        value={demo}
        onChange={(value) => {
          setDemo(value as Demo)
          setResult(null)
        }}
        wrap
        options={[
          { value: 'camera', label: 'Camera' },
          { value: 'markup', label: 'Markup' },
          { value: 'required', label: 'Mark required' },
          { value: 'review', label: 'No markup' },
          { value: 'floor', label: 'Floor tier' },
          { value: 'phone', label: 'Phone, link page' },
        ]}
      />
      <div style={demo === 'phone' ? undefined : frame}>{body}</div>
      <p style={note} role="status">
        {result ?? 'Use photo shows here what the app would get.'}
      </p>
    </section>
  )
}
