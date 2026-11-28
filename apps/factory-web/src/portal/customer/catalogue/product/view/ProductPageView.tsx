'use client'

import Link from 'next/link'
import { KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { Quiet, Section } from '../../../../../lib/record-sections/Kit'
import { Loading, ReadFailed } from '../../../neworder/view/parts'
import { useOrderingWords } from '../../../neworder/words'
import { NS, ppeWords, typeKey } from '../../model'
import type { PortalMeasures, PortalProductPage, ProductTab } from '../product-model'
import '../../catalogue.css'

/** The page's own words (owb-pd4, S4 settle 10: new words in a new catalogue). */
export const PRODUCT_NS = 'portal-product'

export interface ProductPageModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  tab: ProductTab
  page: PortalProductPage | null
  /** "Ask for a change": New order's request with the product carried in (today's "Ask about this style"), and why it is held. */
  askHref: string
  askHeld: string | null
  /** The product's sheet (today's tab:style-sheet), a new tab. */
  sheetHref: string
}

/**
 * owb-pd4 step 4.5 (gap G9; design § 5q, § 5r "Customer") — the customer's product page, two tabs in the frame's band (Overview,
 * Sizes), drawn in the section kit (a portal page may draw it): Overview — the facts, Your price (only with the price grain), Your
 * orders with it, Ask for a change; Sizes — the range and its base size and the sizes each colour offers, nothing to type. Never a
 * cost, a revision, a route or the factory's product code; another customer's product never reaches it (the read answers 404). It
 * draws one model and fetches nothing (ProductPage.tsx reads).
 */
export function ProductPageView({ model, onRetry }: { model: ProductPageModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[NS, PRODUCT_NS, 'orders', 'ds-words']}>
      <Body model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function Body({ model, onRetry }: { model: ProductPageModel; onRetry?: () => void }) {
  const t = useT(PRODUCT_NS)
  if (model.state === 'loading') return <Loading rows={4} />
  if (model.state !== 'ready' || !model.page) return <ReadFailed title={t(model.state === 'missing' ? 'state.missing' : 'state.failed')} onRetry={model.state === 'error' ? onRetry : undefined} />
  return <div className="fw-pt fw-pprod">{model.tab === 'sizes' ? <SizesTab page={model.page} /> : <OverviewTab model={model} page={model.page} />}</div>
}

function OverviewTab({ model, page }: { model: ProductPageModel; page: PortalProductPage }) {
  const t = useT(PRODUCT_NS)
  const words = useOrderingWords()
  const sheet = (
    <Button key="sheet" size="sm" asChild>
      <a href={model.sheetHref} target="_blank" rel="noopener">
        {t('overview.sheet')}
      </a>
    </Button>
  )
  return (
    <>
      <p className="fw-pprod-answer">
        <b>{page.name}.</b> {t(page.family === 'OWN' ? 'overview.answer.own' : 'overview.answer.range')}{' '}
        {page.orders && page.orders.length > 0 ? t('overview.answer.orders', { count: page.orders.length }) : ''}
      </p>
      <div className="fw-pt-pairs">
        <Section id="pp-facts" title={t('overview.facts.title')} buttons={[sheet]} info={<p>{t('overview.facts.info')}</p>}>
          {/* owb-pd5 (step 5.0): the main picture from the product's Sizes read (pd4s). */}
          {page.picture ? <img className="fw-pprod-pic" src={page.picture} alt={t('overview.picture', { name: page.name })} loading="lazy" decoding="async" /> : null}
          <KeyValue
            labelCase="sentence"
            items={[
              { label: t('overview.facts.type'), value: `${words.t(typeKey(page.type))}${page.season ? ` · ${page.season}` : ''}` },
              { label: t('overview.facts.family'), value: t(page.family === 'OWN' ? 'overview.facts.own' : 'overview.facts.range') },
              { label: t('overview.facts.sizes'), value: page.sizes.range || '—', hint: page.sizes.base ? t('sizes.base', { size: page.sizes.base }) : undefined },
              { label: t('overview.facts.protection'), value: ppeWords(page.ppe, words.t) },
            ]}
          />
          {page.description ? <p className="fw-pprod-text">{page.description}</p> : null}
        </Section>
        <Section
          id="pp-price"
          title={t('overview.price.title')}
          answer={page.price ? (page.price.from ? t('overview.price.from', { price: words.price(page.price.from, page.price.currency) ?? '—' }) : t('overview.price.none')) : t('overview.price.notInRole')}
          info={<p>{t('overview.price.info')}</p>}
        >
          {page.price && page.price.byColour.some((row) => row.price) ? (
            <SummaryTable
              label={t('overview.price.title')}
              columns={[t('overview.price.colour'), t('overview.price.each')]}
              align={[undefined, 'right']}
              rows={page.price.byColour.map((row) => ({ id: row.colour, cells: [row.colour, words.price(row.price, page.price!.currency) ?? t('overview.price.ask')] }))}
              stackOnPhone
            />
          ) : null}
        </Section>
      </div>
      {page.orders !== null ? (
        <Section id="pp-orders" title={t('overview.orders.title')} answer={page.orders.length === 0 ? undefined : t('overview.orders.answer', { count: page.orders.length })} info={<p>{t('overview.orders.info')}</p>}>
          {page.orders.length === 0 ? (
            <Quiet>{t('overview.orders.none')}</Quiet>
          ) : (
            <table className="fw-pt-table">
              <thead>
                <tr>
                  <th>{t('overview.orders.col.order')}</th>
                  <th>{t('overview.orders.col.state')}</th>
                  <th className="fw-pt-x">{t('overview.orders.col.pieces')}</th>
                </tr>
              </thead>
              <tbody>
                {page.orders.map((row) => (
                  <tr key={row.id}>
                    <td className="fw-pt-first">
                      <Link className="fw-pt-link" href={row.href}>
                        {row.label}
                      </Link>
                      {row.on ? <span className="fw-pt-sub">{words.day(row.on)}</span> : null}
                    </td>
                    <td data-label={t('overview.orders.col.state')}>{row.state}</td>
                    <td className="fw-pt-x" data-label={t('overview.orders.col.pieces')}>
                      {row.pieces}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      ) : null}
      {/* owb-pd7 (web B, only if design round 38 is done): the "Tech pack" card of the customer's OWN design goes HERE — after Your
          orders with it, before Ask for a change (prototype prodBody: techPortalCard, then prodChanges); web B adds its part in this
          folder and one line at this spot. */}
      <Section
        id="pp-change"
        title={t('overview.change.title')}
        answer={t('overview.change.answer')}
        buttons={[
          model.askHeld ? (
            <Button key="ask" size="sm" heldReason={words.t(model.askHeld)}>
              {t('overview.change.ask')}
            </Button>
          ) : (
            <Button key="ask" size="sm" asChild>
              <a href={model.askHref}>{t('overview.change.ask')}</a>
            </Button>
          ),
        ]}
        info={<p>{t('overview.change.info')}</p>}
      >
        <Quiet>{t('overview.change.how')}</Quiet>
      </Section>
    </>
  )
}

function SizesTab({ page }: { page: PortalProductPage }) {
  const t = useT(PRODUCT_NS)
  const matrix = page.sizes.matrix
  return (
    <>
      <p className="fw-pprod-answer">
        <b>{page.sizes.range || t('sizes.noRange')}.</b> {page.sizes.base ? t('sizes.base', { size: page.sizes.base }) : ''}
      </p>
      <Section id="pp-sizes" title={t('sizes.title')} answer={matrix.sizes.length ? t('sizes.answer', { count: matrix.sizes.length }) : t('sizes.noRange')} info={<p>{t('sizes.info')}</p>}>
        {matrix.rows.length > 0 && matrix.sizes.length > 0 ? (
          <SummaryTable
            label={t('sizes.title')}
            columns={[t('sizes.colour'), ...matrix.sizes.map((size) => (size === page.sizes.base ? t('sizes.baseColumn', { size }) : size))]}
            rows={matrix.rows.map((row) => ({ id: row.id, cells: [row.label, ...row.offered.map((offered) => (offered ? t('sizes.offered') : t('sizes.notOffered')))] }))}
            stackOnPhone
          />
        ) : null}
      </Section>
      {/* owb-pd5 (step 5.0; pd4s s.3): the size table, how to measure and the protectors of the newest released revision — nothing to type. */}
      {page.measures ? (
        <MeasuresParts measures={page.measures} />
      ) : (
        <Section id="pp-measure" title={t('sizes.measure.title')} answer={t('sizes.measure.answer')} info={<p>{t('sizes.measure.info')}</p>}>
          <Quiet>{t('sizes.measure.later')}</Quiet>
        </Section>
      )}
    </>
  )
}

const PROTECTOR_ZONES = ['SHOULDER', 'ELBOW', 'BACK', 'CHEST', 'HIP', 'KNEE']

function MeasuresParts({ measures }: { measures: PortalMeasures }) {
  const t = useT(PRODUCT_NS)
  const zoneWords = (zone: string) => (PROTECTOR_ZONES.includes(zone) ? t(`zone.${zone}`) : zone)
  return (
    <>
      {measures.mode === 'SIZES' && measures.rows.length > 0 ? (
        <Section id="pp-table" title={t('sizes.table.title')} answer={t('sizes.table.answer')} info={<p>{t('sizes.table.info')}</p>}>
          <SummaryTable
            label={t('sizes.table.title')}
            columns={[t('sizes.table.point'), ...measures.sizes.map((size) => (size === measures.base ? t('sizes.baseColumn', { size }) : size))]}
            align={[undefined, ...measures.sizes.map(() => 'right' as const)]}
            rows={measures.rows.map((row) => ({ id: row.code, cells: [row.name, ...row.values.map((value) => (value === null ? '—' : String(value)))] }))}
            stackOnPhone
          />
        </Section>
      ) : measures.mode === 'MADE_TO_MEASURE' ? (
        <Section id="pp-table" title={t('sizes.table.title')} answer={t('sizes.table.mtm')} info={<p>{t('sizes.table.info')}</p>}>
          <Quiet>{t('sizes.table.mtmHow')}</Quiet>
        </Section>
      ) : null}
      <Section id="pp-howto" title={t('sizes.howTo.title')} answer={measures.howTo.length ? undefined : t('sizes.howTo.none')} info={<p>{t('sizes.howTo.info')}</p>}>
        {measures.howTo.length > 0 ? (
          <ol className="fw-pprod-howto">
            {measures.howTo.map((row) => (
              <li key={row.code}>
                <b>{row.name}</b> {row.text}
              </li>
            ))}
          </ol>
        ) : null}
      </Section>
      {measures.protectors.length > 0 ? (
        <Section id="pp-protectors" title={t('sizes.protectors.title')} info={<p>{t('sizes.protectors.info')}</p>}>
          <ul className="fw-pprod-howto">
            {measures.protectors.map((row, index) => (
              <li key={`${row.zone}:${index}`}>
                <b>{zoneWords(row.zone)}</b> {t(`sizes.protectors.level.${row.level}`)}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  )
}
