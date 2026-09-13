'use client'

/**
 * MX.P — the preview banner (design Revision, §3.1 rule 6 / AAA bar 7): on screen WHENEVER
 * `MatrixRead.source === 'preview'`, nothing in live mode. The words are `MATRIX_COPY.previewBanner`
 * verbatim; the probe's own reason (`The Matrix service answered HTTP 404`) trails it so a reader can
 * tell "the service is not built" from "the service refused me" without opening the Network panel.
 */
import { Banner } from '@/design-system/components'

import { MATRIX_COPY, type MatrixRead } from './contract'

export function MatrixBanner({ read, note }: { read: MatrixRead | null; note?: string | null }) {
  if (!read || read.source !== 'preview') return null
  return (
    <Banner tone="info" className="nds-matrix-banner">
      {MATRIX_COPY.previewBanner}
      {note ? <span className="nds-cell-muted"> · {note}</span> : null}
    </Banner>
  )
}
