'use client'

// CX.7 — Schema change detector.
//
// Fetches the flat-file manifest for the current marketplace + productType,
// fingerprints the REQUIRED/RECOMMENDED field set, and compares it against
// what was stored in localStorage the last time the operator viewed this
// cockpit. If the fingerprint changed, returns the new/removed field labels
// so the cockpit can surface a banner.
//
// Uses the same /api/amazon/flat-file/template endpoint (5-min TtlCache on
// the API) — the second fetch within a cache window is essentially free.

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'

interface ManifestColumn {
  fieldRef: string
  labelEn: string
  required: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL'
}

interface ManifestGroup {
  columns: ManifestColumn[]
}

interface Manifest {
  groups: ManifestGroup[]
}

export interface SchemaChangeSummary {
  hasChanged: boolean
  /** Labels of newly added REQUIRED/RECOMMENDED fields */
  newFields: string[]
  /** Labels of removed REQUIRED/RECOMMENDED fields */
  removedFields: string[]
  acknowledge: () => void
}

function storageKey(marketplace: string, productType: string) {
  return `cockpit:schema-fp:${marketplace}:${productType}`
}

function fingerprint(manifest: Manifest): string {
  return manifest.groups
    .flatMap((g) => g.columns)
    .filter((c) => c.required !== 'OPTIONAL')
    .map((c) => c.fieldRef)
    .sort()
    .join(',')
}

function fingerprintLabels(manifest: Manifest): Record<string, string> {
  const out: Record<string, string> = {}
  for (const g of manifest.groups) {
    for (const c of g.columns) {
      if (c.required !== 'OPTIONAL') out[c.fieldRef] = c.labelEn
    }
  }
  return out
}

export function useSchemaChangeDetector(
  marketplace: string,
  productType: string | null,
): SchemaChangeSummary {
  const [summary, setSummary] = useState<SchemaChangeSummary>({
    hasChanged: false,
    newFields: [],
    removedFields: [],
    acknowledge: () => {},
  })

  useEffect(() => {
    if (!productType) return
    let cancelled = false

    const url = `${getBackendUrl()}/api/amazon/flat-file/template?marketplace=${encodeURIComponent(marketplace)}&productType=${encodeURIComponent(productType)}`

    fetch(url, { credentials: 'include' })
      .then((r) => {
        if (!r.ok || cancelled) return null
        return r.json() as Promise<Manifest>
      })
      .then((manifest) => {
        if (!manifest || cancelled) return

        const currentFp = fingerprint(manifest)
        const key = storageKey(marketplace, productType)
        let storedFp: string | null = null
        try {
          storedFp = localStorage.getItem(key)
        } catch {
          // localStorage unavailable (private browsing, etc.)
          return
        }

        const acknowledge = () => {
          try { localStorage.setItem(key, currentFp) } catch { /* ignore */ }
          setSummary((s) => ({ ...s, hasChanged: false }))
        }

        if (storedFp === null) {
          // First visit — store and don't show banner.
          try { localStorage.setItem(key, currentFp) } catch { /* ignore */ }
          return
        }

        if (storedFp === currentFp) return

        // Schema changed — compute diff.
        const prevRefs = new Set(storedFp.split(',').filter(Boolean))
        const currRefs = new Set(currentFp.split(',').filter(Boolean))
        const labels = fingerprintLabels(manifest)

        const newFields = [...currRefs]
          .filter((r) => !prevRefs.has(r))
          .map((r) => labels[r] ?? r)

        const removedFields = [...prevRefs]
          .filter((r) => !currRefs.has(r))
          .map((r) => r) // can't get label for removed field

        if (!cancelled) {
          setSummary({ hasChanged: true, newFields, removedFields, acknowledge })
        }
      })
      .catch(() => { /* silently ignore — banner is non-critical */ })

    return () => { cancelled = true }
  }, [marketplace, productType])

  return summary
}
