'use client'

import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'

import { MEDIA_BOARD_EXTERNAL_TYPE, MediaCard, Menu, Listbox, type MenuItemDef } from '@/design-system/components'
import { Button, Input, Tag } from '@/design-system/primitives'

import { assetProblems, filterLibrary, languageName, versionsOf, type LibraryAsset, type LibraryFilter, type MediaRead } from './model'
import styles from './planPage.module.css'

/** Where "Add to" can put photos: a set of the edited layer, or one value's swatch. */
export interface AddTarget { id: string; label: string; group: 'Sets' | 'Swatches'; one?: boolean }

export interface LibraryPanelProps {
  read: MediaRead
  usage: Map<string, string[]>
  targets: AddTarget[]
  /** The target a set's ＋ asked for; the Add button then goes there. */
  pendingTarget: AddTarget | null
  onClearPending(): void
  onAdd(target: AddTarget, ids: string[]): void
  onOpen(asset: LibraryAsset): void
  onManage(): void
  /** Drag in progress: live refresh waits until it ends. */
  onDragging(on: boolean): void
  /** Photos cannot be dragged out of a drawer onto the page; there the Add button is the way. */
  draggable: boolean
  /** Keyboard: jump past the library (two Tab stops per photo) to the photo plan. */
  onSkip?(): void
  /** "Looks like …" / "Similar to …" (W4a/W4b): compare this photo with a look-alike. */
  onLookalike?(a: string, b: string, kind: 'same' | 'versions'): void
}

const FILTERS: Array<{ value: LibraryFilter; label: string }> = [
  { value: 'all', label: 'All photos' }, { value: 'unused', label: 'Not in any set' }, { value: 'used', label: 'In use' },
  { value: 'problems', label: 'Size or address problem' }, { value: 'text', label: 'Has text (language)' },
  { value: 'lookalikes', label: 'Looks like another photo' },
]

/** The family's photos (parent and children), searchable, with where each one is used (PLAN.md §5.1). */
export function LibraryPanel({ read, usage, targets, pendingTarget, onClearPending, onAdd, onOpen, onManage, onDragging, draggable, onSkip, onLookalike }: LibraryPanelProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<LibraryFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const shown = useMemo(() => filterLibrary(read, usage, filter, search), [read, usage, filter, search])
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(f => [f.value, filterLibrary(read, usage, f.value, '').length])), [read, usage])
  const picked = read.library.filter(a => selected.has(a.id)).map(a => a.id)

  const add = (target: AddTarget) => {
    if (!picked.length) return
    onAdd(target, target.one ? picked.slice(0, 1) : picked)
    setSelected(new Set())
    onClearPending()
  }
  const menu: MenuItemDef[] = (['Sets', 'Swatches'] as const).flatMap(group => {
    const list = targets.filter(t => t.group === group)
    return list.length ? [{ id: `h:${group}`, heading: true, label: group === 'Sets' ? 'Add to set' : 'Use as swatch (one photo)' },
      ...list.map(t => ({ id: t.id, label: t.label, disabled: !picked.length || (t.one === true && picked.length !== 1), onSelect: () => add(t) }))] : []
  })

  return <section className={styles.library} aria-label="Photo library">
    <header className={styles.libraryHead}>
      <h3 className={styles.sectionTitle}>Library · {read.library.length}</h3>
      <Button size="xs" variant="secondary" onClick={onManage}>Upload and edit…</Button>
    </header>
    {onSkip && read.library.length > 0 && <span className={styles.skip}><Button size="xs" variant="link" onClick={onSkip}>Skip to the photo plan</Button></span>}
    <div className={styles.libraryTools}>
      <Input size="sm" leadingIcon={<Search size={14} aria-hidden />} placeholder="Search photos" aria-label="Search photos" value={search} onChange={event => setSearch(event.target.value)} />
      <Listbox size="sm" ariaLabel="Show" value={filter} onChange={value => setFilter(value as LibraryFilter)}
        options={FILTERS.map(f => ({ value: f.value, label: f.label, trailing: String(counts[f.value] ?? 0) }))} />
    </div>
    {pendingTarget && <p className={styles.pending} role="status">
      Adding to <strong>{pendingTarget.label}</strong>: tick photos, then press Add.{' '}
      <Button size="xs" variant="link" onClick={onClearPending}>Cancel</Button>
    </p>}
    <div className={styles.libraryBar}>
      <span className={styles.muted}>{picked.length ? `${picked.length} selected` : `${shown.length} shown`}</span>
      {pendingTarget
        ? <Button size="xs" variant="primary" disabled={!picked.length} onClick={() => add(pendingTarget)}>Add {picked.length || ''} to {pendingTarget.label}</Button>
        : <Menu label="Add to ▾" items={menu} triggerProps={{ className: 'nds-btn xs', disabled: !picked.length, 'aria-label': 'Add the selected photos to a set' }} />}
      {picked.length > 0 && <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>}
    </div>
    {shown.length ? <ul className={styles.libraryGrid} aria-label="Library photos">
      {shown.map(asset => {
        const uses = usage.get(asset.id) ?? []
        const versions = versionsOf(read, asset.id)
        const problems = assetProblems(asset)
        const isSelected = selected.has(asset.id)
        return <li key={asset.id} className={styles.libraryItem} draggable={draggable}
          onDragStart={event => {
            const ids = isSelected ? picked : [asset.id]
            event.dataTransfer.setData(MEDIA_BOARD_EXTERNAL_TYPE, JSON.stringify(ids))
            event.dataTransfer.effectAllowed = 'copy'
            onDragging(true)
          }}
          onDragEnd={() => onDragging(false)}>
          <MediaCard compact src={asset.mediaType === 'VIDEO' ? null : asset.url} mediaType={asset.mediaType} label={asset.label}
            marker={uses.length ? 'In use' : undefined}
            selected={isSelected} onSelectedChange={on => setSelected(current => { const next = new Set(current); if (on) next.add(asset.id); else next.delete(asset.id); return next })}
            onPreview={() => onOpen(asset)}
            detail={<span className={styles.facts}>
              {asset.width && asset.height ? <span>{asset.width}×{asset.height}</span> : null}
              {asset.languageTag !== 'zxx' && <Tag tone="info">{versions.length > 1 ? versions.map(v => v.languageTag.toUpperCase()).join(' · ') : languageName(asset.languageTag)}</Tag>}
              {problems.map(p => <Tag key={p} tone="warning">{p}</Tag>)}
              {uses.slice(0, 2).map(u => <span key={u} className={styles.use}>{u}</span>)}
              {uses.length > 2 && <span className={styles.use}>+{uses.length - 2} more</span>}
              {onLookalike && asset.lookalikes?.slice(0, 1).map(other => {
                const name = read.library.find(x => x.id === other.id)?.label ?? 'another photo'
                return <Button key={other.id} size="xs" variant="link" onClick={() => onLookalike(asset.id, other.id, other.kind ?? 'same')}>
                  {other.kind === 'versions' ? `Similar to ${name} — language versions?` : `Looks like ${name}`}</Button>
              })}
            </span>} />
        </li>
      })}
    </ul> : <p className={styles.muted}>{read.library.length ? 'No photo matches.' : 'No photos yet. Use "Upload and edit…" to add some.'}</p>}
  </section>
}
