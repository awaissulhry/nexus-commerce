'use client'

import { Tag } from '@nexus/ui/primitives'
import type { ProfileRow } from '../../api'
import { useExtras } from '../../photos/words'
import { rangeTone, rangeWords } from '../model'

/**
 * The made-to-measure list's own parts (B-W2b-371, XF2:03): the row's certified range (Inside · Outside with its points · Not
 * checked, in words with its tone, never colour alone). F-SA-224: the customer filter is the Sales lists' one Customer switcher
 * (areas/sales/_shared/customer-switcher). Fetches nothing.
 */
export function RangeCell({ range }: { range: ProfileRow['range'] }) {
  const { t, say } = useExtras()
  return (
    <span title={t('list.range.hint')}>
      <Tag tone={rangeTone(range)}>{say(rangeWords(range))}</Tag>
    </span>
  )
}
