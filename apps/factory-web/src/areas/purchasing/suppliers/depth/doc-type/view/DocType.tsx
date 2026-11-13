'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { VaultDocument } from '../../api'
import { docTypeHeld, typeWords, WORDS_NS } from '../model'
import type { DocTypeActions, DocTypeModel } from '../use-doc-type'

/**
 * A vault document's type in its row (B-W2b-382; SCR-057 cases `w2b-382-*`): the list's words for its code, or "not said"
 * (it meets any ask of its kind), and "What it is…" (held with why without files.upload or offline).
 */
export function DocTypeCell({ doc, model, actions }: { doc: Pick<VaultDocument, 'fileId' | 'name' | 'documentTypeCode' | 'version'>; model: DocTypeModel; actions?: DocTypeActions | undefined }) {
  return (
    <WithMessages namespaces={[WORDS_NS]}>
      <Cell doc={doc} model={model} actions={actions} />
    </WithMessages>
  )
}

function Cell({ doc, model, actions }: { doc: Pick<VaultDocument, 'fileId' | 'name' | 'documentTypeCode' | 'version'>; model: DocTypeModel; actions?: DocTypeActions | undefined }) {
  const t = useT(WORDS_NS)
  const locale = useLocale()
  const code = doc.documentTypeCode ?? null
  const held = !model.mayType ? t('docType.held.noRight') : model.offline ? t('docType.held.offline') : null
  return (
    <>
      <span className="fw-spd-hint">{code ? typeWords(code, model.types, locale) : t('docType.notSaid')}</span>
      <Button size="sm" variant="link" inline wrap heldReason={held} onClick={() => actions?.onOpenType?.(doc)} aria-label={t('docType.openOf', { name: doc.name || code || '—' })}>
        {t(code ? 'docType.change' : 'docType.say')}
      </Button>
    </>
  )
}

/** "What is this document?" — the list's types, "not said", what each choice means for the asks, Save (files.upload). */
export function DocTypeDialog({ model, actions }: { model: DocTypeModel; actions?: DocTypeActions | undefined }) {
  return model.dialog || model.done ? (
    <WithMessages namespaces={[WORDS_NS]}>
      <Dialog model={model} actions={actions} />
    </WithMessages>
  ) : null
}

function Dialog({ model, actions }: { model: DocTypeModel; actions?: DocTypeActions | undefined }) {
  const t = useT(WORDS_NS)
  const locale = useLocale()
  const dialog = model.dialog
  if (!dialog) {
    return (
      <div role="status">
        <Banner
          tone="success"
          title={t('docType.done', { name: model.done!.name })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissType?.()}>
              {t('docType.dismiss')}
            </Button>
          }
        />
      </div>
    )
  }
  const held = docTypeHeld(dialog, { mayType: model.mayType, offline: model.offline })
  const types = model.types ?? []
  const listed = dialog.current === null || types.some((entry) => entry.code === dialog.current)
  return (
    <Modal
      open
      onClose={() => actions?.onCloseType?.()}
      title={t('docType.title', { name: dialog.name || '—' })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onCloseType?.()}>
            {t('docType.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held && held !== 'docType.held.busy' ? t(held) : null} onClick={() => actions?.onSaveType?.()}>
            {dialog.busy && <Spinner size={12} />} {t('docType.save')}
          </Button>
        </>
      }
    >
      <div className="fw-spd-stack">
        <p className="fw-spd-hint">{t('docType.body')}</p>
        <Field label={t('docType.label')} hint={dialog.chosen ? t('docType.hintTyped') : t('docType.hintNone')}>
          <Select value={dialog.chosen} disabled={!model.mayType || dialog.busy} onChange={(event) => actions?.onChooseType?.(event.target.value)} aria-label={t('docType.label')}>
            <option value="">{t('docType.notSaid')}</option>
            {!listed && dialog.current && <option value={dialog.current}>{dialog.current}</option>}
            {types.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {typeWords(entry.code, types, locale)}
              </option>
            ))}
          </Select>
        </Field>
        {model.types === null && <p className="fw-spd-hint">{t('docType.typesUnread')}</p>}
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
      </div>
    </Modal>
  )
}
