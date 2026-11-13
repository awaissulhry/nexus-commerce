'use client'

import { useState } from 'react'
import { FileText, Lock, Printer, Unlock } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Phrase } from '../../../../_shared/stock/model'
import { BLOCK_REASON_LIST, type BlockReason, type PlaceView } from '../api'
import { blockChecks, blockDraftOf, printHeldOf, printSplit, type BlockDraft, type DepthCan, type PrintActions, type PrintDialogModel } from '../model'

/**
 * The W2b dialogs of Locations (design warehouse.locations pop:lc-block "Block location", page.h "Print labels (W2b)",
 * tab:lc-tab-labels "Bin labels PDF"), shared by the list and the record:
 * - Block location: the reason (a count, damage, a clean-up, other: then the words), a note, the last day it holds (none:
 *   until unblocked); a block already there is changed (its start kept). Nothing moves in or out while it holds.
 * - Unblock: moves go through again. A count's block is the count's own (held before this opens).
 * - Print labels: the places picked on a label printer of their site, or as a PDF printed from the browser (a new tab);
 *   copies and the label's language; a place without a code gets its suggested one first; outside, transit and archived
 *   places are left out in words; after a print, the jobs queued and the places refused.
 * Each calls its action and shows the refusal in this page's words; it fetches nothing.
 */

export const DEPTH_WORDS = 'warehouse-depth'

export type DepthDialog = { kind: 'block'; locationId: string; draft?: BlockDraft; refusal?: Phrase | null } | { kind: 'unblock'; locationId: string; refusal?: Phrase | null }

export interface DepthDialogActions {
  onBlock?: (place: PlaceView, draft: BlockDraft) => Promise<Phrase | null>
  onUnblock?: (place: PlaceView) => Promise<Phrase | null>
}

export function DepthDialogs({ dialog, places, today, onClose, actions }: { dialog: DepthDialog | null; places: readonly PlaceView[]; today: string; onClose: () => void; actions?: DepthDialogActions }) {
  if (!dialog) return null
  const place = places.find((entry) => entry.id === dialog.locationId)
  if (!place) return null
  if (dialog.kind === 'block') return <BlockDialog key={`block-${place.id}`} dialog={dialog} place={place} today={today} onClose={onClose} onBlock={actions?.onBlock} />
  return <UnblockDialog key={`unblock-${place.id}`} dialog={dialog} place={place} onClose={onClose} onUnblock={actions?.onUnblock} />
}

function BlockDialog({ dialog, place, today, onClose, onBlock }: { dialog: Extract<DepthDialog, { kind: 'block' }>; place: PlaceView; today: string; onClose: () => void; onBlock?: DepthDialogActions['onBlock'] }) {
  const t = useT(DEPTH_WORDS)
  const s = useT('stock')
  const locale = useLocale()
  const [draft, setDraft] = useState<BlockDraft>(dialog.draft ?? blockDraftOf(place))
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Phrase | null>(dialog.refusal ?? null)
  const checks = blockChecks(draft, today)
  const changing = !!place.block?.holds
  const held = busy ? t('wd.loc.busy') : checks.length > 0 ? t(checks[0]!) : null
  const set = (patch: Partial<BlockDraft>) => {
    setRefusal(null)
    setDraft((current) => ({ ...current, ...patch }))
  }
  const block = async () => {
    if (held || !onBlock) return
    setBusy(true)
    const answer = await onBlock(place, draft)
    setBusy(false)
    if (answer) setRefusal(answer)
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t(changing ? 'wd.loc.block.changeTitle' : 'wd.loc.block.title', { code: place.code })}
      subtitle={place.name}
      footer={
        <>
          <Button onClick={onClose}>{s('common.cancel')}</Button>
          <Button variant="danger" heldReason={held} onClick={() => void block()}>
            <Lock size={13} aria-hidden /> {t(changing ? 'wd.loc.block.change' : 'wd.loc.block.do')}
          </Button>
        </>
      }
    >
      <div className="fw-stk-form">
        {refusal && <Banner tone="danger" title={t(refusal.key, refusal.params)} />}
        <p className="fw-stk-hint">{t('wd.loc.block.effect')}</p>
        <Field label={t('wd.loc.block.reason')} required>
          <Select value={draft.reason} onChange={(event) => set({ reason: event.target.value as BlockReason })}>
            <option value="" disabled>
              {t('wd.loc.block.pickReason')}
            </option>
            {BLOCK_REASON_LIST.map((reason) => (
              <option key={reason} value={reason}>
                {t(`wd.loc.reason.${reason}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('wd.loc.block.note')} required={draft.reason === 'OTHER'} hint={t('wd.loc.block.noteHint')}>
          <Textarea value={draft.note} onChange={(event) => set({ note: event.target.value })} limit={500} rows={2} />
        </Field>
        <Field label={t('wd.loc.block.until')} hint={t('wd.loc.block.untilHint')}>
          <DateField value={draft.until} onChange={(until) => set({ until })} locale={INTL_LOCALE[locale]} min={today} ariaLabel={t('wd.loc.block.until')} />
        </Field>
      </div>
    </Modal>
  )
}

function UnblockDialog({ dialog, place, onClose, onUnblock }: { dialog: Extract<DepthDialog, { kind: 'unblock' }>; place: PlaceView; onClose: () => void; onUnblock?: DepthDialogActions['onUnblock'] }) {
  const t = useT(DEPTH_WORDS)
  const s = useT('stock')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Phrase | null>(dialog.refusal ?? null)
  const unblock = async () => {
    if (busy || !onUnblock) return
    setBusy(true)
    const answer = await onUnblock(place)
    setBusy(false)
    if (answer) setRefusal(answer)
  }
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('wd.loc.unblock.title', { code: place.code })}
      footer={
        <>
          <Button onClick={onClose}>{s('common.cancel')}</Button>
          <Button variant="primary" heldReason={busy ? t('wd.loc.busy') : null} onClick={() => void unblock()}>
            <Unlock size={13} aria-hidden /> {t('wd.loc.unblock.do')}
          </Button>
        </>
      }
    >
      <div className="fw-stk-form">
        {refusal && <Banner tone="danger" title={t(refusal.key, refusal.params)} />}
        {place.block && <p className="fw-stk-hint">{t('wd.loc.unblock.now', { reason: t(`wd.loc.reason.${place.block.reason}`) })}</p>}
        <p className="fw-stk-hint">{t('wd.loc.unblock.effect')}</p>
      </div>
    </Modal>
  )
}

/** Print labels / the bin labels PDF of the places picked. */
export function PrintDialog({ model, can, actions }: { model: PrintDialogModel; can: Pick<DepthCan, 'printLabels' | 'manage'>; actions?: PrintActions }) {
  const t = useT(DEPTH_WORDS)
  const s = useT('stock')
  const split = printSplit(model.places)
  const held = printHeldOf(model, can)
  const set = (patch: Partial<PrintDialogModel['draft']>) => actions?.onChange?.({ ...model.draft, ...patch })
  const printers = model.printers?.status === 'ready' ? model.printers.value : []
  const pdf = model.draft.printerId === 'PDF'

  if (model.done) {
    return (
      <Modal
        open
        onClose={() => actions?.onClose?.()}
        size="md"
        title={model.done.pdfLeftOut ? t('wd.loc.print.pdfDoneTitle') : t('wd.loc.print.doneTitle', { count: model.done.jobs.length })}
        footer={
          <Button variant="primary" onClick={() => actions?.onClose?.()}>
            {s('common.close')}
          </Button>
        }
      >
        <div className="fw-stk-form">
          {model.done.jobs.length > 0 && <Banner tone="success" title={t('wd.loc.print.done', { count: model.done.jobs.length })}>{t('wd.loc.print.doneBody')}</Banner>}
          {!!model.done.pdfLeftOut && (
            <Banner tone="warning" title={t('wd.loc.print.pdfLeftOut', { count: model.done.pdfLeftOut })}>
              {t('wd.loc.print.pdfLeftOutBody')}
            </Banner>
          )}
          {model.done.refused.length > 0 && (
            <Banner tone="warning" title={t('wd.loc.print.refusedTitle', { count: model.done.refused.length })}>
              <ul className="fw-wd-list">
                {model.done.refused.map((entry) => (
                  <li key={entry.code}>{t('wd.loc.print.refusedLine', { code: entry.code, why: t(entry.key) })}</li>
                ))}
              </ul>
            </Banner>
          )}
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t('wd.loc.print.title', { count: split.printable.length })}
      subtitle={t('wd.loc.print.site', { site: model.siteCode })}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{s('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held.key, held.params) : null} onClick={() => actions?.onPrint?.()}>
            {pdf ? <FileText size={13} aria-hidden /> : <Printer size={13} aria-hidden />} {t(pdf ? 'wd.loc.print.pdf' : 'wd.loc.print.do', { count: split.printable.length })}
          </Button>
        </>
      }
    >
      <div className="fw-stk-form">
        {model.problem && <Banner tone="danger" title={t(model.problem.key, model.problem.params)} />}
        <Field label={t('wd.loc.print.printer')} hint={pdf ? t('wd.loc.print.pdfHint') : t('wd.loc.print.printerHint')}>
          <Select value={model.draft.printerId} onChange={(event) => set({ printerId: event.target.value })}>
            {can.printLabels && (
              <option value="" disabled>
                {model.printers?.status === 'loading' ? t('wd.loc.print.printersLoading') : printers.length === 0 ? t('wd.loc.print.noPrinters') : t('wd.loc.print.pickPrinter')}
              </option>
            )}
            {can.printLabels &&
              printers.map((printer) => (
                <option key={printer.id} value={printer.id}>
                  {`${printer.code} · ${printer.name}`}
                </option>
              ))}
            <option value="PDF">{t('wd.loc.print.inBrowser')}</option>
          </Select>
        </Field>
        <div className="fw-wd-pair">
          <Field label={t('wd.loc.print.copies')} hint={t('wd.loc.print.copiesHint')}>
            <Input type="number" inputMode="numeric" min={1} max={10} value={String(model.draft.copies)} onChange={(event) => set({ copies: Math.max(0, Math.min(99, Number(event.target.value) || 0)) })} />
          </Field>
          <Field label={t('wd.loc.print.language')}>
            <Select value={model.draft.language} onChange={(event) => set({ language: event.target.value === 'en' ? 'en' : 'it' })}>
              <option value="it">{t('wd.loc.print.lang.it')}</option>
              <option value="en">{t('wd.loc.print.lang.en')}</option>
            </Select>
          </Field>
        </div>
        {split.needCode.length > 0 && <p className="fw-stk-hint">{t('wd.loc.print.needCode', { count: split.needCode.length })}</p>}
        {split.refused.length > 0 && (
          <Banner tone="warning" title={t('wd.loc.print.leftOut', { count: split.refused.length })}>
            <ul className="fw-wd-list">
              {split.refused.slice(0, 6).map((entry) => (
                <li key={entry.place.id}>{t('wd.loc.print.refusedLine', { code: entry.place.code, why: t(entry.key) })}</li>
              ))}
            </ul>
          </Banner>
        )}
        {model.printers?.status === 'error' && <p className="fw-stk-hint">{s(model.printers.problem)}</p>}
        {!can.printLabels && <p className="fw-stk-hint">{t('wd.loc.print.noRightPdf')}</p>}
      </div>
    </Modal>
  )
}
