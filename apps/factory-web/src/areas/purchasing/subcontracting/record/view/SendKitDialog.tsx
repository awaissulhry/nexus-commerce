'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Checkbox, Input, Select, Spinner, Toggle } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/buying/model'
import { KIT_DDT_REASONS, TRANSPORT_BY } from '../../api'
import { sendHeld, type DdtDraft, type SendDraft } from '../record-model'
import { Frame, type DialogProps } from './Dialogs'
import { useSay } from './parts'

/**
 * Send kit (design rec kit "Send kit"; SCM-140): our material moves into the workshop's stock location (it stays ours,
 * in our books), the pieces go out per operation and the cut bundles travel, with the DDT for work on our behalf
 * (conto lavorazione, DPR 472/1996) — in ONE act. Per planned line: where it leaves from (a place of the site with what is
 * available there; a tracked material by its released lot), how much. The DDT needs shipping.ddt.issue: without it the
 * kit goes without one and the warehouse issues it later. The floor's Subcontract kits screen (SCR-181) comes later.
 */
export function SendKitDialog({ order, model, actions, draft }: DialogProps & { draft: SendDraft }) {
  const t = useT('subcontract-order')
  const sayWords = useSay()
  const locale = useLocale()
  const held = sendHeld(draft, order)
  const set = (next: Partial<SendDraft>) => actions?.onDialog?.({ kind: 'send', draft: { ...draft, ...next } })
  const setDdt = (next: Partial<DdtDraft>) => set({ ddt: { ...draft.ddt, ...next } })
  const planned = order.kitLines.filter((line) => line.status === 'PLANNED')
  const sources = draft.sources.value ?? {}
  const left = order.operations.filter((operation) => operation.pieces > operation.piecesSent)

  return (
    <Frame model={model} actions={actions} size="lg" title={t('send.title', { number: order.number, workshop: order.workshop.name })} held={held ? sayWords(held) : null} label={t('send.confirm')} onConfirm={() => actions?.onSend?.()}>
      <p className="fw-by-hint">{t('send.body', { location: `${order.location.code} · ${order.location.name}` })}</p>

      <section className="fw-sco-section" aria-label={t('send.kitTitle')}>
        <h3 className="fw-by-h3">{t('send.kitTitle')}</h3>
        {planned.length === 0 ? (
          <p className="fw-by-hint">{t('send.noKit')}</p>
        ) : draft.sources.problem ? (
          <Banner tone="danger" title={t(draft.sources.problem)} />
        ) : draft.sources.value === null ? (
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('send.sourcesLoading')}
          </p>
        ) : (
          <ul className="fw-sco-rows">
            {planned.map((line) => {
              const entry = draft.lines.find((row) => row.lineId === line.id)
              if (!entry) return null
              const options = sources[line.id] ?? []
              const update = (next: Partial<typeof entry>) => set({ lines: draft.lines.map((row) => (row.lineId === line.id ? { ...row, ...next } : row)) })
              return (
                <li key={line.id} className="fw-sco-row">
                  <Checkbox checked={entry.include} onChange={(event) => update({ include: event.target.checked })} label={t('send.line', { seq: line.seq, code: line.item.code, name: line.item.name, colour: line.colour ? ` · ${line.colour.code}` : '' })} />
                  {entry.include && (
                    <div className="fw-by-fields">
                      <Field label={t('send.from')} required hint={line.item.tracking === 'NONE' ? undefined : t('send.fromLot')}>
                        {options.length === 0 ? (
                          <p className="fw-by-hint">{t('send.noStock')}</p>
                        ) : (
                          <Select size="sm" value={entry.source} onChange={(event) => update({ source: event.target.value })}>
                            <option value="">{t('send.pickFrom')}</option>
                            {options.map((option) => (
                              <option key={option.key} value={option.key}>
                                {t('send.option', { location: option.locationCode, lot: option.lotCode ? ` · ${option.lotCode}` : '', hide: option.hideCode ? ` · ${option.hideCode}` : '', available: quantity(option.available, locale, 4), unit: t(`uom.${line.item.baseUom}`) })}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field label={t('send.quantity', { unit: t(`uom.${line.uom}`) })} required>
                        <Input size="sm" inputMode="decimal" value={entry.quantity} onChange={(event) => update({ quantity: event.target.value })} />
                      </Field>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="fw-sco-section" aria-label={t('send.piecesTitle')}>
        <h3 className="fw-by-h3">{t('send.piecesTitle')}</h3>
        {left.length === 0 ? (
          <p className="fw-by-hint">{t('send.noPieces')}</p>
        ) : (
          <div className="fw-by-fields">
            {left.map((operation) => (
              <Field key={operation.id} label={t('send.piecesOf', { line: operation.seq, code: operation.workOrderOperation.code })} hint={t('send.piecesLeft', { left: operation.pieces - operation.piecesSent, total: operation.pieces })}>
                <Input size="sm" inputMode="numeric" value={draft.pieces[operation.id] ?? ''} onChange={(event) => set({ pieces: { ...draft.pieces, [operation.id]: event.target.value } })} />
              </Field>
            ))}
          </div>
        )}
      </section>

      <section className="fw-sco-section" aria-label={t('send.bundlesTitle')}>
        <h3 className="fw-by-h3">{t('send.bundlesTitle')}</h3>
        {draft.bundles === null ? (
          <p className="fw-by-hint">{t('send.bundlesNoRight')}</p>
        ) : draft.bundles.problem ? (
          <Banner tone="danger" title={t(draft.bundles.problem)} />
        ) : draft.bundles.value === null ? (
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : draft.bundles.value.length === 0 ? (
          <p className="fw-by-hint">{t('send.noBundles')}</p>
        ) : (
          <ul className="fw-sco-checks">
            {draft.bundles.value.map((bundle) => (
              <li key={bundle.id}>
                <Checkbox
                  checked={draft.bundleIds.includes(bundle.id)}
                  onChange={(event) => set({ bundleIds: event.target.checked ? [...draft.bundleIds, bundle.id] : draft.bundleIds.filter((id) => id !== bundle.id) })}
                  label={t(bundle.part ? 'send.bundlePart' : 'send.bundle', { code: bundle.code, colourway: bundle.colourwayCode, size: bundle.size, count: bundle.quantity, part: bundle.part ?? '' })}
                />
              </li>
            ))}
          </ul>
        )}
        <p className="fw-by-hint">{t('send.bundlesHint')}</p>
      </section>

      <section className="fw-sco-section" aria-label={t('send.ddtTitle')}>
        <div className="fw-by-card-head">
          <h3 className="fw-by-h3">{t('send.ddtTitle')}</h3>
          <span className="fw-by-inline">
            <Toggle checked={draft.ddt.issue} disabled={!model.can.ddtIssue} onChange={(issue) => setDdt({ issue })} aria-label={t('send.ddtIssue')} />
            <span>{t('send.ddtIssue')}</span>
          </span>
        </div>
        {!model.can.ddtIssue ? (
          <Banner tone="info" title={t('send.ddtNoRight')} />
        ) : !draft.ddt.issue ? (
          <p className="fw-by-hint">{t('send.ddtLater')}</p>
        ) : (
          <div className="fw-by-stack">
            <div className="fw-by-fields">
              <Field label={t('send.ddt.reason')} required>
                <Select size="sm" value={draft.ddt.reason} onChange={(event) => setDdt({ reason: event.target.value as DdtDraft['reason'] })}>
                  {KIT_DDT_REASONS.map((reason) => (
                    <option key={reason} value={reason}>
                      {t(`send.ddt.reasons.${reason}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              {draft.ddt.reason === 'OTHER' && (
                <Field label={t('send.ddt.reasonText')} required>
                  <Input size="sm" maxLength={200} value={draft.ddt.reasonText} onChange={(event) => setDdt({ reasonText: event.target.value })} />
                </Field>
              )}
              <Field label={t('send.ddt.transportBy')} required>
                <Select size="sm" value={draft.ddt.transportBy} onChange={(event) => setDdt({ transportBy: event.target.value as DdtDraft['transportBy'] })}>
                  {TRANSPORT_BY.map((by) => (
                    <option key={by} value={by}>
                      {t(`send.ddt.by.${by}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              {draft.ddt.transportBy === 'CARRIER' && (
                <Field label={t('send.ddt.carrier')} required>
                  <Input size="sm" maxLength={200} value={draft.ddt.carrier} onChange={(event) => setDdt({ carrier: event.target.value })} />
                </Field>
              )}
              <Field label={t('send.ddt.packages')} required>
                <Input size="sm" inputMode="numeric" value={draft.ddt.packages} onChange={(event) => setDdt({ packages: event.target.value })} />
              </Field>
              <Field label={t('send.ddt.weight')} required>
                <Input size="sm" inputMode="decimal" value={draft.ddt.grossWeightKg} onChange={(event) => setDdt({ grossWeightKg: event.target.value })} suffix="kg" />
              </Field>
              <Field label={t('send.ddt.appearance')} hint={t('send.ddt.appearanceHint')}>
                <Input size="sm" maxLength={200} value={draft.ddt.appearance} onChange={(event) => setDdt({ appearance: event.target.value })} />
              </Field>
            </div>
            <Field label={t('send.ddt.remarks')}>
              <Textarea rows={2} maxLength={1000} value={draft.ddt.remarks} onChange={(event) => setDdt({ remarks: event.target.value })} />
            </Field>
            <p className="fw-by-hint">{t('send.ddt.fixed')}</p>
          </div>
        )}
      </section>
    </Frame>
  )
}
