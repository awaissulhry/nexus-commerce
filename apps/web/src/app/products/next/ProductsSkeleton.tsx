import styles from './styles.module.css'

/**
 * Shimmer placeholder shown in the grid while the INITIAL product list is still
 * loading (data == null). Without it, a slow/cold first fetch briefly flashes
 * the "No products match this filter." empty state, which reads as broken.
 * Once data has arrived, the grid shows rows (or the real empty message).
 */
export function ProductsSkeleton() {
  return (
    <div className={styles.gridSkel} role="status" aria-label="Loading products">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className={styles.gridSkelRow}>
          <div className={styles.gridSkelThumb} />
          <div className={styles.gridSkelText}>
            <div className={styles.gridSkelBar} style={{ width: '40%' }} />
            <div className={styles.gridSkelBar} style={{ width: '22%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
