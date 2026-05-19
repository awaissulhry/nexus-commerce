import { prisma } from '@nexus/database'
import ApiKeysClient, { type ApiKeyRow } from './ApiKeysClient'

export const dynamic = 'force-dynamic'

export default async function ApiKeysPage() {
  let keys: any[] = []
  try {
    keys = await (prisma as any).apiKey.findMany({
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
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
    scopes: k.scopes ?? [],
    ipAllowlist: k.ipAllowlist ?? [],
    expiresAt: k.expiresAt?.toISOString() ?? null,
    rotatedAt: k.rotatedAt?.toISOString() ?? null,
    rotatedToId: k.rotatedToId ?? null,
    rotationGraceUntil: k.rotationGraceUntil?.toISOString() ?? null,
  }))
  return <ApiKeysClient apiKeys={apiKeys} />
}
