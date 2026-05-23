'use client'

/**
 * DS.1 — Toggles `body[data-print-datasheet]` for the lifetime of
 * the datasheet page. The scoped `@media print` block in
 * globals.css keys off this attribute to hide app-shell chrome
 * (sidebar, banners, palettes) without affecting other pages.
 *
 * Lives in its own client file because the datasheet page is a
 * server component (Prisma fetch). Renders nothing.
 */

import { useEffect } from 'react'

const FLAG = 'printDatasheet'

export default function PrintBodyFlag() {
  useEffect(() => {
    document.body.dataset[FLAG] = '1'
    return () => {
      delete document.body.dataset[FLAG]
    }
  }, [])
  return null
}
