'use client'

import { Trash2 } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Modal, Textarea } from '../../../i18n/ds-parts'
import { useT } from '../../../i18n/provider'
import { ACT_REASON, actHeld, type FileActWindow, type FileActsState } from '../model'
import { ActFoot, ActLines, type FileActActions } from './FileActParts'

/**
 * F-OF-303 (10-design §7 "Delete “{name}” and its 5 versions?"; D4, B-OF-010): the WHOLE document — every version — with a reason; it
 * cannot be undone, the audit keeps who, when and why. A legal hold, a retention, a fiscal copy or a paper Nexus made refuses it (the
 * card's ⋯ holds Delete… with words; the API refuses the whole too). The bulk "Delete N" of the order's body and of the Files window on
 * every record opens this same window.
 */
export function DeleteDocumentDialog({ window, state, actions }: { window: Extract<FileActWindow, { kind: 'delete' }>; state: FileActsState; actions?: FileActActions | undefined }) {
  const t = useT('record-thread-files-view')
  const versions = window.items.reduce((sum, item) => sum + item.versions, 0)
  const one = window.items.length === 1 ? window.items[0]! : null
  const title = one ? (one.versions > 1 ? t('acts.delete.titleVersions', { name: one.name, count: one.versions }) : t('acts.delete.title', { name: one.name })) : t('acts.delete.titleBulk', { count: window.items.length })
  return (
    <Modal
      open
      onClose={() => actions?.onActClose?.()}
      size="md"
      title={title}
      footer={<ActFoot held={actHeld(window)} busy={state.busy} danger label={t('acts.delete.go', { count: versions })} icon={<Trash2 size={14} aria-hidden />} onCancel={() => actions?.onActClose?.()} onGo={() => actions?.onActSubmit?.()} />}
    >
      <div className="fw-of-act-form">
        <Banner tone="warning" title={t('acts.delete.warn')} />
        {!one && (
          <ul className="fw-rtv-upload-files">
            {window.items.map((item) => (
              <li key={item.id}>
                {item.name} {item.versions > 1 && <span className="fw-rtv-muted">{t('version.earlier', { count: item.versions - 1 })}</span>}
              </li>
            ))}
          </ul>
        )}
        <Field label={t('acts.delete.why')} hint={t('acts.delete.whyHint')}>
          <Textarea value={window.reason} rows={3} limit={ACT_REASON.max} maxLength={ACT_REASON.max} onChange={(event) => actions?.onActChange?.({ ...window, reason: event.target.value })} />
        </Field>
        <ActLines problem={state.problem} happens={t('acts.delete.happens')} customer={t('acts.delete.customer')} never={t('acts.delete.never')} />
      </div>
    </Modal>
  )
}
