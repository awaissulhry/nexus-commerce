'use client'

/**
 * AM-33 — the AMC page's "nothing to overlap" reason, read from the campaigns each time the page opens (it was a fixed
 * count from one day in August 2026, shown as a current fact). Counting rules live in `adTypeMix.ts`.
 */
import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { adTypeMix, adTypeMixSentence, type CampaignTypeRow } from './adTypeMix'

const LIMIT = 500

export function AdTypeMixLine() {
  const [text, setText] = useState<{ facts: string; meaning: string } | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/advertising/campaigns?limit=${LIMIT}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { items?: CampaignTypeRow[] }) => {
        if (!alive) return
        const items = Array.isArray(d.items) ? d.items : []
        setText(adTypeMixSentence(adTypeMix(items), items.length >= LIMIT ? LIMIT : undefined))
      })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [])

  if (failed) return <>Every AMC view compares ad types against each other. Your campaigns could not be read just now, so how many Sponsored Brands, Display and TV campaigns run is not shown.</>
  if (!text) return <>Every AMC view compares ad types against each other. Reading your campaigns…</>
  return <>Every AMC view compares ad types against each other. {text.facts} {text.meaning}</>
}
