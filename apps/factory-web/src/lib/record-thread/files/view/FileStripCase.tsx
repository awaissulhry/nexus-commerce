'use client'

import { useState } from 'react'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { FileViewer } from '../../popups/view/FileViewer'
import { FilesView } from '../../files-view/view/FilesView'
import { toViewerFile, type FilesParty, type PinLine, type ThreadFile } from '../model'
import { FILES_NS, FileStrip } from './FileStrip'

/**
 * A design-review case of SCR-006-filesline: the line in a stand-in thread column at the dock's 519 / 711 px and the
 * phone's 375 px; the chip opens the strip, a tile opens the thread's one file viewer (popups). "All files" opens T9.
 */
export interface FileStripCaseModel {
  readonly files: readonly ThreadFile[] | null
  readonly party: FilesParty | null
  readonly open: boolean
  /** What the viewer shows per file (made-up pictures and PDFs). */
  readonly sources: Readonly<Record<string, string | Uint8Array>>
  readonly frames: readonly (519 | 711 | 375)[]
  /** The record the files belong to (the Files view opened from "All files"). */
  readonly record: { readonly type: string; readonly id: string; readonly label: string }
  readonly partyName: string | null
  readonly now: number
  /** B-TH-286: the pins on the line (absent: none). */
  readonly pins?: readonly PinLine[]
  readonly canUnpin?: boolean
}

export function FileStripCase({ model }: { model: FileStripCaseModel }) {
  return (
    <WithMessages namespaces={[FILES_NS]}>
      <Case model={model} />
    </WithMessages>
  )
}

function Case({ model }: { model: FileStripCaseModel }) {
  const t = useT(FILES_NS)
  const [open, setOpen] = useState(model.open)
  const [viewing, setViewing] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [pins, setPins] = useState<readonly PinLine[]>(model.pins ?? [])
  const viewerFiles = (model.files ?? []).filter((file) => file.status !== 'DELETED').map((file) => toViewerFile(file, { src: model.sources[file.id] ?? null, downloadHref: file.status === 'AVAILABLE' ? '#download' : null }))
  const index = viewerFiles.filter((file) => file.status !== 'PENDING_UPLOAD').findIndex((file) => file.id === viewing)
  return (
    <div className="fw-rtf-frames">
      {model.frames.map((frame) => (
        <div key={frame}>
          <p className="fw-rtf-frame-label">{t(`design.frame${frame}`)}</p>
          <section className={`fw-rtf-frame is-${frame}`} aria-label={t('design.frameLabel', { width: frame })}>
            <FileStrip
              model={{ files: model.files, party: model.party, open, pins, canUnpin: model.canUnpin ?? false }}
              actions={{ onToggle: setOpen, onOpen: setViewing, onAllFiles: () => setAll(true), onUnpin: (messageId) => setPins((now) => now.filter((pin) => pin.messageId !== messageId)) }}
            />
            <div className="fw-rtf-feed" aria-hidden />
          </section>
        </div>
      ))}
      {all && (
        <FilesView
          model={{ record: model.record, party: model.party && model.partyName ? { ...model.party, name: model.partyName } : null, files: model.files, problem: null, can: { upload: true, share: true, delete: true }, uploadHeld: null, selected, refused: [], missing: [], upload: null, now: model.now }}
          actions={{ onClose: () => setAll(false), onSelect: setSelected, onOpen: setViewing }}
        />
      )}
      {viewing && index >= 0 && <FileViewer files={viewerFiles} index={index} onIndex={(next) => setViewing(viewerFiles.filter((file) => file.status !== 'PENDING_UPLOAD')[next]?.id ?? null)} onClose={() => setViewing(null)} />}
    </div>
  )
}
