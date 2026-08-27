'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search, Tag as TagIcon } from 'lucide-react'
import { Modal } from '@/design-system/components'
import { Button, Checkbox, ColorSwatchPicker, Input, SWATCHES, Spinner } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import type { ProductRow, Tag as ProductTag } from '@/app/products/_types'
import styles from './styles.module.css'

/**
 * The tagging surface for a grid selection.
 *
 * Replaces a `Menu` whose only entry was "No tags yet", disabled — with zero tags in the
 * database there was no way to create the first one, so tagging was unreachable rather than
 * imperfect.
 *
 * The design problem worth naming is what a checkbox MEANS across a multi-row selection. Select
 * five products where three carry "Clearance": the tag is neither on nor off. A two-state box
 * has to pick a lie, and whichever it picks, clicking Apply writes that lie to the other two.
 * So each row is genuinely tri-state — on / off / mixed — and only the rows you actually touch
 * are sent. Tags you never click are left exactly as they were on every product.
 */

export type TagState = 'on' | 'off' | 'mixed'

export interface TagDialogProps {
  open: boolean
  onClose: () => void
  /** The rows the operator selected — used for the counts and the family cascade. */
  selection: ProductRow[]
  /** Every tag that exists, so the list is not limited to what the current page happens to show. */
  allTags: ProductTag[]
  /** Applied after a successful write, so the caller can refetch and re-toast. */
  onApplied: (summary: { added: number; removed: number; products: number }) => void
  onTagsChanged: () => void
}

export function TagDialog({ open, onClose, selection, allTags, onApplied, onTagsChanged }: TagDialogProps) {
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<Record<string, TagState>>({})
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<string>(SWATCHES[0].hex)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // How many variations ride along. Only parents contribute — a variation has none of its own,
  // so the count is the honest number of extra rows the write will touch.
  const childCount = useMemo(
    () => selection.filter((r) => r.parentId === null).reduce((n, r) => n + (r.childCount ?? 0), 0),
    [selection],
  )
  const [includeChildren, setIncludeChildren] = useState(true)

  /** The state each tag is ACTUALLY in across the selection, before any edits. */
  const initial = useMemo(() => {
    const map: Record<string, TagState> = {}
    for (const tag of allTags) {
      const hits = selection.filter((r) => (r.tags ?? []).some((t) => t.id === tag.id)).length
      map[tag.id] = hits === 0 ? 'off' : hits === selection.length ? 'on' : 'mixed'
    }
    return map
  }, [allTags, selection])

  // Reopening must not inherit the last visit's edits — but this must run ONCE per open, not
  // whenever `initial` changes. Creating a tag refreshes the tag list, which recomputes
  // `initial`, which re-ran this and wiped the pre-tick the create had just set: the tag
  // appeared in the list, unchecked, under "No changes yet". A ref rather than a dep because
  // "has this open been initialised" is not something the value of `initial` can express.
  const initialisedRef = useRef(false)
  useEffect(() => {
    if (!open) {
      initialisedRef.current = false
      return
    }
    if (initialisedRef.current) return
    initialisedRef.current = true
    setDraft(initial)
    setSearch('')
    setCreating(false)
    setNewName('')
    setError(null)
    setIncludeChildren(true)
  }, [open, initial])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? allTags.filter((t) => t.name.toLowerCase().includes(q)) : allTags
  }, [allTags, search])

  // A mixed tag has a third meaning available — "apply to all" — so its first click resolves
  // UP rather than toggling to off. Getting the rest of the selection tagged is what someone
  // clicking a half-filled box almost always wants.
  const cycle = useCallback((id: string) => {
    setDraft((prev) => {
      const cur = prev[id] ?? 'off'
      return { ...prev, [id]: cur === 'on' ? 'off' : 'on' }
    })
  }, [])

  const changes = useMemo(() => {
    const add: string[] = []
    const remove: string[] = []
    for (const tag of allTags) {
      const was = initial[tag.id] ?? 'off'
      const now = draft[tag.id] ?? was
      if (now === was) continue
      if (now === 'on') add.push(tag.id)
      if (now === 'off') remove.push(tag.id)
    }
    return { add, remove }
  }, [allTags, initial, draft])

  const dirty = changes.add.length > 0 || changes.remove.length > 0

  const createTag = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color: newColor }),
      })
      if (res.status === 409) {
        // Names are globally unique. An error here would be technically correct and useless —
        // the tag they want exists, so point at it instead of refusing.
        setError(`"${name}" already exists — find it in the list above.`)
        setSearch(name)
        setCreating(false)
        return
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      const tag = (await res.json()) as ProductTag
      // Pre-check the new tag: creating one from inside this dialog only ever means "and put it
      // on what I have selected".
      setDraft((prev) => ({ ...prev, [tag.id]: 'on' }))
      setNewName('')
      setCreating(false)
      onTagsChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the tag')
    } finally {
      setBusy(false)
    }
  }, [newName, newColor, onTagsChanged])

  const apply = useCallback(async () => {
    if (!dirty) return
    setBusy(true)
    setError(null)
    const ids = selection.map((r) => r.id)
    try {
      // Two calls at most, and only for the direction that actually changed. Tags left alone
      // are never sent, which is what stops a bulk edit from flattening the rows it did not
      // mean to touch.
      for (const [mode, tagIds] of [['add', changes.add], ['remove', changes.remove]] as const) {
        if (tagIds.length === 0) continue
        const res = await fetch(`${getBackendUrl()}/api/products/bulk-tag`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: ids, tagIds, mode, includeChildren }),
        })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      }
      onApplied({
        added: changes.add.length,
        removed: changes.remove.length,
        products: ids.length + (includeChildren ? childCount : 0),
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not apply the tags')
    } finally {
      setBusy(false)
    }
  }, [dirty, selection, changes, includeChildren, childCount, onApplied, onClose])

  const noun = selection.length === 1 ? 'product' : 'products'

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Tag products"
      subtitle={`${selection.length} ${noun} selected`}
      footer={
        <div className={styles.tagFoot}>
          <span className={styles.tagFootNote}>
            {dirty
              ? `${changes.add.length} to add · ${changes.remove.length} to remove`
              : 'No changes yet'}
          </span>
          <span className={styles.tagFootActions}>
            <Button size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={() => void apply()} disabled={!dirty || busy}>
              {busy ? <Spinner size={13} /> : null} Apply
            </Button>
          </span>
        </div>
      }
    >
      <div className={styles.tagBody}>
        <Input
          leadingIcon={<Search size={13} style={{ color: 'var(--nds-text-3)' }} />}
          placeholder="Search tags…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search tags"
        />

        <div className={styles.tagList} role="group" aria-label="Tags">
          {visible.length === 0 && (
            <p className={styles.tagEmpty}>
              {allTags.length === 0
                ? 'No tags exist yet. Create the first one below.'
                : `No tag matches "${search}".`}
            </p>
          )}
          {visible.map((tag) => {
            const state = draft[tag.id] ?? 'off'
            return (
              <label key={tag.id} className={styles.tagRow}>
                <Checkbox
                  checked={state === 'on'}
                  // `mixed` is a real third value in ARIA and the only honest one here.
                  ref={(el) => { if (el) el.indeterminate = state === 'mixed' }}
                  onChange={() => cycle(tag.id)}
                  aria-label={tag.name}
                />
                <span className={styles.tagDot} style={{ background: tag.color ?? 'var(--nds-text-3)' }} />
                <span className={styles.tagName}>{tag.name}</span>
                {state === 'mixed' && <span className={styles.tagMixed}>on some</span>}
              </label>
            )
          })}
        </div>

        {creating ? (
          <div className={styles.tagCreate}>
            <Input
              autoFocus
              placeholder="Tag name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createTag() }}
              aria-label="New tag name"
            />
            <ColorSwatchPicker value={newColor} onChange={setNewColor} ariaLabel="Tag colour" />
            <span className={styles.tagCreateActions}>
              <Button size="sm" onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
              <Button size="sm" variant="primary" onClick={() => void createTag()} disabled={!newName.trim() || busy}>
                Create
              </Button>
            </span>
          </div>
        ) : (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={13} /> New tag
          </Button>
        )}

        {childCount > 0 && (
          <label className={styles.tagCascade}>
            <Checkbox
              checked={includeChildren}
              onChange={(e) => setIncludeChildren(e.target.checked)}
              aria-label="Also tag variations"
            />
            <span>
              Also tag <b>{childCount}</b> {childCount === 1 ? 'variation' : 'variations'}
              <span className={styles.tagCascadeWhy}>
                {' '}— so the tag is still there when you filter inside the family
              </span>
            </span>
          </label>
        )}

        {error && <p className={styles.tagError} role="alert">{error}</p>}
      </div>
    </Modal>
  )
}

export { TagIcon }
