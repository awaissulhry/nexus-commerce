import type { TransferCell } from '@nexus/shared/catalog-transfer'
import type { Column } from '@/design-system/components/DataGrid'
import { Tag } from '@/design-system/primitives/Tag'
import styles from './transfer.module.css'

const display = (value: unknown) => value == null ? 'Empty' : typeof value === 'string' ? value || 'Empty text' : JSON.stringify(value)

/** Stored values and inheritance remain separate in the review, even when their effective values match. */
export function previewColumns(accounts: { id: string; displayName: string | null }[], listings: { channel: string; accountId: string; marketplace: string; aliasKey: string; aliasLabel?: string }[] = [], historical = false): Column<TransferCell>[] {
  const alias = (c: TransferCell) => listings.find(l => l.channel === c.channel && l.accountId === c.accountId && l.marketplace === c.marketplace && l.aliasKey === c.aliasKey)?.aliasLabel ?? (c.aliasKey || 'Primary listing')
  return [
    {
      key: 'product', label: 'Product / scope', width: 210,
      render: c => <div className={styles.cell}>
        <strong>{c.sku}</strong>
        <span className={styles.secondary}>{c.entity === 'Products'
          ? `Master${c.locale ? ` · ${c.locale}` : ''}`
          : `${c.channel} · ${c.marketplace} · ${accounts.find(a => a.id === c.accountId)?.displayName ?? c.accountId} · ${alias(c)}`}</span>
      </div>,
    },
    { key: 'field', label: 'Attribute', width: 180, render: c => <div className={styles.cell}>{c.label ?? (c.entity === 'Products' && c.field === 'parentSku' ? 'Parent SKU' : c.field)}{c.source && <span className={styles.secondary}>{[c.source.file, c.source.sheet, `${c.source.column ?? 'Row '}${c.row}`].filter(Boolean).join(' · ')}</span>}</div> },
    { key: 'before', label: historical ? 'Value before import' : 'Current value', width: 240, render: c => <div className={styles.cell}>{c.entity === 'Products' && c.field === 'parentSku' ? c.before ? `Parent: ${String(c.before)}` : 'No parent'
      : c.effectiveBefore ? <>{display(c.effectiveBefore.value)}<span className={styles.secondary}>{c.effectiveBefore.source}</span></> : c.beforeState === 'inherited' ? <span className={styles.secondary}>No stored override · resolved value unavailable</span> : display(c.before)}</div> },
    { key: 'after', label: historical ? 'Reviewed value' : 'Proposed value', width: 240, render: c => <div className={styles.cell}><Tag>{c.action}</Tag>{c.entity === 'Products' && c.field === 'parentSku'
      ? c.after ? `Child of ${String(c.after)}` : c.before ? 'Unlink from parent' : 'Keep without a parent'
      : c.effectiveAfter ? <>{display(c.effectiveAfter.value)}<span className={styles.secondary}>{c.effectiveAfter.source}</span></> : c.afterState === 'inherited' ? <span className={styles.secondary}>Use inherited value · resolved value unavailable</span> : display(c.after)}</div> },
  ]
}
