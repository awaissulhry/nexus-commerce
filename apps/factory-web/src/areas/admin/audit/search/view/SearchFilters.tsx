'use client'

import { useEffect, useState } from 'react'
import { Globe } from 'lucide-react'
import { Input } from '@nexus/ui/primitives'
import { DateRangePicker } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { looksLikeAddress } from '../../../security/events/model'
import { daysOf, rangeOf } from '../model'

/**
 * The audit table's W2b filters (SCR-018 inline sec:table#1, B-W2b-413): an address typed (applied on Enter or leaving the
 * field; matched through the sessions signed in from it) and the window between two days (DS DateRangePicker). Words
 * `admin-security-depth` (`search.*`). Fetches nothing.
 */
export function IpField({ value, onApply }: { value: string | null; onApply?: (ip: string | null) => void }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <Ip value={value} onApply={onApply} />
    </WithMessages>
  )
}

function Ip({ value, onApply }: { value: string | null; onApply?: (ip: string | null) => void }) {
  const t = useT('admin-security-depth')
  const [typed, setTyped] = useState(value ?? '')
  useEffect(() => setTyped(value ?? ''), [value])
  const bad = typed.trim() !== '' && !looksLikeAddress(typed)
  const apply = () => {
    const next = typed.trim()
    if (next === (value ?? '') || bad) return
    onApply?.(next === '' ? null : next)
  }
  return (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Globe size={14} aria-hidden />}
      aria-label={t('search.ip.label')}
      aria-invalid={bad || undefined}
      title={bad ? t('search.ip.bad') : t('search.ip.hint')}
      placeholder={t('search.ip.placeholder')}
      value={typed}
      onChange={(event) => setTyped(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') apply()
      }}
      onBlur={apply}
    />
  )
}

export function RangeField({ from, to, onChange }: { from: string | null; to: string | null; onChange?: (range: { from: string; to: string }) => void }) {
  const days = daysOf(from, to, new Date())
  return <DateRangePicker value={days} onChange={(next) => onChange?.(rangeOf(next.start, next.end))} />
}
