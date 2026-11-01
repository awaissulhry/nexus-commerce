'use client'

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { CircleAlert, CircleCheck, CircleX } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { StyleView } from '../../api'
import { complianceAfterRelease, draftOf, issueTab, issueWords, nextRevisionNumber, releaseHeld, releasedOf, revisionInView } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../record-model'
import { Swatch } from './VariantsTab'

const COLOURWAY_CODE = /^[A-Z0-9](?:[A-Z0-9._]{0,10}[A-Z0-9])?$/

/** The studio's pop-ups for the style and its revisions (release, start, abandon, archive) and its colourways. */
export function StyleDialogs({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onDialog?.(null)
  switch (dialog.kind) {
    case 'release':
      return <ReleaseDialog style={style} model={model} actions={actions} onClose={close} />
    case 'startRevision':
      return <StartRevisionDialog style={style} model={model} actions={actions} onClose={close} />
    case 'abandon':
      return <ReasonDialog kind="abandon" style={style} model={model} onClose={close} onRun={(reason) => actions?.onAbandon?.(reason) ?? Promise.resolve(false)} />
    case 'archive':
      return <ReasonDialog kind="archive" style={style} model={model} onClose={close} onRun={(reason) => actions?.onArchive?.(reason) ?? Promise.resolve(false)} />
    case 'colourway':
      return <ColourwayDialog style={style} model={model} actions={actions} colourwayId={dialog.colourwayId} onClose={close} />
    case 'generate':
      return <GenerateDialog style={style} model={model} actions={actions} onClose={close} />
    default:
      return null
  }
}

/** ⌘↵ runs the dialog's primary action (when it is not held). */
function submitKeys(run: () => void) {
  return (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      run()
    }
  }
}

function ReleaseDialog({ style, model, actions, onClose }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions; onClose: () => void }) {
  const t = useT('products')
  const [note, setNote] = useState('')
  const revision = revisionInView(style.revisions, model.revisionId)
  const released = releasedOf(style.revisions)
  const bom = model.bom.status === 'ready' ? model.bom.value : null
  const routing = model.routing.status === 'ready' ? model.routing.value : null
  const compliance = model.compliance.status === 'ready' ? model.compliance.value : null
  const held = releaseHeld(style, revision, bom, model.can)
  const heldText = held ? t(held.key, held.params) : model.busy ? t('held.busy') : null
  const after = complianceAfterRelease(compliance)
  const tabHref = (tab: string) => `${model.prefix}/products/styles/${style.id}?tab=${tab}${model.revisionId ? `&rev=${model.revisionId}` : ''}`
  const run = () => {
    if (heldText) return
    void actions?.onRelease?.(note.trim()).then((done) => done && onClose())
  }
  const checks: Array<{ id: string; ok: boolean; text: ReactNode; fix?: string }> = []
  if (bom) {
    for (const [index, issue] of bom.issues.entries()) {
      const words = issueWords(issue, bom, routing)
      checks.push({ id: `b${index}`, ok: false, text: t(words.key, words.params), fix: tabHref(issueTab(issue)) })
    }
    if (bom.issues.length === 0) {
      checks.push({ id: 'bom', ok: true, text: t('release.okBom', { count: bom.lines.length }) })
      checks.push({ id: 'routing', ok: true, text: routing ? t('release.okRouting', { steps: routing.steps.length, minutes: routing.minutes.perGarment }) : t('release.okRoutingPlain') })
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={revision ? t('release.title', { revision: revision.revision }) : t('release.titlePlain')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={heldText} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {revision ? t('release.go', { revision: revision.revision }) : t('release.titlePlain')}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog" onKeyDown={submitKeys(run)}>
        <h3 className="fw-st-h3">{t('release.checkTitle')}</h3>
        {!bom ? (
          <p className="fw-st-hint">{model.bom.status === 'error' ? t(model.bom.problem) : t('check.checking')}</p>
        ) : (
          <ul className="fw-st-checklist">
            {checks.map((check) => (
              <li key={check.id} className={`fw-st-check ${check.ok ? 'is-ok' : 'is-blocked'}`}>
                {check.ok ? <CircleCheck size={14} aria-hidden /> : <CircleX size={14} aria-hidden />}
                <span>{check.text}</span>
                {check.fix && (
                  <Link className="fw-st-link" href={check.fix} onClick={onClose}>
                    {t('check.fix')}
                  </Link>
                )}
              </li>
            ))}
            {bom.warnings.map((warning, index) => {
              const words = issueWords(warning, bom, routing)
              return (
                <li key={`w${index}`} className="fw-st-check is-warning">
                  <CircleAlert size={14} aria-hidden />
                  <span>
                    {t(words.key, words.params)} <span className="fw-st-hint">· {t('release.warningPasses')}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
        {after.length > 0 && (
          <Banner tone="warning" title={t('release.afterTitle')}>
            <ul className="fw-st-list">
              {after.map((check) => (
                <li key={check.code}>
                  {t(`complianceCheck.${check.code}.BLOCKED`)} — {t('release.blocks', { steps: check.blocks.map((step) => t(`blocks.${step}`)).join(', ') })}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        <h3 className="fw-st-h3">{t('release.whatHappens')}</h3>
        <ul className="fw-st-list">
          <li>{t('release.becomes', { revision: revision?.revision ?? 0 })}</li>
          {released && <li>{t('release.obsoletes', { revision: released.revision })}</li>}
          {style.status === 'DRAFT' && <li>{t('release.activates')}</li>}
          <li>{t('release.frozen')}</li>
        </ul>
        <Field label={t('release.note')} hint={t('release.noteHint')}>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2000} />
        </Field>
      </div>
    </Modal>
  )
}

function StartRevisionDialog({ style, model, actions, onClose }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions; onClose: () => void }) {
  const t = useT('products')
  const [note, setNote] = useState('')
  const next = nextRevisionNumber(style.revisions)
  const released = releasedOf(style.revisions)
  const from = released ?? [...style.revisions].sort((a, b) => b.revision - a.revision)[0] ?? null
  const draft = draftOf(style.revisions)
  const held = draft ? t('held.draftOpen', { revision: draft.revision }) : style.status === 'ARCHIVED' ? t('held.archived') : (from ? !model.can.bomManage : !model.can.manage) ? t('held.noManage') : model.busy ? t('held.busy') : null
  const run = () => {
    if (held) return
    void actions?.onStartRevision?.(note.trim()).then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('startRevision.title', { revision: next })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('action.startRevision', { revision: next })}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog" onKeyDown={submitKeys(run)}>
        <p>{from ? t(released ? 'startRevision.copy' : 'startRevision.copyObsolete', { from: from.revision, revision: next }) : t('startRevision.first')}</p>
        <Field label={t('startRevision.note')} hint={t('startRevision.noteHint')}>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={2000} autoFocus />
        </Field>
      </div>
    </Modal>
  )
}

function ReasonDialog({ kind, style, model, onClose, onRun }: { kind: 'abandon' | 'archive'; style: StyleView; model: StyleRecordViewModel; onClose: () => void; onRun: (reason: string) => Promise<boolean> }) {
  const t = useT('products')
  const [reason, setReason] = useState('')
  const draft = draftOf(style.revisions)
  const held = (kind === 'abandon' ? !model.can.bomManage : !model.can.manage) ? t('held.noManage') : reason.trim().length > 500 ? t('held.long') : model.busy ? t('held.busy') : null
  const run = () => {
    if (held) return
    void onRun(reason.trim()).then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={kind === 'abandon' ? t('abandon.title', { revision: draft?.revision ?? 0 }) : t('archive.title', { code: style.code })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={held} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {kind === 'abandon' ? t('abandon.go') : t('archive.go')}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog" onKeyDown={submitKeys(run)}>
        <ul className="fw-st-list">
          {kind === 'abandon' ? (
            <>
              <li>{t('abandon.what', { revision: draft?.revision ?? 0 })}</li>
              <li>{t('abandon.after')}</li>
            </>
          ) : (
            <>
              <li>{t('archive.reach')}</li>
              <li>{t('archive.kept')}</li>
              <li>{t('archive.back')}</li>
            </>
          )}
        </ul>
        <Field label={t('dialog.reason')} hint={t('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} autoFocus />
        </Field>
      </div>
    </Modal>
  )
}

function ColourwayDialog({ style, model, actions, colourwayId, onClose }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions; colourwayId: string | null; onClose: () => void }) {
  const t = useT('products')
  const current = colourwayId ? style.colourways.find((entry) => entry.id === colourwayId) ?? null : null
  const [code, setCode] = useState(current?.code ?? '')
  const [name, setName] = useState(current?.name ?? '')
  const [colourId, setColourId] = useState<string | null>(current?.colour?.id ?? null)
  const [description, setDescription] = useState(current?.description ?? '')
  const colours = model.libraries.colours
  const chosen = colours?.find((colour) => colour.id === colourId) ?? (current?.colour && current.colour.id === colourId ? current.colour : null)
  const codeTaken = style.colourways.some((entry) => entry.id !== colourwayId && entry.code === code.trim().toUpperCase())
  const held = !COLOURWAY_CODE.test(code.trim().toUpperCase())
    ? t('colourway.held.code')
    : codeTaken
      ? t('colourway.held.taken', { code: code.trim().toUpperCase() })
      : name.trim() === ''
        ? t('colourway.held.name')
        : model.busy
          ? t('held.busy')
          : null
  const run = () => {
    if (held) return
    void actions
      ?.onColourway?.({ code: code.trim().toUpperCase(), name: name.trim(), colourId, description: description.trim() || null }, colourwayId)
      .then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={current ? t('colourway.editTitle', { code: current.code }) : t('colourway.addTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {current ? t('colourway.save') : t('colourway.add')}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog" onKeyDown={submitKeys(run)}>
        <div className="fw-st-form-grid">
          <Field label={t('colourway.code')} required hint={current?.inUse ? t('colourway.codeInUse') : t('colourway.codeHint')}>
            {current?.inUse ? <p className="fw-st-static">{current.code}</p> : <Input value={code} maxLength={12} autoFocus onChange={(event) => setCode(event.target.value.toUpperCase())} />}
          </Field>
          <Field label={t('colourway.name')} required>
            <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </Field>
        </div>
        <Field label={t('colourway.colour')} hint={colours ? t('colourway.colourHint') : t('colourway.colourNone')}>
          <span className="fw-st-inline">
            <Swatch hex={chosen?.hex} label={chosen?.name ?? ''} />
            <Select value={colourId ?? ''} onChange={(event) => setColourId(event.target.value || null)} aria-label={t('colourway.colour')}>
              <option value="">{t('colourway.noColour')}</option>
              {(colours ?? []).map((colour) => (
                <option key={colour.id} value={colour.id}>
                  {colour.code} · {colour.name}
                </option>
              ))}
              {current?.colour && !(colours ?? []).some((colour) => colour.id === current.colour?.id) && (
                <option value={current.colour.id}>
                  {current.colour.code} · {current.colour.name}
                </option>
              )}
            </Select>
          </span>
        </Field>
        <Field label={t('colourway.description')} hint={t('colourway.descriptionHint')}>
          <Textarea value={description} rows={2} maxLength={1000} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        {!current && style.matrix.generated && <p className="fw-st-hint">{t('colourway.addsSkus', { count: style.sizes.length })}</p>}
      </div>
    </Modal>
  )
}

function GenerateDialog({ style, model, actions, onClose }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions; onClose: () => void }) {
  const t = useT('products')
  const missing = style.matrix.rows
    .filter((row) => row.status === 'ACTIVE')
    .map((row) => ({ code: row.code, sizes: row.cells.filter((cell) => !cell.sku).map((cell) => cell.size) }))
    .filter((row) => row.sizes.length > 0)
  const count = missing.reduce((sum, row) => sum + row.sizes.length, 0)
  const held = !model.can.manage ? t('held.noManage') : count === 0 ? t('matrix.nothingToGenerate') : model.busy ? t('held.busy') : null
  const run = () => {
    if (held) return
    void actions?.onGenerate?.().then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('generate.title', { count })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('generate.go', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog" onKeyDown={submitKeys(run)}>
        <p>{t('generate.what')}</p>
        <ul className="fw-st-list">
          {missing.map((row) => (
            <li key={row.code}>
              <b>{row.code}</b> — {row.sizes.join(', ')}
            </li>
          ))}
        </ul>
        <p className="fw-st-hint">{t('generate.pattern', { example: `${style.code}-${missing[0]?.code ?? 'BLK'}-${missing[0]?.sizes[0] ?? style.baseSize ?? '52'}` })}</p>
      </div>
    </Modal>
  )
}
