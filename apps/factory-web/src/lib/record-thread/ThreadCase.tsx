'use client'

import { useEffect, useState } from 'react'
import { SplitPane } from '../split-pane/SplitPane'
import { useT } from '../i18n/provider'
import { addDropped, draftOfRecordFile, uploadAudience } from './attachments/model'
import type { SwitchNote } from './composer/model'
import { feedForView, withOutbox, type OutboxItem } from './model'
import { ThreadMessages } from './parts/ThreadMessages'
import { DockedStage } from './parts/DockedStage'
import { RecordThread, type RecordThreadModel } from './RecordThread'
// B-TH-300: the docked thread's bands in the design case.
import type { DockWidth, HeadModel, ThreadView } from './head/model'
import { RecordThreadHead } from './head/view/RecordThreadHead'
import { fileSeries, toViewerFile, type FilesParty, type ThreadFile } from './files/model'
import { FileStrip } from './files/view/FileStrip'
import type { SavedRepliesModel } from './helpers/model'
import { SavedReplies } from './helpers/view/SavedReplies'
import { FileViewer } from './popups/view/FileViewer'

export interface ThreadCaseModel {
  thread: RecordThreadModel
  /** Drawn as Incoming's reading pane (a list on the left), else the request's full page. */
  pane?: boolean
  /** B-TH-300: the docked thread — the Head and the files line above the feed, Saved replies beside the box. */
  docked?: {
    head: HeadModel
    files: readonly ThreadFile[] | null
    party: FilesParty | null
    stripOpen?: boolean
    replies?: SavedRepliesModel
    /** Made-up pictures and PDFs for the one file viewer. */
    sources?: Readonly<Record<string, string | Uint8Array>>
  }
  /** Fill the host's height (inside a record page's dock) instead of standing in a record frame of its own. */
  fill?: boolean
}

/**
 * SCR-006-thread: RecordThread v1 as the reading pane or the full page shows it (design review only). The box works: type, switch
 * (R / N), add files, open the send check; a note or a mail joins the feed as "Sending…" — nothing leaves the browser.
 */
export function ThreadCase({ model, onWidth }: { model: ThreadCaseModel; onWidth?: (choice: DockWidth | 'hide' | 'reset') => void }) {
  return (
    <ThreadMessages>
      <Case model={model} onWidth={onWidth} />
    </ThreadMessages>
  )
}

/** `onWidth`: the record page's frame (SCR-039) takes the width menu; without it the case keeps the width itself. */
function Case({ model, onWidth }: { model: ThreadCaseModel; onWidth?: (choice: DockWidth | 'hide' | 'reset') => void }) {
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
  // B-TH-300: the docked bands' own state in the case (the View, the width, the strip, the viewer); the phone head under 720 px.
  const docked = model.docked
  const [feedView, setFeedView] = useState<ThreadView>(docked?.head.view ?? 'all')
  const [width, setWidth] = useState<DockWidth | null>(docked?.head.width ?? null)
  const [stripOpen, setStripOpen] = useState(docked?.stripOpen ?? false)
  const [viewing, setViewing] = useState<string | null>(null)
  const [phone, setPhone] = useState(false)
  useEffect(() => {
    const list = window.matchMedia('(max-width: 719px)')
    setPhone(list.matches)
    const onChange = () => setPhone(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])
  const latest = docked?.files ? fileSeries(docked.files).map((series) => series.latest) : []
  const viewerFiles = latest.map((file) => toViewerFile(file, { src: docked?.sources?.[file.id] ?? null, downloadHref: file.status === 'AVAILABLE' ? '#download' : null }))
  const viewerIndex = viewerFiles.findIndex((file) => file.id === viewing)
  const slots = docked
    ? {
        head: (
          <RecordThreadHead
            model={{ ...docked.head, view: feedView, width: phone ? null : onWidth ? docked.head.width : width, compact: phone }}
            actions={{ onView: setFeedView, onWidth: onWidth ?? ((choice) => setWidth(choice === 'hide' ? width : choice === 'reset' ? 'forty' : choice)) }}
          />
        ),
        filesLine: docked.files === null || docked.files.length > 0 ? <FileStrip model={{ files: docked.files, party: docked.party, open: stripOpen }} actions={{ onToggle: setStripOpen, onOpen: (fileId) => setViewing(fileId) }} /> : null,
        helpers: docked.replies ? <SavedReplies model={docked.replies} /> : null,
        overlays: viewing && viewerIndex >= 0 ? <FileViewer files={viewerFiles} index={viewerIndex} onIndex={(index) => setViewing(viewerFiles[index]?.id ?? null)} onClose={() => setViewing(null)} /> : null,
      }
    : undefined
  const messages = withOutbox(thread.feed.messages, outbox)
  const view: RecordThreadModel = { ...thread, feed: docked ? feedForView({ ...thread.feed, messages }, feedView) : { ...thread.feed, messages } }
  const element = (
    <div className={model.fill ? 'fw-rt-thread-case is-fill' : docked ? 'fw-rt-thread-case is-docked' : 'fw-rt-thread-case'}>
      <RecordThread
        slots={slots}
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
  if (docked && !model.fill) return <DockedStage>{element}</DockedStage>
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
