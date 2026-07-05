'use client'

// The API session cookie lives on the API origin (cross-site setup) — the
// Next server can never present it, so the old server-side template/rows
// fetches 401'd in prod: initialManifest arrived null and the flat-file
// client's mount effect bails when the manifest is missing, leaving a dead
// page. Data MUST load client-side where the patched window.fetch adds
// credentials.

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import AmazonFlatFileClient from '@/app/products/amazon-flat-file/AmazonFlatFileClient'
import EbayFlatFileClient from '@/app/products/ebay-flat-file/EbayFlatFileClient'
import AmazonFlatFileLoading from '@/app/products/amazon-flat-file/loading'
import EbayFlatFileLoading from '@/app/products/ebay-flat-file/loading'

const DEFAULT_MARKETPLACE  = 'IT'
const DEFAULT_PRODUCT_TYPE = 'OUTERWEAR'

// manifest/rows stay loosely typed exactly as in the old server component,
// where they were implicit `any` from res.json().
type LoadedData =
  | { channel: 'amazon'; manifest: any; rows: any[]; mp: string; pt: string; familyId?: string }
  | { channel: 'ebay'; rows: any[]; mp: string; familyId?: string }

// useSearchParams() requires a Suspense boundary at prerender time, so the
// page shell wraps the real component.
export default function BulkOperationsPage() {
  return (
    <Suspense fallback={<AmazonFlatFileLoading />}>
      <BulkOperationsInner />
    </Suspense>
  )
}

function BulkOperationsInner() {
  const searchParams = useSearchParams()
  const channelParam = searchParams.get('channel') ?? 'amazon'
  const channel = channelParam === 'ebay' ? 'ebay' : 'amazon'
  const familyId = searchParams.get('familyId') ?? undefined

  const [data, setData] = useState<LoadedData | null>(null)

  // Fetch once per (channel, familyId). marketplace/productType changes after
  // mount are handled INSIDE the flat-file clients (shallow history.replaceState
  // + their own loadData), so they are deliberately NOT dependencies — reacting
  // to them here would unmount the grid mid-switch.
  useEffect(() => {
    let alive = true
    setData(null)
    ;(async () => {
      const backend = getBackendUrl()
      // Read the initial marketplace/productType at fetch time.
      const mp = (searchParams.get('marketplace') ?? DEFAULT_MARKETPLACE).toUpperCase()
      const pt = (searchParams.get('productType') ?? DEFAULT_PRODUCT_TYPE).toUpperCase()

      if (channel === 'amazon') {
        const qs = new URLSearchParams({ marketplace: mp, productType: pt })
        if (familyId) qs.set('productId', familyId)

        const [manifestRes, rowsRes] = await Promise.all([
          fetch(`${backend}/api/amazon/flat-file/template?marketplace=${mp}&productType=${pt}`, { cache: 'no-store' }).catch(() => null),
          fetch(`${backend}/api/amazon/flat-file/rows?${qs}`, { cache: 'no-store' }).catch(() => null),
        ])
        const manifest = manifestRes?.ok ? await manifestRes.json().catch(() => null) : null
        const rowsJson = rowsRes?.ok    ? await rowsRes.json().catch(() => null)    : null

        if (alive) setData({ channel: 'amazon', manifest, rows: rowsJson?.rows ?? [], mp, pt, familyId })
        return
      }

      // eBay
      const qs = new URLSearchParams()
      if (familyId) qs.set('familyId', familyId)

      const rowsRes  = await fetch(`${backend}/api/ebay/flat-file/rows?${qs}`, { cache: 'no-store' }).catch(() => null)
      const rowsJson = rowsRes?.ok ? await rowsRes.json().catch(() => null) : null

      if (alive) setData({ channel: 'ebay', rows: rowsJson?.rows ?? [], mp, familyId })
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, familyId])

  if (!data) {
    return channel === 'ebay' ? <EbayFlatFileLoading /> : <AmazonFlatFileLoading />
  }

  if (data.channel === 'amazon') {
    return (
      <AmazonFlatFileClient
        key={`amazon:${data.familyId ?? ''}`}
        initialManifest={data.manifest}
        initialRows={data.rows}
        initialMarketplace={data.mp}
        initialProductType={data.pt}
        familyId={data.familyId}
      />
    )
  }

  return (
    <EbayFlatFileClient
      key={`ebay:${data.familyId ?? ''}`}
      initialRows={data.rows}
      initialMarketplace={data.mp}
      familyId={data.familyId}
    />
  )
}
