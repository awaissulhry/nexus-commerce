'use client'

import { useEffect, useMemo, useState } from 'react'
import type { MediaAsset } from '@nexus/shared/media-plan-channels'

import { Modal, SourceIndicator, Thumbnail } from '@/design-system/components'
import { Button, FilterChip, Tag } from '@/design-system/primitives'

import { SOURCE } from './DestinationsTable'
import { compareDestinations, destinationLabel, shownVersion, type CompareCell, type MediaDestinationRow, type MediaRead } from './model'
import styles from './planPage.module.css'

export interface CompareDialogProps {
  read: MediaRead
  assets: Map<string, MediaAsset>
  open: boolean
  /** The destinations ticked when the dialog opens. */
  initial: string[]
  onClose(): void
  onOpenDestination(key: string): void
}

/** "+2 · −1", "Other order" — how a cell differs from the first chosen destination. */
function difference(cell: CompareCell) {
  if (cell.reordered) return 'Other order'
  return [cell.added.length ? `+${cell.added.length}` : '', cell.missing.length ? `−${cell.missing.length}` : ''].filter(Boolean).join(' · ')
}

/**
 * Images rebuild P4 — Compare (PLAN.md §4.3, §5.1): tick two or more destinations; each set is one block, each chosen
 * destination one line, photos in position order so the same position lines up. Every line is compared with the first
 * destination that uses the set: its extra photos are outlined, the ones it lacks are named, and another order says so.
 * Each photo shows the version the destination's market sees (D6).
 */
export function CompareDialog({ read, assets, open, initial, onClose, onOpenDestination }: CompareDialogProps) {
  const targetable = read.destinations.filter(d => d.targetable)
  const [chosen, setChosen] = useState<string[]>(initial)
  // Each opening starts from its own choice; later reads of the page keep the ticks.
  useEffect(() => { if (open) setChosen(initial) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const picked = chosen.map(key => targetable.find(d => d.key === key)).filter((d): d is MediaDestinationRow => d !== undefined)
  const rows = useMemo(() => compareDestinations(read, chosen), [read, chosen])
  const differing = rows.filter(r => !r.same).length
  const toggle = (key: string) => setChosen(list => list.includes(key) ? list.filter(k => k !== key) : [...list, key])
  const name = (id: string) => assets.get(id)?.label ?? 'Photo'
  const openOne = (key: string) => { onClose(); onOpenDestination(key) }

  return <Modal open={open} onClose={onClose} size="xxl" title="Compare destinations"
    subtitle="Tick two or more. Each line is compared with the first destination that uses the set."
    footer={<Button size="sm" variant="primary" onClick={onClose}>Done</Button>}>
    <div className={styles.compareBody}>
      <div role="group" aria-label="Destinations to compare" className={styles.compareChips}>
        {targetable.map(d => <FilterChip key={d.key} pressed={chosen.includes(d.key)} onClick={() => toggle(d.key)}>{destinationLabel(d)}</FilterChip>)}
      </div>
      {picked.length < 2 ? <p className={styles.muted}>Tick two or more destinations to compare their photos.</p> : <>
        <p className={styles.muted} role="status">{differing === 0
          ? `Every set is the same in these ${picked.length} destinations.`
          : `${differing} of ${rows.length} set${rows.length === 1 ? '' : 's'} differ${differing === 1 ? 's' : ''}. Outlined photos are not in the first line of their set.`}</p>
        {rows.map(row => {
          const reference = picked[row.cells.findIndex(c => c.applies)]
          return <section key={row.ref} className={styles.compareSetBlock} aria-labelledby={`compare-${row.ref}`}>
            <header className={styles.compareSetHead}>
              <h4 id={`compare-${row.ref}`} className={styles.subTitle}>{row.label}</h4>
              {row.same ? <Tag tone="success">Same</Tag> : <Tag tone="warning">Differs</Tag>}
            </header>
            <ul className={styles.compareLines}>
              {picked.map((d, index) => {
                const cell = row.cells[index]
                const who = <span className={styles.compareWho}><Button size="xs" variant="link" onClick={() => openOne(d.key)}>{destinationLabel(d)}</Button></span>
                if (!cell?.applies) return <li key={d.key} className={styles.compareLine}>{who}
                  <span className={styles.muted}>{row.kind === 'safety' ? 'Amazon only' : 'Not used by this channel'}</span></li>
                const shift = cell.same ? null : difference(cell)
                return <li key={d.key} className={styles.compareLine}>
                  {who}
                  <span className={styles.compareCell}>
                    <span className={styles.cell}>
                      <SourceIndicator kind={SOURCE[cell.source].kind} label={`${row.label}: ${SOURCE[cell.source].text}`}
                        description={`${cell.items.length} photo${cell.items.length === 1 ? '' : 's'}.`} tabIndex={-1} />
                      {cell.items.length} photo{cell.items.length === 1 ? '' : 's'} · {SOURCE[cell.source].text}
                      {d === reference && <Tag tone="neutral">First line</Tag>}
                      {shift && <Tag tone="warning">{shift}</Tag>}
                    </span>
                    {cell.items.length ? <ol className={styles.previewStrip} aria-label={`${row.label} on ${destinationLabel(d)}`}>
                      {cell.items.map((id, n) => {
                        const shown = shownVersion(read, assets, id, d.languages)
                        const extra = cell.added.includes(id)
                        return <li key={`${id}:${n}`} className={extra ? styles.compareExtra : undefined}>
                          <Thumbnail src={assets.get(shown.id)?.url ?? null} alt={name(shown.id)}
                            title={`${n + 1}. ${name(shown.id)}${extra && reference ? ` · not in ${destinationLabel(reference)}` : ''}`} />
                        </li>
                      })}
                    </ol> : <span className={styles.muted}>No photos</span>}
                    {cell.missing.length > 0 && <span className={styles.muted}>Lacks {cell.missing.map(name).join(', ')}</span>}
                  </span>
                </li>
              })}
            </ul>
          </section>
        })}
      </>}
    </div>
  </Modal>
}
