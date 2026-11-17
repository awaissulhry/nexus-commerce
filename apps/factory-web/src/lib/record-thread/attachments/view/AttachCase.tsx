'use client'

import { useState } from 'react'
import { useT } from '../../../i18n/provider'
import type { ComposerContext, ComposerDraft } from '../../composer/model'
import { Composer } from '../../composer/view/Composer'
import { ThreadMessages } from '../../parts/ThreadMessages'
import { addDropped, draftOfRecordFile, MAIL_MAX, mailBytes, trayHeld, uploadAudience, type DraftFile, type RecordFile } from '../model'
import { AttachmentLines, AttachmentTray, ClipMenu, FromRecordPicker } from './AttachmentTray'

export interface AttachCaseModel {
  context: ComposerContext
  draft: ComposerDraft
  files: readonly DraftFile[]
  recordFiles: readonly RecordFile[]
  canUpload: boolean
  canShare: boolean
  pickerOpen?: boolean
}

/** SCR-006-attach: the composer with its files (design review only: a drop or a pick adds rows; nothing is uploaded). */
export function AttachCase({ model }: { model: AttachCaseModel }) {
  return (
    <ThreadMessages>
      <Case model={model} />
    </ThreadMessages>
  )
}

function Case({ model }: { model: AttachCaseModel }) {
  const t = useT('record-thread-attach')
  const [draft, setDraft] = useState(model.draft)
  const [files, setFiles] = useState<readonly DraftFile[]>(model.files)
  const [picking, setPicking] = useState(model.pickerOpen ?? false)
  const party = model.context.party?.name ?? ''
  let seq = files.length
  const held = trayHeld(files, draft.mode)
  const add = (dropped: File[]) => setFiles((current) => addDropped(current, dropped, uploadAudience(draft.mode, model.canShare, model.context.party !== null), () => `drop-${++seq}`).files)
  return (
    <div className="fw-rt-case fw-rt-column">
      <div className="fw-rt-case-fill" aria-hidden="true" />
      <Composer
        context={model.context}
        draft={draft}
        hasFiles={files.some((file) => file.phase === 'done')}
        extraHeld={held ? t(held.key, held.params) : null}
        tray={<AttachmentTray files={files} partyName={party} onRemove={(key) => setFiles((list) => list.filter((file) => file.key !== key))} onRetry={(key) => setFiles((list) => list.map((file) => (file.key === key ? { ...file, phase: 'uploading', problem: undefined } : file)))} />}
        lines={
          <AttachmentLines
            files={files}
            mode={draft.mode}
            partyName={party}
            canShare={model.canShare}
            overMailLimit={mailBytes(files) > MAIL_MAX}
            onShare={(key) => setFiles((list) => list.map((file) => (file.key === key ? { ...file, audience: 'PARTY' } : file)))}
            onRemove={(key) => setFiles((list) => list.filter((file) => file.key !== key))}
          />
        }
        clip={<ClipMenu canUpload={model.canUpload} canPick onFiles={add} onPick={() => setPicking(true)} />}
        onDraft={(next) => setDraft(next)}
        onSend={() => undefined}
        onFiles={add}
      />
      <FromRecordPicker
        open={picking}
        files={model.recordFiles}
        mode={draft.mode}
        partyName={party}
        record={model.context.recordLabel}
        onClose={() => setPicking(false)}
        onAdd={(ids) => setFiles((list) => [...list, ...model.recordFiles.filter((file) => ids.includes(file.id)).map((file) => draftOfRecordFile(file, `record-${file.id}`))])}
      />
    </div>
  )
}
