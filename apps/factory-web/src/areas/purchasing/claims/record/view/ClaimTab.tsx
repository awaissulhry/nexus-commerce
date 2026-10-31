'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Camera, ExternalLink, FileText, Trash2 } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Radio, Select, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { usePhotoWords } from '../../../../../lib/ds-words/photo-capture'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dayAt, money, quantity, unitPrice } from '../../../../_shared/buying/model'
import { CLAIM_FOUND_AT, CLAIM_KINDS, letterPreviewHref, type Claim, type ClaimFile, type ClaimLine } from '../../api'
import { actHeld, changedFields, editableFields, fileOpenHeld, formHeld, formOf, letterKeepHeld, photoAddHeld, photoRemoveHeld, reasonWords, say, type ClaimForm, type ClaimRecordActions, type ClaimRecordModel } from '../../model'

/**
 * The Claim tab (design rec "Supplier claim › Claim", saved with an explicit bar): what is wrong and what is asked — the
 * facts the claim came from (the supplier, the receipt and its DDT, the order, where it was found, when it was sent and
 * answered, the supplier's own words, how it was settled), the fields the person may still change (a draft: kind, where
 * found, reason and note, remedy; once sent: the remedy and the credit agreed (cost grain); always: the internal note),
 * saved with ⌘S (Discard; Save held with why; the browser asks before leaving with changes), and the lines (material,
 * lot or hide, the receipt discrepancy it pursues, quantity, value with the cost grain, whether the goods went back) —
 * a draft's lines removed in bulk. B-W2b-14 (SCM-135, the design's W2b "Claim" section): the evidence card — the area
 * affected, the claim's photos (added until it is settled, removed from a draft) beside the photos of the discrepancies it
 * pursues, the supplier's contact with a link to the supplier, the NCR it came from, and the claim letter (preview, a
 * version kept, every version to open).
 */
export function ClaimTab({ claim, model, actions }: { claim: Claim; model: ClaimRecordModel; actions?: ClaimRecordActions }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const form = model.form ?? formOf(claim)
  const editable = editableFields(claim, model.can)
  const changed = changedFields(form, claim, model.can)
  const set = (next: Partial<ClaimForm>) => actions?.onForm?.({ ...form, ...next })
  const person = (id: string | null) => (id ? (claim.people.find((entry) => entry.id === id)?.name ?? null) : null)
  const reasons = model.reasons.value
  const picked = reasons?.find((reason) => reason.code === form.reasonCode) ?? null
  const reason = reasonWords(claim.reason, locale)
  const label = (entry: { labelIt: string; labelEn: string }) => (locale === 'it' ? entry.labelIt : entry.labelEn)

  const facts = [
    { label: t('fact.supplier'), value: claim.supplier.name, hint: claim.supplier.code },
    { label: t('fact.site'), value: claim.site.code },
    {
      label: t('fact.receipt'),
      value: claim.goodsReceipt ? (
        <Link className="fw-by-link" href={`${model.prefix}/warehouse/receipts/${claim.goodsReceipt.id}`}>
          {claim.goodsReceipt.number}
        </Link>
      ) : (
        '—'
      ),
      hint: claim.goodsReceipt?.supplierDdtNumber ? t('fact.supplierDdt', { number: claim.goodsReceipt.supplierDdtNumber, date: claim.goodsReceipt.supplierDdtDate ? formatDate(dayAt(claim.goodsReceipt.supplierDdtDate), place) : '—' }) : undefined,
    },
    {
      label: t('fact.order'),
      value: claim.purchaseOrder ? (
        <Link className="fw-by-link" href={`${model.prefix}/purchasing/orders/${claim.purchaseOrder.id}`}>
          {claim.purchaseOrder.number}
        </Link>
      ) : (
        '—'
      ),
    },
    { label: t('fact.sent'), value: claim.sentAt ? formatDateTime(claim.sentAt, place) : t('fact.notSent'), hint: person(claim.sentById) ? t('fact.by', { name: person(claim.sentById)! }) : undefined },
    { label: t('fact.answered'), value: claim.answeredAt ? formatDateTime(claim.answeredAt, place) : '—' },
    ...(claim.closedAt ? [{ label: t('fact.closed'), value: formatDateTime(claim.closedAt, place) }] : []),
    { label: t('fact.created'), value: formatDateTime(claim.createdAt, place), hint: person(claim.createdById) ? t('fact.by', { name: person(claim.createdById)! }) : undefined },
  ]

  return (
    <div className="fw-by-stack">
      <div className="fw-by-cards fw-by-cards--wide">
        <Card padded>
          <div className="fw-by-card">
            <h2 className="fw-by-h2">{t('claimTab.what')}</h2>
            <div className="fw-by-fields">
              <Editable label={t('field.kind')} editable={editable.has('kind')} value={t(`kind.${claim.kind}`)}>
                <Select size="sm" value={form.kind} onChange={(event) => set({ kind: event.target.value as ClaimForm['kind'] })}>
                  {CLAIM_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(`kind.${kind}`)}
                    </option>
                  ))}
                </Select>
              </Editable>
              <Editable label={t('field.foundAt')} editable={editable.has('foundAt')} value={t(`foundAt.${claim.foundAt}`)}>
                <Select size="sm" value={form.foundAt} onChange={(event) => set({ foundAt: event.target.value as ClaimForm['foundAt'] })}>
                  {CLAIM_FOUND_AT.map((at) => (
                    <option key={at} value={at}>
                      {t(`foundAt.${at}`)}
                    </option>
                  ))}
                </Select>
              </Editable>
              <Editable label={t('field.reason')} editable={editable.has('reasonCode')} value={reason.label ?? '—'} required>
                {model.reasons.problem ? (
                  <p className="fw-by-hint">{t(model.reasons.problem)}</p>
                ) : (
                  <Select size="sm" value={form.reasonCode} onChange={(event) => set({ reasonCode: event.target.value })}>
                    <option value="">{reasons ? t('field.pickReason') : t('common.loading')}</option>
                    {reasons && form.reasonCode && !reasons.some((entry) => entry.code === form.reasonCode) && <option value={form.reasonCode}>{reason.label ?? form.reasonCode}</option>}
                    {(reasons ?? []).map((entry) => (
                      <option key={entry.code} value={entry.code}>
                        {label(entry)}
                      </option>
                    ))}
                  </Select>
                )}
              </Editable>
              <Editable label={t('field.remedy')} editable={editable.has('remedy')} value={claim.remedy ? t(`remedy.${claim.remedy}`) : t('remedy.none')}>
                <span className="fw-by-inline" role="radiogroup" aria-label={t('field.remedy')}>
                  <Radio name="claim-remedy" checked={form.remedy === 'CREDIT'} onChange={() => set({ remedy: 'CREDIT' })} label={t('remedy.CREDIT')} />
                  <Radio name="claim-remedy" checked={form.remedy === 'REPLACEMENT'} onChange={() => set({ remedy: 'REPLACEMENT' })} label={t('remedy.REPLACEMENT')} />
                  {claim.status === 'DRAFT' && <Radio name="claim-remedy" checked={form.remedy === ''} onChange={() => set({ remedy: '' })} label={t('remedy.later')} />}
                </span>
              </Editable>
              {model.can.cost && claim.status !== 'DRAFT' && claim.remedy !== 'REPLACEMENT' && (
                <Editable label={t('field.agreed', { currency: claim.currency })} editable={editable.has('agreed')} value={claim.expectedCreditAmount != null ? money(claim.expectedCreditAmount, claim.currency, locale) : '—'} hint={t('field.agreedHint')}>
                  <Input size="sm" inputMode="decimal" value={form.agreed} onChange={(event) => set({ agreed: event.target.value })} suffix={claim.currency} />
                </Editable>
              )}
            </div>
            <Editable label={t('field.reasonNote')} editable={editable.has('reasonNote')} value={reason.note ?? '—'} hint={picked?.needsDetail ? t('field.reasonNoteNeeded') : t('field.reasonNoteHint')} required={!!picked?.needsDetail}>
              <Textarea rows={2} maxLength={500} value={form.reasonNote} onChange={(event) => set({ reasonNote: event.target.value })} />
            </Editable>
            <Editable label={t('field.internalNote')} editable={editable.has('internalNote')} value={claim.internalNote ?? '—'} hint={t('field.internalNoteHint')}>
              <Textarea rows={2} maxLength={1000} value={form.internalNote} onChange={(event) => set({ internalNote: event.target.value })} />
            </Editable>
            {claim.status !== 'DRAFT' && editable.size > 0 && <p className="fw-by-hint">{t('claimTab.fixedAfterSend')}</p>}
          </div>
        </Card>
        <Card padded>
          <div className="fw-by-card">
            <h2 className="fw-by-h2">{t('claimTab.facts')}</h2>
            <KeyValue dense labelCase="sentence" items={facts} />
            {claim.supplierAnswer && (
              <div className="fw-cl-readfield">
                <span className="fw-cl-readfield-label">{t('fact.supplierAnswer')}</span>
                <p className="fw-cl-said">{claim.supplierAnswer}</p>
              </div>
            )}
            {claim.closeNote && (
              <div className="fw-cl-readfield">
                <span className="fw-cl-readfield-label">{t('fact.closeNote')}</span>
                <p className="fw-cl-said">{claim.closeNote}</p>
              </div>
            )}
            {claim.cancelReason && (
              <div className="fw-cl-readfield">
                <span className="fw-cl-readfield-label">{t('fact.cancelReason')}</span>
                <p className="fw-cl-said">{claim.cancelReason}</p>
              </div>
            )}
          </div>
        </Card>
      </div>

      <EvidenceCard claim={claim} model={model} actions={actions} />

      {changed.length > 0 && <SaveBar count={changed.length} held={(() => { const held = formHeld(form, claim, model.can, reasons); return held ? say(t, held) : null })()} busy={model.saving} onSave={() => actions?.onSave?.()} onDiscard={() => actions?.onForm?.(null)} />}
      {model.formProblem && <Banner tone="danger" title={say(t, model.formProblem)} />}

      <LinesList claim={claim} model={model} actions={actions} />
    </div>
  )
}

/** A field the person may change (its control) or only read (its value as text, never a greyed control). */
function Editable({ label, editable, value, hint, required, children }: { label: string; editable: boolean; value: ReactNode; hint?: string; required?: boolean; children: ReactNode }) {
  if (editable) {
    return (
      <Field label={label} hint={hint} required={required}>
        {children}
      </Field>
    )
  }
  return (
    <div className="fw-cl-readfield">
      <span className="fw-cl-readfield-label">{label}</span>
      <span className="fw-cl-readfield-value">{value === null || value === undefined || value === '' ? '—' : value}</span>
    </div>
  )
}

/** The explicit save (composed: the DS EditModeBar speaks English only): ⌘S saves, Discard, the browser asks before leaving. */
function SaveBar({ count, held, busy, onSave, onDiscard }: { count: number; held: string | null; busy: boolean; onSave: () => void; onDiscard: () => void }) {
  const t = useT('purchasing-claims')
  const latest = useRef({ onSave, held, busy })
  latest.current = { onSave, held, busy }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (!latest.current.held && !latest.current.busy) latest.current.onSave()
    }
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('beforeunload', onLeave)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeunload', onLeave)
    }
  }, [])
  return (
    <div className="fw-cl-savebar" role="region" aria-label={t('save.region')}>
      <span className="fw-by-hint" role="status">
        {t('save.unsaved', { count })} · {t('save.shortcut')}
      </span>
      <span className="fw-by-actions">
        <Button size="sm" onClick={onDiscard} heldReason={busy ? t('held.busy') : null}>
          {t('save.discard')}
        </Button>
        <Button size="sm" variant="primary" onClick={onSave} heldReason={held ?? (busy ? t('held.busy') : null)} aria-keyshortcuts="Meta+S Control+S">
          {t('save.save')}
        </Button>
      </span>
    </div>
  )
}

function LinesList({ claim, model, actions }: { claim: Claim; model: ClaimRecordModel; actions?: ClaimRecordActions }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const picked = claim.lines.filter((line) => selected.includes(line.id))
  const removeHeld = actHeld(claim, 'removeLines', model.can)
  const columns = useMemo<ColDef<ClaimLine>[]>(() => {
    const MaterialCell = ({ data }: ICellRendererParams<ClaimLine>) =>
      data ? (
        <span className="fw-by-cell" title={`${data.item.code} ${data.item.name}`}>
          <span className="fw-by-ellipsis">
            {data.item.code} · {data.item.name}
          </span>
          <span className="fw-by-cell-sub">{data.colour ? `${data.colour.code} ${data.colour.name}` : ''}</span>
        </span>
      ) : null
    const LotCell = ({ data }: ICellRendererParams<ClaimLine>) =>
      data ? (
        <span className="fw-by-cell">
          {data.lot ? (
            <Link className="fw-by-link" href={`${model.prefix}/warehouse/lots/${data.lot.id}`}>
              {data.lot.code}
            </Link>
          ) : (
            <span>—</span>
          )}
          <span className="fw-by-cell-sub">{data.hide ? data.hide.code : ''}</span>
        </span>
      ) : null
    const DiscrepancyCell = ({ data }: ICellRendererParams<ClaimLine>) =>
      data?.discrepancy ? (
        <span className="fw-by-cell">
          <Link className="fw-by-link" href={`${model.prefix}/warehouse/receipts/${data.discrepancy.receiptId}?tab=discrepancies`}>
            {t('lines.discrepancy', { seq: data.discrepancy.seq })}
          </Link>
          <span className="fw-by-cell-sub">{[t(`discrepancyKind.${data.discrepancy.kind}`), t(`discrepancyStatus.${data.discrepancy.status}`)].join(' · ')}</span>
        </span>
      ) : (
        <span className="fw-by-cell-sub">—</span>
      )
    const QuantityCell = ({ data }: ICellRendererParams<ClaimLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-num">
            {quantity(data.quantity, locale, 4)} {t(`uom.${data.uom}`)}
          </span>
          {data.uom !== data.item.baseUom && <span className="fw-by-cell-sub">{`${quantity(data.baseQuantity, locale, 4)} ${t(`uom.${data.item.baseUom}`)}`}</span>}
        </span>
      ) : null
    const ReasonCell = ({ data }: ICellRendererParams<ClaimLine>) => (data ? <span className="fw-by-ellipsis" title={data.reason ?? ''}>{data.reason ?? '—'}</span> : null)
    const ValueCell = ({ data }: ICellRendererParams<ClaimLine>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-num">{money(data.creditAmount ?? null, claim.currency, locale)}</span>
          <span className="fw-by-cell-sub">{data.unitCost ? t('lines.unitCost', { cost: unitPrice(data.unitCost, claim.currency, locale), unit: t(`uom.${data.item.baseUom}`) }) : ''}</span>
        </span>
      ) : null
    const GoneCell = ({ data }: ICellRendererParams<ClaimLine>) => (data ? data.move ? <Tag tone="success">{t('lines.returned')}</Tag> : claim.kind === 'RETURN' ? <Tag tone="warning">{t('lines.here')}</Tag> : <span className="fw-by-cell-sub">{t('lines.kept')}</span> : null)
    return [
      { colId: 'seq', headerName: t('lines.col.seq'), field: 'seq', minWidth: 58, maxWidth: 70, type: 'rightAligned' },
      { colId: 'material', headerName: t('lines.col.material'), minWidth: 200, flex: 1.5, cellRenderer: MaterialCell },
      { colId: 'lot', headerName: t('lines.col.lot'), minWidth: 140, flex: 1, cellRenderer: LotCell },
      { colId: 'discrepancy', headerName: t('lines.col.discrepancy'), minWidth: 150, flex: 1, cellRenderer: DiscrepancyCell },
      { colId: 'quantity', headerName: t('lines.col.quantity'), minWidth: 120, flex: 0.8, cellRenderer: QuantityCell },
      { colId: 'reason', headerName: t('lines.col.reason'), minWidth: 150, flex: 1.1, cellRenderer: ReasonCell },
      ...(model.can.cost ? [{ colId: 'value', headerName: t('lines.col.value'), minWidth: 130, flex: 0.8, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<ClaimLine>] : []),
      { colId: 'gone', headerName: t('lines.col.goods'), minWidth: 120, flex: 0.7, cellRenderer: GoneCell },
    ]
  }, [t, locale, model.prefix, model.can.cost, claim.currency, claim.kind])

  return (
    <ListFrame<ClaimLine>
      label={t('lines.label')}
      rows={claim.lines}
      rowId={(line) => line.id}
      columns={columns}
      listKey={null}
      count={t('lines.count', { count: claim.lines.length })}
      state={claim.lines.length === 0 ? <p className="fw-by-hint">{t('lines.none')}</p> : undefined}
      selection={
        claim.status === 'DRAFT' && model.can.manage
          ? {
              selected,
              onChange: setSelected,
              actions: (
                <Button size="sm" tone="danger" aria-label={t('lines.remove', { count: picked.length })} heldReason={removeHeld ? say(t, removeHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'removeLines', lineIds: picked.map((line) => line.id) })}>
                  <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('lines.remove', { count: picked.length })}</SelectionLabel>
                </Button>
              ),
            }
          : undefined
      }
    />
  )
}

/** B-W2b-14 (SCM-135): what the claim rests on and the letter the supplier gets. */
function EvidenceCard({ claim, model, actions }: { claim: Claim; model: ClaimRecordModel; actions?: ClaimRecordActions }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const photoWords = usePhotoWords()
  const place = { locale, timeZone: model.timeZone }
  const addresses = model.photos ?? {}
  const ids = [...claim.photos, ...claim.discrepancyPhotos].map((photo) => photo.id).join(',')
  useEffect(() => {
    if (model.can.files) actions?.onPhotos?.([...claim.photos, ...claim.discrepancyPhotos].filter((photo) => photo.status === 'AVAILABLE').map((photo) => photo.id))
    // Each new set of photos once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])
  const addHeld = photoAddHeld(claim, model.can)
  const removeHeld = photoRemoveHeld(claim, model.can)
  const openHeld = fileOpenHeld(model.can)
  const keepHeld = letterKeepHeld(model.can)
  const person = (id: string | null) => (id ? (claim.people.find((entry) => entry.id === id)?.name ?? null) : null)
  const area = claim.quantity

  return (
    <Card padded>
      <div className="fw-by-card">
        <h2 className="fw-by-h2">{t('evidence.title')}</h2>
        <KeyValue
          dense
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('evidence.area'), value: area ? `${quantity(area.quantity, locale, 4)} ${t(`uom.${area.uom}`)}` : t('evidence.areaMixed', { count: claim.lines.length }) },
            { label: t('evidence.lots'), value: claim.lots.length > 0 ? claim.lots.map((lot) => lot.code).join(', ') : '—', hint: claim.materials.map((item) => `${item.code} ${item.name}`).join(', ') || undefined },
            {
              label: t('evidence.supplier'),
              value: (
                <Link className="fw-by-link" href={`${model.prefix}/purchasing/suppliers/${claim.supplier.id}`}>
                  {claim.supplier.name}
                </Link>
              ),
              hint: claim.supplierContact ? t('evidence.contact', { name: claim.supplierContact.name, email: claim.supplierContact.email }) : t('evidence.noContact'),
            },
            ...(claim.ncr ? [{ label: t('evidence.ncr'), value: <Link className="fw-by-link" href={`${model.prefix}/quality/ncr/${claim.ncr.id}`}>{claim.ncr.number}</Link> }] : []),
          ]}
        />

        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">{t('evidence.photos', { count: claim.photos.length })}</h3>
          {!model.photoStep && (
            <Button size="sm" heldReason={addHeld ? say(t, addHeld) : model.uploading ? t('held.busy') : null} onClick={() => actions?.onPhotoStep?.(true)}>
              <Camera size={13} aria-hidden /> {t('evidence.addPhoto')}
            </Button>
          )}
        </div>
        {model.photoStep ? (
          <PhotoCapture label={t('evidence.capture', { number: claim.number })} words={photoWords} markup={false} onCapture={async (photo) => void (await actions?.onPhoto?.(photo.photo))} onCancel={() => actions?.onPhotoStep?.(false)} />
        ) : (
          <PhotoGrid photos={claim.photos} addresses={addresses} label={t('evidence.photosLabel', { number: claim.number })} canSee={!openHeld} remove={(photo) => (removeHeld ? null : () => actions?.onDialog?.({ kind: 'removePhoto', fileId: photo.id }))} removeHeld={removeHeld ? say(t, removeHeld) : null} />
        )}
        {claim.discrepancyPhotos.length > 0 && (
          <>
            <h3 className="fw-by-h3">{t('evidence.discrepancyPhotos', { count: claim.discrepancyPhotos.length })}</h3>
            <PhotoGrid photos={claim.discrepancyPhotos} addresses={addresses} label={t('evidence.discrepancyPhotosLabel')} canSee={!openHeld} caption={(photo) => ('discrepancySeq' in photo && photo.discrepancySeq !== null ? t('evidence.fromDiscrepancy', { seq: photo.discrepancySeq as number }) : null)} />
          </>
        )}
        <p className="fw-by-hint">{t('evidence.photosHint')}</p>

        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">
            <FileText size={14} aria-hidden /> {t('letter.title')}
          </h3>
          <span className="fw-by-actions">
            <Button size="sm" variant="quiet" asChild>
              <a href={letterPreviewHref(claim.id)} target="_blank" rel="noopener">
                <ExternalLink size={13} aria-hidden /> {t('letter.preview')}
              </a>
            </Button>
            <Button size="sm" heldReason={keepHeld ? say(t, keepHeld) : model.busy ? t('held.busy') : null} onClick={() => actions?.onKeepLetter?.()}>
              {t('letter.keep')}
            </Button>
          </span>
        </div>
        {claim.letters.length === 0 ? (
          <p className="fw-by-hint">{t('letter.none')}</p>
        ) : (
          <ul className="fw-by-list" aria-label={t('letter.versions')}>
            {claim.letters.map((letter, index) => (
              <li key={letter.id} className="fw-cl-letter">
                <span>
                  {t('letter.version', { version: letter.version, language: t(`language.${letter.language === 'it' ? 'it' : 'en'}`) })} · {formatDateTime(letter.createdAt, place)}
                  {person(letter.createdById) ? ` · ${t('fact.by', { name: person(letter.createdById)! })}` : ''}
                  {index === 0 ? <> {' '}<Tag tone="info">{t('letter.current')}</Tag></> : null}
                </span>
                <Button size="sm" variant="quiet" heldReason={openHeld ? say(t, openHeld) : null} onClick={() => actions?.onOpenFile?.(letter.fileId)} aria-label={t('letter.openVersion', { version: letter.version })}>
                  <ExternalLink size={13} aria-hidden /> {t('letter.open')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="fw-by-hint">{t('letter.hint')}</p>
      </div>
    </Card>
  )
}

/** Thumbnails of stored photos (composed: the DS MediaGallery speaks English only — named in the step's notes). */
function PhotoGrid({ photos, addresses, label, canSee, remove, removeHeld, caption }: { photos: readonly ClaimFile[]; addresses: Readonly<Record<string, string | null>>; label: string; canSee: boolean; remove?: (photo: ClaimFile) => (() => void) | null; removeHeld?: string | null; caption?: (photo: ClaimFile) => string | null }) {
  const t = useT('purchasing-claims')
  if (photos.length === 0) return <p className="fw-by-hint">{t('evidence.noPhotos')}</p>
  return (
    <ul className="fw-cl-photos" aria-label={label}>
      {photos.map((photo, index) => {
        const address = addresses[photo.id]
        const alt = t('evidence.photoAlt', { label, n: index + 1 })
        const onRemove = remove?.(photo)
        return (
          <li key={photo.id} className="fw-cl-photo">
            <span className="fw-cl-photo-frame">
              {!canSee ? (
                <span className="fw-cl-photo-wait">{t('evidence.noFilesRight')}</span>
              ) : photo.status !== 'AVAILABLE' ? (
                <span className="fw-cl-photo-wait">{t('evidence.photoPending')}</span>
              ) : address ? (
                <a href={address} target="_blank" rel="noopener" aria-label={t('evidence.openPhoto', { n: index + 1 })}>
                  <img src={address} alt={alt} loading="lazy" />
                </a>
              ) : address === null ? (
                <span className="fw-cl-photo-wait">{t('evidence.photoFailed')}</span>
              ) : (
                <span className="fw-cl-photo-wait" role="status">
                  <Spinner size={12} /> {t('common.loading')}
                </span>
              )}
            </span>
            {caption?.(photo) && <span className="fw-by-cell-sub">{caption(photo)}</span>}
            {remove && (
              <Button size="sm" variant="quiet" tone="danger" heldReason={onRemove ? null : (removeHeld ?? null)} onClick={() => onRemove?.()} aria-label={t('evidence.removePhoto', { n: index + 1 })}>
                <Trash2 size={13} aria-hidden />
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
