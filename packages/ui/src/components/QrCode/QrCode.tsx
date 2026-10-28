'use client'

/**
 * QrCode — a QR code drawn as SVG, with its text form under it to read out or copy.
 *
 * For a device enrolment (a tablet scans the code a manager's screen shows) and any code a person may have to type
 * instead: the text form (`code`, default the value itself) is always on screen in a monospace line with a Copy button,
 * so a camera that cannot read the code, or a person who cannot see it, still has the code.
 *
 * Dark modules on a light plate in BOTH themes: a reader (ZXing, a phone camera) expects dark on light, and an inverted
 * code fails on many of them. The plate and modules use the light-tooltip pair (`--nds-tooltip-light-bg` / `-fg`), the
 * design system's one theme-invariant light ground and its text (15.9:1). The quiet zone (four modules) is part of the
 * drawing, so the code reads wherever it is placed.
 *
 * The encoder (`qrcode`, a peer dependency the apps already have) is loaded when the first code is drawn
 * (`import('./qrCodeModel')`), so no bundle that does not draw a QR carries it. Until then the plate holds its size and
 * says it is loading; a value too long for any QR version says so in words.
 *
 * Screen reader: the drawing is one `role="img"` named by `label`; the text form is plain text; Copy says "Copied" in a
 * polite live region.
 */
import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '../../primitives/Button'
import type { QrErrorLevel, QrMatrix } from './qrCodeModel'
import './qr-code.css'

export interface QrCodeLabels {
  copy: string
  copied: string
  /** The browser refused the clipboard (no permission, not a secure page). */
  copyFailed: string
  /** While the encoder loads. */
  loading: string
  /** The value is longer than a QR code can hold. */
  tooLong: string
}

export const QR_CODE_LABELS: QrCodeLabels = {
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Could not copy. Select the code and copy it.',
  loading: 'Drawing the code',
  tooLong: 'This is too long for a QR code.',
}

export interface QrCodeProps {
  /** What the code holds: an enrolment address, a token. */
  value: string
  /** What the code is, for a screen reader: "Enrolment code for Cutting station 2". */
  label: string
  /** The drawing's side in px, quiet zone included (default 200). */
  size?: number
  /** The text form under the code, when it differs from `value` (a short code a person types instead of the address). */
  code?: string
  /** Error correction (default `M`, 15 %). */
  level?: QrErrorLevel
  labels?: Partial<QrCodeLabels>
  className?: string
}

type Drawing = { status: 'loading' } | { status: 'ready'; matrix: QrMatrix; path: string; box: number } | { status: 'error' }

export function QrCode({ value, label, size = 200, code, level = 'M', labels, className }: QrCodeProps) {
  const words = { ...QR_CODE_LABELS, ...labels }
  const [drawing, setDrawing] = useState<Drawing>({ status: 'loading' })
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const text = code ?? value

  useEffect(() => {
    let live = true
    setDrawing({ status: 'loading' })
    import('./qrCodeModel')
      .then(({ qrMatrix, qrPath, qrBox }) => {
        if (!live) return
        const matrix = qrMatrix(value, level)
        setDrawing({ status: 'ready', matrix, path: qrPath(matrix), box: qrBox(matrix) })
      })
      .catch(() => live && setDrawing({ status: 'error' }))
    return () => {
      live = false
    }
  }, [value, level])

  useEffect(() => {
    if (copy === 'idle') return
    const t = setTimeout(() => setCopy('idle'), 2400)
    return () => clearTimeout(t)
  }, [copy])

  const onCopy = () => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clip) return setCopy('failed')
    clip.writeText(text).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    )
  }

  return (
    <figure className={['nds-qr', className ?? ''].filter(Boolean).join(' ')}>
      <div className="nds-qr-plate" style={{ width: size, height: size }}>
        {drawing.status === 'ready' ? (
          <svg
            className="nds-qr-svg"
            role="img"
            aria-label={label}
            viewBox={`0 0 ${drawing.box} ${drawing.box}`}
            width={size}
            height={size}
            shapeRendering="crispEdges"
            data-qr-version={drawing.matrix.version}
          >
            <rect className="nds-qr-light" width={drawing.box} height={drawing.box} />
            <path className="nds-qr-dark" d={drawing.path} />
          </svg>
        ) : drawing.status === 'error' ? (
          <span className="nds-qr-note" role="alert">
            {words.tooLong}
          </span>
        ) : (
          <span className="nds-qr-note" role="status" aria-label={`${label}: ${words.loading}`} />
        )}
      </div>
      <figcaption className="nds-qr-text">
        <code className="nds-qr-code">{text}</code>
        <Button size="sm" onClick={onCopy} aria-label={`${words.copy}: ${text}`}>
          {copy === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          {copy === 'copied' ? words.copied : words.copy}
        </Button>
        <span className="nds-qr-live" aria-live="polite">
          {copy === 'copied' ? words.copied : copy === 'failed' ? words.copyFailed : ''}
        </span>
      </figcaption>
    </figure>
  )
}
