'use client'

import { useSearchParams } from 'next/navigation'

/** `?new=<what>` asks a list page to open a create dialog (the palette, the checklist's "Do it"). */
export function useNewParam(): string | null {
  const params = useSearchParams()
  return params?.get('new') ?? null
}
