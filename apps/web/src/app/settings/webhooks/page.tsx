import { getBackendUrl } from '@/lib/backend-url'
import WebhooksClient, { type WebhookRow } from './WebhooksClient'

export const dynamic = 'force-dynamic'

export default async function WebhooksPage() {
  const backend = getBackendUrl()
  let webhooks: WebhookRow[] = []
  let loadError: string | null = null
  try {
    const res = await fetch(`${backend}/api/settings/webhooks`, {
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as { webhooks: WebhookRow[] }
    webhooks = data.webhooks ?? []
  } catch (err: any) {
    loadError = err?.message ?? String(err)
  }
  return <WebhooksClient initial={webhooks} initialError={loadError} />
}
