'use client'

import { useCallback, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ChannelGroup {
  id: string
  name: string
  channelKeys: string[]
}

/**
 * Phase K.6 — user-defined channel groups, shared between Step 8
 * (Content) and Step 9 (Pricing). Groups don't change underlying
 * storage (state.content.byGroup keeps its language:platform keys;
 * channelStates[key].pricing stays per-channel). They're a bulk-
 * edit affordance: "apply this content to every channel in EU
 * Tier 1," "set the price across UK markets to £49.99."
 *
 * Persistence: state.channelGroups: ChannelGroup[].
 */
interface Props {
  groups: ChannelGroup[]
  availableChannels: Array<{ platform: string; marketplace: string }>
  onChange: (next: ChannelGroup[]) => void
  /** Optional collapsed-by-default mode for steps where the
   *  groups list isn't the focal point. */
  defaultCollapsed?: boolean
}

export default function ChannelGroupsManager({
  groups,
  availableChannels,
  onChange,
  defaultCollapsed = true,
}: Props) {
  const [expanded, setExpanded] = useState(!defaultCollapsed)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const addGroup = useCallback(() => {
    const id = `g_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 7)}`
    onChange([
      ...groups,
      { id, name: 'New group', channelKeys: [] },
    ])
    setEditingId(id)
    setDraftName('New group')
    setExpanded(true)
  }, [groups, onChange])

  const renameGroup = useCallback(
    (id: string, name: string) => {
      onChange(
        groups.map((g) => (g.id === id ? { ...g, name } : g)),
      )
    },
    [groups, onChange],
  )

  const deleteGroup = useCallback(
    (id: string) => {
      onChange(groups.filter((g) => g.id !== id))
    },
    [groups, onChange],
  )

  const toggleChannelInGroup = useCallback(
    (groupId: string, channelKey: string) => {
      onChange(
        groups.map((g) => {
          if (g.id !== groupId) return g
          const has = g.channelKeys.includes(channelKey)
          return {
            ...g,
            channelKeys: has
              ? g.channelKeys.filter((k) => k !== channelKey)
              : [...g.channelKeys, channelKey],
          }
        }),
      )
    },
    [groups, onChange],
  )

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <button
        type="button"
        onClick={() => setExpanded((s) => !s)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-[12px] text-slate-700 hover:bg-slate-50"
      >
        <span className="inline-flex items-center gap-1.5">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          <Users className="w-3.5 h-3.5 text-slate-500" />
          <span className="font-medium">Channel groups</span>
          <span className="text-[10px] font-medium text-slate-500">
            {groups.length}
          </span>
        </span>
        <span className="text-[10px] text-slate-400 italic">
          Bulk-edit shortcuts for content + pricing
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-100 px-3 py-2 space-y-2">
          {groups.length === 0 ? (
            <p className="text-[11px] text-slate-500 py-1">
              No groups yet. Use a group to apply the same content or
              price across multiple channels with one edit.
            </p>
          ) : (
            groups.map((g) => {
              const isEditing = editingId === g.id
              return (
                <div
                  key={g.id}
                  className="border border-slate-200 rounded bg-slate-50/40 px-2 py-2"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    {isEditing ? (
                      <input
                        type="text"
                        value={draftName}
                        autoFocus
                        onChange={(e) => setDraftName(e.target.value)}
                        onBlur={() => {
                          if (draftName.trim().length > 0) {
                            renameGroup(g.id, draftName.trim())
                          }
                          setEditingId(null)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            ;(e.target as HTMLInputElement).blur()
                          } else if (e.key === 'Escape') {
                            setEditingId(null)
                          }
                        }}
                        className="flex-1 h-6 px-1.5 text-[12px] font-medium border border-slate-200 rounded focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(g.id)
                          setDraftName(g.name)
                        }}
                        className="flex-1 text-left text-[12px] font-medium text-slate-900 hover:underline inline-flex items-center gap-1"
                      >
                        {g.name}
                        <Pencil className="w-2.5 h-2.5 text-slate-400" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => deleteGroup(g.id)}
                      title="Delete group"
                      className="text-slate-400 hover:text-rose-700 flex-shrink-0"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {availableChannels.map((c) => {
                      const channelKey = `${c.platform}:${c.marketplace}`
                      const inGroup = g.channelKeys.includes(channelKey)
                      return (
                        <button
                          key={channelKey}
                          type="button"
                          onClick={() =>
                            toggleChannelInGroup(g.id, channelKey)
                          }
                          className={cn(
                            'inline-flex items-center gap-1 h-6 px-1.5 text-[10px] font-mono font-medium rounded border transition-colors',
                            inGroup
                              ? 'bg-blue-50 border-blue-300 text-blue-800'
                              : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300',
                          )}
                        >
                          {channelKey}
                          {inGroup && <X className="w-2.5 h-2.5" />}
                        </button>
                      )
                    })}
                  </div>
                  {g.channelKeys.length === 0 && (
                    <p className="mt-1 text-[10px] text-amber-700">
                      Empty group — click chips above to add channels.
                    </p>
                  )}
                </div>
              )
            })
          )}
          <button
            type="button"
            onClick={addGroup}
            className="inline-flex items-center gap-1 h-6 px-2 text-[11px] text-blue-600 hover:underline"
          >
            <Plus className="w-3 h-3" />
            Add group
          </button>
        </div>
      )}
    </div>
  )
}
