'use client'

/**
 * CE.1 — Client-side data loader for the Mapping Canvas.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so rules + channel schemas MUST load
 * client-side where the fetch patch adds credentials. Server-side these
 * fetches 401'd into an empty canvas for everyone.
 *
 * `refreshToken` comes from the server page render (Date.now() under
 * force-dynamic): MappingCanvasClient's seed-schemas flow and Refresh
 * button call router.refresh(), which re-renders the server page, mints a
 * new token, and re-triggers this loader's fetch — preserving the original
 * refresh semantics.
 */

import { useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { MappingCanvasClient } from './MappingCanvasClient'

interface TransformRule {
  id: string
  name: string
  description: string | null
  channel: string
  marketplace: string | null
  field: string
  priority: number
  enabled: boolean
  condition: { field: string; op: string; value: unknown } | null
  action: { type: string; value?: string; template?: string }
  createdAt: string
  updatedAt: string
}

interface ChannelSchemaField {
  id: string
  channel: string
  marketplace: string | null
  fieldKey: string
  label: string
  maxLength: number | null
  required: boolean
}

async function fetchRules(): Promise<TransformRule[]> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/feed-transform/rules`, {
      cache: 'no-store',
    })
    if (!res.ok) return []
    const json = (await res.json()) as { rules: TransformRule[] }
    return json.rules
  } catch {
    return []
  }
}

async function fetchSchema(channel: string): Promise<ChannelSchemaField[]> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/feed-transform/schema/${channel}`, {
      cache: 'no-store',
    })
    if (!res.ok) return []
    const json = (await res.json()) as { schema: ChannelSchemaField[] }
    return json.schema
  } catch {
    return []
  }
}

export function MappingCanvasLoader({ refreshToken }: { refreshToken: number }) {
  const [data, setData] = useState<{
    rules: TransformRule[]
    allSchemaFields: ChannelSchemaField[]
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetchRules(),
      fetchSchema('AMAZON'),
      fetchSchema('EBAY'),
      fetchSchema('SHOPIFY'),
    ]).then(([rules, amazonSchema, ebaySchema, shopifySchema]) => {
      if (cancelled) return
      const allSchemaFields = [
        ...amazonSchema.map((f) => ({ ...f, channel: 'AMAZON' })),
        ...ebaySchema.map((f) => ({ ...f, channel: 'EBAY' })),
        ...shopifySchema.map((f) => ({ ...f, channel: 'SHOPIFY' })),
      ]
      setData({ rules, allSchemaFields })
    })
    return () => {
      cancelled = true
    }
  }, [refreshToken])

  if (!data) {
    return (
      <div className="space-y-3" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-md border border-default bg-slate-100 dark:border-slate-800 dark:bg-slate-800"
          />
        ))}
      </div>
    )
  }

  return (
    <MappingCanvasClient
      initialRules={data.rules}
      schemaFields={data.allSchemaFields}
    />
  )
}
