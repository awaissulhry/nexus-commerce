'use client'

/**
 * A detail tab with nothing to show (design audit M12: "Effect" was one 16 px line in a 389 px body). The DS EmptyState —
 * an icon and one line — that fills what is left of the tab and centres in it, so the room the detail holds for its
 * tallest tab reads as meant, not as a gap.
 */
import type { ReactNode } from 'react'
import { EmptyState } from '@/design-system/components'
import styles from '../bid.module.css'

export function TabEmpty({ icon, title, description }: { icon: ReactNode; title: string; description?: string }) {
  return <EmptyState className={styles.tabEmpty} icon={icon} title={title} description={description} />
}
