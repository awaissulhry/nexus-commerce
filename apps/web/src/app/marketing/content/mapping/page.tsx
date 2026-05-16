/**
 * CE.1 — Mapping Canvas.
 *
 * The core of the Feed Transform Engine: operators define IF/THEN rules
 * that compile master Product records into channel-correct attribute
 * packages for Amazon, eBay, and Shopify.
 *
 * Each rule maps a condition (e.g. brand == 'Xavia') to a field action
 * (e.g. APPEND ' - Premium Motorcycle Gear' to title). Rules are
 * evaluated in priority order; first match per field wins.
 */

import { Layers } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { MappingCanvasClient } from './MappingCanvasClient'

export const dynamic = 'force-dynamic'

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

export default async function MappingCanvasPage() {
  const [rules, amazonSchema, ebaySchema, shopifySchema] = await Promise.all([
    fetchRules(),
    fetchSchema('AMAZON'),
    fetchSchema('EBAY'),
    fetchSchema('SHOPIFY'),
  ])

  const allSchemaFields = [
    ...amazonSchema.map((f) => ({ ...f, channel: 'AMAZON' })),
    ...ebaySchema.map((f) => ({ ...f, channel: 'EBAY' })),
    ...shopifySchema.map((f) => ({ ...f, channel: 'SHOPIFY' })),
  ]

  return (
    <div className="px-4 py-4 max-w-6xl">
      <div className="flex items-start gap-3 mb-5">
        <Layers className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Mapping Canvas
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            IF/THEN field rules that transform your master catalog into channel-ready attribute
            packages for Amazon, eBay, and Shopify. Rules run at listing generation and feed
            export time — first match per field wins.
          </p>
        </div>
      </div>

      <MappingCanvasClient
        initialRules={rules}
        schemaFields={allSchemaFields}
      />
    </div>
  )
}
