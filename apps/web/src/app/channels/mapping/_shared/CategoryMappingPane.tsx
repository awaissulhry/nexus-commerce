'use client'

import Link from '@/lib/workspaces/Link'
import { Button } from '@/design-system/primitives'
import { categoryHref } from '@/app/catalog/categories/api'
import styles from '../mapping.module.css'

interface Props { channel: string; code: string; open: boolean; onOpenChange: (open: boolean) => void; onApplied: () => void | Promise<void> }

/** Category assignments have one shared editor, reached with this mapping scope preserved. */
export function CategoryMappingPane({ channel, code }: Props) {
  return <div className={styles.railFoot}>
    <div className={styles.railFootHead}>Category assignments</div>
    <div className={styles.railFootBody}>Manage how your categories map to {channel} · {code}.</div>
    <Button asChild size="xs" variant="link"><Link href={categoryHref('assignments', { channel, market: code })}>Manage categories</Link></Button>
  </div>
}
