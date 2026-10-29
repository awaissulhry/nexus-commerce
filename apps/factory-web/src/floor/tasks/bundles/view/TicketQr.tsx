'use client'

import { useEffect, useState } from 'react'

/**
 * The QR of a ticket's code inside LabelPreview's QR square (its `renderQr`). The DS `QrCode` always draws its caption
 * and a Copy button under the code (made for enrolment links), which a 16 mm square on a label cannot hold: this is the
 * bare mark, drawn from the DS's own QR model (`QrCode/qrCodeModel`, loaded when a code is drawn, as `QrCode` does), an
 * `<svg>` that fills its box, dark on the label's paper. A DS gap ("QrCode without its caption"), named in the notes.
 */
export function TicketQr({ value, label }: { value: string; label: string }) {
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
  if (!drawing) return <span className="fw-bundles-qr-empty" aria-hidden="true" />
  return (
    <svg className="fw-bundles-qr" role="img" aria-label={label} viewBox={`0 0 ${drawing.box} ${drawing.box}`} shapeRendering="crispEdges">
      <path className="fw-bundles-qr-dark" d={drawing.path} />
    </svg>
  )
}
