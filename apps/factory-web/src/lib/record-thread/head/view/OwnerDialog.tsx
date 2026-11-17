'use client'

import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { ListboxPanel, Modal } from '../../../i18n/ds-parts'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { HeadOwner } from '../model'
import { HEAD_NS } from './RecordThreadHead'

/** The value of "the record's own owner" in the list (the API's ownerId null). */
const RECORD_OWN = '__record__'

export interface OwnerDialogModel {
  /** The record as its page names it ("SO-2026-0142"). */
  readonly record: string
  readonly owner: HeadOwner | null
  /** The office people who read the thread (the API refuses anyone else). */
  readonly people: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly meId: string
  readonly busy: boolean
  /** Why the last change was refused, in words. */
  readonly problem: string | null
}

/**
 * B-TH-229 — "Change owner…" (T1-F03; B-TH-028 PUT …/owner, threads.post): who answers the thread, picked among the office people who
 * read it (me first), or back to the record's own owner (the request's assignee, the order's supervisor, else its maker). ↑ ↓ and
 * Enter choose. Draws its model; the container sends the change.
 */
export function OwnerDialog({ model, onPick, onClose }: { model: OwnerDialogModel; onPick: (ownerId: string | null) => void; onClose: () => void }) {
  return (
    <WithMessages namespaces={[HEAD_NS]}>
      <Dialog model={model} onPick={onPick} onClose={onClose} />
    </WithMessages>
  )
}

function Dialog({ model, onPick, onClose }: { model: OwnerDialogModel; onPick: (ownerId: string | null) => void; onClose: () => void }) {
  const t = useT(HEAD_NS)
  const set = model.owner?.source === 'SET'
  const options = [
    ...[...model.people]
      .sort((a, b) => Number(b.id === model.meId) - Number(a.id === model.meId) || a.name.localeCompare(b.name))
      .map((person) => ({ value: person.id, label: person.id === model.meId ? t('owner.me', { name: person.name }) : person.name, disabled: person.id === model.owner?.id })),
    ...(set ? [{ value: RECORD_OWN, label: t('owner.recordOwn') }] : []),
  ]
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('owner.title')}
      subtitle={t('owner.subtitle', { record: model.record })}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('owner.cancel')}
        </Button>
      }
    >
      <div className="fw-rth-ownerdialog">
        {model.problem && <Banner tone="danger" title={t('owner.failed', { reason: model.problem })} />}
        <p className="fw-rth-ownerhint">
          {model.owner ? `${t('owner.now', { name: model.owner.active ? model.owner.name : t('owner.inactive', { name: model.owner.name }) })} · ${t(`owner.source.${model.owner.source}`)}` : t('owner.nobody')}
        </p>
        {options.length === 0 ? (
          <p className="fw-rth-ownerhint">{t('owner.noPeople')}</p>
        ) : (
          <ListboxPanel
            options={options}
            onCommit={(value) => {
              if (model.busy) return
              onPick(value === RECORD_OWN ? null : value)
            }}
            onCancel={onClose}
            ariaLabel={t('owner.listLabel')}
            searchPlaceholder={t('owner.search')}
            style={{ position: 'relative', width: '100%' }}
          />
        )}
        <p className="fw-rth-ownerhint">{t('owner.hint')}</p>
      </div>
    </Modal>
  )
}
