'use client'

import { useEffect, useMemo, useRef } from 'react'
import { ExternalLink, FileArchive, PackageCheck, Send } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, SegmentedControl, Select } from '@nexus/ui/primitives'
import { PACK_CONTENTS, PACK_PURPOSES, PACK_SCOPES, type PackContent } from '@nexus/factory-domain/compliance/techfiles/rules'
import { Combobox, JobProgress, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Pack, PartyOption, ShipmentOption } from '../api'
import { batchList, PACK_LANGUAGES, PACK_TONE, packProblems, shortHash, valueOf, type PackDraft, type Read } from '../model'
import { languageName, NoticeBanner, StatePill, useWords, type Notice } from './parts'

/**
 * pop:tf-pack "Build evidence pack" (design compliance.techfiles; PRD-299): for whom (an authority or a customer, the recipient
 * in words and — for a link later — as a party), the language they understand, the scope (the whole style, batches, a serial
 * range or a shipment), the contents checklist (every kind on by default) with the line "Costs, prices and wages are never
 * included.", then Build pack (⌘Enter). While it builds, JobProgress; the dialog can be left and the build goes on. Built: every
 * document with its fingerprint, Open PDF (a new tab), Send by link…. Fetches nothing.
 */

export interface PackDialogModel {
  file: { id: string; number: string; style: { code: string; name: string } }
  draft: PackDraft
  /** The parties to pick the recipient from (parties.view); null: the person cannot read parties. */
  parties: Read<PartyOption[]> | null
  /** The shipments to scope a pack to (shipping.view); null: none offered. */
  shipments: Read<ShipmentOption[]> | null
  busy: boolean
  problem: Notice | null
  /** The pack asked for: BUILDING while the worker builds it, then BUILT or FAILED. */
  pack: Pack | null
  /** When the build was asked (ms), for JobProgress's clock. */
  startedAt: number | null
  online: boolean
  /** Held by the page (no right to build). */
  held: string | null
}

export interface PackDialogActions {
  onDraft?: (draft: PackDraft) => void
  onPartyQuery?: (q: string) => void
  onShipmentQuery?: (q: string) => void
  onBuild?: () => void
  onClose?: () => void
  onOpenPdf?: (packId: string) => void
  onShare?: (packId: string) => void
}

export function PackDialog({ model, actions }: { model: PackDialogModel; actions?: PackDialogActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const { draft, pack } = model
  const problems = useMemo(() => packProblems(draft), [draft])
  const held = model.held ? t(model.held) : !model.online ? t('held.offline') : problems.length > 0 ? t('held.packDraft', { first: t(problems[0]!) }) : null
  const set = (patch: Partial<PackDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  const toggle = (kind: PackContent, on: boolean) => set({ include: on ? PACK_CONTENTS.filter((entry) => entry === kind || draft.include.includes(entry)) : draft.include.filter((entry) => entry !== kind) })
  const latest = useRef({ held, busy: model.busy, pack, actions })
  latest.current = { held, busy: model.busy, pack, actions }

  // ⌘Enter builds (the design's key) while the draft is being filled.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        const now = latest.current
        if (now.pack || now.busy || now.held) return
        event.preventDefault()
        now.actions?.onBuild?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const title = t('pack.title', { number: model.file.number })
  const languages = PACK_LANGUAGES.includes(draft.language as (typeof PACK_LANGUAGES)[number]) ? PACK_LANGUAGES : [draft.language, ...PACK_LANGUAGES]
  const parties = valueOf(model.parties)
  const shipments = valueOf(model.shipments)

  if (pack) {
    return (
      <Modal
        open
        onClose={() => actions?.onClose?.()}
        title={title}
        subtitle={`${model.file.style.code} · ${model.file.style.name}`}
        size="lg"
        footer={
          <>
            <Button onClick={() => actions?.onClose?.()}>{t('common.close')}</Button>
            {pack.status === 'BUILT' && (
              <>
                <Button onClick={() => actions?.onShare?.(pack.id)}>
                  <Send size={14} aria-hidden /> {t('pack.share')}
                </Button>
                <Button variant="primary" onClick={() => actions?.onOpenPdf?.(pack.id)}>
                  <ExternalLink size={14} aria-hidden /> {t('pack.openPdf')}
                </Button>
              </>
            )}
          </>
        }
      >
        <div className="fw-tf-form">
          <span className="fw-tf-row">
            <span className="fw-tf-code">{pack.number}</span>
            <StatePill group="packStatus" state={pack.status} tone={PACK_TONE[pack.status]} />
            <span className="fw-tf-muted">{t(`purpose.${pack.purpose}`)} · {languageName(pack.language, locale)} · {pack.recipient}</span>
          </span>
          {pack.status === 'BUILDING' && <JobProgress label={t('pack.building')} {...(model.startedAt ? { startedAt: model.startedAt } : {})} note={t('pack.canLeave')} />}
          {pack.status === 'FAILED' && (
            <Banner tone="danger" title={t('pack.failed')}>
              {pack.failureReason ? <p className="fw-tf-muted">{pack.failureReason}</p> : null}
            </Banner>
          )}
          {pack.status === 'BUILT' && (
            <>
              <Banner tone="success" title={t('pack.built', { count: pack.documents ?? pack.contents?.length ?? 0 })}>
                <span className="fw-tf-muted">{t('pack.fingerprint', { hash: shortHash(pack.fingerprint) })}</span>
              </Banner>
              <ol className="fw-tf-contents" aria-label={t('pack.contentsBuilt')}>
                {(pack.contents ?? []).map((entry, index) => (
                  <li key={`${entry.sha256}-${index}`}>
                    <span>{entry.title}</span>
                    <span className="fw-tf-hash" title={entry.sha256}>
                      {shortHash(entry.sha256)}
                    </span>
                  </li>
                ))}
              </ol>
              <span className="fw-tf-row fw-tf-muted">
                <FileArchive size={14} aria-hidden /> {t('pack.files', { pdf: pack.pdf?.name ?? '—', zip: pack.zip?.name ?? '—' })}
              </span>
            </>
          )}
          <p className="fw-tf-never">{t('pack.never')}</p>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={title}
      subtitle={`${model.file.style.code} · ${model.file.style.name}`}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('common.cancel')}</Button>
          <Button variant="primary" aria-keyshortcuts="Meta+Enter" heldReason={held} disabled={model.busy} onClick={() => actions?.onBuild?.()}>
            <PackageCheck size={14} aria-hidden /> {t('pack.build', { count: draft.include.length })}
          </Button>
        </>
      }
    >
      <div className="fw-tf-form">
        <NoticeBanner notice={model.problem} />
        <div className="fw-tf-grid2">
          <Field label={t('pack.purpose')}>
            <SegmentedControl ariaLabel={t('pack.purpose')} size="sm" value={draft.purpose} onChange={(value) => set({ purpose: value as PackDraft['purpose'] })} options={PACK_PURPOSES.map((purpose) => ({ value: purpose, label: t(`purpose.${purpose}`) }))} />
          </Field>
          <Field label={t('pack.language')} hint={t('pack.languageHint')}>
            <Select size="sm" value={draft.language} onChange={(event) => set({ language: event.target.value })}>
              {languages.map((code) => (
                <option key={code} value={code}>
                  {languageName(code, locale)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('pack.recipient')} required hint={t(draft.purpose === 'AUTHORITY' ? 'pack.recipientHintAuthority' : 'pack.recipientHintCustomer')}>
            <Input size="sm" value={draft.recipient} maxLength={300} onChange={(event) => set({ recipient: event.target.value })} />
          </Field>
          <Field label={t('pack.party')} hint={model.parties === null ? t('pack.partyNoRight') : t('pack.partyHint')}>
            {model.parties === null ? (
              <span className="fw-tf-muted">{t('pack.partyNone')}</span>
            ) : (
              <Combobox
                options={(parties ?? []).map((party) => ({ value: party.id, label: `${party.name} · ${party.code}` }))}
                value={draft.recipientPartyId ?? ''}
                placeholder={model.parties.status === 'loading' ? t('common.reading') : t('pack.partyPick')}
                onChange={(value) => {
                  const party = (parties ?? []).find((entry) => entry.id === value)
                  set({ recipientPartyId: value || null, ...(party && !draft.recipient.trim() ? { recipient: party.name } : {}) })
                }}
              />
            )}
          </Field>
        </div>

        <Field label={t('pack.scope')}>
          <SegmentedControl ariaLabel={t('pack.scope')} size="sm" wrap value={draft.scope} onChange={(value) => set({ scope: value as PackDraft['scope'] })} options={PACK_SCOPES.map((scope) => ({ value: scope, label: t(`scope.${scope}`) }))} />
        </Field>
        {draft.scope === 'STYLE' && <p className="fw-tf-muted">{t('pack.scopeStyle')}</p>}
        {draft.scope === 'BATCHES' && (
          <Field label={t('pack.batches')} hint={t('pack.batchesHint', { count: batchList(draft.batchNumbers).length })}>
            <Textarea rows={2} value={draft.batchNumbers} onChange={(event) => set({ batchNumbers: event.target.value })} />
          </Field>
        )}
        {draft.scope === 'SERIALS' && (
          <div className="fw-tf-grid2">
            <Field label={t('pack.serialFrom')}>
              <Input size="sm" value={draft.serialFrom} maxLength={60} onChange={(event) => set({ serialFrom: event.target.value })} />
            </Field>
            <Field label={t('pack.serialTo')}>
              <Input size="sm" value={draft.serialTo} maxLength={60} onChange={(event) => set({ serialTo: event.target.value })} />
            </Field>
          </div>
        )}
        {draft.scope === 'SHIPMENT' && (
          <Field label={t('pack.shipment')} hint={model.shipments === null ? t('pack.shipmentNoRight') : undefined}>
            {model.shipments === null ? (
              <Input size="sm" value={draft.shipmentId} placeholder={t('pack.shipmentId')} onChange={(event) => set({ shipmentId: event.target.value.trim() })} />
            ) : (
              <Combobox
                options={(shipments ?? []).map((shipment) => ({ value: shipment.id, label: `${shipment.number} · ${shipment.partyName}` }))}
                value={draft.shipmentId}
                placeholder={model.shipments.status === 'loading' ? t('common.reading') : t('pack.shipmentPick')}
                onChange={(value) => set({ shipmentId: value })}
              />
            )}
          </Field>
        )}

        <fieldset className="fw-tf-fieldset">
          <legend>{t('pack.contents')}</legend>
          <div className="fw-tf-checks">
            {PACK_CONTENTS.map((kind) => (
              <Checkbox key={kind} label={t(`content.${kind}`)} checked={draft.include.includes(kind)} onChange={(event) => toggle(kind, event.target.checked)} />
            ))}
          </div>
          <span className="fw-tf-row">
            <Button size="sm" variant="quiet" onClick={() => set({ include: [...PACK_CONTENTS] })}>
              {t('pack.all')}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => set({ include: [] })}>
              {t('pack.none')}
            </Button>
          </span>
        </fieldset>
        <p className="fw-tf-never">{t('pack.never')}</p>
        <Field label={t('pack.note')} hint={t('pack.noteHint')}>
          <Textarea rows={2} value={draft.note} maxLength={2000} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        <p className="fw-tf-muted">{t('pack.output')}</p>
      </div>
    </Modal>
  )
}

/** The building pack as one line (the list's and the tab's row): JobProgress until it is built. */
export function PackProgress({ pack, startedAt }: { pack: Pick<Pack, 'status' | 'number'>; startedAt?: number | null }) {
  const t = useWords()
  if (pack.status !== 'BUILDING') return null
  return <JobProgress label={t('pack.buildingNumber', { number: pack.number })} {...(startedAt ? { startedAt } : {})} note={t('pack.canLeave')} />
}

export { shortHash }
