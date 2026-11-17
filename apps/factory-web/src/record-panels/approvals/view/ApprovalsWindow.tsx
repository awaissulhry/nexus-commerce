'use client'

import type { ReactNode } from 'react'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../i18n'
import type { ApprovalsPanelActions, ApprovalsPanelModel } from '../model'
import { ApprovalsPanel } from './ApprovalsPanel'

/**
 * B-TH-280 — the record's requests to its partner in a window (the old record panels' Approvals tab went with the panels): the
 * list with Withdraw, "Ask a partner to approve" (its dialog stacks over the window), the link given once, and under it the
 * record's own approval history when the page passes it (approvals.view, B-W2b-307). The docked thread's "Ask a partner to
 * approve" door opens this window when the record already has a request or an approval; with none, the door opens the Ask
 * dialog at once. Brand wall: the panel and its dialogs reach this record's party only (the API checks it again). One view
 * model, nothing fetched.
 */
export function ApprovalsWindow({ model, actions, record, history, onClose }: { model: ApprovalsPanelModel | null; actions?: ApprovalsPanelActions; record: string; history?: ReactNode; onClose: () => void }) {
  return (
    <WithMessages namespaces={['record-approvals']}>
      <Window model={model} actions={actions} record={record} history={history} onClose={onClose} />
    </WithMessages>
  )
}

function Window({ model, actions, record, history, onClose }: { model: ApprovalsPanelModel | null; actions?: ApprovalsPanelActions | undefined; record: string; history?: ReactNode; onClose: () => void }) {
  const t = useT('record-approvals')
  return (
    <Modal open onClose={onClose} size="lg" title={t('tab')} subtitle={record} footer={<Button onClick={onClose}>{t('close')}</Button>}>
      <div className="fw-ra-window">
        {model && <ApprovalsPanel model={model} actions={actions} title={record} />}
        {history}
      </div>
    </Modal>
  )
}
