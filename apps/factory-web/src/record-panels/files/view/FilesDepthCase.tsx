'use client'

import { useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { formatDate } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { FilesParty, ThreadFile } from '../../../lib/record-thread/files/model'
import { DockedStage } from '../../../lib/record-thread/parts/DockedStage'
import { FILES_VIEW_NS, FilesView } from '../../../lib/record-thread/files-view/view/FilesView'
import { WithMessages } from '../../i18n'
import type { PanelFile } from '../../model'
import { missingOf, type FileDepthModel } from '../model'
import { DepthActions, DepthDialogs, DepthTags, DepthTop } from './DepthParts'

/**
 * A design-review case of SCR-006-files (B-TH-280): the files in depth where they live now — the docked thread's Files view, its
 * slots filled with the depth parts as the docked thread fills them (each document's type and expiry beside its audience marks,
 * Versions / Mark up / What it is on its row, the pop-ups over the window, and the view's "Missing before …" lines from the same
 * documents read). Reopened with its button after Close. Made-up data; nothing is sent.
 */
export interface FilesDepthCaseModel {
  readonly record: { readonly type: string; readonly id: string; readonly label: string }
  readonly party: (FilesParty & { readonly name: string }) | null
  readonly files: readonly PanelFile[]
  readonly depth: FileDepthModel
  /** files.upload (the depth's Mark up and What it is wait without it). */
  readonly canUpload: boolean
  readonly now: number
}

/** A made-up file as the Files view lists it (the docked thread maps the API's file the same way, lib/record-thread/files). */
const threadFileOf = (file: PanelFile, record: FilesDepthCaseModel['record']): ThreadFile => ({
  id: file.id,
  recordType: record.type,
  recordId: record.id,
  name: file.name,
  contentType: file.contentType,
  kind: file.kind,
  sizeBytes: file.sizeBytes,
  status: file.status,
  quarantineReason: file.quarantineReason,
  visibility: file.visibility,
  partyId: file.partyId,
  createdAt: file.createdAt,
  ...(file.versionNo !== undefined ? { versionNo: file.versionNo } : {}),
  seriesId: file.seriesId ?? null,
  supersededAt: file.supersededAt ?? null,
  retainUntil: file.retainUntil,
  legalHold: file.legalHold,
  previewUrl: null,
})

export function FilesDepthCase({ model }: { model: FilesDepthCaseModel }) {
  return (
    <WithMessages namespaces={[FILES_VIEW_NS, 'record-files']}>
      <Case model={model} />
    </WithMessages>
  )
}

function Case({ model }: { model: FilesDepthCaseModel }) {
  const t = useT(FILES_VIEW_NS)
  const tf = useT('record-files')
  const locale = useLocale()
  const [open, setOpen] = useState(true)
  const byId = new Map(model.files.map((file) => [file.id, file] as const))
  const missing = missingOf(model.depth.documents).map((need) => {
    const kind = tf(`category.${need.category}`)
    return { id: need.id, document: need.expiredOn ? `${kind} (${tf('required.expiredOn', { date: formatDate(need.expiredOn, { locale }) })})` : kind, before: tf(`status.${need.toStatus}`), level: need.level }
  })
  return (
    <DockedStage>
      <Button size="sm" onClick={() => setOpen(true)}>
        <FolderOpen size={14} aria-hidden /> {t('design.openAgain')}
      </Button>
      {open && (
        <FilesView
          model={{
            record: model.record,
            party: model.party,
            files: model.files.map((file) => threadFileOf(file, model.record)),
            problem: null,
            can: { upload: model.canUpload, share: model.canUpload, delete: false },
            uploadHeld: model.canUpload ? null : t('upload.noRight'),
            selected: [],
            refused: [],
            missing,
            upload: null,
            now: model.now,
          }}
          actions={{ onClose: () => setOpen(false) }}
          slots={{
            top: <DepthTop depth={model.depth} />,
            tags: (fileId) => {
              const file = byId.get(fileId)
              return file ? <DepthTags depth={model.depth} file={file} /> : null
            },
            rowActions: (fileId) => {
              const file = byId.get(fileId)
              return file ? <DepthActions depth={model.depth} file={file} /> : null
            },
            overlays: <DepthDialogs depth={model.depth} />,
          }}
        />
      )}
    </DockedStage>
  )
}
