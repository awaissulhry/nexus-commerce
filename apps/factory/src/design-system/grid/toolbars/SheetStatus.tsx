'use client'

import { Pill } from '../../primitives/Pill'
import { InfoTip } from '../../primitives/InfoTip'
export interface SheetStatus {
  tone: 'neutral' | 'info' | 'warning' | 'danger'
  label: string
  detail?: string
}
export interface SheetStatusesProps { status?: readonly SheetStatus[]; compact?: boolean }
const showDetail = () => {} // InfoTip opens on the real pill button’s focus, including touch clicks.
function Status({ item }: { item: SheetStatus }) {
  const pill = <Pill tone={item.tone} size="md" onClick={item.detail != null ? showDetail : undefined}
    aria-label={item.detail != null ? `${item.label}. ${item.detail}` : undefined}>{item.label}</Pill>
  return <span role={item.tone === 'danger' ? 'alert' : undefined}>
    {item.detail != null ? <InfoTip tip={item.detail}>{pill}</InfoTip> : pill}
  </span>
}
/** At most three visible marks. Every surplus sentence remains keyboard reachable. */
export function SheetStatuses({ status = [], compact = false }: SheetStatusesProps) {
  const overflow = compact ? status : status.length > 3 ? status.slice(2) : []
  const visible = compact ? [] : overflow.length ? status.slice(0, 2) : status
  return <span className="nds-sheet-statuses">
    {visible.map((item, i) => <Status key={i} item={item} />)}
    {overflow.length > 0 && <Status item={{ tone: 'neutral', label: `+${overflow.length}`, detail: overflow.map(s => `${s.label}${s.detail != null ? `. ${s.detail}` : ''}`).join('; ') }} />}
    {overflow.some(s => s.tone === 'danger') && <span role="alert" className="nds-vh">{overflow.filter(s => s.tone === 'danger').map(s => `${s.label}${s.detail != null ? `. ${s.detail}` : ''}`).join('; ')}</span>}
  </span>
}
