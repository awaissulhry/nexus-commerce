/**
 * PES.1 — the studio's own route skeleton.
 *
 * 🔴 It has to exist. `edit/loading.tsx` is a Suspense boundary for the `edit` segment AND every
 * segment nested under it, and it draws the OLD page's shape — a max-width form column with a
 * thirteen-tab strip. Without this file the studio flashes a skeleton of the page it replaces.
 *
 * The shape drawn here is the frame's: two fixed bands over one full-height body.
 */

import { Skeleton } from '@/design-system/primitives'

import styles from '../_studio/studio.module.css'

export default function ProductStudioLoading() {
  return (
    <div className={styles.shell}>
      <div className={styles.bands}>
        <div className={styles.skelHeader}>
          <Skeleton width={72} height={13} />
          <Skeleton width={220} height={15} />
          <Skeleton width={110} height={13} />
        </div>
        <div className={styles.skelScope}>
          <Skeleton width={44} height={10} />
          <Skeleton width={92} height={28} radius="999px" />
          <Skeleton width={104} height={28} radius="999px" />
          <Skeleton width={86} height={28} radius="999px" />
        </div>
      </div>
      <div className={styles.body}>
        <div className={styles.tabBody}>
          <Skeleton width="100%" height="100%" />
        </div>
      </div>
    </div>
  )
}
