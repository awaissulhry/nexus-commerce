'use client'

import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../i18n/ds-parts'
import { useT } from '../../../i18n/provider'

/**
 * "Leave with unsent text?" (T5-F10; picture 3 state "Leave with text"): Stay or Discard. Discard is never the default: Stay is
 * the primary button and takes the focus first; Stay brings the focus back to the box with the text as it was.
 */
export function LeaveDialog({ open, record, onStay, onDiscard }: { open: boolean; record: string; onStay: () => void; onDiscard: () => void }) {
  const t = useT('record-thread-composer')
  return (
    <Modal
      open={open}
      onClose={onStay}
      size="sm"
      title={t('leave.title')}
      footer={
        <>
          <Button size="sm" onClick={onDiscard}>
            {t('leave.discard')}
          </Button>
          <Button size="sm" variant="primary" onClick={onStay} autoFocus>
            {t('leave.stay')}
          </Button>
        </>
      }
    >
      <p className="fw-rt-cx-line">{t('leave.body', { record })}</p>
    </Modal>
  )
}
