'use client'

import { arrowHead, markInPixels, type PhotoMark } from '@nexus/ui/components/PhotoCapture/index'

/**
 * Marks drawn back over a picture or a PDF page (an overlay is never burned into a PDF): the page as an image and the DS
 * PhotoCapture's own marks (arrows and circles, 0..1 of the picture) in an SVG on top. An app part (the DS PhotoCapture
 * draws marks only while they are made); named in B-W2b-177's notes.
 */
export function MarkSketch({ src, width, height, marks, label }: { src: string; width: number; height: number; marks: readonly PhotoMark[]; label: string }) {
  const stroke = Math.max(2, Math.round(width / 300))
  return (
    <figure className="fw-rf-sketch" aria-label={label}>
      <img src={src} alt="" width={width} height={height} />
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden focusable="false">
        {marks.map((mark, index) => {
          const pixel = markInPixels(mark, width, height)
          if (pixel.kind === 'circle') return <circle key={index} cx={pixel.center.x} cy={pixel.center.y} r={pixel.radius} fill="none" strokeWidth={stroke} className="fw-rf-mark" />
          const [left, right] = arrowHead(pixel.from, pixel.to, stroke * 5)
          return (
            <g key={index} className="fw-rf-mark">
              <line x1={pixel.from.x} y1={pixel.from.y} x2={pixel.to.x} y2={pixel.to.y} strokeWidth={stroke} />
              <polyline points={`${left.x},${left.y} ${pixel.to.x},${pixel.to.y} ${right.x},${right.y}`} fill="none" strokeWidth={stroke} />
            </g>
          )
        })}
      </svg>
    </figure>
  )
}
