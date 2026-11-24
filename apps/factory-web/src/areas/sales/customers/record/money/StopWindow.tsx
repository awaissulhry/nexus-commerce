'use client'

import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { ReminderDepth } from '../../../../finance/receivables/reminder-stops/ReminderDepth'
import { CM } from './model'
import type { StopAsk } from './use-money-windows'

/**
 * F-CM-201 (customer page › MONEY tab, cm-w2 W2.1; 13-backend §4.2; 10-design §6 "Promise to pay / dispute…") — Finance's OWN stop
 * container (`ReminderDepth`: the stops in force on this invoice with Lift…, "Stop reminders of an invoice", the trusted level — it reads
 * and writes itself, with its own words, its own fresh-code window and its own stylesheet) in ONE centred window titled "Stop reminders
 * of FT-2026-00041". Nothing of it is redrawn: the window is its host, handed this customer and this invoice. Opened only with
 * receivables.reminders.manage (the row's ⋯ offers it only then); a move → the tab's burst.
 */
export function StopWindow({ partyId, ask, onClose, onChanged }: { partyId: string; ask: StopAsk; onClose: () => void; onChanged: () => void }) {
  const t = useT(CM)
  const o = useT('orders')
  const invoice = ask.invoice
  return (
    <Modal
      open
      size="md"
      onClose={onClose}
      title={t('cm.collect.stopTitle', { invoice: invoice.number ?? '—' })}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={onClose}>
            {o('common.done')}
          </Button>
        </>
      }
    >
      <ReminderDepth reminder={{ customer: { id: partyId }, invoices: [{ id: invoice.id, number: invoice.number, issueDate: null, dueDate: invoice.dueDate }], status: 'PREPARED' /* cm-fx1: no `trusted` — none read here; ReminderDepth says null itself */ }} onChanged={onChanged} />
    </Modal>
  )
}
