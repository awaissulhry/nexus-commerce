'use client'

// MC.2.2 — folder tree.
//
// Replaces the flat library with a folder-narrowed view when the
// operator selects a folder in the tree. Three "virtual" entries
// pin to the top: All assets, Unfiled, and a divider before the
// real folder hierarchy. Folders are rendered recursively from a
// flat parentId list.
//
// Persistence: localStorage tracks expanded-state per folder id so
// the tree remembers what was open across page loads.

import { useEffect, useState, useCallback } from 'react'
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Plus,
  Inbox,
  Layers,
  Loader2,
  Trash2,
  MoreHorizontal,
} from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'

export type FolderSelection = 'all' | 'unfiled' | string

export interface AssetFolderNode {
  id: string
  name: string
  parentId: string | null
  order: number
  _count?: { assets: number; children: number }
}

interface Props {
  apiBase: string
  selected: FolderSelection
  onSelect: (next: FolderSelection) => void
}

const EXPANDED_KEY = 'nexus:marketing-content:folders-expanded'

function readExpanded(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeExpanded(set: Set<string>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]))
  } catch {
    /* silent */
  }
}

export default function FolderTree({ apiBase, selected, onSelect }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const confirm = useConfirm()
  const [folders, setFolders] = useState<AssetFolderNode[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded())
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null)
  const [creatingName, setCreatingName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${apiBase}/api/asset-folders`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`Folders API returned ${res.status}`)
      const data = (await res.json()) as { folders: AssetFolderNode[] }
      setFolders(data.folders ?? [])
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('marketingContent.folders.loadError'),
      )
    } finally {
      setLoading(false)
    }
  }, [apiBase, t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeExpanded(next)
      return next
    })
  }

  const childrenOf = (parentId: string | null): AssetFolderNode[] =>
    folders
      .filter((f) => f.parentId === parentId)
      .sort(
        (a, b) =>
          a.order - b.order || a.name.localeCompare(b.name),
      )

  const submitCreate = async () => {
    const name = creatingName.trim()
    if (!name) {
      setCreating(null)
      setCreatingName('')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${apiBase}/api/asset-folders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, parentId: creating?.parentId ?? null }),
      })
      if (!res.ok) throw new Error(`Create failed (${res.status})`)
      setCreating(null)
      setCreatingName('')
      await load()
      // Auto-expand the parent so the new folder is visible.
      if (creating?.parentId)
        setExpanded((prev) => {
          const next = new Set(prev)
          next.add(creating.parentId as string)
          writeExpanded(next)
          return next
        })
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('marketingContent.folders.createError'),
      )
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (folder: AssetFolderNode) => {
    const childCount = folder._count?.children ?? 0
    const assetCount = folder._count?.assets ?? 0
    const ok = await confirm({
      title: t('marketingContent.folders.deleteTitle', { name: folder.name }),
      description:
        childCount > 0 || assetCount > 0
          ? t('marketingContent.folders.deleteBodyNonEmpty', {
              children: childCount.toString(),
              assets: assetCount.toString(),
            })
          : t('marketingContent.folders.deleteBodyEmpty'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await fetch(
        `${apiBase}/api/asset-folders/${encodeURIComponent(folder.id)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`Delete failed (${res.status})`)
      if (selected === folder.id) onSelect('all')
      await load()
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('marketingContent.folders.deleteError'),
      )
    } finally {
      setBusy(false)
    }
  }

  const renderTree = (parentId: string | null, depth: number): React.ReactNode => {
    const kids = childrenOf(parentId)
    return kids.map((folder) => {
      const isOpen = expanded.has(folder.id)
      const hasKids = (folder._count?.children ?? 0) > 0
      return (
        <li key={folder.id}>
          <div
            className={`group flex items-center gap-1 rounded-md px-1 py-1 text-sm ${
              selected === folder.id
                ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
            }`}
            style={{ paddingLeft: `${depth * 12 + 4}px` }}
          >
            <button
              type="button"
              onClick={() => toggleExpanded(folder.id)}
              aria-label={
                isOpen
                  ? t('marketingContent.folders.collapse')
                  : t('marketingContent.folders.expand')
              }
              className="rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              style={{ visibility: hasKids ? 'visible' : 'hidden' }}
            >
              {isOpen ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onSelect(folder.id)}
              className="flex flex-1 items-center gap-1.5 truncate text-left"
            >
              {isOpen ? (
                <FolderOpen className="w-4 h-4 text-amber-500 flex-shrink-0" />
              ) : (
                <Folder className="w-4 h-4 text-amber-500 flex-shrink-0" />
              )}
              <span className="truncate">{folder.name}</span>
              {(folder._count?.assets ?? 0) > 0 && (
                <span className="ml-1 text-xs text-slate-400">
                  {folder._count?.assets}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating({ parentId: folder.id })
                setCreatingName('')
              }}
              aria-label={t('marketingContent.folders.addSubfolder')}
              className="rounded p-0.5 text-slate-400 opacity-0 hover:text-slate-700 group-hover:opacity-100 dark:hover:text-slate-200"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(folder)}
              aria-label={t('marketingContent.folders.delete', {
                name: folder.name,
              })}
              className="rounded p-0.5 text-slate-400 opacity-0 hover:text-red-600 group-hover:opacity-100 dark:hover:text-red-400"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
          {creating?.parentId === folder.id && (
            <div
              className="px-2 py-1"
              style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}
            >
              <input
                autoFocus
                type="text"
                value={creatingName}
                onChange={(e) => setCreatingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCreate()
                  if (e.key === 'Escape') {
                    setCreating(null)
                    setCreatingName('')
                  }
                }}
                onBlur={() => void submitCreate()}
                placeholder={t('marketingContent.folders.namePlaceholder')}
                className="w-full rounded border border-slate-300 px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
          )}
          {isOpen && hasKids && <ul>{renderTree(folder.id, depth + 1)}</ul>}
        </li>
      )
    })
  }

  return (
    <aside
      className="flex flex-col rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
      aria-label={t('marketingContent.folders.sidebarLabel')}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('marketingContent.folders.title')}
        </p>
        <button
          type="button"
          onClick={() => {
            setCreating({ parentId: null })
            setCreatingName('')
          }}
          aria-label={t('marketingContent.folders.addRootFolder')}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="overflow-y-auto py-1">
        <button
          type="button"
          onClick={() => onSelect('all')}
          className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-sm ${
            selected === 'all'
              ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
              : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
          }`}
        >
          <Layers className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <span className="flex-1 text-left">
            {t('marketingContent.folders.allAssets')}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onSelect('unfiled')}
          className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-sm ${
            selected === 'unfiled'
              ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
              : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'
          }`}
        >
          <Inbox className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <span className="flex-1 text-left">
            {t('marketingContent.folders.unfiled')}
          </span>
        </button>

        {creating?.parentId === null && (
          <div className="px-2 py-1">
            <input
              autoFocus
              type="text"
              value={creatingName}
              onChange={(e) => setCreatingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitCreate()
                if (e.key === 'Escape') {
                  setCreating(null)
                  setCreatingName('')
                }
              }}
              onBlur={() => void submitCreate()}
              placeholder={t('marketingContent.folders.namePlaceholder')}
              className="w-full rounded border border-slate-300 px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('marketingContent.folders.loading')}
          </div>
        ) : folders.length === 0 ? (
          <p className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">
            {t('marketingContent.folders.empty')}
          </p>
        ) : (
          <ul className="border-t border-slate-200 pt-1 dark:border-slate-800">
            {renderTree(null, 0)}
          </ul>
        )}
        {busy && (
          <div className="flex items-center justify-center py-1">
            <Loader2 className="w-3 h-3 animate-spin text-slate-400" />
          </div>
        )}
        {/* MoreHorizontal not actively used yet — placeholder for the
            MC.2-followup rename + reorder context menu. */}
        <span className="hidden">
          <MoreHorizontal className="w-3 h-3" />
        </span>
      </div>
    </aside>
  )
}
