'use client'

/**
 * The product column of the Rules & Automation tables (grid audit E12): ONE cell for Keyword Harvest (Sources, Terms)
 * and Negative Targeting (Wasting, Stopped), which drew it three ways. The product's name as a link that takes a second
 * line before it is cut, the whole name on hover; a shared campaign's "2 products" in muted words; the engine's blank
 * when there is none. Enter follows the link: the column sets `entityLinksKeys`.
 */
import { EmptyValue, keepFromGrid } from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import styles from './productCell.module.css'

/** A name as a link that takes a second line before it is cut (re-audit S14); the whole name on hover. */
export function TwoLineLink({ name, href }: { name: string; href?: string | null }) {
  return (
    <span className={styles.cell} onClickCapture={keepFromGrid}>
      {href
        ? <Link href={href} className={`nds-entitylink ${styles.clamp2}`} title={name}>{name}</Link>
        : <span className={styles.clamp2} title={name}>{name}</span>}
    </span>
  )
}

/** The product; else the products a shared campaign holds (`count` above 1); else the engine's blank. */
export function ProductCell({ product, count = 0 }: { product: { name: string; href?: string | null } | null | undefined; count?: number }) {
  if (product) return <TwoLineLink name={product.name} href={product.href} />
  if (count > 1) return <span className="nds-cell-muted" title={`A shared campaign: ${count} products`}>{count} products</span>
  return <EmptyValue />
}
