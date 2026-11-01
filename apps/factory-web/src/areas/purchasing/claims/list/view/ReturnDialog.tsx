'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, FilePlus2, FileText, Search, Undo2 } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Radio, Select, Spinner, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money, quantity } from '../../../../_shared/buying/model'
import { CLAIM_FOUND_AT, type ClaimFoundAt, type LotRow } from '../../api'
import { isHideLot, newClaimHeld, plain, returnHeld, say, type ClaimsCan, type ReturnDialogModel, type ReturnDraft } from '../../model'
import { DdtFields } from '../../parts/DdtFields'

const QUALITY_TONE = { QUARANTINE: 'warning', RELEASED: 'success', BLOCKED: 'danger', REJECTED: 'danger' } as const

export interface ReturnDialogActions {
  onClose?: () => void
  onDraft?: (draft: ReturnDraft) => void
  onSearch?: (q: string) => void
  onPick?: (lot: LotRow | null) => void
  onContacts?: () => void
  onCreate?: () => void
  onOpenDdt?: (ddtId: string) => void
}

/**
 * Return to supplier (design purchasing.claims pop:return: "Lot, quantity, reason; creates the return DDT, takes stock
 * out, records the credit expected"; Create return; Esc closes and the focus goes back to the opener) — in ONE act on
 * the server: the claim is made and sent to the supplier, the goods leave the stock, the return DDT is issued. The lot
 * (searched among the lots in stock), what goes back (a leather lot's hides one by one, else how much from each place),
 * why (the CLAIM reason list), what is asked (a credit or a replacement), an optional e-mail to the supplier's contacts,
 * and the DDT's transport. Create return is held with the first missing thing; a refusal is said in our words; the
 * result names the claim, the DDT (its PDF in a new tab) and the credit expected (cost grain only).
 */
export function ReturnDialog({ model, can, prefix, actions }: { model: ReturnDialogModel; can: ClaimsCan; prefix: string; actions?: ReturnDialogActions }) {
  const t = useT('purchasing-claims')
  const locale = useLocale()
  const draft = model.draft
  const set = (next: Partial<ReturnDraft>) => actions?.onDraft?.({ ...draft, ...next })
  const [query, setQuery] = useState(draft.q)
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])

  if (model.result) {
    const answer = model.result
    const claimHref = `${prefix}/purchasing/claims/${answer.claim.id}`
    return (
      <Modal
        open
        onClose={() => actions?.onClose?.()}
        title={t('ret.done.title', { number: answer.claim.number })}
        size="lg"
        footer={
          <>
            <span className="grow" />
            <Button size="sm" onClick={() => actions?.onClose?.()}>
              {t('common.close')}
            </Button>
            <Button size="sm" variant="primary" asChild>
              <Link href={claimHref}>{t('ret.done.open')}</Link>
            </Button>
          </>
        }
      >
        <div className="fw-by-dialog">
          <Banner tone="success" title={t('ret.done.banner', { number: answer.claim.number, supplier: answer.claim.supplier.name, ddt: answer.ddt.number })} />
          <KeyValue
            dense
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('ret.done.claim'), value: <Link className="fw-by-link" href={claimHref}>{answer.claim.number}</Link>, hint: t(`statusIn.${answer.claim.status}`) },
              { label: t('ret.done.goods'), value: t('ret.done.goodsValue', { count: answer.moveIds.length }) },
              {
                label: t('ret.done.ddt'),
                value: (
                  <span className="fw-by-inline">
                    {answer.ddt.number}
                    <Button size="sm" variant="quiet" heldReason={!can.files ? t('held.permissionPlain', { permission: 'files.read' }) : answer.ddt.pdfProblem ? t('ret.done.pdfLater') : null} onClick={() => actions?.onOpenDdt?.(answer.ddt.id)}>
                      <ExternalLink size={13} aria-hidden /> {t('goods.openPdf')}
                    </Button>
                  </span>
                ),
                hint: answer.ddt.pdfProblem ? t('ret.done.pdfLater') : undefined,
              },
              ...(can.cost ? [{ label: t('credit.expected'), value: answer.claim.expectedCreditAmount != null ? money(answer.claim.expectedCreditAmount, answer.claim.currency, locale) : t('credit.none') }] : []),
            ]}
          />
          {answer.overReserved.length > 0 && <Banner tone="warning" title={t('ret.done.overReserved', { count: answer.overReserved.length })}>{t('ret.done.overReservedBody')}</Banner>}
        </div>
      </Modal>
    )
  }

  // B-W2b-14: New claim — the lot, its goods and the reason only (no mail, no DDT): a draft that keeps the goods.
  const claiming = model.mode === 'claim'
  const held = model.busy ? t('held.busy') : (() => {
    const reason = claiming ? newClaimHeld(draft, can) : returnHeld(draft, can)
    return reason ? say(t, reason) : null
  })()
  const lot = draft.lot
  const reasons = draft.reasons.value ?? []
  const picked = reasons.find((reason) => reason.code === draft.reasonCode) ?? null
  const label = (reason: { labelIt: string; labelEn: string }) => (locale === 'it' ? reason.labelIt : reason.labelEn)

  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={claiming ? t('newClaim.title') : t('ret.title')}
      subtitle={claiming ? t('newClaim.subtitle') : t('ret.subtitle')}
      size="lg"
      busy={model.busy}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()} heldReason={model.busy ? t('held.busy') : null}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onCreate?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? <Spinner size={12} /> : claiming ? <FilePlus2 size={13} aria-hidden /> : <Undo2 size={13} aria-hidden />} {claiming ? t('newClaim.create') : t('ret.create')}
          </Button>
        </>
      }
    >
      <div className="fw-by-dialog">
        <section className="fw-cl-section" aria-label={t('ret.lotTitle')}>
          <h3 className="fw-by-h3">{t('ret.lotTitle')}</h3>
          {!can.stock ? (
            <Banner tone="info" title={claiming ? t('newClaim.noStockRight') : t('ret.noStockRight')} />
          ) : lot ? (
            <div className="fw-cl-pick">
              <Pill tone={QUALITY_TONE[lot.qualityStatus]}>{t(`lotQuality.${lot.qualityStatus}`)}</Pill>
              <span className="fw-cl-pick-body">
                <span className="fw-by-ellipsis">
                  <b>{lot.code}</b> · {lot.item.code} {lot.item.name}
                  {lot.colour ? ` · ${lot.colour.name}` : ''}
                </span>
                <span className="fw-by-cell-sub">{[lot.supplier?.name ?? t('ret.noSupplier'), lot.receipt ? t('ret.fromReceipt', { number: lot.receipt.number }) : null, t('ret.onHand', { quantity: quantity(lot.onHand, locale), unit: t(`uom.${lot.item.baseUom}`) })].filter(Boolean).join(' · ')}</span>
              </span>
              <Button size="sm" variant="quiet" onClick={() => actions?.onPick?.(null)}>
                {t('ret.change')}
              </Button>
            </div>
          ) : (
            <>
              <Input
                size="sm"
                type="search"
                leadingIcon={<Search size={13} aria-hidden />}
                aria-label={t('ret.search')}
                placeholder={t('ret.search')}
                value={query}
                autoFocus
                onChange={(event) => {
                  typed.current = true
                  setQuery(event.target.value)
                }}
              />
              {draft.found === null ? (
                <p className="fw-by-hint">{t('ret.searchHint')}</p>
              ) : draft.found.problem ? (
                <Banner tone="danger" title={t(draft.found.problem)} />
              ) : draft.found.value === null ? (
                <p className="fw-by-hint" role="status">
                  <Spinner size={14} /> {t('common.loading')}
                </p>
              ) : draft.found.value.length === 0 ? (
                <EmptyState title={t('ret.noLots.title')} description={t(claiming ? 'newClaim.noLotsBody' : 'ret.noLots.body')} />
              ) : (
                <ul className="fw-cl-picks" aria-label={t('ret.results')}>
                  {draft.found.value.map((option) => (
                    <li key={option.id} className="fw-cl-pick">
                      <Pill tone={QUALITY_TONE[option.qualityStatus]}>{t(`lotQuality.${option.qualityStatus}`)}</Pill>
                      <span className="fw-cl-pick-body">
                        <span className="fw-by-ellipsis">
                          <b>{option.code}</b> · {option.item.code} {option.item.name}
                        </span>
                        <span className="fw-by-cell-sub">{[option.supplier?.name ?? t('ret.noSupplier'), t('ret.onHand', { quantity: quantity(option.onHand, locale), unit: t(`uom.${option.item.baseUom}`) }), option.hides > 0 ? t('ret.hides', { count: option.hides }) : null].filter(Boolean).join(' · ')}</span>
                      </span>
                      <Button size="sm" onClick={() => actions?.onPick?.(option)} aria-label={t('ret.pickLot', { lot: option.code })}>
                        {t('ret.pick')}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        {lot && (
          <section className="fw-cl-section" aria-label={claiming ? t('newClaim.goodsTitle') : t('ret.goodsTitle')}>
            <h3 className="fw-by-h3">{claiming ? t('newClaim.goodsTitle') : t('ret.goodsTitle')}</h3>
            {isHideLot(lot) ? (
              draft.hides.problem ? (
                <Banner tone="danger" title={t(draft.hides.problem)} />
              ) : !draft.hides.value ? (
                <p className="fw-by-hint" role="status">
                  <Spinner size={14} /> {t('common.loading')}
                </p>
              ) : draft.hides.value.length === 0 ? (
                <p className="fw-by-hint">{t('ret.noHideInStock', { lot: lot.code })}</p>
              ) : (
                <>
                  <Checkbox
                    checked={draft.hideIds.length === draft.hides.value.length}
                    onChange={(event) => set({ hideIds: event.target.checked ? draft.hides.value!.map((hide) => hide.id) : [] })}
                    label={t('ret.allHides', { count: draft.hides.value.length })}
                  />
                  <ul className="fw-cl-picks" aria-label={t('ret.hidesLabel', { lot: lot.code })}>
                    {draft.hides.value.map((hide) => (
                      <li key={hide.id} className="fw-cl-pick">
                        <Checkbox checked={draft.hideIds.includes(hide.id)} onChange={(event) => set({ hideIds: event.target.checked ? [...draft.hideIds, hide.id] : draft.hideIds.filter((id) => id !== hide.id) })} aria-label={t('ret.hideLabel', { hide: hide.code })} />
                        <span className="fw-cl-pick-body">
                          <span className="fw-by-ellipsis">
                            <b>{hide.code}</b>
                            {hide.supplierCode ? ` · ${t('ret.tannery', { code: hide.supplierCode })}` : ''}
                          </span>
                          <span className="fw-by-cell-sub">{[hide.location?.code ?? null, hide.grade ? t('ret.grade', { grade: hide.grade }) : null, hide.defects].filter(Boolean).join(' · ')}</span>
                        </span>
                        <span className="fw-by-num">
                          {quantity(hide.left, locale)} {t(`uom.${hide.item.baseUom}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )
            ) : draft.stock.problem ? (
              <Banner tone="danger" title={t(draft.stock.problem)} />
            ) : !draft.stock.value ? (
              <p className="fw-by-hint" role="status">
                <Spinner size={14} /> {t('common.loading')}
              </p>
            ) : (
              <div className="fw-cl-places">
                {draft.stock.value
                  .filter((row) => Number(row.onHand) > 0)
                  .map((row) => (
                    <Field key={row.location.id} label={t('ret.fromPlace', { place: row.location.code })} hint={t('ret.placeOnHand', { quantity: quantity(row.onHand, locale, 4), unit: t(`uom.${lot.item.baseUom}`) })}>
                      <Input size="sm" inputMode="decimal" value={draft.quantities[row.location.id] ?? ''} onChange={(event) => set({ quantities: { ...draft.quantities, [row.location.id]: event.target.value } })} suffix={t(`uom.${lot.item.baseUom}`)} />
                    </Field>
                  ))}
                {draft.stock.value.every((row) => Number(row.onHand) <= 0) && <p className="fw-by-hint">{t('ret.nothingInStock', { lot: lot.code })}</p>}
              </div>
            )}
          </section>
        )}

        <section className="fw-cl-section" aria-label={t('ret.whyTitle')}>
          <h3 className="fw-by-h3">{t('ret.whyTitle')}</h3>
          <div className="fw-by-fields">
            <Field label={t('field.reason')} required>
              {draft.reasons.problem ? (
                <p className="fw-by-hint">{t(draft.reasons.problem)}</p>
              ) : (
                <Select size="sm" value={draft.reasonCode} onChange={(event) => set({ reasonCode: event.target.value })}>
                  <option value="">{draft.reasons.value ? t('field.pickReason') : t('common.loading')}</option>
                  {reasons.map((reason) => (
                    <option key={reason.code} value={reason.code}>
                      {label(reason)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('field.remedy')} required>
              <span className="fw-by-inline" role="radiogroup" aria-label={t('field.remedy')}>
                <Radio name="ret-remedy" checked={draft.remedy === 'CREDIT'} onChange={() => set({ remedy: 'CREDIT' })} label={t('remedy.CREDIT')} />
                <Radio name="ret-remedy" checked={draft.remedy === 'REPLACEMENT'} onChange={() => set({ remedy: 'REPLACEMENT' })} label={t('remedy.REPLACEMENT')} />
              </span>
            </Field>
          </div>
          <Field label={t('field.reasonNote')} required={!!picked?.needsDetail} hint={picked?.needsDetail ? t('field.reasonNoteNeeded') : t('field.reasonNoteHint')}>
            <Textarea rows={2} maxLength={500} value={draft.reasonNote} onChange={(event) => set({ reasonNote: event.target.value })} />
          </Field>
          {claiming && (
            <Field label={t('field.foundAt')} hint={t('newClaim.foundAtHint')}>
              <Select size="sm" value={draft.foundAt} onChange={(event) => set({ foundAt: event.target.value as ClaimFoundAt | '' })}>
                <option value="">{t('newClaim.foundAtDefault')}</option>
                {CLAIM_FOUND_AT.map((at) => (
                  <option key={at} value={at}>
                    {t(`foundAt.${at}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </section>

        {claiming ? (
          <ul className="fw-by-list">
            <li>{t('newClaim.does.draft', { supplier: lot?.supplier?.name ?? '—' })}</li>
            <li>{t('newClaim.does.goods')}</li>
            <li>{t('newClaim.does.next')}</li>
          </ul>
        ) : (
        <>
        <section className="fw-cl-section" aria-label={t('ret.mailTitle')}>
          <div className="fw-by-card-head">
            <h3 className="fw-by-h3">{t('ret.mailTitle')}</h3>
            <span className="fw-by-inline">
              <Toggle
                checked={draft.mail}
                onChange={(mail) => {
                  set({ mail })
                  if (mail && draft.contacts === null) actions?.onContacts?.()
                }}
                aria-label={t('ret.mailNow')}
              />
              <span>{t('ret.mailNow')}</span>
            </span>
          </div>
          {!draft.mail ? (
            <p className="fw-by-hint">{t('ret.noMail')}</p>
          ) : !can.parties ? (
            <Banner tone="info" title={t('ret.noPartiesRight')} />
          ) : !lot ? (
            <p className="fw-by-hint">{t('ret.mailAfterLot')}</p>
          ) : draft.contacts?.problem ? (
            <Banner tone="danger" title={t(draft.contacts.problem)} />
          ) : !draft.contacts?.value ? (
            <p className="fw-by-hint" role="status">
              <Spinner size={14} /> {t('common.loading')}
            </p>
          ) : draft.contacts.value.length === 0 ? (
            <Banner tone="warning" title={t('ret.noContacts', { supplier: lot.supplier?.name ?? '—' })} />
          ) : (
            <div className="fw-by-stack">
              <ul className="fw-by-list" aria-label={t('send.recipients')}>
                {draft.contacts.value.map((contact) => (
                  <li key={contact.id}>
                    <Checkbox
                      checked={draft.contactIds.includes(contact.id)}
                      onChange={(event) => set({ contactIds: event.target.checked ? [...draft.contactIds, contact.id] : draft.contactIds.filter((id) => id !== contact.id) })}
                      label={`${contact.name} · ${contact.email}${contact.roles.length > 0 ? ` (${contact.roles.map((role) => t(`contactRole.${role}`)).join(', ')})` : ''}`}
                    />
                  </li>
                ))}
              </ul>
              <Field label={t('ret.message')} hint={t('ret.messageHint')}>
                <Textarea rows={3} maxLength={4000} value={draft.message} onChange={(event) => set({ message: event.target.value })} />
              </Field>
            </div>
          )}
        </section>

        <section className="fw-cl-section" aria-label={t('ret.ddtTitle')}>
          <h3 className="fw-by-h3">
            <FileText size={14} aria-hidden /> {t('ret.ddtTitle')}
          </h3>
          {!can.ddtIssue ? <Banner tone="info" title={t('ret.noDdtRight')} /> : <DdtFields draft={draft.ddt} onChange={(ddt) => set({ ddt })} />}
        </section>

        <ul className="fw-by-list">
          <li>{t('ret.does.claim', { supplier: lot?.supplier?.name ?? '—' })}</li>
          <li>{lot ? (isHideLot(lot) ? t('ret.does.hides', { count: draft.hideIds.length }) : t('ret.does.stock', { lot: lot.code })) : t('ret.does.goods')}</li>
          <li>{t('ret.does.ddt')}</li>
          <li>{can.cost ? t('ret.does.credit') : t('ret.does.creditHidden')}</li>
        </ul>
        </>
        )}
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        {lot && !isHideLot(lot) && draft.stock.value && <p className="fw-by-hint">{t(claiming ? 'newClaim.quantityHint' : 'ret.quantityHint', { unit: t(`uom.${lot.item.baseUom}`), total: plain(lot.onHand) })}</p>}
      </div>
    </Modal>
  )
}
