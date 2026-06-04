'use client'

/**
 * RC4.10 — consolidated intelligence banner. A single at-a-glance alert at the top
 * of the cockpit, rendered ONLY when there's something to flag: other campaigns
 * advertising the same ASIN (self-competition) and/or your own products contesting
 * the same keywords (cross-product overlap). Details live in the cockpit below.
 */

import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export function IntelligenceBanner({ campaignId, market }: { campaignId: string; market: string }) {
  const [selfN, setSelfN] = useState(0)
  const [kwN, setKwN] = useState(0)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!campaignId) { setSelfN(0); setKwN(0); setLoaded(false); return }
    const ac = new AbortController()
    setLoaded(false)
    void Promise.all([
      fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/self-competition`, { cache: 'no-store', signal: ac.signal }).then(r => r.json()).catch(() => ({ conflicts: [] })),
      fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/keyword-conflicts?marketplace=${market}`, { cache: 'no-store', signal: ac.signal }).then(r => r.json()).catch(() => ({ summary: { contestedKeywords: 0 } })),
    ]).then(([sc, kc]) => { if (ac.signal.aborted) return; setSelfN((sc.conflicts ?? []).length); setKwN(kc.summary?.contestedKeywords ?? 0); setLoaded(true) })
    return () => ac.abort()
  }, [campaignId, market])

  if (!loaded || (selfN === 0 && kwN === 0)) return null
  return (
    <div className="az-intel" role="status">
      <ShieldAlert size={15} />
      {selfN > 0 && <span className="it"><b>{selfN}</b> other campaign{selfN === 1 ? '' : 's'} advertise this ASIN — they bid against each other</span>}
      {selfN > 0 && kwN > 0 && <span className="dot">·</span>}
      {kwN > 0 && <span className="it"><b>{kwN}</b> keyword{kwN === 1 ? '' : 's'} contested by your other products</span>}
      <span className="hint">Details in the cockpit below ↓</span>
    </div>
  )
}
