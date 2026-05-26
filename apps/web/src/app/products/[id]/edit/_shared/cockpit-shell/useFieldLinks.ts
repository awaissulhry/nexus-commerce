'use client'

// FL.3b — client for the FieldLinkGroup persistence API.
//
// Loads a product's link groups (tolerant of an unmigrated table) and
// PUTs scope changes. Independent/master both clear the group; the
// independent per-cell pin (ChannelListingOverride) lands in FL.4.

import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import type { FieldScope, FieldScopeResult } from './FieldScopePopover'

export interface FieldLinkMember {
  channel: string
  marketplace: string
  variantId?: string
}

export interface FieldLinkGroupDto {
  id: string
  productId: string
  fieldKey: string
  parentage: 'PARENT' | 'CHILD'
  translatePolicy: 'TRANSLATE' | 'VERBATIM' | 'NONE'
  members: FieldLinkMember[]
  sourceLanguage: string | null
}

export interface SetScopeOptions {
  parentage?: 'PARENT' | 'CHILD'
  sourceLanguage?: string | null
}

export function useFieldLinks(productId: string) {
  const [groups, setGroups] = useState<Record<string, FieldLinkGroupDto>>({})
  const [unavailable, setUnavailable] = useState(false)

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/products/${productId}/field-links`, {
        credentials: 'include',
      })
      if (!r.ok) return
      const j = (await r.json()) as { groups?: FieldLinkGroupDto[]; unavailable?: boolean }
      if (j.unavailable) {
        setUnavailable(true)
        return
      }
      const map: Record<string, FieldLinkGroupDto> = {}
      for (const g of j.groups ?? []) map[g.fieldKey] = g
      setGroups(map)
    } catch {
      // tolerate — linking just stays inert
    }
  }, [productId])

  useEffect(() => {
    void reload()
  }, [reload])

  const setScope = useCallback(
    async (fieldKey: string, result: FieldScopeResult, opts?: SetScopeOptions): Promise<boolean> => {
      const members: FieldLinkMember[] = result.memberKeys.map((k) => {
        const [channel, marketplace] = k.split(':')
        return { channel, marketplace }
      })
      try {
        const r = await fetch(
          `${getBackendUrl()}/api/products/${productId}/field-links/${encodeURIComponent(fieldKey)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              scope: result.scope,
              members,
              translatePolicy: result.translate ? 'TRANSLATE' : 'VERBATIM',
              parentage: opts?.parentage ?? 'PARENT',
              sourceLanguage: opts?.sourceLanguage ?? null,
            }),
          },
        )
        if (!r.ok) return false
        await reload()
        return true
      } catch {
        return false
      }
    },
    [productId, reload],
  )

  /** Stored scope for a field: 'linked' when a group exists, else
   *  'master' (independent isn't persisted as a group in FL.3b). */
  const scopeFor = useCallback(
    (fieldKey: string): FieldScope => (groups[fieldKey] ? 'linked' : 'master'),
    [groups],
  )

  const memberKeysFor = useCallback(
    (fieldKey: string): string[] =>
      (groups[fieldKey]?.members ?? []).map((m) => `${m.channel}:${m.marketplace}`),
    [groups],
  )

  return { groups, unavailable, reload, setScope, scopeFor, memberKeysFor }
}
