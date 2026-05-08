'use client'

/**
 * F.6 — Client-side trigger for window.print(). Lives in its own
 * file because the datasheet page itself is server-rendered (data
 * fetch via prisma); the print button is the only interactive
 * piece.
 */

import { Printer } from 'lucide-react'

export default function PrintButtonClient() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-1.5 h-8 px-3 text-md font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800"
    >
      <Printer className="w-4 h-4" />
      Print
    </button>
  )
}
