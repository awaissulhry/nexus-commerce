'use client'

import { useRef } from 'react'
import { FileImage, FileText, Lock, Upload } from 'lucide-react'
import { Banner, Card, Disclosure, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { FileDropzone, FileRow, Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDateTime, formatNumber } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { ProofViewer, type ViewerProof } from '../../../../../../lib/proofs/ProofViewer'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { ProofVersion, QuoteProof } from '../api'
import { ACCEPT, addHeldOf, codeOf, currentOf, earlierOf, heldOf, viewable, type ProofsPanelActions, type ProofsPanelModel, type Words } from '../model'
import '../proofs.css'

const STATE_TONE = { READY: 'success', UPLOADING: 'info', CHECKING: 'info', REFUSED: 'danger' } as const

/**
 * SCR-035-proofs — Documents › Proofs (B-W2b-165; SAL-199): the proofs the customer accepts with the quote — an artwork
 * proof, a size chart, a measurement sheet. The current version: add (drop or choose a PDF or a picture), a new version of
 * one, remove one, carry over an earlier version's (each held with its reason before the click: the role, the version
 * sent, the version full, an upload running); then each version the customer saw, with what was sent and what the
 * acceptance named (name, version, SHA-256). Every proof opens in the viewer. One view model; it fetches nothing.
 */
export function ProofsPanel({ model, actions }: { model: ProofsPanelModel; actions?: ProofsPanelActions }) {
  return (
    <WithMessages namespaces={['quote-proofs']}>
      <Panel model={model} actions={actions} />
    </WithMessages>
  )
}

function Panel({ model, actions }: { model: ProofsPanelModel; actions?: ProofsPanelActions }) {
  const t = useT('quote-proofs')
  const say = (words: Words) => t(words.key, words.params)
  const data = model.data
  const current = currentOf(data)
  const held = heldOf(data, model.busy !== null)
  const addHeld = addHeldOf(data, model.busy !== null)
  const viewerProofs: ViewerProof[] = (data?.versions ?? []).flatMap((version) =>
    viewable(version).map((proof) => ({ id: proof.currentFileId!, name: proof.name, shape: proof.shape, versionNo: proof.versionNo, src: model.shown[proof.currentFileId!]?.src ?? null, problem: model.shown[proof.currentFileId!]?.problem ?? false })),
  )
  const openVersion = data?.versions.find((version) => version.proofs.some((proof) => proof.currentFileId === model.open)) ?? null
  const openList = openVersion ? viewerProofs.filter((proof) => viewable(openVersion).some((entry) => entry.currentFileId === proof.id)) : []

  return (
    <Card padded className="fw-qp">
      <div className="fw-qp-head">
        <h2 className="fw-q-h2">
          <FileImage size={16} aria-hidden /> {t('office.title')}
        </h2>
        {data?.carry && !held && (
          <Button size="sm" onClick={() => actions?.onCarry?.()}>
            {t('office.carry', { count: data.carry.count, revision: data.carry.revision })}
          </Button>
        )}
      </div>
      <p className="fw-q-hint">{t('office.hint')}</p>

      {model.state === 'loading' && (
        <p className="fw-q-hint" role="status">
          <Spinner size={14} /> {t('office.loading')}
        </p>
      )}
      {model.state === 'error' && (
        <Banner
          tone="danger"
          title={t('office.problem')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('office.retry')}
            </Button>
          }
        />
      )}

      {model.state === 'ready' && current && (
        <>
          {model.notice && <Banner tone="success" title={say(model.notice)} onDismiss={() => actions?.onDismiss?.()} />}
          {model.problem && <Banner tone="danger" title={say(model.problem)} onDismiss={() => actions?.onDismiss?.()} />}
          {held && held.key !== 'office.held.busy' ? (
            <p className="fw-qp-held">
              <Lock size={14} aria-hidden /> {say(held)}
            </p>
          ) : (
            <FileDropzone
              accept={ACCEPT}
              disabled={addHeld !== null}
              onFiles={(files) => actions?.onFiles?.(files)}
              hint={addHeld ? say(addHeld) : t('office.dropShort')}
              labels={{ prompt: t('office.drop') }}
            />
          )}
          {model.busy && (
            <p className="fw-q-hint" role="status">
              <Spinner size={14} /> {model.busy.name ? t(model.busy.step === 'reading' ? 'office.upload.reading' : 'office.upload.sending', { name: model.busy.name }) : t('office.loading')}
            </p>
          )}
          <VersionProofs version={current} model={model} actions={actions} editable={held === null} />
          {earlierOf(data).map((version) => (
            <Disclosure key={version.versionId} summary={`${t('office.versionHead', { revision: version.revision })} · ${t(`office.versionStatus.${version.status}`)}`} open={version.accepted !== null}>
              <div className="fw-qp-stack">
                <VersionProofs version={version} model={model} actions={actions} editable={false} />
              </div>
            </Disclosure>
          ))}
        </>
      )}

      <ProofViewer proofs={openList} openId={model.open} onOpen={(id) => actions?.onOpen?.(id)} onRetry={(id) => actions?.onOpenRetry?.(id)} />
      {model.confirmRemove && <RemoveDialog model={model} actions={actions} />}
    </Card>
  )
}

function VersionProofs({ version, model, actions, editable }: { version: ProofVersion; model: ProofsPanelModel; actions?: ProofsPanelActions; editable: boolean }) {
  const t = useT('quote-proofs')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  return (
    <div className="fw-qp-stack">
      {version.proofs.length === 0 ? (
        <p className="fw-q-hint">{t(version.current && version.sentAt === null ? 'office.none' : 'office.noneSent')}</p>
      ) : (
        <ul className="fw-qp-list" aria-label={t('office.versionHead', { revision: version.revision })}>
          {version.proofs.map((proof) => (
            <li key={proof.seriesId}>
              <ProofRow proof={proof} editable={editable} busy={model.busy !== null} actions={actions} place={place} />
            </li>
          ))}
        </ul>
      )}
      {version.accepted && (
        <section className="fw-qp-accepted" aria-label={t('office.accepted.title', { revision: version.revision })}>
          <h3 className="fw-qp-h3">{t('office.accepted.title', { revision: version.revision })}</h3>
          <p className="fw-q-hint">{t('office.accepted.by', { name: version.accepted.signerName ?? '—', at: formatDateTime(version.accepted.acceptedAt, place) })}</p>
          {version.accepted.proofs.length === 0 ? (
            <p className="fw-q-hint">{t('office.accepted.none')}</p>
          ) : (
            <SummaryTable
              label={t('office.accepted.title', { revision: version.revision })}
              columns={[t('office.accepted.name'), t('office.accepted.version'), t('office.accepted.code'), t('office.accepted.size')]}
              align={['left', 'right', 'left', 'right']}
              rows={version.accepted.proofs.map((proof) => ({ id: proof.fileId, cells: [proof.name, String(proof.versionNo), <code key="c" className="fw-qp-code">{proof.sha256}</code>, sizeOf(proof.sizeBytes, locale)] }))}
              stackOnPhone
            />
          )}
        </section>
      )}
    </div>
  )
}

const sizeOf = (bytes: number, locale: 'it' | 'en'): string =>
  bytes >= 1024 * 1024
    ? formatNumber(bytes / (1024 * 1024), locale, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })
    : formatNumber(Math.max(1, Math.round(bytes / 1024)), locale, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 })

function ProofRow({ proof, editable, busy, actions, place }: { proof: QuoteProof; editable: boolean; busy: boolean; actions?: ProofsPanelActions; place: { locale: 'it' | 'en'; timeZone?: string | undefined } }) {
  const t = useT('quote-proofs')
  const input = useRef<HTMLInputElement>(null)
  const added = proof.addedBy ? t('office.addedBy', { at: formatDateTime(proof.addedAt, place), name: proof.addedBy }) : t('office.addedAt', { at: formatDateTime(proof.addedAt, place) })
  return (
    <FileRow
      name={proof.name}
      size={proof.sizeBytes}
      tone={proof.state === 'REFUSED' ? 'danger' : 'neutral'}
      status={
        <span className="fw-qp-status">
          <Pill tone={STATE_TONE[proof.state]}>{t(`office.state.${proof.state}`)}</Pill>
          <Tag tone="neutral">{t('office.fileVersion', { n: proof.versionNo })}</Tag>
          {proof.sourceFileId && <Tag tone="neutral">{t('office.copied')}</Tag>}
          <span>{proof.sharedWithCustomer ? t('office.shared') : t('office.notShared')}</span>
          <span>{added}</span>
          <code className="fw-qp-code">{t('office.code', { code: codeOf(proof.sha256) })}</code>
          {proof.state !== 'READY' && <span>{t(`office.stateHint.${proof.state}`)}</span>}
        </span>
      }
      actions={
        <>
          <Button size="sm" heldReason={proof.currentFileId ? null : t(`office.stateHint.${proof.state === 'READY' ? 'UPLOADING' : proof.state}`)} onClick={() => proof.currentFileId && actions?.onOpen?.(proof.currentFileId)}>
            {proof.shape === 'PDF' ? <FileText size={14} aria-hidden /> : <FileImage size={14} aria-hidden />} {t('office.open')}
          </Button>
          {editable && (
            <>
              <Button size="sm" heldReason={busy ? t('office.held.busy') : null} onClick={() => input.current?.click()}>
                <Upload size={14} aria-hidden /> {t('office.newVersion')}
              </Button>
              <input
                ref={input}
                type="file"
                hidden
                accept={proof.shape === 'PDF' ? '.pdf' : '.jpg,.jpeg,.png,.webp'}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) actions?.onNewVersion?.(proof.fileId, file)
                }}
              />
            </>
          )}
        </>
      }
      onRemove={editable && !busy ? () => actions?.onRemove?.(proof.fileId) : undefined}
      labels={{ remove: t('office.remove') }}
    />
  )
}

function RemoveDialog({ model, actions }: { model: ProofsPanelModel; actions?: ProofsPanelActions }) {
  const t = useT('quote-proofs')
  const proof = currentOf(model.data)?.proofs.find((entry) => entry.fileId === model.confirmRemove) ?? null
  if (!proof) return null
  return (
    <Modal
      open
      onClose={() => actions?.onRemove?.(null)}
      title={t('office.removeConfirm.title', { name: proof.name })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onRemove?.(null)}>{t('office.removeConfirm.back')}</Button>
          <Button variant="danger" onClick={() => actions?.onRemoveConfirm?.(proof.fileId)}>
            {t('office.removeConfirm.go')}
          </Button>
        </>
      }
    >
      <p className="fw-q-hint">{t('office.removeConfirm.body')}</p>
    </Modal>
  )
}
