'use client'

import { Field, Modal } from '@nexus/ui/components'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import type { Person } from '../../api'
import { NoticeLine, useNcrWords } from '../../parts'
import type { ListDialog, NcrListActions } from '../view-model'

/**
 * Assign owner (design ncr-grid "Selection: … Assign"): one owner for the NCRs picked (one site; at most 50), each saved
 * as its own change with the version the list read; the answer says how many took it.
 */
export function AssignDialog({ dialog, people, actions }: { dialog: Extract<ListDialog, { kind: 'assign' }>; people: readonly Person[] | null; actions?: NcrListActions }) {
  const { t } = useNcrWords()
  const count = dialog.ids.length
  return (
    <Modal
      open
      onClose={() => actions?.onDialogClose?.()}
      title={t('list.assignTitle', { count })}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={() => actions?.onDialogClose?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={dialog.ownerId ? null : t('list.heldAssignOwner')} disabled={dialog.busy} onClick={() => actions?.onSubmitAssign?.()}>
            {dialog.busy ? <Spinner size={12} /> : null} {t('list.assignSubmit', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-q-stack">
        <NoticeLine notice={dialog.notice} />
        <Field label={t('list.assignOwner')} required>
          <Select size="sm" value={dialog.ownerId} onChange={(event) => actions?.onAssignOwner?.(event.target.value)}>
            <option value="">—</option>
            {(people ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.me ? t('common.me', { name: person.name }) : person.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}
