'use client'

import { useEffect, useState } from 'react'
import { Biohazard, Bomb, Cylinder, Fish, Flame, FlameKindling, HeartPulse, Skull, TestTubeDiagonal, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { GhsPictogram, SignalWord as SignalWordCode } from '@nexus/factory-domain/safety/chemicals/rules'
import type { Translate } from '../i18n/messages'
import './marks.css'

/**
 * The chemicals' marks the Office (Plant › Chemicals & waste, SCR-213) and the Floor (the cabinet reader, SCR-213-floor) both
 * draw (B-W2b-143), shared through src/lib as the views may share. Words come from the caller's catalogue (`ghs.<code>`,
 * `ghs.none`, `signal.<WORD>`).
 *
 * The GHS pictograms are STAND-INS: a red-edged diamond with an icon close to the symbol and the code and name as its
 * accessible name, never the CLP artwork (the design system has no GHS part: a missing DS part, named in the step's notes).
 */

const GHS_ICONS: Readonly<Record<GhsPictogram, LucideIcon>> = {
  GHS01: Bomb,
  GHS02: Flame,
  GHS03: FlameKindling,
  GHS04: Cylinder,
  GHS05: TestTubeDiagonal,
  GHS06: Skull,
  GHS07: TriangleAlert,
  GHS08: HeartPulse,
  GHS09: Fish,
}

/** One GHS pictogram (stand-in); its code and name are its accessible name and title (`decorative`: beside words that say it). */
export function GhsMark({ code, say, big = false, decorative = false }: { code: GhsPictogram; say: Translate; big?: boolean; decorative?: boolean }) {
  const Icon = GHS_ICONS[code] ?? Biohazard
  const name = `${code} · ${say(`ghs.${code}`)}`
  return (
    <span className={`fw-ghs-mark${big ? ' fw-ghs-big' : ''}`} {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name, title: name })}>
      <span>
        <Icon size={big ? 18 : 12} aria-hidden />
      </span>
    </span>
  )
}

/** A product's pictograms in a row (none: "No pictogram"). */
export function GhsMarks({ codes, say, big = false }: { codes: readonly GhsPictogram[]; say: Translate; big?: boolean }) {
  if (codes.length === 0) return <span className="fw-ghs-none">{say('ghs.none')}</span>
  return (
    <span className="fw-ghs">
      {codes.map((code) => (
        <GhsMark key={code} code={code} say={say} big={big} />
      ))}
    </span>
  )
}

/** The signal word in its tone (DANGER red, WARNING amber), or nothing. */
export function SignalWord({ word, say }: { word: SignalWordCode | null; say: Translate }) {
  if (!word) return null
  return <span className={word === 'DANGER' ? 'fw-signal-danger' : 'fw-signal-warning'}>{say(`signal.${word}`)}</span>
}

/**
 * The cabinet QR's bare mark (LabelPreview's `renderQr`, the cabinet sheet's corner): drawn from the DS's own QR model
 * (`QrCode/qrCodeModel`, loaded when a code is drawn, as the DS `QrCode` does), an `<svg>` that fills its box. The DS `QrCode`
 * always draws its caption and a Copy button under the code, which a label cannot hold (the DS gap "QrCode without its
 * caption" the bundle ticket and the badge named first).
 */
export function CabinetQr({ value, label }: { value: string; label: string }) {
  const [drawing, setDrawing] = useState<{ path: string; box: number } | null>(null)
  useEffect(() => {
    let live = true
    import('@nexus/ui/components/QrCode/qrCodeModel')
      .then(({ qrMatrix, qrPath, qrBox }) => {
        if (!live) return
        const matrix = qrMatrix(value, 'M')
        setDrawing({ path: qrPath(matrix), box: qrBox(matrix) })
      })
      .catch(() => live && setDrawing(null))
    return () => {
      live = false
    }
  }, [value])
  if (!drawing) return <span className="fw-qr-mark" aria-hidden="true" />
  return (
    <svg className="fw-qr-mark" role="img" aria-label={label} viewBox={`0 0 ${drawing.box} ${drawing.box}`} shapeRendering="crispEdges">
      <path className="fw-qr-dark" d={drawing.path} />
    </svg>
  )
}
