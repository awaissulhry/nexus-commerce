'use client'

/**
 * Shared stock plan step 5 — "who owns this pool" beside a stock number (stock page, stock drawer,
 * product list). The number next to it is this business's OWN stock; a product that sells from another
 * business's pool shows that pool here, labelled, never added to its own (one source at a time).
 */
import type { ReactNode } from 'react'
import { Pill } from '@/design-system/primitives'
import styles from './PoolSourceTag.module.css'

export interface PoolSourceView {
  lenderName: string
  available: number
  /** A parent row: how many of its variations sell from a pool. */
  products?: number
}

export function poolSourceSentence(source: PoolSourceView): string {
  const which = source.products && source.products > 1 ? `${source.products} variations sell` : 'Sells'
  return `${which} from ${source.lenderName}'s shared stock: ${source.available.toLocaleString()} available there.`
}

export function PoolSourceTag({ source }: { source: PoolSourceView }) {
  return <span className={styles.tag}>
    <Pill tone="info">Shared stock</Pill>
    <span className={styles.text}>{source.available.toLocaleString()} available · {source.lenderName}</span>
  </span>
}

/** A narrow table cell's form: "10 shared", the lender named for screen readers (the drawer says it in full). */
export function PoolSourceCompact({ source }: { source: PoolSourceView }) {
  return <span className={styles.compact}>
    {source.available.toLocaleString()} shared
    <span className={styles.srOnly}> — {poolSourceSentence(source)}</span>
  </span>
}

/** A stock number with the pool it sells from under it (only when there is one). */
export function WithPoolSource({ source, compact, children }: { source?: PoolSourceView | null; compact?: boolean; children: ReactNode }) {
  if (!source) return <>{children}</>
  return <span className={styles.stack}>{children}{compact ? <PoolSourceCompact source={source} /> : <PoolSourceTag source={source} />}</span>
}

/** The drawer's line: the tag and the sentence, and what the listings follow. */
export function PoolSourceNote({ source }: { source: PoolSourceView }) {
  return <div className={styles.note}>
    <PoolSourceTag source={source} />
    <span>{poolSourceSentence(source)} Its listings follow that stock, not this business's own numbers.</span>
  </div>
}

/** A lender's view: one business that sells from this business's lent stock (stock-pool/lent-usage.ts). */
export interface LentUsageView {
  workspaceId: string
  businessName: string
  heldNow: number
  sold30d: number
  putBack30d: number
}

export function lentUsageSentence(usage: LentUsageView): string {
  const parts = [`${usage.heldNow.toLocaleString()} held for its open orders`, `${usage.sold30d.toLocaleString()} sold in the last 30 days`]
  if (usage.putBack30d) parts.push(`${usage.putBack30d.toLocaleString()} put back`)
  return `${usage.businessName}: ${parts.join(', ')}.`
}

/** The lender's drawer: who sells from this stock, and how much. Nothing when no one does. */
export function LentUsageNote({ usage }: { usage: LentUsageView[] }) {
  if (!usage.length) return null
  return <div className={styles.note}>
    <Pill tone="neutral">Lent stock</Pill>
    <ul className={styles.lentList}>{usage.map((row) => <li key={row.workspaceId}>{lentUsageSentence(row)}</li>)}</ul>
  </div>
}

/** A hold made for another business's order: whose, and why it has no Release here. */
export function HeldForNote({ usedBy }: { usedBy: { businessName: string; orderRef: string | null } }) {
  return <div className={styles.usedBy}>
    For {usedBy.businessName}{usedBy.orderRef ? ` · order ${usedBy.orderRef}` : ''}. Released when that order ships or is cancelled there.
  </div>
}

/** A movement made for another business: which one, and its order. */
export function MovementUsedBy({ usedBy }: { usedBy?: { businessName: string; orderRef: string | null } | null }) {
  if (!usedBy) return null
  return <div className={styles.usedBy}>For {usedBy.businessName}{usedBy.orderRef ? ` · order ${usedBy.orderRef}` : ''}</div>
}
