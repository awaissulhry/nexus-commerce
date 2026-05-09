import { prisma } from '@nexus/database'
import PageHeader from '@/components/layout/PageHeader'
import ApiKeysClient from './ApiKeysClient'

export const dynamic = 'force-dynamic'

export interface ApiKeyRow {
  id: string
  label: string
  keyPrefix: string
  createdAt: string
  lastUsed: string | null
  revokedAt: string | null
}

export default async function ApiKeysPage() {
  // U.61 — defensive try/catch. See /catalog/drafts for context.
  let keys: any[] = []
  try {
    keys = await (prisma as any).apiKey.findMany({
      orderBy: { createdAt: 'desc' },
    })
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settings/api-keys] prisma error:', err)
  }

  const apiKeys: ApiKeyRow[] = keys.map((k: any) => ({
    id: k.id,
    label: k.label,
    keyPrefix: k.keyPrefix,
    createdAt: k.createdAt.toISOString(),
    lastUsed: k.lastUsed?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  }))

  return (
    <div>
      <PageHeader
        title="API Keys"
        subtitle="Manage API keys for external integrations"
        breadcrumbs={[
          { label: 'Settings', href: '/settings/account' },
          { label: 'API Keys' },
        ]}
      />

      <ApiKeysClient apiKeys={apiKeys} />
    </div>
  )
}
