'use client'

import { OrderChangeLog } from '../../../../lib/change-log/OrderChangeLog'
import type { ReadOrderLog } from '../../../../lib/change-log/api'
import { WindowShell } from '../../../../lib/window-shell/view/WindowShell'
import { usePageWords } from '../page-words'

/**
 * owb-po5.3 (plan § 5i, § 5l; design `changesWindow`) — "All changes" of an order or a request: the ONE change log (lib/change-log, S2's
 * part, mounted as it is) over the portal's log route (`orderLogReader(api, orderLogPath('portal', 'order' | 'request', id))`). Its faces
 * are the base's ONE allow-list: "The factory", "You", "your colleague" — never a worker, never an office note or reason. On the base's
 * window shell (centred, a sheet on a phone, Esc closes).
 */
export function AllChangesWindow({ open, onClose, name, read }: { open: boolean; onClose: () => void; name: string; read: ReadOrderLog | null }) {
  const t = usePageWords()
  return (
    <WindowShell open={open} onClose={onClose} title={t('changes.title')} subtitle={name} size="xl">
      {open ? <OrderChangeLog read={read} /> : null}
    </WindowShell>
  )
}
