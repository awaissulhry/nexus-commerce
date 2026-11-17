'use client'

import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { toViewerFile } from '../../files/model'
import { FileViewer } from '../../popups/view/FileViewer'
import { START_AUDIENCE, type UploadAsk } from '../model'
import { FILES_VIEW_NS, FilesView, type FilesViewModel } from './FilesView'

/**
 * A design-review case of SCR-006-filesview: the window over a stand-in, with choosing, the bulk bar's counts, the upload
 * asked after a drop and the thread's one file viewer working on made-up files. Reopened with its button after Close.
 */
export interface FilesViewCaseModel {
  readonly view: FilesViewModel
  /** What the viewer shows per file (made-up pictures and PDFs). */
  readonly sources: Readonly<Record<string, string | Uint8Array>>
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
  const files = (model.view.files ?? []).filter((file) => file.status !== 'DELETED' && file.status !== 'PENDING_UPLOAD')
  const viewerFiles = files.map((file) => toViewerFile(file, { src: model.sources[file.id] ?? null, downloadHref: file.status === 'AVAILABLE' ? '#download' : null }))
  const index = viewerFiles.findIndex((file) => file.id === viewing)
  return (
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
          }}
        />
      )}
      {viewing && index >= 0 && <FileViewer files={viewerFiles} index={index} onIndex={(next) => setViewing(viewerFiles[next]?.id ?? null)} onClose={() => setViewing(null)} />}
    </div>
  )
}
