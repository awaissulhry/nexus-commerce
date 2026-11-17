'use client'

import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { NoticeLine, useWords } from '../../../parts'
import { PEOPLE_NS, type ConfirmModel, type PeopleBlockActions } from '../model'

/**
 * Take a person out of the project (PROJ.members-F06: the lead or projects.manage; removing does not hide an open project from a
 * colleague — it stops the news; an outside company's person no longer sees it in their portal, what they wrote stays) or leave it
 * myself (F05: "You will still be told when someone mentions you"). One question, one button. Pure.
 */
export function OutConfirm({ model, project, company, actions }: { model: ConfirmModel; project: string; company: string | null; actions?: NonNullable<PeopleBlockActions['confirm']> }) {
  const { t, shared } = useWords(PEOPLE_NS)
  const leave = model.kind === 'leave'
  const body = leave ? t('out.leaveBody') : model.row.org === 'outside' ? t('out.removeBodyOutside', { company: company ?? '' }) : t('out.removeBodyTeam')
  return (
    <Modal
      open
      size="sm"
      title={leave ? t('out.leaveTitle', { project }) : t('out.removeTitle', { name: model.row.name, project })}
      onClose={() => actions?.onCancel?.()}
      closeHeld={model.busy ? shared('held.busy') : null}
      footer={
        <>
          <Button size="sm" variant="secondary" heldReason={model.busy ? shared('held.busy') : null} onClick={() => actions?.onCancel?.()}>
            {shared('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={model.busy ? shared('held.busy') : null} onClick={() => actions?.onConfirm?.()}>
            {model.busy ? shared('common.working') : leave ? t('out.leaveConfirm') : t('out.removeConfirm')}
          </Button>
        </>
      }
    >
      <div className="fw-prjp-dialog">
        <NoticeLine notice={model.notice} ns={PEOPLE_NS} />
        <p className="fw-prjp-text">{body}</p>
      </div>
    </Modal>
  )
}
