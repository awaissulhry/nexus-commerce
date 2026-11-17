'use client'

import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../i18n'
import { SHARES_NS, type SharesPanelActions, type SharesPanelModel } from '../model'
import { SharesPanel } from './SharesPanel'

/**
 * B-TH-280 — who outside is invited to the record, in a window (the old record panels' Partners tab went with the panels): the
 * invitations with Change (what they may do now) and Revoke (the invitation and its link stop together), "Share with a partner"
 * (its dialog stacks over the window) and the link given once. The docked thread's "Share with a partner" door opens this window
 * when the record already has an invitation; with none, the door opens the invitation at once. Brand wall: only this record's
 * party and its contacts are offered (the API checks it again). One view model, nothing fetched.
 */
export function SharesWindow({ model, actions, record, onClose }: { model: SharesPanelModel; actions?: SharesPanelActions; record: string; onClose: () => void }) {
  return (
    <WithMessages namespaces={[SHARES_NS]}>
      <Window model={model} actions={actions} record={record} onClose={onClose} />
    </WithMessages>
  )
}

function Window({ model, actions, record, onClose }: { model: SharesPanelModel; actions?: SharesPanelActions | undefined; record: string; onClose: () => void }) {
  const t = useT(SHARES_NS)
  return (
    <Modal open onClose={onClose} size="lg" title={t('tab')} subtitle={record} footer={<Button onClick={onClose}>{t('close')}</Button>}>
      <div className="fw-rsh-window">
        <SharesPanel model={model} actions={actions} title={record} />
      </div>
    </Modal>
  )
}
