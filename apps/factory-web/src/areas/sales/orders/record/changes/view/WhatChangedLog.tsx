'use client'

import { useState } from 'react'
import { SegmentedControl } from '@nexus/ui/primitives'
import type { ReadOrderLog } from '../../../../../../lib/change-log/api'
import { useChangeLog } from '../../../../../../lib/change-log/use-change-log'
import { ChangeLog } from '../../../../../../lib/change-log/view/ChangeLog'
import { useDepartments } from '../../../../../../lib/department/use-departments'
import { useFlowWords } from '../../flow-words'
import { LOG_CHIPS, logChipCounts, rowsOfChip, type LogChip } from '../log-chips'

/**
 * owb-of6 step 2 (design plan § 5l, § 5zl "one icon for each kind of change") — "What changed" as the ONE order log (the base's
 * `GET /sales/orders/:id/log`, office face: names, before → after, why; history only through the base's allow-list): the chips All ·
 * Asks · Lines · Dates · Design · Status over the rows read, then the base's ChangeLog view (its "Load more", its icons). The log holds
 * no amount at all (its values are words, days, counts, states): a money step is a row in words for every reader. Draws its port.
 */
export function WhatChangedLog({ read }: { readonly read: ReadOrderLog }) {
  const f = useFlowWords()
  const { state, onMore, onRetry } = useChangeLog(read)
  const { departments } = useDepartments(null)
  const [chip, setChip] = useState<LogChip>('all')
  const counts = logChipCounts(state.rows)
  const rows = rowsOfChip(state.rows, chip)
  return (
    <>
      {state.rows.length > 0 ? (
        <div className="fw-oc-chips">
          <SegmentedControl size="sm" ariaLabel={f('log.chipsLabel')} value={chip} onChange={(value) => setChip(value as LogChip)} options={LOG_CHIPS.map((value) => ({ value, label: `${f(`log.chips.${value}`)} ${counts[value]}` }))} wrap />
        </div>
      ) : null}
      {state.rows.length > 0 && rows.length === 0 ? <p className="fw-pt-quiet">{f('log.emptyChip')}</p> : <ChangeLog model={{ rows, status: state.status, more: state.more, departments, picture: null }} actions={{ onMore, onRetry }} />}
    </>
  )
}
