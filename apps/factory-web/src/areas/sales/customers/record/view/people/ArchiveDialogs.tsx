'use client'

import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { said } from '../../people/model'
import type { ArchiveModel, PeopleTabActions } from '../../people/tab'
import { usePeopleSay } from './say'

/**
 * F-CA-221 (customer page › PEOPLE & ADDRESSES tab, lane ca- ca-w2 W2.4; 10-design §6 windows 2 and 3; P14) — NEW windows "Archive
 * {name}?" and "Archive “{address}”?" (560): archived, never deleted (Restore brings it back); only the warnings that are true from the
 * data already read — who gets its mails after, its portal access, the named production approver, the open quotes / draft quotes and
 * shipments that name it (D3), the defaults and the e-invoices. They warn, never refuse: Archive sends the record's own change.
 * `ArchiveBody` is the inside (a design case draws it on a plain card).
 */

export function ArchiveDialog({ model, customer, actions }: { model: ArchiveModel; customer: string; actions?: PeopleTabActions | undefined }) {
  const say = usePeopleSay()
  const title = model.kind === 'contact' ? say(said('archive.contact.title', { params: { name: model.name } })) : say(said('archive.address.title', { params: { name: model.name } }))
  return (
    <Modal
      open
      size="md"
      onClose={() => actions?.onArchiveClose?.()}
      title={title}
      subtitle={[customer, ...model.what.map(say)].join(' · ')}
      footer={
        <>
          <Button onClick={() => actions?.onArchiveClose?.()}>{say(said('parties:common.cancel'))}</Button>
          <Button variant="primary" onClick={() => actions?.onArchiveConfirm?.()}>
            {say(said('archive.confirm'))}
          </Button>
        </>
      }
    >
      <ArchiveBody model={model} />
    </Modal>
  )
}

export function ArchiveBody({ model }: { model: ArchiveModel }) {
  const say = usePeopleSay()
  return (
    <div className="fw-ca-win">
      <p className="fw-ca-sub">{say(said(model.kind === 'contact' ? 'archive.contact.never' : 'archive.address.never', { params: { name: model.name } }))}</p>
      <ul className="fw-ca-warns">
        {model.warnings.map((warning, index) => (
          <li key={`${warning.words.key}-${index}`} className={`is-${warning.tone}`}>
            {warning.tone === 'danger' ? <CircleAlert size={14} aria-hidden /> : warning.tone === 'warning' ? <TriangleAlert size={14} aria-hidden /> : <Info size={14} aria-hidden />}
            <span>{say(warning.words)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
