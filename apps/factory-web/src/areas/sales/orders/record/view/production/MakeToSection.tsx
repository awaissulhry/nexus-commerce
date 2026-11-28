'use client'

import { useEffect, useRef, useState } from 'react' // owb-of6: useState (Place the scan code… open)
import { FileText, Reply } from 'lucide-react'
import { Button, Tag, ToolbarButton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { RecordPicture } from '../../../../../../lib/record-picture/view/RecordPicture'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import type { Order } from '../../../api'
import { dayInstant } from '../../../model'
import { NAMESPACE as DEPTH, packRows } from '../../../depth/model'
import { readOf } from '../../overview/model'
import { specRowsOf, specTone, type SpecRow, type SpecState, type StylePart } from '../../production/specs'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartFailed, PartReading, Quiet, Section } from '../../../../../../lib/record-sections/Kit'
import { PlaceScanCodeButton } from './FlowProduction' // owb-of6 step 1
import { PlaceScanCodeWindow } from '../../print/PlaceScanCodeWindow' // owb-of6 step 1: S3's window, through the base's stub (L10)

const DISPOSITIONS = ['FINISH_OLD', 'REWORK', 'SCRAP', 'HOLD']

/**
 * F-PT-401 / F-PT-402 (order PRODUCTION tab, 10-design §7; L1 "Pattern v{n}", L6, L10, L11) — "What we make it to" (#specs): for each
 * style what we make it to and whether that is still the right one (Our pattern), and the customer's files behind it (the customer's
 * tech pack, sales.inquiries.view — hidden for Planner, Finance, Warehouse). The styles are read when the section comes into view
 * (`onSpecsSeen`); each half and each style fails alone with its own Try again. Read doors only for who may open them; Ask for a
 * design change… only with product.changes.request (L11). The customer's files open in the ONE viewer (the order's open route).
 */
export function MakeToSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  // owb-of6 step 1 (design § 5k "What we make it to": Place the scan code): production.print.start, or the designer on the order (ss2b).
  const [placeOpen, setPlaceOpen] = useState(false)
  const mayPlace = (!!model.can.printStart || !!model.can.viewOwn) && (order.status === 'CONFIRMED' || order.status === 'IN_PRODUCTION')
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const frame = useRecordFrame()
  const read = readOf(model.production)
  const day = (value: string) => formatDate(dayInstant(value), { locale })

  // L6: the styles are read once the section comes into view (one observer, then it lets go).
  const seenAt = useRef<HTMLDivElement | null>(null)
  const onSeen = useRef(actions?.onSpecsSeen)
  onSeen.current = actions?.onSpecsSeen
  useEffect(() => {
    const node = seenAt.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') return void onSeen.current?.()
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        onSeen.current?.()
        observer.disconnect()
      },
      { rootMargin: '240px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const styleParts: ReadonlyMap<string, StylePart> = model.styleSpecs?.parts ?? new Map()
  const rows = specRowsOf(order, read?.work?.workOrders ?? null, styleParts)
  const pack = model.depth?.techPack ?? null
  const files = packRows(pack?.value ?? null)
  const packNewer = files.some((file) => file.state === 'newer')
  const decide = rows.filter((row) => row.needsDecision).length
  const answer = [t('productionTab.specs.styles', { count: rows.length }), decide > 0 ? t('productionTab.specs.needDecision', { count: decide }) : null, pack?.value?.inquiry && packNewer ? t('productionTab.specs.packNewerShort') : null].filter(Boolean).join(' · ')
  const mayAsk = !!model.people?.mayNote && !!frame?.compose

  const stateWords = (state: SpecState): string => {
    switch (state.kind) {
      case 'inForce':
        return t('productionTab.specs.state.inForce', { revision: state.revision })
      case 'replaced':
        return state.by === null ? t('productionTab.specs.state.replacedNoNumber', { revision: state.revision }) : state.on ? t('productionTab.specs.state.replaced', { revision: state.revision, by: state.by, date: day(state.on) }) : t('productionTab.specs.state.replacedNoDay', { revision: state.revision, by: state.by })
      case 'withdrawn':
        return t('productionTab.specs.state.withdrawn', { revision: state.revision })
      case 'notApproved':
        return t('lines.pattern.notApproved', { revision: state.revision })
      case 'notFixedUses':
        return t('productionTab.specs.state.notFixedUses', { number: state.workOrder, revision: state.revision })
      case 'notFixedWill':
        return t('productionTab.specs.state.notFixedWill', { revision: state.revision })
      case 'notFixed':
        return t('lines.pattern.none')
    }
  }
  const styleHref = (styleId: string) => `${model.prefix}/products/styles/${encodeURIComponent(styleId)}`

  const ourRow = (row: SpecRow) => (
    <li key={row.key} className="fw-pt-spec" id={`about-Style-${row.styleId}`}>
      <RecordPicture
        source="order"
        recordId={order.id}
        number={`${row.code} · ${row.name}`}
        size="line"
        picture={{ styleId: row.styleId, styleCode: row.code, styleName: row.name, fileId: row.picture?.fileId ?? null, small: !!row.picture?.small }}
        held={row.picture?.small ?? null}
      />
      <div className="fw-pt-spec-b">
        <span className="fw-pt-inline">
          {model.styleSpecs ? (
            <a className="fw-pt-link" href={styleHref(row.styleId)} title={t('lines.style.open', { code: row.code })}>
              {row.code} · {row.name} ↗
            </a>
          ) : (
            <b>
              {row.code} · {row.name}
            </b>
          )}
          <Tag tone={specTone(row.state)}>{stateWords(row.state)}</Tag>
        </span>
        {row.changeNote ? <span className="fw-pt-sub">{t('productionTab.specs.changeNote', { revision: row.changeNote.revision, note: row.changeNote.note })}</span> : null}
        {row.older.map((work) => (
          <span key={work.id} className="fw-pt-sub">
            {[
              work.newer
                ? work.newer.on
                  ? t('productionTab.specs.older', { number: work.number, revision: work.revision ?? '—', newer: work.newer.revision, date: day(work.newer.on) })
                  : t('productionTab.specs.olderNoDay', { number: work.number, revision: work.revision ?? '—', newer: work.newer.revision })
                : t('productionTab.specs.olderNoNewer', { number: work.number, revision: work.revision ?? '—' }),
              work.decision ? t('productionTab.specs.decision', { changeOrder: work.decision.changeOrder, what: DISPOSITIONS.includes(work.decision.disposition) ? t(`productionTab.specs.disposition.${work.decision.disposition}`, { revision: work.revision ?? '—' }) : work.decision.disposition }) : t('productionTab.specs.noDecision'),
            ].join(' — ')}
          </span>
        ))}
        {row.read === 'reading' ? <PartReading rows={1} height={18} /> : null}
        {row.read === 'failed' ? <PartFailed part={t('productionTab.specs.partStyle', { code: row.code })} problem={styleParts.get(row.styleId)?.problem ?? 'problem.read.unavailable'} onRetry={() => actions?.onRetrySpec?.(row.styleId)} /> : null}
        {(model.styleSpecs && model.specCan?.versions) || model.specCan?.changeRequest ? (
          <span className="fw-pt-move-doors">
            {model.styleSpecs && model.specCan?.versions ? (
              <a className="fw-pt-link" href={`${styleHref(row.styleId)}?tab=versions${row.releasedId ? `&rev=${encodeURIComponent(row.releasedId)}` : ''}`}>
                {t('productionTab.specs.versions')}
              </a>
            ) : null}
            {model.specCan?.changeRequest ? (
              <a className="fw-pt-link" href={`${model.prefix}/products/changes?new=1&style=${encodeURIComponent(row.styleId)}`}>
                {t('productionTab.specs.askChange')}
              </a>
            ) : null}
          </span>
        ) : null}
      </div>
    </li>
  )

  return (
    <Section id="specs" title={t('productionTab.specs.title')} answer={answer} buttons={mayPlace ? [<PlaceScanCodeButton key="place" onOpen={() => setPlaceOpen(true)} />] : []} info={<p>{t('productionTab.specs.infoBody')}</p>}>
      <PlaceScanCodeWindow open={placeOpen} onClose={() => setPlaceOpen(false)} companyId={order.companyId} orderId={order.id} />
      <div ref={seenAt} className={pack ? 'fw-pt-mk is-pair' : 'fw-pt-mk'}>
        <div className="fw-pt-now-blk">
          <h3 className="fw-pt-h3">{t('productionTab.specs.ourTitle')}</h3>
          {rows.length === 0 ? <Quiet>{t('productionTab.specs.noStyle')}</Quiet> : <ul className="fw-pt-specs">{rows.map(ourRow)}</ul>}
          {(model.styleSpecs?.more ?? 0) > 0 ? <p className="fw-pt-hint">{t('productionTab.specs.moreStyles', { count: model.styleSpecs!.more })}</p> : null}
        </div>
        {pack ? (
          <div className="fw-pt-now-blk fw-pt-mk-pack">
            <h3 className="fw-pt-h3">{t('productionTab.specs.packTitle')}</h3>
            {!pack.value && !pack.problem ? <PartReading rows={2} height={22} /> : null}
            {pack.problem ? <PartFailed part={t('productionTab.specs.packTitle')} problem={pack.problem} onRetry={() => actions?.depth?.onRetry?.('techPack')} /> : null}
            {pack.value && !pack.value.inquiry ? <Quiet>{t('productionTab.specs.noPack')}</Quiet> : null}
            {pack.value?.inquiry ? (
              <>
                <span className="fw-pt-inline">
                  <a className="fw-pt-link" href={`${model.prefix}/sales/incoming/${encodeURIComponent(pack.value.inquiry.id)}`}>
                    {d('pack.from', { number: pack.value.inquiry.number })} ›
                  </a>
                  {pack.value.inquiry.techPack.version ? <span className="fw-pt-sub">{d('pack.version', { version: pack.value.inquiry.techPack.version })}</span> : null}
                </span>
                {packNewer ? <p className="fw-pt-hint">{t('productionTab.specs.packNewer')}</p> : null}
                {files.length === 0 ? <Quiet>{d('pack.none')}</Quiet> : null}
                {files.length > 0 ? (
                  <ul className="fw-pt-units">
                    {files.map((file) => (
                      <li key={file.id} className="fw-pt-inline">
                        <FileText size={14} aria-hidden />
                        <span>{file.name}</span>
                        <Tag tone={file.state === 'gone' ? 'danger' : file.state === 'newer' ? 'warning' : 'success'}>{file.state === 'gone' ? d('pack.gone') : file.state === 'newer' ? d('pack.newer', { named: file.named, current: file.current ?? '—' }) : d('pack.inForce', { version: file.named })}</Tag>
                        {model.depth?.can.files && file.available && actions?.onOpenOrderFile ? (
                          <Button size="sm" variant="quiet" onClick={(event) => actions.onOpenOrderFile?.(file.openId, event.currentTarget)}>
                            {d('pack.open')}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {mayAsk ? <ToolbarButton icon={<Reply size={14} aria-hidden />} label={t('productionTab.specs.askCustomer')} onClick={() => frame?.compose?.({ messageId: null, mode: 'reply' })} /> : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  )
}
