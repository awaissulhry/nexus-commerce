'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Banner, ConfirmPhraseField, DateField, Field, Modal, phraseMatches } from '@nexus/ui/components'
import { Button, Checkbox, Input, RadioCard, Select, Textarea, Toggle } from '@nexus/ui/primitives'
import { CR_VI_EVIDENCE, LOT_DOCUMENT_KINDS, type EvidenceRule } from '@nexus/factory-domain/quality/lab/rules'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Lot } from '../../../../quality/_shared/lots'
import { CheckList, Facts } from '../../../../quality/_shared/parts'
import type { LotChecklist, LotDecision } from '../../api'
import { CR_VI_METHODS, documentProblems, LEGAL_LIMIT, liveVerdict, mgKg, reasonProblem, resultProblems, type DocumentDraft, type ResultDraft } from '../../model'
import { FileChooser } from '../../view/parts'

/**
 * The lot record's dialogs (design ts-record, ts-release, ts-reject, ts-later-fail; lt-block, lt-status): record a
 * chromium VI result with its report (the verdict said while typing, computed as the API will: never typed), attach a
 * supplier document, and the decisions — release (the checklist, then the lot's code typed; never the person who
 * received it), reject (final: the reason and the code), block (the reason), release again after a block, clear the
 * receiver's hold. Every refusal is said in words; the API's own sentences (a check still open) are listed under them.
 */

const dateLocale = (locale: string) => (locale === 'it' ? 'it-IT' : 'en-GB')

function Problem({ problem, lines }: { problem: string | null; lines?: readonly string[] }) {
  const t = useT('lab')
  if (!problem) return null
  return (
    <Banner tone="danger" title={t(problem)}>
      {lines && lines.length > 0 && (
        <ul className="fw-q-lines">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

/** The live verdict of the result being typed (the domain's own rule, in this app's words). */
export function VerdictLine({ draft, limit }: { draft: ResultDraft; limit: string | null }) {
  const t = useT('lab')
  const locale = useLocale()
  const verdict = liveVerdict(draft, limit)
  const show = (value: string) => mgKg(value, locale)
  if (verdict.kind === 'none') return <p className="fw-q-hint">{t('result.verdict.none', { limit: show(limit ?? LEGAL_LIMIT) })}</p>
  if (verdict.kind === 'problem') return <Banner tone="warning" title={t(verdict.key, { lod: show(verdict.lod ?? '0'), limit: show(verdict.limit) })} />
  if (verdict.kind === 'fail') return <Banner tone="danger" title={t('result.verdict.fail', { value: show(verdict.value), limit: show(verdict.limit) })}>{t('result.verdict.failBody')}</Banner>
  if (verdict.kind === 'notDetected') return <Banner tone="success" title={t('result.verdict.notDetected', { lod: show(verdict.lod), limit: show(verdict.limit) })} />
  return <Banner tone="success" title={t('result.verdict.pass', { value: show(verdict.value), limit: show(verdict.limit) })} />
}

export function ResultDialog({
  open,
  lot,
  rule,
  draft,
  today,
  canThenRelease,
  busy,
  problem,
  lines,
  onDraft,
  onFile,
  onSave,
  onClose,
}: {
  open: boolean
  lot: Lot
  rule: EvidenceRule | null
  draft: ResultDraft
  today: string
  /** The person may release the lot afterwards (quality.lots.release, did not receive it, the lot is in quarantine). */
  canThenRelease: boolean
  busy: boolean
  problem: string | null
  lines?: readonly string[]
  onDraft: (draft: ResultDraft) => void
  onFile: (file: File) => void
  onSave: () => void
  onClose: () => void
}) {
  const t = useT('lab')
  const q = useT('quality')
  const locale = useLocale()
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) setTried(false)
  }, [open])
  const limit = lot.crVi.limitMgKg
  const problems = resultProblems(draft, today, rule, limit)
  const first = Object.values(problems)[0] ?? null
  const shown = (field: string): string | undefined => {
    const key = problems[field]
    if (!key) return undefined
    const typed = field in draft ? String((draft as unknown as Record<string, unknown>)[field] ?? '') !== '' : false
    return tried || typed ? t(key, { limit: mgKg(limit ?? LEGAL_LIMIT, locale), lod: mgKg(draft.detectionLimitMgKg.replace(',', '.') || '0', locale) }) : undefined
  }
  const set = (patch: Partial<ResultDraft>) => onDraft({ ...draft, ...patch })
  const supplier = draft.evidence === 'SUPPLIER_REPORT'
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('result.title', { code: lot.code })}
      subtitle={t('result.sub', { item: `${lot.item.code} · ${lot.item.name}`, limit: mgKg(limit ?? LEGAL_LIMIT, locale) })}
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {q('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setTried(true)
              if (!first) onSave()
            }}
            heldReason={busy ? t('result.saving') : tried && first ? t(first, { limit: mgKg(limit ?? LEGAL_LIMIT, locale), lod: mgKg(draft.detectionLimitMgKg.replace(',', '.') || '0', locale) }) : null}
          >
            {draft.thenRelease ? t('result.saveThenRelease') : t('result.save')}
          </Button>
        </>
      }
    >
      <form
        className="fw-q-form"
        onSubmit={(event) => {
          event.preventDefault()
          setTried(true)
          if (!first) onSave()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            setTried(true)
            if (!first && !busy) onSave()
          }
        }}
      >
        <Problem problem={problem} lines={lines} />
        <div className="fw-q-form-two">
          <Field label={t('result.method')} required error={shown('method')}>
            <Select value={draft.method} onChange={(event) => set({ method: event.target.value })}>
              {CR_VI_METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(`method.${method === 'EN ISO 17075-1' ? 'one' : 'two'}`)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="fw-q-choices">
            <Checkbox label={t('result.belowDetection')} checked={draft.belowDetectionLimit} onChange={(event) => set({ belowDetectionLimit: event.target.checked, valueMgKg: '', detectionLimitMgKg: '' })} />
            {draft.belowDetectionLimit ? (
              <Field label={t('result.lod')} required hint={t('result.lodHint')} error={shown('detectionLimitMgKg')}>
                <Input inputMode="decimal" value={draft.detectionLimitMgKg} onChange={(event) => set({ detectionLimitMgKg: event.target.value })} suffix="mg/kg" />
              </Field>
            ) : (
              <Field label={t('result.value')} required hint={t('result.valueHint')} error={shown('valueMgKg')}>
                <Input inputMode="decimal" value={draft.valueMgKg} onChange={(event) => set({ valueMgKg: event.target.value })} suffix="mg/kg" autoFocus />
              </Field>
            )}
          </div>
        </div>
        <VerdictLine draft={draft} limit={limit} />
        <div className="fw-q-form-three">
          <Field label={t('result.lab')} required error={shown('lab')}>
            <Input value={draft.lab} onChange={(event) => set({ lab: event.target.value })} maxLength={200} />
          </Field>
          <Field label={t('result.reportNumber')}>
            <Input value={draft.reportNumber} onChange={(event) => set({ reportNumber: event.target.value })} maxLength={200} />
          </Field>
          <Field label={t('result.testedOn')} required error={shown('testedOn')}>
            <DateField value={draft.testedOn} onChange={(value) => set({ testedOn: value })} locale={dateLocale(locale)} max={today} placeholder={t('date.notSet')} clearLabel={t('date.clear')} clearable={false} />
          </Field>
        </div>
        <div className="fw-q-choices" role="radiogroup" aria-label={t('result.evidence')}>
          <span className="fw-lab-file-label">{t('result.evidence')}</span>
          {CR_VI_EVIDENCE.map((evidence) => {
            const refused = evidence === 'SUPPLIER_REPORT' && rule === 'LOT_REPORT_REQUIRED'
            return (
              <RadioCard
                key={evidence}
                name="crvi-evidence"
                value={evidence}
                checked={draft.evidence === evidence}
                selected={draft.evidence === evidence}
                disabled={refused}
                onChange={() => set({ evidence })}
                title={t(`evidence.${evidence}`)}
                description={refused ? t('result.supplierRefused') : t(`evidence.hint.${evidence}`)}
              />
            )
          })}
        </div>
        {supplier && (
          <div className="fw-q-form-three">
            <Field label={t('result.article')} required error={shown('article')}>
              <Input value={draft.article} onChange={(event) => set({ article: event.target.value })} maxLength={200} />
            </Field>
            <Field label={t('result.periodFrom')} required error={shown('periodFrom')}>
              <DateField value={draft.periodFrom} onChange={(value) => set({ periodFrom: value })} locale={dateLocale(locale)} placeholder={t('date.notSet')} clearLabel={t('date.clear')} />
            </Field>
            <Field label={t('result.periodTo')} required error={shown('periodTo')}>
              <DateField value={draft.periodTo} onChange={(value) => set({ periodTo: value })} locale={dateLocale(locale)} placeholder={t('date.notSet')} clearLabel={t('date.clear')} />
            </Field>
          </div>
        )}
        <Field label={t('result.note')}>
          <Textarea value={draft.note} onChange={(event) => set({ note: event.target.value })} rows={2} limit={500} counterLabel={(used, max) => t('common.counter', { used, max })} />
        </Field>
        <FileChooser label={t('result.file')} hint={t('result.fileHint')} name={draft.fileName} onFile={onFile} error={tried ? (problems.file ? t(problems.file) : null) : null} />
        {canThenRelease && (
          <label className="fw-q-cell-row">
            <Toggle checked={draft.thenRelease} onChange={(next) => set({ thenRelease: next })} aria-label={t('result.thenRelease')} />
            <span className="fw-q-cell">
              <span>{t('result.thenRelease')}</span>
              <span className="fw-q-hint">{t('result.thenReleaseHint')}</span>
            </span>
          </label>
        )}
      </form>
    </Modal>
  )
}

export function DocumentDialog({
  open,
  lot,
  draft,
  today,
  busy,
  problem,
  onDraft,
  onFile,
  onSave,
  onClose,
}: {
  open: boolean
  lot: Lot
  draft: DocumentDraft
  today: string
  busy: boolean
  problem: string | null
  onDraft: (draft: DocumentDraft) => void
  onFile: (file: File) => void
  onSave: () => void
  onClose: () => void
}) {
  const t = useT('lab')
  const q = useT('quality')
  const locale = useLocale()
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) setTried(false)
  }, [open])
  const problems = documentProblems(draft, today)
  const first = Object.values(problems)[0] ?? null
  const set = (patch: Partial<DocumentDraft>) => onDraft({ ...draft, ...patch })
  const save = () => {
    setTried(true)
    if (!first && !busy) onSave()
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('document.title', { code: lot.code })}
      subtitle={lot.item.isPpeComponent ? t('document.subPpe') : t('document.sub')}
      size="md"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {q('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save} heldReason={busy ? t('document.saving') : tried && first ? t(first) : null}>
            {t('document.save')}
          </Button>
        </>
      }
    >
      <div
        className="fw-q-form"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
      >
        <Problem problem={problem} />
        <Field label={t('document.kind')} required hint={t(`kind.hint.${draft.kind}`)}>
          <Select value={draft.kind} onChange={(event) => set({ kind: event.target.value as DocumentDraft['kind'] })}>
            {LOT_DOCUMENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('document.validTo')} hint={t('document.validToHint')} error={tried || draft.validTo !== '' ? (problems.validTo ? t(problems.validTo) : undefined) : undefined}>
          <DateField value={draft.validTo} onChange={(value) => set({ validTo: value })} locale={dateLocale(locale)} min={today} placeholder={t('date.notSet')} clearLabel={t('date.clear')} />
        </Field>
        <Field label={t('document.note')} required={draft.kind === 'OTHER'} error={tried && problems.note ? t(problems.note) : undefined}>
          <Textarea value={draft.note} onChange={(event) => set({ note: event.target.value })} rows={2} limit={500} counterLabel={(used, max) => t('common.counter', { used, max })} />
        </Field>
        <FileChooser label={t('document.file')} hint={t('result.fileHint')} name={draft.fileName} onFile={onFile} error={tried && problems.file ? t(problems.file) : null} />
      </div>
    </Modal>
  )
}

/** A decision on the lot: release, release again, reject, block, clear the receiver's hold. */
export function DecideDialog({
  open,
  decision,
  lot,
  checklist,
  held,
  code,
  reason,
  busy,
  problem,
  lines,
  onCode,
  onReason,
  onConfirm,
  onClose,
}: {
  open: boolean
  decision: LotDecision
  lot: Lot
  checklist: LotChecklist
  /** Why the decision is held (our words), when it is. */
  held: string | null
  code: string
  reason: string
  busy: boolean
  problem: string | null
  lines?: readonly string[]
  onCode: (code: string) => void
  onReason: (reason: string) => void
  onConfirm: () => void
  onClose: () => void
}) {
  const t = useT('lab')
  const q = useT('quality')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) setTried(false)
  }, [open])
  const needsCode = decision === 'release' || decision === 'reject'
  const needsReason = decision !== 'release'
  const reasonKey = needsReason ? reasonProblem(reason) : null
  const codeOk = !needsCode || phraseMatches(code, lot.code)
  const blocker = held ?? (needsCode && !codeOk ? t('decide.problem.code', { code: lot.code }) : reasonKey ? t(reasonKey) : null)
  const confirm = () => {
    setTried(true)
    if (!blocker && !busy) onConfirm()
  }
  const danger = decision === 'reject' || decision === 'block'
  const checks = decision === 'release' || decision === 'unblock'
  let intro: ReactNode = null
  if (decision === 'reject') intro = <Banner tone="warning" title={t('decide.reject.final')}>{t('decide.reject.next')}</Banner>
  if (decision === 'block') intro = <Banner tone="warning" title={t('decide.block.what')}>{t('decide.block.next')}</Banner>
  if (decision === 'clearHold')
    intro = (
      <Banner tone="info" title={t('decide.clearHold.what')}>
        {lot.hold}
      </Banner>
    )
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(`decide.${decision}.title`, { code: lot.code })}
      subtitle={`${lot.item.code} · ${lot.item.name}`}
      size="md"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {q('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={confirm} heldReason={busy ? t('decide.saving') : tried || held ? blocker : null}>
            {t(`decide.${decision}.confirm`, { code: lot.code })}
          </Button>
        </>
      }
    >
      <div
        className="fw-q-form"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            confirm()
          }
        }}
      >
        <Problem problem={problem} lines={lines} />
        {intro}
        {checks && (
          <>
            <p className="fw-q-hint">{checklist.ready ? t('release.ready') : t('release.open', { count: checklist.open.length })}</p>
            <CheckList label={t('release.checksLabel')} checks={checklist.checks.map((check) => ({ id: check.code, state: check.state, name: t(`check.${check.code}`), text: check.words, fix: check.fix }))} />
          </>
        )}
        {held && <Banner tone="warning" title={held} />}
        {needsReason && (
          <Field label={t(`decide.${decision}.reason`)} required error={tried && reasonKey ? t(reasonKey) : undefined}>
            <Textarea value={reason} onChange={(event) => onReason(event.target.value)} rows={3} limit={500} counterLabel={(used, max) => t('common.counter', { used, max })} />
          </Field>
        )}
        {needsCode && !held && (
          <ConfirmPhraseField
            phrase={lot.code}
            value={code}
            onChange={onCode}
            label={
              <>
                {t('decide.typeCode')} <strong>{lot.code}</strong>
              </>
            }
          />
        )}
        <Facts
          items={[
            { label: t('record.facts.status'), value: t(`status.${lot.qualityStatus}`) },
            { label: t('record.facts.crVi'), value: t(`crVi.${lot.crVi.required ? (lot.crVi.status === 'NOT_REQUIRED' ? 'NOT_REQUIRED' : lot.crVi.status) : 'NOT_REQUIRED'}`) },
            { label: t('record.facts.receipt'), value: lot.receipt ? lot.receipt.number : t('record.opening') },
          ]}
        />
      </div>
    </Modal>
  )
}
