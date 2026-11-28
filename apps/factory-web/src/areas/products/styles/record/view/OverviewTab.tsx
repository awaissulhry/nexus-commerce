'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import Link from 'next/link'
import { CircleCheck, CircleX, FileText, ImageOff, MessageSquare, Pencil, Route as RouteIcon, Shirt } from 'lucide-react'
import { Disclosure, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { EditModeBar, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { PartFailed, PartReading, Quiet, Section } from '../../../../../lib/record-sections/Kit'
import { DeptBar } from '../../../../../lib/department/view/DeptBar'
import { StateChip } from '../../../../../lib/order-cells/view/StateChip'
import type { StylePatch, StyleView } from '../../api'
import { countryName, countryOptions } from '../../../../parties/_shared/model'
import { PpeFields, settlePpe, type PpeValue } from '../../forms'
import { complianceAfterRelease, decimalText, draftOf, issueHash, issueTab, issueWords, mayEditFacts, releasedOf, revisionChips, revisionInView, VARIANTS_ANCHOR } from '../../model'
import { agreedText } from '../../list/list-model'
import { customsDraftOf, customsErrors, customsPatch, hsCodeText, refusedCustoms, type CustomsDraft, type CustomsField } from '../customs'
import type { StyleRecordActions, StyleRecordViewModel } from '../record-model'
// B-TH-261: "Thread and history" shows the docked thread (the Activity tab is gone).
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
// B-W2b-237: the depth's parts (identity in depth, the lifecycle, completeness, where-used).
import type { StyleDepthSlots } from '../overview/slots'
// ---- owb-pd4 (step 4.3): the Overview in the section kit ----
import { howItIsMadeOf, madeForOf, mainPicturesOf, overviewSectionsFor, sheetHref, sizesAnswerOf, whereUsedOf } from '../product-model'
import { useProductWords } from '../product-words'
import { pictureSrc } from '../gallery/gallery-model'
import { GallerySection } from '../gallery/view/GallerySection'
import { VariantsTab } from './VariantsTab'
// ---- end owb-pd4

const PRODUCT_TYPES: StyleView['productType'][] = ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER']

/**
 * Country names come from the runtime's Intl data, which differs between the server and the browser: they are drawn
 * after hydration (the code alone before), so the first client render matches the server's.
 */
const noSubscription = () => () => undefined
const useHydrated = () => useSyncExternalStore(noSubscription, () => true, () => false)

interface Identity {
  code: string
  name: string
  productType: StyleView['productType']
  season: string
  brandPartyId: string | null
  description: string
  mtmAllowed: boolean
  ppe: PpeValue
  /** W2a customs and origin (PRD-018). */
  customs: CustomsDraft
}

const identityOf = (style: StyleView, locale: 'it' | 'en' = 'it'): Identity => ({
  code: style.code,
  name: style.name,
  productType: style.productType,
  season: style.season ?? '',
  brandPartyId: style.brand?.id ?? null,
  description: style.description ?? '',
  mtmAllowed: style.mtmAllowed,
  ppe: { ppeCategory: style.ppeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass },
  customs: customsDraftOf(style, locale),
})

/** What changed, as the API's PATCH body (only the fields that differ). */
export function identityPatch(style: StyleView, draft: Identity): StylePatch {
  const patch: StylePatch = {}
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  if (draft.code.trim().toUpperCase() !== style.code) patch.code = draft.code.trim().toUpperCase()
  if (draft.name.trim() !== style.name) patch.name = draft.name.trim()
  if (draft.productType !== style.productType) patch.productType = draft.productType
  if (text(draft.season) !== style.season) patch.season = text(draft.season)
  if (draft.brandPartyId !== (style.brand?.id ?? null)) patch.brandPartyId = draft.brandPartyId
  if (text(draft.description) !== style.description) patch.description = text(draft.description)
  if (draft.mtmAllowed !== style.mtmAllowed) patch.mtmAllowed = draft.mtmAllowed
  if (draft.ppe.ppeCategory !== style.ppeCategory || draft.ppe.ppeStandard !== style.ppeStandard || draft.ppe.ppeClass !== style.ppeClass) {
    patch.ppeCategory = draft.ppe.ppeCategory
    patch.ppeStandard = draft.ppe.ppeStandard
    patch.ppeClass = draft.ppe.ppeClass
  }
  return { ...patch, ...customsPatch(style, draft.customs) }
}
const sameIdentity = (a: Identity, b: Identity) => JSON.stringify(a) === JSON.stringify(b)

function applyDesignDraft(base: Identity, patch: StylePatch): Partial<Identity> {
  return {
    ...(patch.name !== undefined ? { name: patch.name ?? '' } : {}),
    ...(patch.season !== undefined ? { season: patch.season ?? '' } : {}),
    ...(patch.ppeCategory !== undefined ? { ppe: { ppeCategory: patch.ppeCategory, ppeStandard: patch.ppeStandard ?? null, ppeClass: patch.ppeClass ?? null } } : { ppe: base.ppe }),
    customs: {
      hsCode: patch.hsCode !== undefined ? (patch.hsCode ?? '') : base.customs.hsCode,
      originCountry: patch.originCountry !== undefined ? (patch.originCountry ?? '') : base.customs.originCountry,
      netMassKg: patch.netMassKg !== undefined ? (patch.netMassKg ?? '') : base.customs.netMassKg,
    },
  }
}

/**
 * SCR-041 Overview — owb-pd4 step 4.3 (design § 5q, prototype prod.js prodBody): the product's Overview in the section kit (the order
 * page's card look), one column that follows its room: the answer line · Design (the main pictures, front and back) · Product facts
 * | Sizes (short) · Before release | Agreed prices (price grain) · How it is made (the route as departments, never a minute; the
 * "Route" button only for product.routing.manage) · Where it is used (the open orders) · ONE closed section "Variants and markets"
 * at the bottom with today's colourways and sizes, SKUs and GTINs, markets, pictures, names per language, private label and
 * lifecycle (S4 settle 12: short pages, nothing lost). A pair never leaves an empty half: a section without its partner takes the row.
 */
export function OverviewTab({ style, model, actions, depth }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions; depth?: StyleDepthSlots }) {
  const sections = overviewSectionsFor(model.can, model.grains, { orders: model.orders !== undefined })
  const has = (section: (typeof sections)[number]) => sections.includes(section)
  const partner = has('prices') ? <PricesSection model={model} /> : has('used') ? <UsedSection model={model} actions={actions} /> : null
  const release = <ReleaseSection style={style} model={model} actions={actions} gate={depth?.gate} />
  return (
    <div className="fw-pt fw-pd-ov">
      <AnswerLine style={style} model={model} />
      <DesignSection style={style} model={model} />
      <div className="fw-pt-pairs">
        <FactsSection style={style} model={model} actions={actions} />
        <SizesShort style={style} model={model} />
      </div>
      {partner ? (
        <div className="fw-pt-pairs">
          {release}
          {partner}
        </div>
      ) : (
        release
      )}
      <MadeSection model={model} />
      {has('prices') && has('used') ? <UsedSection model={model} actions={actions} /> : null}
      <VariantsSection style={style} model={model} actions={actions} depth={depth} />
    </div>
  )
}

/** The answer line: the state, the revisions, the orders — one sentence before every section (design answerLine). */
function AnswerLine({ style, model }: { style: StyleView; model: StyleRecordViewModel }) {
  const { t, tp } = useProductWords()
  const revisions = revisionChips({ releasedRevision: releasedOf(style.revisions)?.revision ?? null, draftRevision: draftOf(style.revisions)?.revision ?? null })
  const orders = model.orders?.status === 'ready' ? model.orders.value.totals.openOrders : null
  return (
    <p className="fw-pd-answer" data-state={style.status}>
      <Shirt size={16} aria-hidden />
      <span>
        <b>{tp(`status.${style.status}`)}.</b> {revisions.length ? `${revisions.map((chip) => tp(`list.rev.${chip.kind}`, { revision: chip.revision })).join(' · ')}.` : t('overview.answer.noRevision')}{' '}
        {orders === null ? '' : orders > 0 ? t('overview.answer.inOrders', { count: orders }) : t('overview.answer.noOrders')}
      </span>
    </p>
  )
}

/** Design: the main pictures, front and back (the gallery's main one first); the Product sheet beside them. */
function DesignSection({ style, model }: { style: StyleView; model: StyleRecordViewModel }) {
  const { t } = useProductWords()
  const part = model.gallery?.part
  const pictures = mainPicturesOf(part?.status === 'ready' ? part.value : null)
  const sheet = (
    <Button key="sheet" size="sm" asChild>
      <a href={sheetHref(model.prefix, style.id, model.revisionId)} target="_blank" rel="noopener">
        <FileText size={14} aria-hidden /> {t('band.sheet')}
      </a>
    </Button>
  )
  return (
    <Section id="pd-design" title={t('overview.design.title')} answer={pictures.length ? t('overview.design.answer') : undefined} buttons={[sheet]} info={<p>{t('overview.design.info')}</p>}>
      {part?.status === 'loading' ? (
        <PartReading rows={1} height={160} />
      ) : pictures.length === 0 ? (
        <Quiet>
          <ImageOff size={14} aria-hidden /> {t('overview.design.none')}
        </Quiet>
      ) : (
        <div className="fw-pd-pics">
          {pictures.map((picture, index) => {
            const src = pictureSrc(picture)
            const caption = picture.caption ?? t(index === 0 ? 'sheet.front' : 'sheet.back')
            return src ? (
              <figure key={picture.id} className="fw-pd-pic">
                <img src={src} alt={caption} loading="lazy" decoding="async" />
                <figcaption>{caption}</figcaption>
              </figure>
            ) : null
          })}
        </div>
      )}
    </Section>
  )
}

/** Product facts: what the product is, read; "Change" opens today's identity form in the section (product.styles.manage, or the designer on a draft). */
function FactsSection({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const { t, tp, say } = useProductWords()
  const locale = useLocale()
  const hydrated = useHydrated()
  const may = mayEditFacts(style, model.can)
  const [editing, setEditing] = useState(Boolean(model.identityDraft) && may)
  // B-TH-261 (R-ACT): the thread docks beside every tab; this button shows it (docked) or opens it full width (narrower).
  const frame = useRecordFrame()
  const buttons = [
    ...(may && !editing
      ? [
          <Button key="change" size="sm" onClick={() => setEditing(true)}>
            <Pencil size={13} aria-hidden /> {t('overview.facts.change')}
          </Button>,
        ]
      : []),
    ...(model.can.thread && frame?.showThread
      ? [
          <Button key="thread" size="sm" variant="quiet" onClick={() => frame.showThread?.()}>
            <MessageSquare size={13} aria-hidden /> {tp('side.activity')}
          </Button>,
        ]
      : []),
  ]
  const ppe = style.ppeCategory === 'NOT_PPE' ? tp('ppe.short.NOT_PPE') : [tp(`ppe.short.${style.ppeCategory}`), style.ppeStandard, style.ppeClass ? `CE ${style.ppeClass}` : null].filter(Boolean).join(' · ')
  return (
    <Section
      id="pd-facts"
      title={t('overview.facts.title')}
      answer={style.status === 'ARCHIVED' ? tp('identity.readArchived') : may ? undefined : t('overview.facts.readOnly')}
      buttons={buttons}
      info={<p>{t('overview.facts.info')}</p>}
    >
      {editing ? (
        <IdentityForm style={style} model={model} actions={actions} onDone={() => setEditing(false)} />
      ) : (
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: tp('identity.code'), value: style.code },
            { label: tp('identity.name'), value: style.name },
            { label: tp('identity.type'), value: tp(`productType.${style.productType}`) },
            { label: t('overview.facts.family'), value: say(madeForOf(style)) },
            { label: tp('identity.season'), value: style.season ?? '—' },
            { label: tp('identity.ppe'), value: ppe },
            { label: tp('identity.tracking'), value: tp(`tracking.${style.tracking}`) },
            { label: tp('customs.hsCode'), value: hsCodeText(style.hsCode) },
            { label: tp('customs.origin'), value: style.originCountry ? (hydrated ? `${countryName(style.originCountry, locale)} (${style.originCountry})` : style.originCountry) : '—' },
            { label: tp('customs.netMass'), value: style.netMassKg ? tp('customs.kg', { kg: decimalText(style.netMassKg, locale, 3) }) : '—' },
            { label: tp('side.skus'), value: tp('side.skusValue', { skus: style.skuCount, colourways: style.colourwayCount }) },
            { label: tp('side.updated'), value: formatDateTime(style.updatedAt, { locale }) },
            { label: tp('identity.description'), value: style.description ?? '—' },
          ]}
        />
      )}
    </Section>
  )
}

/** Sizes (short): the range and the base size, or made to measure; the Sizes tab holds the rest. */
function SizesShort({ style, model }: { style: StyleView; model: StyleRecordViewModel }) {
  const { t, tp } = useProductWords()
  const answer = sizesAnswerOf(style)
  const open = (
    <Button key="open" size="sm" asChild>
      <Link href={`${model.prefix}/products/styles/${style.id}?tab=sizes${model.revisionId ? `&rev=${model.revisionId}` : ''}`}>{tp('tab.sizes')}</Link>
    </Button>
  )
  return (
    <Section id="pd-sizes" title={t('sizes.title')} answer={t(answer.key, answer.params)} buttons={[open]} info={<p>{t('sizes.info')}</p>}>
      {style.sizes.length > 0 ? (
        <span className="fw-pd-sizes" aria-label={t('sizes.title')}>
          {style.sizes.map((size) => (
            <span key={size} className={size === style.baseSize ? 'fw-pd-size is-base' : 'fw-pd-size'}>
              {size === style.baseSize ? t('sizes.baseMark', { size }) : size}
            </span>
          ))}
        </span>
      ) : null}
    </Section>
  )
}

/** Before release: what the draft still needs (the release check), the completeness, the product's warnings; or why there is nothing to do. */
function ReleaseSection({ style, model, actions, gate }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions; gate?: ReactNode }) {
  const { t, tp } = useProductWords()
  const revision = revisionInView(style.revisions, model.revisionId)
  const draft = draftOf(style.revisions)
  const released = releasedOf(style.revisions)
  const bom = model.bom.status === 'ready' ? model.bom.value : null
  const routing = model.routing.status === 'ready' ? model.routing.value : null
  const compliance = model.compliance.status === 'ready' ? model.compliance.value : null
  const after = complianceAfterRelease(compliance)
  const tabHref = (tab: string) => `${model.prefix}/products/styles/${style.id}?tab=${tab}${model.revisionId ? `&rev=${model.revisionId}` : ''}`
  const fixHref = `${tabHref('overview')}#${VARIANTS_ANCHOR}`
  const answer =
    style.status === 'ARCHIVED'
      ? t('overview.release.archived')
      : !revision
        ? tp('check.noRevision')
        : revision.status !== 'DRAFT'
          ? tp(revision.status === 'RELEASED' ? 'check.released' : 'check.obsolete', { revision: revision.revision })
          : bom
            ? bom.issues.length > 0
              ? t('overview.release.things', { count: bom.issues.length })
              : tp('check.ready', { revision: revision.revision })
            : undefined
  const open =
    revision?.status === 'DRAFT' && model.can.bomView ? (
      <Button key="open" size="sm" onClick={() => actions?.onDialog?.({ kind: 'release' })} aria-keyshortcuts="r">
        {tp('check.open')}
      </Button>
    ) : null
  let body: ReactNode = null
  if (revision?.status === 'DRAFT') {
    if (!model.can.bomView) body = <Quiet>{tp('check.noBomView')}</Quiet>
    else if (model.bom.status === 'error') body = <PartFailed part={t('overview.release.title')} problem={model.bom.problem} onRetry={actions?.onReload} />
    else if (!bom) body = <PartReading rows={2} />
    else if (bom.issues.length === 0)
      body = (
        <p className="fw-st-inline fw-st-ok">
          <CircleCheck size={14} aria-hidden /> {tp('check.ready', { revision: revision.revision })}
        </p>
      )
    else
      body = (
        <ul className="fw-st-checklist">
          {bom.issues.slice(0, 4).map((issue, index) => {
            const words = issueWords(issue, bom, routing)
            return (
              <li key={`${issue.code}-${index}`} className="fw-st-check is-blocked">
                <CircleX size={14} aria-hidden />
                <span>{tp(words.key, words.params)}</span>
                <Link className="fw-st-link" href={`${tabHref(issueTab(issue))}${issueHash(issue) /* B-TH-261 */}`}>
                  {tp('check.showMe')}
                </Link>
              </li>
            )
          })}
          {bom.issues.length > 4 && <li className="fw-st-hint">{tp('check.more', { count: bom.issues.length - 4 })}</li>}
        </ul>
      )
  }
  return (
    <Section id="pd-release" title={t('overview.release.title')} answer={answer} buttons={open ? [open] : []} info={<p>{t('overview.release.info')}</p>}>
      {gate /* B-W2b-237: the completeness % */}
      {body}
      {style.warnings.length > 0 && (
        <ul className="fw-st-list">
          {style.warnings.map((warning) => (
            <li key={warning.code}>
              {tp(`warning.${warning.code}`)}{' '}
              {!['NO_PPE_STANDARD', 'NO_PPE_CLASS', 'NO_MEASUREMENT_TEMPLATE'].includes(warning.code) && (
                <Link className="fw-st-link" href={fixHref}>
                  {tp('warning.fix')}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      {revision?.status === 'DRAFT' && after.length > 0 && (
        <p className="fw-st-hint">
          {tp('check.complianceAfter', { count: after.length })}{' '}
          <Link className="fw-st-link" href={tabHref('compliance')}>
            {tp('check.seeCompliance')}
          </Link>
        </p>
      )}
      {draft && released && <p className="fw-st-hint">{tp('check.inUse', { released: released.revision, draft: draft.revision })}</p>}
    </Section>
  )
}

/** Agreed prices (price grain only): the lowest and highest agreed price of the product over every customer (the list row's extras). */
function PricesSection({ model }: { model: StyleRecordViewModel }) {
  const { t } = useProductWords()
  const locale = useLocale()
  const part = model.agreed
  const row = part?.status === 'ready' ? part.value : null
  const text = row ? agreedText(row.agreedRange ?? null, locale) : null
  const lists = model.can.prices ? (
    <Button key="lists" size="sm" asChild>
      <Link href={`${model.prefix}/sales/price-lists`}>{t('overview.prices.lists')}</Link>
    </Button>
  ) : null
  return (
    <Section
      id="pd-prices"
      title={t('overview.prices.title')}
      answer={text ? t('overview.prices.answer', { range: text, count: row?.agreedRange?.count ?? 0 }) : part?.status === 'ready' ? t('overview.prices.none') : undefined}
      buttons={lists ? [lists] : []}
      info={<p>{t('overview.prices.info')}</p>}
    >
      {!part || part.status === 'idle' ? <Quiet>{t('overview.prices.notRead')}</Quiet> : part.status === 'loading' ? <PartReading rows={1} /> : part.status === 'error' ? <PartFailed part={t('overview.prices.title')} problem={part.problem} /> : null}
    </Section>
  )
}

/** How it is made: the route of the revision as department chips, in order — never a minute; the Route button only for the person who changes routes. */
function MadeSection({ model }: { model: StyleRecordViewModel }) {
  const { t, tp } = useProductWords()
  const route = howItIsMadeOf(model.routeSummary)
  const button = model.can.routingManage ? (
    <Button key="route" size="sm" asChild>
      <Link href={`${model.prefix}/products/styles/${model.style.status === 'ready' ? model.style.value.id : ''}?tab=routing${model.revisionId ? `&rev=${model.revisionId}` : ''}`}>
        <RouteIcon size={13} aria-hidden /> {tp('tab.routing')}
      </Link>
    </Button>
  ) : null
  return (
    <Section id="pd-made" title={t('overview.made.title')} answer={route.length ? t('overview.made.answer', { count: route.length }) : t('overview.made.none')} buttons={button ? [button] : []} info={<p>{t('overview.made.info')}</p>}>
      {route.length > 0 ? <DeptBar route={route} current={null} /> : null}
    </Section>
  )
}

/** Where it is used: the open orders with this product — order, customer, pieces, its state; none: one plain line. */
function UsedSection({ model, actions }: { model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const { t } = useProductWords()
  const part = model.orders
  const rows = part?.status === 'ready' ? whereUsedOf(part.value.lines) : []
  const shown = rows.slice(0, 8)
  return (
    <Section
      id="pd-used"
      title={t('overview.used.title')}
      answer={part?.status === 'ready' ? (rows.length ? t('overview.used.answer', { count: rows.length, pieces: part.value.totals.openPieces }) : undefined) : undefined}
      info={<p>{t('overview.used.info')}</p>}
    >
      {!part || part.status === 'idle' || part.status === 'loading' ? (
        <PartReading rows={2} />
      ) : part.status === 'error' ? (
        <PartFailed part={t('overview.used.title')} problem={part.problem} onRetry={actions?.onRetryOrders} />
      ) : rows.length === 0 ? (
        <Quiet>{t('overview.used.none')}</Quiet>
      ) : (
        <>
          <table className="fw-pt-table">
            <thead>
              <tr>
                <th>{t('overview.used.col.order')}</th>
                <th>{t('overview.used.col.customer')}</th>
                <th className="fw-pt-x">{t('overview.used.col.pieces')}</th>
                <th>{t('overview.used.col.state')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.orderId}>
                  <td className="fw-pt-first">
                    {model.ordersOpen ? (
                      <Link className="fw-pt-link" href={`${model.prefix}/sales/orders/${encodeURIComponent(row.orderId)}`}>
                        {row.orderNumber}
                      </Link>
                    ) : (
                      row.orderNumber
                    )}
                  </td>
                  <td data-label={t('overview.used.col.customer')}>{row.customer ?? t('overview.used.noCustomer')}</td>
                  <td className="fw-pt-x" data-label={t('overview.used.col.pieces')}>
                    {row.pieces}
                  </td>
                  <td data-label={t('overview.used.col.state')}>
                    <StateChip life={row.life} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > shown.length && <Quiet>{t('overview.used.more', { count: rows.length - shown.length })}</Quiet>}
        </>
      )}
    </Section>
  )
}

/**
 * Variants and markets — ONE closed section at the bottom (S4 settle 12): today's colourways and sizes, the SKU matrix and GTINs, the
 * markets, the pictures, names per language, private label, lifecycle and where else it is used. It opens by itself when the address
 * asks for it (`#style-variants`: a Fix of a range or colourway problem, the list's "Open colourways & sizes").
 */
function VariantsSection({ style, model, actions, depth }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions; depth?: StyleDepthSlots }) {
  const { t } = useProductWords()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const follow = () => {
      if (window.location.hash !== `#${VARIANTS_ANCHOR}`) return
      setOpen(true)
      requestAnimationFrame(() => document.getElementById(VARIANTS_ANCHOR)?.scrollIntoView({ block: 'start' }))
    }
    follow()
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  return (
    <Section id={VARIANTS_ANCHOR} title={t('overview.variants.title')} answer={t('overview.variants.answer', { colourways: style.colourwayCount, skus: style.skuCount })} info={<p>{t('overview.variants.info')}</p>}>
      <Disclosure summary={t(open ? 'overview.variants.close' : 'overview.variants.open')} open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <div className="fw-st-stack-lg">
          {depth?.identity /* B-W2b-237: type, names per language, private label */}
          {depth?.sideTop /* B-W2b-237: the lifecycle */}
          <GallerySection model={model.gallery} actions={actions?.gallery} />
          <VariantsTab style={style} model={model} actions={actions} depth={depth /* B-W2b-237 */} />
          {depth?.markets /* B-W2b-283 */}
          {depth?.side /* B-W2b-237: where it is used besides the open orders */}
        </div>
      </Disclosure>
    </Section>
  )
}

/** Today's identity form (W1 + W2a customs), now inside Product facts: explicit save with ⌘S; Back leaves it unchanged. */
function IdentityForm({ style, model, actions, onDone }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions; onDone: () => void }) {
  const t = useT('products')
  const locale = useLocale()
  const hydrated = useHydrated()
  const base = useMemo(() => identityOf(style, locale), [style, locale])
  const seeded = model.identityDraft ? { ...base, ...applyDesignDraft(base, model.identityDraft) } : base
  const [draft, setDraft] = useState<Identity>(seeded)
  const [saving, setSaving] = useState(false)
  // A new read of the style starts the form again — unless the person has unsaved changes in it (they stay; after a
  // save they equal the new read anyway).
  const lastBase = useRef(base)
  useEffect(() => {
    // A draft that says the same as the new read (customs typed with spaces, now stored as digits) shows the stored form.
    setDraft((current) => (sameIdentity(current, lastBase.current) || Object.keys(identityPatch(style, current)).length === 0 ? base : current))
    lastBase.current = base
  }, [base])
  const codeFrozen = style.matrix.generated
  const patch = identityPatch(style, draft)
  const count = Object.keys(patch).filter((key) => key !== 'ppeStandard' && key !== 'ppeClass').length
  const customsProblems = customsErrors(draft.customs)
  const held =
    draft.name.trim() === ''
      ? t('identity.held.name')
      : !/^[A-Z0-9](?:[A-Z0-9._-]{0,22}[A-Z0-9])?$/.test(draft.code.trim().toUpperCase())
        ? t('identity.held.code')
        : Object.keys(customsProblems).length > 0
          ? t('customs.held', { count: Object.keys(customsProblems).length })
          : saving
            ? t('held.busy')
            : null
  const setCustoms = (field: CustomsField, value: string) => setDraft((current) => ({ ...current, customs: { ...current.customs, [field]: value } }))
  const customsError = (field: CustomsField) => (customsProblems[field] ? t(customsProblems[field]!) : refusedCustoms(model.refused ?? [], field) ? t('customs.refused') : undefined)
  const set = <K extends keyof Identity>(field: K, value: Identity[K]) => setDraft((current) => ({ ...current, [field]: value }))
  const save = async () => {
    if (held || count === 0) return
    setSaving(true)
    const done = (await actions?.onSaveIdentity?.(patch)) ?? false
    setSaving(false)
    if (done) onDone()
  }
  const brandName = style.brand ? style.brand.name : t('identity.ownCollection')
  return (
    <div className="fw-st-form">
      <p className="fw-st-hint">{t('identity.intro')}</p>
      <div className="fw-st-form-grid">
        <Field label={t('identity.code')} required hint={codeFrozen ? t('identity.codeFrozen') : t('identity.codeHint')}>
          {codeFrozen ? <p className="fw-st-static">{style.code}</p> : <Input value={draft.code} maxLength={24} onChange={(event) => set('code', event.target.value.toUpperCase())} />}
        </Field>
        <Field label={t('identity.name')} required>
          <Input value={draft.name} maxLength={200} onChange={(event) => set('name', event.target.value)} />
        </Field>
        <Field label={t('identity.type')}>
          <Select
            value={draft.productType}
            onChange={(event) => {
              const productType = event.target.value as StyleView['productType']
              setDraft((current) => ({ ...current, productType, ppe: settlePpe(current.ppe, productType) }))
            }}
          >
            {PRODUCT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`productType.${type}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('identity.season')} hint={t('identity.seasonHint')}>
          <Input value={draft.season} maxLength={20} onChange={(event) => set('season', event.target.value)} />
        </Field>
        <Field label={t('identity.brand')} hint={t('identity.brandHint')}>
          {model.libraries.brands ? (
            <Select value={draft.brandPartyId ?? ''} onChange={(event) => set('brandPartyId', event.target.value || null)}>
              <option value="">{t('identity.ownCollection')}</option>
              {model.libraries.brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.tradeName ?? brand.legalName} · {brand.code}
                </option>
              ))}
              {style.brand && !model.libraries.brands.some((brand) => brand.id === style.brand?.id) && <option value={style.brand.id}>{style.brand.name}</option>}
            </Select>
          ) : (
            <p className="fw-st-static">{brandName}</p>
          )}
        </Field>
      </div>
      <PpeFields value={draft.ppe} productType={draft.productType} onChange={(ppe) => set('ppe', ppe)} />
      <KeyValue dense labelCase="sentence" items={[{ label: t('identity.tracking'), value: t(`tracking.${draft.ppe.ppeCategory === 'NOT_PPE' ? 'NONE' : 'LOT'}`) }]} />
      <div className="fw-st-stack">
        <h3 className="fw-st-h3">{t('customs.title')}</h3>
        <p className="fw-st-hint">{t('customs.intro')}</p>
        <div className="fw-st-form-grid">
          <Field label={t('customs.hsCode')} hint={t('customs.hsCodeHint')} error={customsError('hsCode')}>
            <Input value={draft.customs.hsCode} maxLength={20} inputMode="numeric" onChange={(event) => setCustoms('hsCode', event.target.value)} />
          </Field>
          <Field label={t('customs.origin')} hint={t('customs.originHint')} error={customsError('originCountry')}>
            <Select value={draft.customs.originCountry} onChange={(event) => setCustoms('originCountry', event.target.value)}>
              <option value="">{t('customs.notOnRecord')}</option>
              {hydrated
                ? countryOptions(locale).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({option.value})
                    </option>
                  ))
                : draft.customs.originCountry && <option value={draft.customs.originCountry}>{draft.customs.originCountry}</option>}
            </Select>
          </Field>
          <Field label={t('customs.netMass')} hint={t('customs.netMassHint')} error={customsError('netMassKg')}>
            <Input value={draft.customs.netMassKg} maxLength={14} inputMode="decimal" suffix="kg" onChange={(event) => setCustoms('netMassKg', event.target.value)} />
          </Field>
        </div>
      </div>
      <Field label={t('identity.description')} hint={t('identity.descriptionHint')}>
        <Textarea value={draft.description} rows={3} maxLength={4000} onChange={(event) => set('description', event.target.value)} />
      </Field>
      {count > 0 ? (
        <EditModeBar count={count} message={t('identity.unsaved', { count })} onDiscard={() => setDraft(base)} onApply={() => void save()} applyLabel={t('identity.save')} applyHeldReason={held} busy={saving} saveShortcut />
      ) : (
        <span>
          <Button size="sm" onClick={onDone}>
            {t('common.back')}
          </Button>
        </span>
      )}
    </div>
  )
}
