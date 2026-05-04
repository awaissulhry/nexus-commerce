'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RotateCw,
  Sparkles,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'
import ChannelGroupsManager, {
  type ChannelGroup,
} from '../components/ChannelGroupsManager'

interface TitleResult {
  content: string
  charCount: number
  insights: string[]
}
interface BulletsResult {
  content: string[]
  charCounts: number[]
  insights: string[]
}
interface DescriptionResult {
  content: string
  preview: string
  insights: string[]
}
interface KeywordsResult {
  content: string
  charCount: number
  insights: string[]
}

interface ContentSlice {
  title?: TitleResult
  bullets?: BulletsResult
  description?: DescriptionResult
  keywords?: KeywordsResult
  aiGenerated?: boolean
  generatedAt?: string
  metadata?: any
}

interface GenerateGroup {
  groupKey: string
  platform: string
  language: string
  marketplaces: string[]
  channelKeys: string[]
  result?: ContentSlice
  error?: string
}

interface GenerateResponse {
  groups: GenerateGroup[]
  byChannel: Record<string, ContentSlice | { error?: string }>
  dedupSavings: { channelCount: number; groupCount: number }
}

type Field = 'title' | 'bullets' | 'description' | 'keywords'
const ALL_FIELDS: Field[] = ['title', 'bullets', 'description', 'keywords']

const TITLE_MAX = 200
const BULLET_MAX = 500
const KEYWORD_MAX = 250
const MAX_VARIANTS = 5

const MARKETPLACE_TO_LANGUAGE: Record<string, string> = {
  IT: 'it',
  DE: 'de',
  FR: 'fr',
  ES: 'es',
  UK: 'en',
  GB: 'en',
  US: 'en',
  CA: 'en',
  MX: 'es',
  AU: 'en',
  JP: 'ja',
  GLOBAL: 'en',
}

function groupKeyFor(platform: string, marketplace: string): string {
  const lang = MARKETPLACE_TO_LANGUAGE[marketplace.toUpperCase()] ?? 'en'
  return `${lang}:${platform.toUpperCase()}`
}

interface ContentState {
  byGroup: Record<string, ContentSlice>
}

export default function Step6Content({
  wizardState,
  updateWizardState,
  channels,
  wizardId,
}: StepProps) {
  // wizardState.content shape:
  //   Phase G (new):  { byGroup: { [groupKey]: ContentSlice } }
  //   Pre-Phase G:    flat ContentSlice (no migration — pre-existing
  //                   wizards regenerate; the field editors below
  //                   read from byGroup only).
  const initialContent = useMemo<ContentState>(() => {
    const c = (wizardState.content ?? {}) as Partial<ContentState> & ContentSlice
    if (c && typeof c === 'object' && 'byGroup' in c && c.byGroup) {
      return c as ContentState
    }
    return { byGroup: {} }
  }, [wizardState.content])

  const [content, setContent] = useState<ContentState>(initialContent)
  const [busyAll, setBusyAll] = useState(false)
  const [busyGroups, setBusyGroups] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const variantsRef = useRef<Record<string, Record<Field, number>>>({})

  const channelGroups = (wizardState.channelGroups ?? []) as ChannelGroup[]
  const onChannelGroupsChange = useCallback(
    (next: ChannelGroup[]) => {
      void updateWizardState({ channelGroups: next })
    },
    [updateWizardState],
  )

  // Compute distinct groups for the channels picked in Step 1.
  const groups = useMemo(() => {
    const out: Array<{
      groupKey: string
      platform: string
      language: string
      channelKeys: string[]
    }> = []
    const seen = new Map<
      string,
      { platform: string; language: string; channelKeys: string[] }
    >()
    for (const c of channels) {
      const key = groupKeyFor(c.platform, c.marketplace)
      const channelKey = `${c.platform}:${c.marketplace}`
      if (!seen.has(key)) {
        seen.set(key, {
          platform: c.platform,
          language:
            MARKETPLACE_TO_LANGUAGE[c.marketplace.toUpperCase()] ?? 'en',
          channelKeys: [channelKey],
        })
      } else {
        seen.get(key)!.channelKeys.push(channelKey)
      }
    }
    for (const [groupKey, val] of seen.entries()) {
      out.push({ groupKey, ...val })
    }
    out.sort((a, b) => a.groupKey.localeCompare(b.groupKey))
    return out
  }, [channels])

  const [activeGroup, setActiveGroup] = useState<string | null>(
    groups[0]?.groupKey ?? null,
  )
  // Re-sync the active tab when the channels change.
  useEffect(() => {
    if (!activeGroup && groups[0]) {
      setActiveGroup(groups[0].groupKey)
    } else if (activeGroup && !groups.find((g) => g.groupKey === activeGroup)) {
      setActiveGroup(groups[0]?.groupKey ?? null)
    }
  }, [groups, activeGroup])

  // Persist content state to wizardState.content. The byGroup-shaped
  // payload replaces the slot wholesale; the wizard shell shallow-
  // merges at the slot level so other state slices are untouched.
  const persistContent = useCallback(
    async (next: ContentState) => {
      await updateWizardState({ content: next })
    },
    [updateWizardState],
  )

  // ── Generate all groups (one call → fan out to N Gemini calls
  //    on the server, deduped by group). ─────────────────────────
  const generateAll = useCallback(
    async (fields: Field[], variantBumpFor?: { groupKey: string; field: Field }) => {
      if (fields.length === 0 || groups.length === 0) return
      setError(null)
      if (variantBumpFor) {
        const slot =
          variantsRef.current[variantBumpFor.groupKey] ??
          ({ title: 0, bullets: 0, description: 0, keywords: 0 } as Record<
            Field,
            number
          >)
        slot[variantBumpFor.field] = Math.min(
          slot[variantBumpFor.field] + 1,
          MAX_VARIANTS - 1,
        )
        variantsRef.current[variantBumpFor.groupKey] = slot
      }
      // For a regen-all (no specific variant bump), fire variant=0
      // so we get a fresh first-take across every group.
      const variant = variantBumpFor
        ? (variantsRef.current[variantBumpFor.groupKey]?.[variantBumpFor.field] ?? 0)
        : 0

      setBusyAll(true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/listing-wizard/${wizardId}/generate-content`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields, variant }),
          },
        )
        const json = (await res.json()) as GenerateResponse & {
          error?: string
        }
        if (!res.ok) {
          throw new Error(json?.error ?? `HTTP ${res.status}`)
        }
        // Merge each group's result into byGroup.
        setContent((prev) => {
          const next: ContentState = { byGroup: { ...prev.byGroup } }
          for (const g of json.groups) {
            if (g.result) {
              next.byGroup[g.groupKey] = {
                ...(next.byGroup[g.groupKey] ?? {}),
                ...g.result,
                aiGenerated: true,
                generatedAt:
                  g.result.metadata?.generatedAt ??
                  new Date().toISOString(),
              }
            }
          }
          void persistContent(next)
          return next
        })
      } catch (err: any) {
        setError(err?.message ?? String(err))
      } finally {
        setBusyAll(false)
      }
    },
    [groups.length, persistContent, wizardId],
  )

  // ── Per-group regenerate of a single field ───────────────────
  const regenerateOne = useCallback(
    async (groupKey: string, field: Field) => {
      setBusyGroups((prev) => {
        const next = new Set(prev)
        next.add(groupKey)
        return next
      })
      try {
        await generateAll([field], { groupKey, field })
      } finally {
        setBusyGroups((prev) => {
          const next = new Set(prev)
          next.delete(groupKey)
          return next
        })
      }
    },
    [generateAll],
  )

  // ── Per-group field edits ─────────────────────────────────────
  const editGroupField = useCallback(
    (groupKey: string, patch: Partial<ContentSlice>) => {
      setContent((prev) => {
        const slot = prev.byGroup[groupKey] ?? {}
        const merged: ContentSlice = { ...slot, ...patch }
        const next: ContentState = {
          byGroup: { ...prev.byGroup, [groupKey]: merged },
        }
        void persistContent(next)
        return next
      })
    },
    [persistContent],
  )

  const editTitle = (groupKey: string, val: string) => {
    editGroupField(groupKey, {
      title: { content: val, charCount: val.length, insights: [] },
    })
  }
  const editBullet = (groupKey: string, idx: number, val: string) => {
    setContent((prev) => {
      const slot = prev.byGroup[groupKey] ?? {}
      const current = slot.bullets ?? {
        content: [] as string[],
        charCounts: [] as number[],
        insights: [] as string[],
      }
      const nextContent = current.content.slice()
      nextContent[idx] = val
      const merged: ContentSlice = {
        ...slot,
        bullets: {
          ...current,
          content: nextContent,
          charCounts: nextContent.map((s) => s.length),
        },
      }
      const next: ContentState = {
        byGroup: { ...prev.byGroup, [groupKey]: merged },
      }
      void persistContent(next)
      return next
    })
  }
  const editDescription = (groupKey: string, val: string) => {
    editGroupField(groupKey, {
      description: {
        content: val,
        preview: val.replace(/<[^>]+>/g, '').slice(0, 240),
        insights: [],
      },
    })
  }
  const editKeywords = (groupKey: string, val: string) => {
    editGroupField(groupKey, {
      keywords: { content: val, charCount: val.length, insights: [] },
    })
  }

  // ── Apply-to-all: copy active group's content to every other
  //    group. Useful when users edit one tab and want the same on
  //    the others without re-generating. ──────────────────────────
  const applyToAll = useCallback(() => {
    if (!activeGroup) return
    setContent((prev) => {
      const source = prev.byGroup[activeGroup]
      if (!source) return prev
      const next: ContentState = { byGroup: { ...prev.byGroup } }
      for (const g of groups) {
        if (g.groupKey !== activeGroup) {
          next.byGroup[g.groupKey] = { ...source, aiGenerated: false }
        }
      }
      void persistContent(next)
      return next
    })
  }, [activeGroup, groups, persistContent])

  // K.6 — broadcast active tab's content to every auto-group that
  // contains a member of the user-defined channel group.
  const applyToChannelGroup = useCallback(
    (channelGroupId: string) => {
      if (!activeGroup) return
      const cg = channelGroups.find((g) => g.id === channelGroupId)
      if (!cg) return
      // Resolve the auto group keys hit by this channel group's
      // members. Two members in the same auto group don't double-
      // count.
      const targetAutoKeys = new Set<string>()
      for (const channelKey of cg.channelKeys) {
        const [platform, marketplace] = channelKey.split(':')
        if (!platform || !marketplace) continue
        targetAutoKeys.add(groupKeyFor(platform, marketplace))
      }
      setContent((prev) => {
        const source = prev.byGroup[activeGroup]
        if (!source) return prev
        const next: ContentState = { byGroup: { ...prev.byGroup } }
        for (const autoKey of targetAutoKeys) {
          if (autoKey === activeGroup) continue
          next.byGroup[autoKey] = { ...source, aiGenerated: false }
        }
        void persistContent(next)
        return next
      })
    },
    [activeGroup, channelGroups, persistContent],
  )

  // ── Continue gating: every group must have at least a title +
  //    one non-empty bullet. ────────────────────────────────────
  const groupReady = useCallback(
    (groupKey: string) => {
      const slot = content.byGroup[groupKey]
      if (!slot) return false
      if (!slot.title?.content?.trim()) return false
      if (
        !slot.bullets?.content?.some(
          (b) => typeof b === 'string' && b.trim().length > 0,
        )
      ) {
        return false
      }
      return true
    },
    [content.byGroup],
  )

  const allGroupsReady = useMemo(() => {
    if (groups.length === 0) return false
    return groups.every((g) => groupReady(g.groupKey))
  }, [groups, groupReady])

  const onContinue = useCallback(async () => {
    if (!allGroupsReady) return
    await updateWizardState({ content }, { advance: true })
  }, [allGroupsReady, content, updateWizardState])

  if (channels.length === 0) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-6 text-center">
        <p className="text-[13px] text-slate-600">
          Pick channels in Step 1 first.
        </p>
      </div>
    )
  }

  const activeSlot = activeGroup ? content.byGroup[activeGroup] : undefined
  const activeGroupInfo = groups.find((g) => g.groupKey === activeGroup)

  return (
    <div className="max-w-3xl mx-auto py-8 px-6 space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[20px] font-semibold text-slate-900">
            Content
          </h2>
          <p className="text-[13px] text-slate-600 mt-1 max-w-2xl">
            One tab per (language, platform). Same language + same
            platform = one Gemini call broadcast to every channel in
            that group, so picking Amazon IT + Amazon DE costs two
            calls but Amazon IT + eBay IT costs two as well (different
            char limits).
          </p>
        </div>
        <button
          type="button"
          onClick={() => generateAll(ALL_FIELDS)}
          disabled={busyAll || groups.length === 0}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] font-medium flex-shrink-0',
            busyAll
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700',
          )}
        >
          {busyAll ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          Generate all groups
        </button>
      </header>

      {error && (
        <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-[12px] text-rose-700 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Tab strip */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200">
        {groups.map((g) => {
          const isActive = g.groupKey === activeGroup
          const ready = groupReady(g.groupKey)
          return (
            <button
              key={g.groupKey}
              type="button"
              onClick={() => setActiveGroup(g.groupKey)}
              className={cn(
                'flex flex-col items-start gap-0.5 px-3 py-2 border-b-2 -mb-px transition-colors flex-shrink-0',
                isActive
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-slate-600 hover:text-slate-900',
              )}
            >
              <span className="inline-flex items-center gap-1.5 text-[12px] font-medium">
                {ready && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
                {g.language.toUpperCase()} · {g.platform}
              </span>
              <span className="text-[10px] font-mono text-slate-500">
                {g.channelKeys.join(', ')}
              </span>
            </button>
          )
        })}
      </div>

      {/* K.6 — channel groups manager (manual, shared with Step 9) */}
      <ChannelGroupsManager
        groups={channelGroups}
        availableChannels={channels}
        onChange={onChannelGroupsChange}
        defaultCollapsed
      />

      {activeGroup && activeGroupInfo && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[11px] text-slate-500">
              Applies to{' '}
              <span className="font-mono">
                {activeGroupInfo.channelKeys.join(', ')}
              </span>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {channelGroups
                .filter((g) => g.channelKeys.length > 0)
                .map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => applyToChannelGroup(g.id)}
                    title={`Copy this tab's content to every channel in ${g.name}: ${g.channelKeys.join(', ')}`}
                    className="text-[11px] text-blue-600 hover:underline"
                  >
                    Copy to {g.name}
                  </button>
                ))}
              {groups.length > 1 && (
                <button
                  type="button"
                  onClick={applyToAll}
                  className="text-[11px] text-blue-600 hover:underline"
                  title="Copy this tab's content to every other tab"
                >
                  Apply to all groups
                </button>
              )}
            </div>
          </div>

          <FieldCard
            label="Title"
            limit={TITLE_MAX}
            charCount={activeSlot?.title?.charCount ?? 0}
            onRegen={() => regenerateOne(activeGroup, 'title')}
            busy={busyAll || busyGroups.has(activeGroup)}
            insights={activeSlot?.title?.insights}
          >
            <input
              type="text"
              value={activeSlot?.title?.content ?? ''}
              onChange={(e) => editTitle(activeGroup, e.target.value)}
              maxLength={TITLE_MAX}
              placeholder="Click 'Generate all groups' to start with an AI draft"
              className="w-full h-9 px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </FieldCard>

          <FieldCard
            label="Bullet points"
            limit={BULLET_MAX}
            charCount={
              activeSlot?.bullets?.charCounts?.reduce((a, b) => a + b, 0) ?? 0
            }
            onRegen={() => regenerateOne(activeGroup, 'bullets')}
            busy={busyAll || busyGroups.has(activeGroup)}
            insights={activeSlot?.bullets?.insights}
          >
            <div className="space-y-1.5">
              {[0, 1, 2, 3, 4].map((idx) => {
                const v = activeSlot?.bullets?.content?.[idx] ?? ''
                return (
                  <div key={idx} className="flex items-start gap-2">
                    <span className="text-[10px] font-mono text-slate-400 mt-2 flex-shrink-0">
                      {idx + 1}.
                    </span>
                    <textarea
                      value={v}
                      onChange={(e) =>
                        editBullet(activeGroup, idx, e.target.value)
                      }
                      maxLength={BULLET_MAX}
                      rows={2}
                      placeholder={`Bullet ${idx + 1}`}
                      className="flex-1 px-2 py-1 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                    <span className="text-[10px] font-mono text-slate-400 mt-2 tabular-nums flex-shrink-0 w-10 text-right">
                      {v.length}/{BULLET_MAX}
                    </span>
                  </div>
                )
              })}
            </div>
          </FieldCard>

          <FieldCard
            label="Description (HTML)"
            charCount={activeSlot?.description?.content?.length ?? 0}
            onRegen={() => regenerateOne(activeGroup, 'description')}
            busy={busyAll || busyGroups.has(activeGroup)}
            insights={activeSlot?.description?.insights}
          >
            <textarea
              value={activeSlot?.description?.content ?? ''}
              onChange={(e) => editDescription(activeGroup, e.target.value)}
              rows={6}
              placeholder="HTML description body"
              className="w-full px-2 py-1.5 text-[13px] font-mono border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
            {activeSlot?.description?.preview && (
              <p className="mt-1 text-[11px] text-slate-500 italic">
                Preview: {activeSlot.description.preview}…
              </p>
            )}
          </FieldCard>

          <FieldCard
            label="Backend keywords"
            limit={KEYWORD_MAX}
            charCount={activeSlot?.keywords?.charCount ?? 0}
            onRegen={() => regenerateOne(activeGroup, 'keywords')}
            busy={busyAll || busyGroups.has(activeGroup)}
            insights={activeSlot?.keywords?.insights}
          >
            <input
              type="text"
              value={activeSlot?.keywords?.content ?? ''}
              onChange={(e) => editKeywords(activeGroup, e.target.value)}
              maxLength={KEYWORD_MAX}
              placeholder="search-term-style keywords, comma or space separated"
              className="w-full h-9 px-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </FieldCard>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <div className="text-[12px]">
          {allGroupsReady ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Every group has a title + at least one bullet.
            </span>
          ) : (
            <span className="text-amber-700">
              {groups.filter((g) => !groupReady(g.groupKey)).length} group
              {groups.filter((g) => !groupReady(g.groupKey)).length === 1
                ? ''
                : 's'}{' '}
              still need title + bullets
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onContinue}
          disabled={!allGroupsReady}
          className={cn(
            'h-8 px-4 rounded-md text-[13px] font-medium',
            !allGroupsReady
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700',
          )}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function FieldCard({
  label,
  limit,
  charCount,
  onRegen,
  busy,
  insights,
  children,
}: {
  label: string
  limit?: number
  charCount: number
  onRegen: () => void
  busy: boolean
  insights?: string[]
  children: React.ReactNode
}) {
  return (
    <div className="border border-slate-200 rounded-lg bg-white px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-slate-900">
            {label}
          </span>
          {limit && (
            <span
              className={cn(
                'text-[10px] font-mono tabular-nums',
                charCount > limit
                  ? 'text-rose-700'
                  : charCount > limit * 0.9
                  ? 'text-amber-700'
                  : 'text-slate-400',
              )}
            >
              {charCount}/{limit}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onRegen}
          disabled={busy}
          className="inline-flex items-center gap-1 h-6 px-2 text-[11px] text-slate-600 border border-slate-200 rounded hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RotateCw className="w-3 h-3" />
          )}
          Regenerate
        </button>
      </div>
      {children}
      {insights && insights.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-slate-500">
          {insights.map((it, i) => (
            <li key={i}>· {it}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
