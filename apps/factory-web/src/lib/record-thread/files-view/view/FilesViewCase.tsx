'use client'

import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { toViewerFile } from '../../files/model'
import { DockedStage } from '../../parts/DockedStage'
import { FileViewer } from '../../popups/view/FileViewer'
import { START_AUDIENCE, type UploadAsk } from '../model'
import { FILES_VIEW_NS, FilesView, type FilesViewModel } from './FilesView'
// B-TH-231: "Use on another record…" over made-up records of the same customer or none.
import type { OfferedTarget } from '../../files/use-on'
import { UseOnDialog, type UseOnModel } from '../../files/view/UseOnDialog'

/**
 * A design-review case of SCR-006-filesview: the window over the docked thread it opens from (B-TH-300's follow-up: the stand-in
 * record frame fills the width), with choosing, the bulk bar's counts, the upload
 * asked after a drop and the thread's one file viewer working on made-up files. Reopened with its button after Close.
 */
export interface FilesViewCaseModel {
  readonly view: FilesViewModel
  /** What the viewer shows per file (made-up pictures and PDFs). */
  readonly sources: Readonly<Record<string, string | Uint8Array>>
  /** B-TH-231: the records "Use on another record…" offers here (made up), and the window open at first. */
  readonly targets?: readonly OfferedTarget[]
  readonly useOn?: UseOnModel
}

export function FilesViewCase({ model }: { model: FilesViewCaseModel }) {
  return (
    <WithMessages namespaces={[FILES_VIEW_NS]}>
      <Case model={model} />
    </WithMessages>
  )
}

function Case({ model }: { model: FilesViewCaseModel }) {
  const t = useT(FILES_VIEW_NS)
  const [open, setOpen] = useState(true)
  const [selected, setSelected] = useState(model.view.selected)
  const [upload, setUpload] = useState<UploadAsk | null>(model.view.upload)
  const [viewing, setViewing] = useState<string | null>(null)
  const [useOn, setUseOn] = useState<UseOnModel | null>(model.useOn ?? null)
  const files = (model.view.files ?? []).filter((file) => file.status !== 'DELETED' && file.status !== 'PENDING_UPLOAD')
  const viewerFiles = files.map((file) => toViewerFile(file, { src: model.sources[file.id] ?? null, downloadHref: file.status === 'AVAILABLE' ? '#download' : null }))
  const index = viewerFiles.findIndex((file) => file.id === viewing)
  return (
    <DockedStage>
      <div className="fw-rtv-stage">
        <Button size="sm" onClick={() => setOpen(true)}>
          <FolderOpen size={14} aria-hidden /> {t('design.openAgain')}
        </Button>
        {open && (
          <FilesView
            model={{ ...model.view, selected, upload }}
            actions={{
              onClose: () => setOpen(false),
              onSelect: setSelected,
              onOpen: (fileId) => setViewing(fileId),
              onDrop: (dropped) => setUpload({ files: dropped.map((file) => ({ name: file.name, sizeBytes: file.size })), kind: 'ATTACHMENT', audience: START_AUDIENCE, kinds: ['ATTACHMENT', 'DOCUMENT', 'PHOTO', 'CERTIFICATE'], audiences: ['OFFICE', 'FLOOR', 'PARTNER', 'LINK'] }),
              onUploadChange: (change) => setUpload((ask) => (ask ? { ...ask, ...change } : ask)),
              onUploadCancel: () => setUpload(null),
              onUploadConfirm: () => setUpload(null),
              onUseOn: (ids) =>
                setUseOn({
                  files: files.filter((file) => ids.includes(file.id)).map((file) => ({ id: file.id, name: file.name })),
                  party: model.view.party ? { name: model.view.party.name } : null,
                  query: 'AX-100',
                  targets: model.targets ?? [],
                  searching: false,
                  chosen: null,
                  share: false,
                  canShare: model.view.can.share,
                  busy: false,
                  problem: null,
                  failed: [],
                  copied: 0,
                }),
            }}
          />
        )}
        {useOn && (
          <UseOnDialog
            model={useOn}
            actions={{
              onQuery: (query) => setUseOn((now) => (now ? { ...now, query } : now)),
              onChoose: (chosen) => setUseOn((now) => (now ? { ...now, chosen } : now)),
              onShare: (share) => setUseOn((now) => (now ? { ...now, share } : now)),
              onConfirm: () => setUseOn(null),
              onClose: () => setUseOn(null),
            }}
          />
        )}
        {viewing && index >= 0 && <FileViewer files={viewerFiles} index={index} onIndex={(next) => setViewing(viewerFiles[next]?.id ?? null)} onClose={() => setViewing(null)} />}
      </div>
    </DockedStage>
  )
}
