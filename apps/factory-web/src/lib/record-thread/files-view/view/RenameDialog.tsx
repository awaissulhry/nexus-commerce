'use client'

import { PencilLine } from 'lucide-react'
import { Field } from '@nexus/ui/components'
import { Input } from '@nexus/ui/primitives'
import { Modal } from '../../../i18n/ds-parts'
import { useT } from '../../../i18n/provider'
import { actHeld, type FileActWindow, type FileActsState } from '../model'
import { ActFoot, ActLines, type FileActActions } from './FileActParts'

/**
 * F-OF-303 (10-design §7 "Rename {name}"; B-OF-011): the new name; renaming makes a new version with it — the old one keeps its name. A
 * fiscal copy and a paper Nexus made keep their names (the card's ⋯ holds Rename… with words).
 */
export function RenameDialog({ window, state, actions }: { window: Extract<FileActWindow, { kind: 'rename' }>; state: FileActsState; actions?: FileActActions | undefined }) {
  const t = useT('record-thread-files-view')
  const item = window.items[0]
  return (
    <Modal
      open
      onClose={() => actions?.onActClose?.()}
      size="md"
      title={t('acts.rename.title', { name: item.name })}
      footer={<ActFoot held={actHeld(window)} busy={state.busy} label={t('acts.rename.go')} icon={<PencilLine size={14} aria-hidden />} onCancel={() => actions?.onActClose?.()} onGo={() => actions?.onActSubmit?.()} />}
    >
      <div className="fw-of-act-form">
        <Field label={t('acts.rename.field')}>
          <Input value={window.name} maxLength={255} onChange={(event) => actions?.onActChange?.({ ...window, name: event.target.value })} />
        </Field>
        <ActLines problem={state.problem} happens={t('acts.rename.happens', { n: item.versionNo, old: item.name })} customer={t('acts.rename.customer')} never={t('acts.rename.never')} />
      </div>
    </Modal>
  )
}
