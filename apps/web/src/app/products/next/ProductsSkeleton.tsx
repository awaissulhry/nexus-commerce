import { Skeleton } from '@/design-system/primitives'
import styles from './styles.module.css'

/**
 * Shimmer placeholder shown in the grid while the INITIAL product list is still
 * loading (data == null). Without it, a slow/cold first fetch briefly flashes
 * the "No products match this filter." empty state, which reads as broken.
 * Once data has arrived, the grid shows rows (or the real empty message).
 *
 * The shimmer itself is the DS `Skeleton` — this file used to carry its own
 * `@keyframes` and a hand-picked grey, which pulsed on a different rhythm from
 * every other loading surface in the app.
 */
export function ProductsSkeleton() {
  return (
    <div className={styles.gridSkel} role="status" aria-label="Loading products">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className={styles.gridSkelRow}>
          <Skeleton width={40} height={40} radius={8} />
          <div className={styles.gridSkelText}>
            <Skeleton width="40%" height={11} />
            <Skeleton width="22%" height={11} />
          </div>
        </div>
      ))}
    </div>
  )
}
