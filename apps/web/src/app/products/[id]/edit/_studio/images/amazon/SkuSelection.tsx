'use client'
import { useState } from 'react'
import { Search } from 'lucide-react'
import { groupAmazonItems, type AmazonMediaItem } from '@nexus/shared/amazon-media'
import { Field } from '@/design-system/components'
import { Button, Checkbox, Input, Select, Tag } from '@/design-system/primitives'
import styles from './media.module.css'

export const amazonAxisLabel = (axis: string) => axis.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase())

/** Selection is explicit and retained when search or the grouping axis changes. */
export function SkuSelection({ items, selected, onChange, defaultAxis = '', disabled = false }: {
  items: AmazonMediaItem[]; selected: string[]; onChange(ids: string[]): void; defaultAxis?: string; disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const [axis, setAxis] = useState(defaultAxis)
  const [parents, setParents] = useState(items.some(i => i.parent && selected.includes(i.id)))
  const axes = [...new Set(items.flatMap(i => Object.keys(i.attributes)))]
  const matching = items.filter(i => (parents || !i.parent) && `${i.sku} ${i.label} ${Object.values(i.attributes).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  const groups = groupAmazonItems(matching, axes.includes(axis) ? axis : '')
  const hidden = selected.filter(id => !matching.some(i => i.id === id)).length
  const toggle = (ids: string[], checked: boolean) => onChange(checked ? [...new Set([...selected, ...ids])] : selected.filter(id => !ids.includes(id)))
  return <div className={styles.selectionList}>
    <Input aria-label="Search target SKUs and variations" placeholder="Search SKU or variation" leadingIcon={<Search size={16} />} value={query} disabled={disabled} onChange={e => setQuery(e.target.value)} />
    {axes.length > 0 && <Field label="Group target SKUs by"><Select value={axes.includes(axis) ? axis : ''} disabled={disabled} onChange={e => setAxis(e.target.value)}>
      <option value="">All SKUs</option>{axes.map(a => <option key={a} value={a}>{amazonAxisLabel(a)}</option>)}
    </Select></Field>}
    {items.some(i => i.parent) && <Checkbox label="Show parent listings" checked={parents} disabled={disabled} onChange={e => setParents(e.target.checked)} />}
    <div className={styles.actions}>
      <Button size="sm" disabled={disabled || !matching.length} onClick={() => toggle(matching.map(i => i.id), true)}>Select matching ({matching.length})</Button>
      <Button size="sm" disabled={disabled || !selected.length} onClick={() => onChange([])}>Clear selection</Button>
      <Tag>{selected.length} selected</Tag>
    </div>
    {hidden > 0 && <p role="status" className={styles.note}>{hidden} selected {hidden === 1 ? 'SKU is' : 'SKUs are'} outside the current filter and will still be included.</p>}
    <div className={styles.targetList}>
      {groups.map(group => {
        const count = group.items.filter(i => selected.includes(i.id)).length
        return <section key={group.label}>
          <Checkbox label={`${group.label} · ${count}/${group.items.length}`} disabled={disabled} checked={count === group.items.length}
            ref={element => { if (element) element.indeterminate = count > 0 && count < group.items.length }}
            onChange={e => toggle(group.items.map(i => i.id), e.target.checked)} />
          {group.items.map(item => <div key={item.id} className={styles.targetItem}>
            <Checkbox label={item.sku || item.label} disabled={disabled} checked={selected.includes(item.id)} onChange={e => toggle([item.id], e.target.checked)} />
            <span className={styles.note}>{Object.entries(item.attributes).map(([key, value]) => `${amazonAxisLabel(key)}: ${value}`).join(' · ')}</span>
          </div>)}
        </section>
      })}
      {!matching.length && <p>No matching SKUs.</p>}
    </div>
  </div>
}
