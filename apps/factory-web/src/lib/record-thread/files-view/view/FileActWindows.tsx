'use client'

import { FilePlus2, Lock, LockOpen } from 'lucide-react'
import { Checkbox } from '@nexus/ui/primitives'
import { FileDropzone, Modal } from '../../../i18n/ds-parts'
import { useLocale, useT } from '../../../i18n/provider'
import { sizeWords } from '../../popups/view/FileViewer'
import { actHeld, type FileActsState } from '../model'
import { DeleteDocumentDialog } from './DeleteDocumentDialog'
import { ActFoot, ActLines, type FileActActions } from './FileActParts'
import { RenameDialog } from './RenameDialog'
import { WhoCanSeeDialog } from './WhoCanSeeDialog'
import './files-tab.css'

/**
 * F-OF-303 (order FILES tab W3; 10-design §7) — the file windows, drawn once by the body that opens them (the order's tab and its thread
 * window; the Files window on every record for Delete): Who can see…, Rename…, Delete…, New version… (one file; the name kept or the new
 * file's; the audience and the price mark carry over), Mark as priced? / Take the price mark off? Centred DS Modals (a sheet at 375),
 * footer ≤ 2 buttons, each says what happens, the customer and what never changes; a refusal in the window. Draws the state; fetches nothing.
 */
export function FileActWindows({ state, actions }: { state: FileActsState | undefined; actions?: FileActActions | undefined }) {
  const window = state?.window ?? null
  if (!state || !window) return null
  if (window.kind === 'whoCanSee') return <WhoCanSeeDialog window={window} state={state} actions={actions} />
  if (window.kind === 'rename') return <RenameDialog window={window} state={state} actions={actions} />
  if (window.kind === 'delete') return <DeleteDocumentDialog window={window} state={state} actions={actions} />
  if (window.kind === 'newVersion') return <NewVersionDialog window={window} state={state} actions={actions} />
  return <PricedDialog window={window} state={state} actions={actions} />
}

function NewVersionDialog({ window, state, actions }: { window: Extract<NonNullable<FileActsState['window']>, { kind: 'newVersion' }>; state: FileActsState; actions?: FileActActions | undefined }) {
  const t = useT('record-thread-files-view')
  const locale = useLocale()
  const item = window.items[0]
  return (
    <Modal
      open
      onClose={() => actions?.onActClose?.()}
      size="md"
      title={t('acts.version.title', { name: item.name })}
      footer={<ActFoot held={actHeld(window)} busy={state.busy} label={t('acts.version.go', { n: item.versionNo + 1 })} icon={<FilePlus2 size={14} aria-hidden />} onCancel={() => actions?.onActClose?.()} onGo={() => actions?.onActSubmit?.()} />}
    >
      <div className="fw-of-act-form">
        <FileDropzone onFiles={(files) => actions?.onActFile?.(files)} hint={t('acts.version.hint')} />
        {window.file && (
          <p>
            {window.file.name} <span className="fw-rtv-muted">{sizeWords(window.file.sizeBytes, locale)}</span>
          </p>
        )}
        <Checkbox label={t('acts.version.keepName', { name: item.name })} checked={window.keepName} onChange={(event) => actions?.onActChange?.({ ...window, keepName: event.target.checked })} />
        <ActLines problem={state.problem} happens={t('acts.version.happens', { n: item.versionNo })} customer={t('acts.version.customer')} never={t('acts.version.never', { n: item.versionNo })} />
      </div>
    </Modal>
  )
}

function PricedDialog({ window, state, actions }: { window: Extract<NonNullable<FileActsState['window']>, { kind: 'priced' }>; state: FileActsState; actions?: FileActActions | undefined }) {
  const t = useT('record-thread-files-view')
  const p = useT('record-files')
  const item = window.items[0]
  return (
    <Modal
      open
      onClose={() => actions?.onActClose?.()}
      size="md"
      title={window.priced ? t('acts.priced.title', { name: item.name }) : t('acts.priced.titleOff', { name: item.name })}
      footer={<ActFoot held={null} busy={state.busy} label={p(window.priced ? 'priced.mark' : 'priced.unmark')} icon={window.priced ? <Lock size={14} aria-hidden /> : <LockOpen size={14} aria-hidden />} onCancel={() => actions?.onActClose?.()} onGo={() => actions?.onActSubmit?.()} />}
    >
      <div className="fw-of-act-form">
        <ActLines problem={state.problem} happens={window.priced ? t('acts.priced.happens') : t('acts.priced.happensOff')} customer={window.priced ? t('acts.priced.customer') : t('acts.priced.customerOff')} never={t('acts.priced.never')} />
      </div>
    </Modal>
  )
}
