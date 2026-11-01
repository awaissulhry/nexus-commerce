'use client'

import { useEffect, useState } from 'react'

/**
 * The QR inside LabelPreview's square on a badge (its `renderQr`): the bare mark drawn from the DS's own QR model
 * (`QrCode/qrCodeModel`, loaded when a code is drawn, as the DS `QrCode` does), an `<svg>` that fills its box. The DS
 * `QrCode` always draws its caption and a Copy button under the code, which a 20 mm square on a badge cannot hold — the
 * DS gap "QrCode without its caption" the floor's bundle ticket named first; composed here for the People area.
 */
export function BadgeQr({ value, label }: { value: string; label: string }) {
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
  if (!drawing) return <span className="fw-pp-qr" aria-hidden="true" />
  return (
    <svg className="fw-pp-qr" role="img" aria-label={label} viewBox={`0 0 ${drawing.box} ${drawing.box}`} shapeRendering="crispEdges">
      <path className="fw-pp-qr-dark" d={drawing.path} />
    </svg>
  )
}
