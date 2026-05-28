'use client'

// FL.3b — client for the FieldLinkGroup persistence API.
//
// Loads a product's link groups (tolerant of an unmigrated table) and
// PUTs scope changes. Independent/master both clear the group; the
// independent per-cell pin (ChannelListingOverride) lands in FL.4.

import { useCallback, useEffect, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import type { FieldScope, FieldScopeResult } from './FieldScopePopover'

// Field keys that represent a price → propagation routes them through
// /channel-pricing (the real price column) instead of the attributes PUT.
const PRICE_FIELD_KEYS = new Set(['our_price', 'price', 'purchasable_offer.our_price'])

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
  // T3.1 — null for a PARENT (product-level) group; the variant id for
  // a CHILD group that pins one variant's field across coordinates.
  variantId: string | null
  translatePolicy: 'TRANSLATE' | 'VERBATIM' | 'NONE'
  members: FieldLinkMember[]
  sourceLanguage: string | null
}

export interface SetScopeOptions {
  parentage?: 'PARENT' | 'CHILD'
  sourceLanguage?: string | null
  // T3.2 — set to scope the link to a single variant (CHILD group).
  variantId?: string | null
}

// Composite map key so a field's PARENT group and its per-variant CHILD
// groups coexist without collision.
function groupKey(fieldKey: string, variantId?: string | null): string {
  return variantId ? `${fieldKey}::${variantId}` : fieldKey
}

export interface PropagationEntryDto {
  channel: string
  marketplace: string
  variantId?: string
  currentValue: string | null
  proposedValue: string | null
  action: 'verbatim' | 'translate' | 'skip'
  language: string | null
  unchanged: boolean
  // T3.3b/B2 — price target whose currency differs from the source's;
  // skipped so the operator sets it manually instead of copying a raw
  // number across currencies.
  currencyMismatch?: boolean
}

export interface PropagatePreview {
  entries: PropagationEntryDto[]
  translatable: boolean
  aiBudgetExceeded: boolean
}

export interface PropagationSource {
  channel: string
  marketplace: string
  language?: string | null
}

export interface LinkSuggestion {
  fieldKey: string
  label: string
  sampleValue: string
  members: Array<{ channel: string; marketplace: string }>
  count: number
}

export function useFieldLinks(productId: string) {
  const [groups, setGroups] = useState<Record<string, FieldLinkGroupDto>>({})
  const [unavailable, setUnavailable] = useState(false)
  const [suggestions, setSuggestions] = useState<LinkSuggestion[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

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
      for (const g of j.groups ?? []) map[groupKey(g.fieldKey, g.variantId)] = g
      setGroups(map)
    } catch {
      // tolerate — linking just stays inert
    }
  }, [productId])

  const loadSuggestions = useCallback(async () => {
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/products/${productId}/field-links/suggestions`,
        { credentials: 'include' },
      )
      if (!r.ok) return
      const j = (await r.json()) as { suggestions?: LinkSuggestion[] }
      setSuggestions(j.suggestions ?? [])
    } catch {
      // tolerate
    }
  }, [productId])

  useEffect(() => {
    void reload()
    void loadSuggestions()
  }, [reload, loadSuggestions])

  const setScope = useCallback(
    async (fieldKey: string, result: FieldScopeResult, opts?: SetScopeOptions): Promise<boolean> => {
      const variantId = opts?.variantId ?? null
      const members: FieldLinkMember[] = result.memberKeys.map((k) => {
        const [channel, marketplace] = k.split(':')
        return variantId ? { channel, marketplace, variantId } : { channel, marketplace }
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
              // A variant coordinate forces CHILD parentage server-side too.
              parentage: variantId ? 'CHILD' : (opts?.parentage ?? 'PARENT'),
              sourceLanguage: opts?.sourceLanguage ?? null,
              variantId,
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

  /** Stored scope for a field (optionally scoped to one variant):
   *  'linked' when a group exists, else 'master' (independent isn't
   *  persisted as a group in FL.3b). */
  const scopeFor = useCallback(
    (fieldKey: string, variantId?: string | null): FieldScope =>
      groups[groupKey(fieldKey, variantId)] ? 'linked' : 'master',
    [groups],
  )

  const memberKeysFor = useCallback(
    (fieldKey: string, variantId?: string | null): string[] =>
      (groups[groupKey(fieldKey, variantId)]?.members ?? []).map(
        (m) => `${m.channel}:${m.marketplace}`,
      ),
    [groups],
  )

  // FL.4 — preview the propagation diff for a linked field (plan + AI
  // translate, no writes).
  const propagatePreview = useCallback(
    async (
      fieldKey: string,
      editedValue: string,
      source: PropagationSource,
    ): Promise<PropagatePreview | null> => {
      try {
        const r = await fetch(
          `${getBackendUrl()}/api/products/${productId}/field-links/${encodeURIComponent(fieldKey)}/propagate-preview`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              editedValue,
              sourceChannel: source.channel,
              sourceMarketplace: source.marketplace,
              sourceLanguage: source.language ?? null,
            }),
          },
        )
        if (!r.ok) return null
        return (await r.json()) as PropagatePreview
      } catch {
        return null
      }
    },
    [productId],
  )

  // FL.4 — apply confirmed entries. Price routes through /channel-pricing
  // (writes the real price column); everything else writes through the
  // editor's own listing-attributes PUT (item_name→title, etc.).
  const applyPropagation = useCallback(
    async (
      fieldKey: string,
      entries: PropagationEntryDto[],
    ): Promise<{ ok: number; fail: number }> => {
      const actionable = entries.filter((e) => e.action !== 'skip' && e.proposedValue != null)
      if (actionable.length === 0) return { ok: 0, fail: 0 }

      // Price → one /channel-pricing call (per-(channel, marketplace) price).
      if (PRICE_FIELD_KEYS.has(fieldKey)) {
        const updates = actionable
          .map((e) => ({
            marketplace: e.marketplace,
            channel: e.channel,
            price: parseFloat(e.proposedValue as string),
          }))
          .filter((u) => Number.isFinite(u.price))
        if (updates.length === 0) return { ok: 0, fail: 0 }
        try {
          const r = await fetch(
            `${getBackendUrl()}/api/products/${productId}/channel-pricing`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ updates }),
            },
          )
          return r.ok ? { ok: updates.length, fail: 0 } : { ok: 0, fail: updates.length }
        } catch {
          return { ok: 0, fail: updates.length }
        }
      }

      // Text / other → per-member listing-attributes PUT.
      let ok = 0
      let fail = 0
      for (const e of actionable) {
        try {
          const r = await fetch(
            `${getBackendUrl()}/api/products/${productId}/listings/${e.channel}/${e.marketplace}`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ attributes: { [fieldKey]: e.proposedValue } }),
            },
          )
          if (r.ok) ok++
          else fail++
        } catch {
          fail++
        }
      }
      return { ok, fail }
    },
    [productId],
  )

  // FL.6.2 — accept a suggestion: link the field across its members.
  const linkSuggestion = useCallback(
    async (s: LinkSuggestion): Promise<boolean> => {
      const ok = await setScope(s.fieldKey, {
        scope: 'linked',
        memberKeys: s.members.map((m) => `${m.channel}:${m.marketplace}`),
        translate: true,
      })
      if (ok) {
        setSuggestions((prev) => prev.filter((x) => x.fieldKey !== s.fieldKey))
      }
      return ok
    },
    [setScope],
  )

  const dismissSuggestion = useCallback((fieldKey: string) => {
    setDismissed((prev) => new Set(prev).add(fieldKey))
  }, [])

  const visibleSuggestions = suggestions.filter((s) => !dismissed.has(s.fieldKey))

  return {
    groups,
    unavailable,
    reload,
    setScope,
    scopeFor,
    memberKeysFor,
    propagatePreview,
    applyPropagation,
    suggestions: visibleSuggestions,
    linkSuggestion,
    dismissSuggestion,
  }
}
