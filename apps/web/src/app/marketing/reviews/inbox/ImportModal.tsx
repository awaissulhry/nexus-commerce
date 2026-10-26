'use client'

/**
 * Reviews › Inbox › Import reviews (build spec §3.2 "Import", the Inbox-import board): a DS `Modal` with a `Stepper` —
 * File · Match columns · Check · Done; a done step can be opened again until the import ran.
 *
 *   File   drop a .csv / .tsv / .xlsx / .json (up to 10 MB) and say where it is from (Amazon export, Shopify review app,
 *          Etsy, another file) and, for Amazon and other files, the market.
 *   Match  Nexus's guess for each field (one Listbox each, "Not in the file" too) with the first two rows as read;
 *          review text is required; warnings in words (SKUs not in the catalog, e-mail and IP columns never imported).
 *   Check  ready · already in Nexus · cannot import (with every reason, and the rows as a CSV to download).
 *   Done   "186 reviews imported", Open them in the Inbox, Import another file, Undo this import (asks first).
 *
 * Nothing is written before "Import N reviews": the first steps call `POST /api/reviews/import/preview`, which only
 * reads. The import (`…/apply`, with an Idempotency-Key) answers with a `batchId`; undo is `…/import/:batchId/undo`.
 * After each write: `emitInvalidation('review.imported')`, so the Inbox and the Overview read again.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileText } from 'lucide-react'
import { Banner, FileDropzone, Field, Listbox, Modal, Stepper, useActionConfirm, useToast } from '@/design-system/components'
import { downloadCsv } from '@/design-system/grid'
import { Button, Checkbox, RadioCard, Spinner } from '@/design-system/primitives'
import { SUPPORTED_MARKETS, COUNTRY_NAMES } from '@/app/_shared/app-nav'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { reviewsSend } from '../_lib/reviewsFetch'
import {
  IMPORT_ACCEPT, IMPORT_FIELDS, IMPORT_MAX_BYTES, IMPORT_SOURCES, IMPORT_STEPS, canOpenStep, checkCounts, doneWords, fileKindOf, footNote,
  guessWords, importBody, importWarnings, nextHeld, nextLabel, rejectsCsv, sampleValues, shownMapping, sizeWords, sourceNeedsMarket,
  undoWords, type CanonicalField, type FileKind, type ImportPreview, type ImportResult, type ImportSource, type ImportStep, type Mapping,
} from './importModel'
import s from './inbox.module.css'

export interface ImportModalProps {
  open: boolean
  onClose: () => void
  canManage: boolean
}

interface PickedFile {
  name: string
  size: number
  kind: FileKind
  text: string | null
  bytesBase64: string | null
}

const MARKET_OPTIONS = [...new Set([...(SUPPORTED_MARKETS.AMAZON ?? []), ...(SUPPORTED_MARKETS.EBAY ?? [])])]
  .map((code) => ({ value: code, label: COUNTRY_NAMES[code] ?? code }))
  .sort((a, b) => a.label.localeCompare(b.label))

const NOT_IN_FILE = ''

function toBase64(buffer: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function ImportModal({ open, onClose, canManage }: ImportModalProps) {
  const { toast } = useToast()
  const confirm = useActionConfirm()
  const [step, setStep] = useState<ImportStep>(0)
  const [file, setFile] = useState<PickedFile | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [source, setSource] = useState<ImportSource | null>(null)
  const [market, setMarket] = useState<string | null>(null)
  const [mapping, setMapping] = useState<Mapping>({})
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [includeUnlinked, setIncludeUnlinked] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [undoing, setUndoing] = useState(false)
  const readSeq = useRef(0)

  const reset = useCallback(() => {
    setStep(0)
    setFile(null)
    setFileError(null)
    setSource(null)
    setMarket(null)
    setMapping({})
    setPreview(null)
    setIncludeUnlinked(true)
    setError(null)
    setResult(null)
  }, [])
  useEffect(() => { if (!open) reset() }, [open, reset])

  const pickFile = useCallback(async (files: File[]) => {
    const f = files[0]
    if (!f) return
    const kind = fileKindOf(f.name)
    if (!kind) {
      setFileError('Nexus reads .csv, .tsv, .xlsx and .json files.')
      return
    }
    setFileError(null)
    try {
      const picked: PickedFile = kind === 'xlsx'
        ? { name: f.name, size: f.size, kind, text: null, bytesBase64: toBase64(await f.arrayBuffer()) }
        : { name: f.name, size: f.size, kind, text: await f.text(), bytesBase64: null }
      setFile(picked)
      setPreview(null)
      setMapping({})
    } catch {
      setFileError('Nexus could not read this file. Save it again, then pick it.')
    }
  }, [])

  /** Read the file on the server with the current choices: checks only, writes nothing. */
  const runPreview = useCallback(async (own: Mapping, linkUnknown: boolean): Promise<ImportPreview | null> => {
    if (!file || !source) return null
    const seq = ++readSeq.current
    setBusy(true)
    setError(null)
    const res = await reviewsSend<{ preview: ImportPreview }>('POST', '/reviews/import/preview', importBody({
      text: file.text, bytesBase64: file.bytesBase64, fileKind: file.kind, source, market, mapping: own, includeUnlinked: linkUnknown,
    }))
    if (seq !== readSeq.current) return null
    setBusy(false)
    if (!res.data) {
      setError(res.error ?? 'Nexus could not read this file.')
      return null
    }
    setPreview(res.data.preview)
    return res.data.preview
  }, [file, source, market])

  const changeMapping = useCallback((field: CanonicalField, column: string) => {
    const next = { ...mapping, [field]: column }
    setMapping(next)
    void runPreview(next, includeUnlinked)
  }, [mapping, includeUnlinked, runPreview])

  const changeUnlinked = useCallback((value: boolean) => {
    setIncludeUnlinked(value)
    void runPreview(mapping, value)
  }, [mapping, runPreview])

  const runImport = useCallback(async () => {
    if (!file || !source) return
    setBusy(true)
    setError(null)
    const res = await reviewsSend<{ result: ImportResult; batchId: string }>('POST', '/reviews/import/apply', importBody({
      text: file.text, bytesBase64: file.bytesBase64, fileKind: file.kind, source, market, mapping, includeUnlinked,
    }), { idempotent: true, what: 'import' })
    setBusy(false)
    if (!res.data) {
      setError(res.error ?? 'The import did not run. Nothing was imported.')
      return
    }
    setResult(res.data.result)
    setStep(3)
    emitInvalidation({ type: 'review.imported', meta: { batchId: res.data.batchId, count: res.data.result.imported } })
    toast(doneWords(res.data.result).title, 'success')
  }, [file, source, market, mapping, includeUnlinked, toast])

  const undo = useCallback(async () => {
    if (!result) return
    const ok = await confirm.ask({
      level: 'confirm',
      title: `Undo this import of ${result.imported.toLocaleString('en-US')} reviews?`,
      confirmLabel: 'Undo this import',
      reach: 'local-destructive',
      consequences: [
        'Removes the reviews this file added from the Inbox.',
        'Keeps any review someone already replied to, triaged or re-read, and says which.',
        'Nothing was ever sent to a channel by the import, so nothing changes there.',
      ],
    })
    if (!ok) return
    setUndoing(true)
    const res = await reviewsSend<{ removed: number; kept: { id: string; reason: string }[] }>('POST', `/reviews/import/${encodeURIComponent(result.batchId)}/undo`)
    setUndoing(false)
    if (!res.data) {
      toast(res.error ?? 'The import could not be undone.', 'danger')
      return
    }
    emitInvalidation({ type: 'review.imported', meta: { batchId: result.batchId, undone: true } })
    toast(undoWords(res.data), 'success')
    onClose()
  }, [result, confirm, toast, onClose])

  const next = useCallback(async () => {
    if (step === 0) {
      if (await runPreview(mapping, includeUnlinked)) setStep(1)
      return
    }
    if (step === 1) {
      if (await runPreview(mapping, includeUnlinked)) setStep(2)
      return
    }
    if (step === 2) void runImport()
  }, [step, mapping, includeUnlinked, runPreview, runImport])

  const held = nextHeld({ step, fileName: file?.name ?? null, source, market, preview, busy, canManage }, mapping)
  const shown = shownMapping(preview, mapping)
  const columnOptions = [{ value: NOT_IN_FILE, label: 'Not in the file' }, ...(preview?.headers ?? []).map((h) => ({ value: h, label: h }))]

  const footer = (
    <div className={s.importFoot}>
      <Button size="sm" variant="ghost" onClick={onClose}>{step === 3 ? 'Close' : 'Cancel'}</Button>
      <span className={s.footHint}>{footNote(step)}</span>
      {step > 0 && step < 3 && <Button size="sm" onClick={() => setStep((step - 1) as ImportStep)} heldReason={busy ? 'Nexus is reading the file.' : null}>Back</Button>}
      {step < 3 && (
        <Button size="sm" variant="primary" onClick={() => void next()} heldReason={held}>
          {busy && <Spinner size={13} />}
          {nextLabel(step, preview)}
        </Button>
      )}
    </div>
  )

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="lg"
        title="Import reviews"
        subtitle="From a file: Amazon review exports, a Shopify review app, Etsy, or any spreadsheet"
        footer={footer}
        busy={busy}
      >
        <div className={s.importBody}>
          <Stepper
            steps={IMPORT_STEPS.map((label) => ({ key: label, label }))}
            current={step}
            onSelect={(i) => setStep(i as ImportStep)}
            canSelect={(i) => canOpenStep(i, step) && !busy}
          />

          {!canManage && <Banner tone="warning" title="You can read reviews here but not import them.">Ask an admin for the “Manage reviews” permission.</Banner>}
          {error && <Banner tone="danger" title={error} />}

          {step === 0 && (
            <>
              {file ? (
                <div className={s.fileRow}>
                  <FileText size={18} aria-hidden />
                  <span className={s.stack}>
                    <span className={s.main}>{file.name}</span>
                    <span className={s.sub}>{sizeWords(file.size)}{preview ? ` · ${preview.totalRows.toLocaleString('en-US')} rows · ${preview.headers.length} columns` : ''}</span>
                  </span>
                  <Button size="sm" onClick={() => { setFile(null); setPreview(null) }}>Replace file</Button>
                </div>
              ) : (
                <FileDropzone onFiles={(files) => void pickFile(files)} accept={IMPORT_ACCEPT} maxBytes={IMPORT_MAX_BYTES} hint=".csv, .tsv, .xlsx, .json · up to 10 MB" />
              )}
              {fileError && <Banner tone="danger" title={fileError} />}
              <fieldset className={s.sources}>
                <legend className={s.legend}>Where is the file from?</legend>
                <div className={s.sourceGrid}>
                  {IMPORT_SOURCES.map((option) => (
                    <RadioCard
                      key={option.value}
                      name="review-import-source"
                      value={option.value}
                      title={option.title}
                      description={option.description}
                      checked={source === option.value}
                      selected={source === option.value}
                      onChange={() => { setSource(option.value); setPreview(null) }}
                    />
                  ))}
                </div>
              </fieldset>
              {sourceNeedsMarket(source) && (
                <Field label="Market" hint="The market these reviews are from, unless the file says it per row.">
                  <Listbox size="sm" ariaLabel="Market" placeholder="Pick a market" options={MARKET_OPTIONS} value={market ?? undefined} onChange={setMarket} searchable width={240} />
                </Field>
              )}
            </>
          )}

          {step === 1 && preview && (
            <>
              <p className={s.hint}>{guessWords(preview)}</p>
              {importWarnings(preview).map((w) => <Banner key={w.key} tone={w.tone} title={w.title}>{w.body}</Banner>)}
              <div className={s.mapTable} role="table" aria-label="Match the columns">
                <div className={s.mapHead} role="row">
                  <span role="columnheader">Nexus field</span>
                  <span role="columnheader">Column in your file</span>
                  <span role="columnheader">First two rows</span>
                </div>
                {IMPORT_FIELDS.map((field) => {
                  const [v1, v2] = sampleValues(preview, field.key)
                  return (
                    <div key={field.key} className={s.mapRow} role="row">
                      <span role="cell" className={s.mapField}>
                        {field.label}{field.required && <span className={s.required}> (required)</span>}
                        {field.hint && <span className={s.sub}>{field.hint}</span>}
                      </span>
                      <span role="cell">
                        <Listbox
                          size="sm"
                          ariaLabel={`${field.label}: column in your file`}
                          options={columnOptions}
                          value={shown[field.key] ?? NOT_IN_FILE}
                          onChange={(column) => changeMapping(field.key, column)}
                          width="100%"
                        />
                      </span>
                      <span role="cell" className={s.mapSample}><span>{v1}</span><span>{v2}</span></span>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {step === 2 && preview && (
            <>
              <div className={s.counts}>
                {checkCounts(preview, includeUnlinked).map((c) => (
                  <div key={c.label} className={s.countTile}>
                    <span className={s.sub}>{c.label}</span>
                    <span className={s.countValue}>{c.value}</span>
                    <span className={s.sub}>{c.hint}</span>
                  </div>
                ))}
              </div>
              {preview.unknownProductRows > 0 && (
                <Checkbox
                  checked={includeUnlinked}
                  onChange={(e) => changeUnlinked(e.target.checked)}
                  label={`Import the ${preview.unknownProductRows.toLocaleString('en-US')} rows without a product link too`}
                />
              )}
              {preview.rejected.length > 0 && (
                <section className={s.rejects} aria-label="Rows that cannot import">
                  <div className={s.rejectsHead}>
                    <span className={s.main}>{preview.rejected.length.toLocaleString('en-US')} {preview.rejected.length === 1 ? 'row cannot' : 'rows cannot'} import</span>
                    <Button size="sm" onClick={() => downloadCsv('reviews-that-cannot-import.csv', rejectsCsv(preview.rejected))}>
                      <Download size={13} aria-hidden /> Download these rows
                    </Button>
                  </div>
                  <ul className={s.rejectList}>
                    {preview.rejected.slice(0, 50).map((r) => (
                      <li key={r.line}><span className={s.sub}>Row {r.line}</span> {r.reasons.join(' · ')}</li>
                    ))}
                  </ul>
                  {preview.rejected.length > 50 && <p className={s.hint}>The download has all {preview.rejected.length.toLocaleString('en-US')} rows.</p>}
                </section>
              )}
            </>
          )}

          {step === 3 && result && (
            <div className={s.done}>
              <Banner tone="success" title={doneWords(result).title}>{doneWords(result).body}</Banner>
              <div className={s.linkRow}>
                <Button size="sm" variant="primary" onClick={onClose}>Open them in the Inbox</Button>
                <Button size="sm" onClick={reset}>Import another file</Button>
              </div>
              <p className={s.hint}>
                Imported by mistake?{' '}
                <Button size="sm" variant="link" onClick={() => void undo()} heldReason={!canManage ? "You need 'Manage reviews' to undo an import." : undoing ? 'Undoing… this takes a few seconds.' : null}>
                  Undo this import
                </Button>{' '}
                removes these {result.imported.toLocaleString('en-US')} reviews again.
              </p>
            </div>
          )}
        </div>
      </Modal>
      {confirm.element}
    </>
  )
}
