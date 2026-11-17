'use client'

import { Lock } from 'lucide-react'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { Feed, type FeedActions } from '../../../../../lib/record-thread/feed/view/Feed'
import { audienceMarks, versionMark, type FileSeries } from '../../../../../lib/record-thread/files/model'
import { keepLines } from '../../../../../lib/record-thread/files-view/model'
import { THREAD_NAMESPACES } from '../../../../../lib/record-thread/parts/ThreadMessages'
import { sizeWords } from '../../../../../lib/record-thread/popups/view/FileViewer'
import { WithMessages } from '../../../../../record-panels/i18n'
import { carriesOfficeNotes, type ThreadPrintModel } from '../model'
import '../thread-print.css'

export const PRINT_NAMESPACES = ['records', 'record-thread-files', 'record-thread-files-view', ...THREAD_NAMESPACES] as const

/**
 * B-TH-280 — the record's thread on paper (the record frame's print view, under the band and the body; T1-F09): the record's name,
 * "Contains office notes" at the head and the foot when a note prints, the conversation as the docked thread draws it (the same
 * cards: one way to say a message), every message open and nothing to act on, then the record's documents in force with their
 * kind, size, date, version, who sees each and how long they are kept — a sheet the reader may not open by its lock words only.
 * Only reading controls reach the screen (Show 50 earlier, Try again); on paper no button prints. Draws its model, fetches nothing.
 */
export function ThreadPrintView({ model, actions }: { model: ThreadPrintModel; actions?: Pick<FeedActions, 'onOlder' | 'onReload'> }) {
  return (
    <WithMessages namespaces={PRINT_NAMESPACES}>
      <Paper model={model} actions={actions} />
    </WithMessages>
  )
}

function Paper({ model, actions }: { model: ThreadPrintModel; actions?: Pick<FeedActions, 'onOlder' | 'onReload'> }) {
  const t = useT('records')
  const notes = model.feed.state === 'ready' && carriesOfficeNotes(model.feed.messages)
  return (
    <section className="fw-rtp" aria-labelledby="fw-rtp-title">
      <h2 id="fw-rtp-title" className="fw-rtp-title">
        {t('print.title', { title: model.title })}
      </h2>
      {notes && (
        <p className="fw-rtp-notes">
          <Lock size={13} aria-hidden /> {t('print.notes')}
        </p>
      )}
      <div className="fw-rtp-part">
        <h3 className="fw-rtp-head">{t('print.conversation')}</h3>
        <div className="fw-rtp-feed">
          <Feed model={model.feed} actions={actions} />
        </div>
      </div>
      {model.files && <Files files={model.files} model={model} />}
      {notes && (
        <p className="fw-rtp-notes fw-rtp-foot">
          <Lock size={13} aria-hidden /> {t('print.notes')}
        </p>
      )}
    </section>
  )
}

function Files({ files, model }: { files: readonly FileSeries[]; model: ThreadPrintModel }) {
  const t = useT('records')
  const fileWords = useT('record-thread-files')
  const viewWords = useT('record-thread-files-view')
  const locale = useLocale()
  return (
    <div className="fw-rtp-part">
      <h3 className="fw-rtp-head">{t('print.files', { count: files.length })}</h3>
      {files.length === 0 ? (
        <p className="fw-rtp-meta">{t('print.filesNone')}</p>
      ) : (
        <ul className="fw-rtp-files">
          {files.map((series) => {
            const file = series.latest
            const version = versionMark(series)
            const { marks, more } = audienceMarks(file, model.party)
            const who = [...marks.map((mark) => fileWords(`audience.${mark}`)), ...(more > 0 ? [fileWords('audience.more', { count: more })] : [])].join(' · ')
            const kept = keepLines(file, model.now).map((line) => viewWords(line.key, line.params?.date ? { date: formatDate(String(line.params.date), { locale }) } : undefined))
            return (
              <li key={series.key} className="fw-rtp-file">
                <span className="fw-rtp-name">
                  {file.locked ? (
                    <>
                      <Lock size={13} aria-hidden /> {fileWords('locked.sheet')}
                    </>
                  ) : (
                    file.name
                  )}
                </span>
                <span className="fw-rtp-meta">
                  {fileWords(`kind.${file.kind}`)} · {sizeWords(file.sizeBytes, locale)} · {formatDate(file.createdAt, { locale })}
                  {version !== null && <> · {viewWords('version.inForce', { n: version })}</>} · {who}
                </span>
                {file.locked && <span className="fw-rtp-meta">{fileWords('locked.sheetWhy')}</span>}
                {kept.length > 0 && <span className="fw-rtp-meta">{kept.join(' · ')}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
