'use client'
import { usePathname, useSearchParams } from 'next/navigation'
import { workspaceFromPath } from '@/lib/workspaces/paths'
import { CategoriesWorkspace } from './CategoriesWorkspace'

export function CategoriesClient() {
  const search = useSearchParams()
  const workspace = workspaceFromPath(usePathname() ?? '') ?? 'legacy'
  return <CategoriesWorkspace key={workspace} initialView={search.get('view') ?? undefined} initialChannel={search.get('channel') ?? undefined} initialMarket={search.get('market') ?? undefined} />
}
