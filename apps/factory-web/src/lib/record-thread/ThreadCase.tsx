'use client'

import { useState } from 'react'
import { SplitPane } from '../split-pane/SplitPane'
import { useT } from '../i18n/provider'
import { addDropped, draftOfRecordFile, uploadAudience } from './attachments/model'
import type { SwitchNote } from './composer/model'
import { withOutbox, type OutboxItem } from './model'
import { ThreadMessages } from './parts/ThreadMessages'
import { RecordThread, type RecordThreadModel } from './RecordThread'

export interface ThreadCaseModel {
  thread: RecordThreadModel
  /** Drawn as Incoming's reading pane (a list on the left), else the request's full page. */
  pane?: boolean
}

/**
 * SCR-006-thread: RecordThread v1 as the reading pane or the full page shows it (design review only). The box works: type, switch
 * (R / N), add files, open the send check; a note or a mail joins the feed as "Sending…" — nothing leaves the browser.
 */
export function ThreadCase({ model }: { model: ThreadCaseModel }) {
  return (
    <ThreadMessages>
      <Case model={model} />
    </ThreadMessages>
  )
}

function Case({ model }: { model: ThreadCaseModel }) {
  const t = useT('record-thread')
  const [thread, setThread] = useState(model.thread)
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const composer = thread.composer
  const set = (next: Partial<RecordThreadModel['composer']>) => setThread((current) => ({ ...current, composer: { ...current.composer, ...next } }))
  let seq = composer.files.length
  const post = () => {
    const key = `local-${outbox.length + 1}`
    setOutbox((list) => [
      ...list,
      {
        key,
        state: 'sending',
        card: { id: key, kind: composer.draft.mode === 'note' ? 'note' : 'ours', channel: composer.draft.mode === 'note' ? 'APP' : 'EMAIL', author: 'Alex Demo', authorKind: 'USER', at: thread.feed.now, body: composer.draft.body, mentions: [], files: [] },
      },
    ])
    set({ draft: { ...composer.draft, body: '', forFloor: false }, notes: [], files: [] })
    setThread((current) => ({ ...current, check: null }))
  }
  const view: RecordThreadModel = { ...thread, feed: { ...thread.feed, messages: withOutbox(thread.feed.messages, outbox) } }
  const element = (
    <div className="fw-rt-thread-case">
      <RecordThread
        model={view}
        actions={{
          onDraft: (draft, notes: readonly SwitchNote[]) => set({ draft, notes }),
          onSend: () => (composer.draft.mode === 'reply' ? setThread((current) => ({ ...current, check: { state: { status: 'checking' }, outside: false } })) : post()),
          onFiles: (files) => set({ files: addDropped(composer.files, files, uploadAudience(composer.draft.mode, composer.canShare, composer.context.party !== null), () => `drop-${++seq}`).files.map((file) => (file.phase === 'uploading' ? { ...file, phase: 'done', fileId: file.key } : file)) }),
          onRemoveFile: (key) => set({ files: composer.files.filter((file) => file.key !== key) }),
          onRetryFile: () => undefined,
          onShareFile: (key) => set({ files: composer.files.map((file) => (file.key === key ? { ...file, audience: 'PARTY' } : file)) }),
          onPicker: (open) => setThread((current) => ({ ...current, pickerOpen: open })),
          onAddRecordFiles: (ids) => set({ files: [...composer.files, ...composer.recordFiles.filter((file) => ids.includes(file.id)).map((file) => draftOfRecordFile(file, `record-${file.id}`))] }),
          onLines: (next) => set(next),
          onCheckBack: () => setThread((current) => ({ ...current, check: null })),
          onCheckRetry: () => undefined,
          onOutside: (ticked) => setThread((current) => ({ ...current, check: current.check ? { ...current.check, outside: ticked } : null })),
          onConfirm: post,
          onStay: () => setThread((current) => ({ ...current, leaving: false })),
          onDiscard: () => setThread((current) => ({ ...current, leaving: false })),
          onDismissNotice: () => setThread((current) => ({ ...current, notice: null })),
        }}
      />
    </div>
  )
  if (!model.pane) return element
  return (
    <div className="fw-rt-thread-case">
      <SplitPane
        labels={{ pane: t('pane.label'), close: t('pane.close') }}
        onClose={() => undefined}
        list={
          <ul className="fw-rt-case-list" aria-hidden="true">
            {['INQ-2026-0007', 'INQ-2026-0006', 'INQ-2026-0005', 'INQ-2026-0004', 'INQ-2026-0003'].map((number, index) => (
              <li key={number} className={index === 0 ? 'is-current' : ''}>
                {number}
              </li>
            ))}
          </ul>
        }
        pane={element}
      />
    </div>
  )
}
