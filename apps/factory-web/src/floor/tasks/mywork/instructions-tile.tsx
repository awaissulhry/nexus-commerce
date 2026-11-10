'use client'

import { BookOpenCheck } from 'lucide-react'
import { FloorTile } from '@nexus/ui/floor'
import { formatNumber } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { NS } from '../instructions/model'

/**
 * My work's "New instructions N" (B-W2b-232, follow-up FI9:02; design floor.mywork "Two counts as chips: 'Messages 2' · 'New
 * instructions 1'. Each opens its list."): the second FloorTile of For your work, hidden at zero, beside Messages. Its count is the
 * versions waiting for the person's Seen (`GET /production/instructions/floor/mine` less those Seen on this tablet); it opens Spec &
 * instructions on its list "New for you".
 */
export function InstructionsTile({ count, onPress }: { count: number; onPress: () => void }) {
  const t = useT(NS)
  const locale = useLocale()
  if (count <= 0) return null
  return <FloorTile icon={<BookOpenCheck />} label={t('mywork.tile')} count={formatNumber(count, locale)} countLabel={t('mywork.tileCount', { count })} tone="primary" onPress={onPress} />
}
