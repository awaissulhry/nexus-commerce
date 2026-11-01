'use client'

import { useRef, useState, type ReactNode } from 'react'
import { Download, Eye, FolderOpen, Upload } from 'lucide-react'
import { Banner, Disclosure, EmptyState, Field } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Checkbox, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { FileRow, Modal } from '../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../lib/i18n/format'
import { useLocale, useT } from '../../lib/i18n/provider'
import { pdfViewerLabels } from '../../lib/pdf/labels'
import {
  acceptFor,
  audienceBadges,
  canPreview,
  fileGroups,
  retentionFacts,
  uploadChoices,
  type FileAudience,
  type FileKind,
  type PanelFile,
  type RecordPanelsViewModel,
} from '../model'
import type { RecordPanelsActions } from './actions'

/**
 * The record's files (COL-045, COL-050): who sees each one (badges), its versions (same name, newest on top), what keeps
 * it (legal hold, retention — read only here), a file the store refused (quarantined, with why); upload with a kind and
 * an audience; download (a 60-second signed address); a PDF opens in the design system's viewer.
 */
export function FilesPanel({ model, actions, now }: { model: RecordPanelsViewModel; actions?: RecordPanelsActions; now: Date }) {
  const t = useT('records')
  const shellT = useT('shell')
  const { items, problem } = model.files

  return (
    <div className="fw-rp-files">
      {model.can.upload && (uploadChoices(model).kinds.length > 0 ? (
        <UploadBar model={model} actions={actions} />
      ) : (
        <p className="fw-rp-muted fw-rp-small">{t('files.upload.ownedAll')}</p>
      ))}

      {model.uploads.length > 0 && (
        <ul className="fw-rp-filelist" aria-label={t('files.uploadsLabel')}>
          {model.uploads.map((upload) => (
            <li key={upload.key} className="fw-rp-file">
              <FileRow
                name={upload.name}
                size={upload.sizeBytes}
                tone={upload.phase === 'failed' ? 'danger' : 'neutral'}
                status={
                  upload.phase === 'failed' ? (
                    t(upload.problem ?? 'files.problem.failed')
                  ) : (
                    <span className="fw-rp-inline" role="status">
                      <Spinner size={12} /> {t(`files.phase.${upload.phase}`)}
                    </span>
                  )
                }
              />
              {upload.phase === 'failed' && (
                <div className="fw-rp-file-actions">
                  <Button size="sm" variant="quiet" onClick={() => actions?.onDismissUpload?.(upload.key)}>
                    {t('files.dismiss')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {problem ? (
        <Banner tone="danger" title={t(problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('files')}>{t('panels.retry')}</Button>} />
      ) : items === null ? (
        <p className="fw-rp-loading" role="status">
          <Spinner size={14} /> {t('files.loading')}
        </p>
      ) : fileGroups(items).length === 0 ? (
        <EmptyState icon={<FolderOpen size={22} aria-hidden />} title={t('files.empty.title')} description={t(model.can.upload ? 'files.empty.bodyUpload' : 'files.empty.body')} />
      ) : (
        <ul className="fw-rp-filelist" aria-label={t('files.listLabel')}>
          {fileGroups(items).map((group) => (
            <li key={group.key} className="fw-rp-file">
              <FileItem file={group.latest} model={model} actions={actions} now={now} version={group.earlier.length > 0 ? group.earlier.length + 1 : null} />
              {group.earlier.length > 0 && (
                <Disclosure className="fw-rp-versions" summary={t('files.earlier', { count: group.earlier.length })}>
                  <ul className="fw-rp-filelist">
                    {group.earlier.map((file, index) => (
                      <li key={file.id} className="fw-rp-file">
                        <FileItem file={file} model={model} actions={actions} now={now} version={group.earlier.length - index} />
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!model.preview} onClose={() => actions?.onClosePreview?.()} title={model.preview?.name ?? ''} size="xl">
        {model.preview && (
          <PdfViewer
            src={model.preview.src}
            title={model.preview.name}
            fileName={model.preview.name}
            labels={pdfViewerLabels(shellT)}
            onDownload={actions?.onDownload ? () => actions.onDownload?.(model.preview!.fileId) : undefined}
            height="min(70vh, 720px)"
          />
        )}
      </Modal>
    </div>
  )
}

function FileItem({ file, model, actions, now, version }: { file: PanelFile; model: RecordPanelsViewModel; actions?: RecordPanelsActions; now: Date; version: number | null }) {
  const t = useT('records')
  const locale = useLocale()
  const facts = retentionFacts(file, now)
  const quarantined = file.status === 'QUARANTINED'
  const added = file.availableAt ?? file.createdAt
  const status: ReactNode = quarantined
    ? t(`files.quarantine.${file.quarantineReason ?? 'unknown'}`)
    : file.status === 'PENDING_UPLOAD'
      ? t('files.pending')
      : t('files.added', { kind: t(`files.kind.${file.kind}`), at: formatDateTime(added, { locale }) })
  const held = !model.can.readFiles ? t('files.held.noRead') : file.status !== 'AVAILABLE' ? t('files.held.notAvailable') : null
  return (
    <>
      <FileRow name={file.name} size={file.sizeBytes} tone={quarantined ? 'danger' : 'neutral'} status={status} />
      <div className="fw-rp-file-meta">
        {version !== null && <Tag tone="neutral">{t('files.version', { n: version })}</Tag>}
        {audienceBadges(file.visibility).map((badge) => (
          <Tag key={badge.audience} tone={badge.tone}>
            {t(badge.key)}
          </Tag>
        ))}
        {quarantined && <Tag tone="danger">{t('files.quarantined')}</Tag>}
        {facts.map((fact) => (
          <Tag key={fact.key} tone={fact.tone}>
            {t(fact.key, fact.until ? { date: formatDate(fact.until, { locale }) } : undefined)}
          </Tag>
        ))}
      </div>
      <div className="fw-rp-file-actions">
        {canPreview(file) && (
          <Button size="sm" variant="quiet" onClick={() => actions?.onPreview?.(file.id)} heldReason={held} aria-label={t('files.previewNamed', { name: file.name })}>
            <Eye size={14} aria-hidden /> {t('files.preview')}
          </Button>
        )}
        <Button size="sm" variant="quiet" onClick={() => actions?.onDownload?.(file.id)} heldReason={held} aria-label={t('files.downloadNamed', { name: file.name })}>
          <Download size={14} aria-hidden /> {t('files.download')}
        </Button>
      </div>
    </>
  )
}

function UploadBar({ model, actions }: { model: RecordPanelsViewModel; actions?: RecordPanelsActions }) {
  const t = useT('records')
  const input = useRef<HTMLInputElement>(null)
  const choices = uploadChoices(model)
  const [kind, setKind] = useState<FileKind>(choices.kinds.includes('ATTACHMENT') ? 'ATTACHMENT' : choices.kinds[0])
  const [shared, setShared] = useState<FileAudience[]>([])
  const partyName = model.party?.name || t('message.theParty')
  const pick = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) actions?.onUpload?.(file, { kind, visibility: ['OFFICE', ...shared] })
  }
  return (
    <section className="fw-rp-upload" aria-label={t('files.upload.label')}>
      <div className="fw-rp-upload-fields">
        <Field label={t('files.upload.kind')} hint={t(`files.kindHint.${kind}`)}>
          <Select size="sm" value={kind} onChange={(event) => setKind(event.target.value as FileKind)}>
            {choices.kinds.map((option) => (
              <option key={option} value={option}>
                {t(`files.kind.${option}`)}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="fw-rp-checklist fw-rp-audiences">
          <legend className="fw-rp-legend">{t('files.upload.audience')}</legend>
          <Checkbox label={t('files.audience.OFFICE')} checked disabled />
          {choices.audiences
            .filter((audience) => audience !== 'OFFICE')
            .map((audience) => (
              <Checkbox
                key={audience}
                label={t(`files.upload.share.${audience}`, { party: partyName })}
                checked={shared.includes(audience)}
                onChange={(event) => setShared((list) => (event.target.checked ? [...list, audience] : list.filter((item) => item !== audience)))}
              />
            ))}
          {choices.audiences.length === 1 && <span className="fw-rp-muted fw-rp-small">{t(model.can.share ? 'files.upload.officeOnlyNoParty' : 'files.upload.officeOnly')}</span>}
        </fieldset>
      </div>
      <div className="fw-rp-upload-go">
        <Button size="sm" onClick={() => input.current?.click()}>
          <Upload size={14} aria-hidden /> {t('files.upload.choose')}
        </Button>
        {kind === 'FISCAL_ARCHIVE' && <span className="fw-rp-muted fw-rp-small">{t('files.upload.fiscalNote')}</span>}
        {choices.owned.length > 0 && (
          <span className="fw-rp-muted fw-rp-small">{t('files.upload.ownedSome', { kinds: choices.owned.map((owned) => t(`files.kind.${owned}`)).join(', ') })}</span>
        )}
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={acceptFor(kind)}
          onChange={(event) => {
            pick(event.target.files)
            event.target.value = ''
          }}
        />
      </div>
    </section>
  )
}
