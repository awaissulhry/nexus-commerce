import type { TransferCell } from '@nexus/shared/catalog-transfer'
import type { Column } from '@/design-system/components/DataGrid'
import { AsOf } from '@/design-system/components/AsOf'
import { Tag } from '@/design-system/primitives/Tag'
import styles from './transfer.module.css'

const display = (value: unknown) => value == null ? 'Empty' : typeof value === 'string' ? value || 'Empty text' : JSON.stringify(value)

/** CFI — the fields a channel file adds beside ordinary attributes, named for the Owner. */
const CHANNEL_FILE_LABELS: Record<string, string> = { presence: 'Listing on the channel', price: 'Price', sale: 'Sale price', sellerSku: 'Channel SKU' }
const money = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : display(value)
type Sale = { value: number | null; start: string | null; end: string | null }
const isSale = (value: unknown): value is Sale => !!value && typeof value === 'object' && 'value' in value && 'start' in value && 'end' in value
function saleText(value: unknown) {
  if (!isSale(value)) return display(value)
  if (value.value === null) return 'No sale'
  return `${money(value.value)} · ${value.start ?? 'no start date'} to ${value.end ?? 'no end date'}`
}
/** A channel-file value in words; `undefined` = no special rendering (the generic one applies). */
export function channelFileValue(c: TransferCell, value: unknown): string | undefined {
  if (c.entity === 'Listings' && c.field === 'presence') return value === 'ENDED' ? 'Listing ended on the channel' : value == null ? 'Listed' : display(value)
  if (c.entity === 'Overrides' && c.field === 'price') return value == null ? 'Follows the master price' : money(value)
  if (c.entity === 'Overrides' && c.field === 'sale') return value == null ? 'No sale' : saleText(value)
  return undefined
}

/**
 * CFI-8 — what the channel held at its last read. An absent read is "not read yet", never a
 * claimed match; shared (master) values have no channel value at all.
 */
export function ChannelReadCell({ cell }: { cell: TransferCell }) {
  if (cell.entity === 'Products') return <span className={styles.secondary}>Not a channel value</span>
  const read = cell.channelRead
  if (!read) return <span className={styles.secondary}>Not read yet</span>
  if (!read.differs) return <div className={styles.cell}>Same as Nexus at the last read<span className={styles.secondary}>read <AsOf at={read.readAt} via={read.source} /></span></div>
  return <div className={styles.cell}>{channelFileValue(cell, read.value) ?? display(read.value)}<span className={styles.secondary}>read <AsOf at={read.readAt} via={read.source} /></span></div>
}

/** Stored values and inheritance remain separate in the review, even when their effective values match. */
export function previewColumns(accounts: { id: string; displayName: string | null }[], listings: { channel: string; accountId: string; marketplace: string; aliasKey: string; aliasLabel?: string }[] = [], historical = false): Column<TransferCell>[] {
  const alias = (c: TransferCell) => listings.find(l => l.channel === c.channel && l.accountId === c.accountId && l.marketplace === c.marketplace && l.aliasKey === c.aliasKey)?.aliasLabel ?? (c.aliasKey || 'Primary listing')
  return [
    {
      key: 'product', label: 'Product / scope', width: 210,
      render: c => <div className={styles.cell}>
        <strong>{c.sku}</strong>
        {c.fileSku && c.fileSku !== c.sku && <span className={styles.secondary}>File SKU: {c.fileSku}</span>}
        <span className={styles.secondary}>{c.entity === 'Products'
          ? `Master${c.locale ? ` · ${c.locale}` : ''}`
          : `${c.channel} · ${c.marketplace} · ${accounts.find(a => a.id === c.accountId)?.displayName ?? c.accountId} · ${alias(c)}`}</span>
        {c.origin === 'channel-file' && <Tag tone="info">From the channel file</Tag>}
      </div>,
    },
    { key: 'field', label: 'Attribute', width: 180, render: c => <div className={styles.cell}>{c.label ?? (c.entity === 'Products' && c.field === 'parentSku' ? 'Parent SKU' : c.origin === 'channel-file' && CHANNEL_FILE_LABELS[c.field] ? CHANNEL_FILE_LABELS[c.field] : c.field)}{c.source && <span className={styles.secondary}>{[c.source.file, c.source.sheet, `${c.source.column ?? 'Row '}${c.row}`].filter(Boolean).join(' · ')}</span>}</div> },
    { key: 'before', label: historical ? 'Value before import' : 'Current value', width: 240, render: c => <div className={styles.cell}>{c.entity === 'Products' && c.field === 'parentSku' ? c.before ? `Parent: ${String(c.before)}` : 'No parent'
      : c.effectiveBefore ? <>{display(c.effectiveBefore.value)}<span className={styles.secondary}>{c.effectiveBefore.source}</span></>
      : c.clearIfPresent ? <>{display(c.before)}<span className={styles.secondary}>What Nexus holds for this market now</span></>
      : c.beforeState === 'inherited' ? <span className={styles.secondary}>No stored override · resolved value unavailable</span> : channelFileValue(c, c.before) ?? display(c.before)}</div> },
    { key: 'after', label: historical ? 'Reviewed value' : 'Proposed value', width: 240, render: c => <div className={styles.cell}><Tag>{c.action}</Tag>{c.entity === 'Products' && c.field === 'parentSku'
      ? c.after ? `Child of ${String(c.after)}` : c.before ? 'Unlink from parent' : 'Keep without a parent'
      : c.clearIfPresent && c.action === 'CLEAR' ? <>Removed on the channel — will be cleared<span className={styles.secondary}>The file&apos;s full update leaves this blank, so Amazon removes it</span></>
      : c.effectiveAfter ? <>{display(c.effectiveAfter.value)}<span className={styles.secondary}>{c.effectiveAfter.source}</span></>
      : c.afterState === 'inherited' ? <span className={styles.secondary}>Use inherited value · resolved value unavailable</span> : channelFileValue(c, c.after) ?? display(c.after)}
      {c.entity === 'Overrides' && (c.field === 'price' || c.field === 'sale') && c.origin === 'channel-file' && <span className={styles.secondary}>Recorded in Nexus only · not sent to the channel</span>}
      {c.entity === 'Listings' && c.field === 'presence' && c.after === 'ENDED' && <span className={styles.secondary}>Marked ended in Nexus only · nothing is sent</span>}</div> },
    { key: 'channel', label: 'On the channel', width: 220, render: c => <ChannelReadCell cell={c} /> },
  ]
}
