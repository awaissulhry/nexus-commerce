'use client'

import { Card } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import { OrderFilesBody, type FilesViewActions } from '../../../../../lib/record-thread/files-view/view/FilesView'
import type { OrderFilesModel } from '../../../../../lib/record-thread/files-view/model'
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import type { Order } from '../../api'
import type { OrderRecordModel } from '../record-model'

/**
 * F-SA-237 (sales page plan N9, picks P14, R7; 10-order-page §2.7) — Files: every file of the order by where it comes from, the SAME
 * body as the thread's Files window on this order, from the SAME walled read (`GET /sales/orders/:orderId/files`): who can see each
 * file, where it sits, "also on …" as the read names it, Open through the order's own route, Open in the conversation (the dock shows
 * and scrolls to the message), Download N · Share N own; "N files you cannot open", counted, never named. F-OP-125–127: the files are
 * cards with lazy previews, and Open shows them in the ONE viewer the body draws from the page's container (← / → every file in display
 * order; body data only when asked, its opening recorded; Esc gives the focus back to the card; "Go to message" shows it in the dock).
 */
export function FilesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: { readonly files?: FilesViewActions } }) {
  const t = useT('orders')
  const frame = useRecordFrame()
  const files: OrderFilesModel = model.files ?? { read: null, problem: null, selected: [], canShare: false }
  const showMessage = (messageId: string) => {
    frame?.showThread?.()
    // The docked thread draws the message; scroll to it once it is there.
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
      target?.scrollIntoView({ block: 'center' })
      target?.focus()
    }, 120)
  }
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('files.title')}</h2>
      <OrderFilesBody model={files} party={order.party ? { name: order.party.legalName } : null} actions={{ ...actions?.files, onOrderMessage: showMessage }} />
    </Card>
  )
}
