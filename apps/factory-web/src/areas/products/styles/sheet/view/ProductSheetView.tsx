'use client'

import { ImageOff } from 'lucide-react'
import { KeyValue, SummaryTable } from '@nexus/ui/components'
import { Skeleton } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { PRODUCT_NS, useProductWords } from '../../record/product-words'
import type { ProductSheet } from '../sheet-model'
import '../sheet.css'

/**
 * owb-pd4 step 4.2 (design § 5q; prototype prod.js prodSheetSvg: "ONE A4 page, for the screen and for the PDF. Never a price") — the
 * Product sheet, drawn in the Office's print view (`?sheet=1&print=1`, a new tab from the band's "Product sheet"): the shell's paper
 * head names the company and who printed it when; this page draws the product — its name and code, the design pictures front and
 * back, the facts, the size table, how to measure and the protectors. The browser prints it or saves it as PDF. It draws one model
 * (sheet-model.ts, no money in it) and fetches nothing.
 */
export function ProductSheetView({ model }: { model: ProductSheet | null }) {
  return (
    <WithMessages namespaces={['products', PRODUCT_NS, 'products-prepacks']}>
      <Sheet model={model} />
    </WithMessages>
  )
}

function Sheet({ model }: { model: ProductSheet | null }) {
  const { t, tp, say } = useProductWords()
  if (!model)
    return (
      <div className="fw-pd-sheet" aria-busy="true">
        <Skeleton width={320} height={28} />
        <Skeleton height={260} />
      </div>
    )
  return (
    <article className="fw-pd-sheet" aria-labelledby="fw-pd-sheet-title">
      <header className="fw-pd-sheet-head">
        <h1 id="fw-pd-sheet-title" className="fw-pd-sheet-title">
          {model.name}
        </h1>
        <p className="fw-pd-sheet-sub">
          {t('sheet.subtitle', { code: model.code })}
          {model.revision ? ` · ${t('sheet.revision', { revision: model.revision.revision, status: tp(`revisionStatus.${model.revision.status}`) })}` : ''}
        </p>
      </header>
      <div className="fw-pd-sheet-top">
        <div className="fw-pd-sheet-pics">
          {model.pictures.length === 0 ? (
            <p className="fw-pd-sheet-none">
              <ImageOff size={16} aria-hidden /> {t('sheet.noPicture')}
            </p>
          ) : (
            model.pictures.map((picture, index) => (
              <figure key={picture.src} className="fw-pd-sheet-pic">
                <img src={picture.src} alt={picture.caption ?? t(index === 0 ? 'sheet.front' : 'sheet.back')} />
                <figcaption>{picture.caption ?? t(index === 0 ? 'sheet.front' : 'sheet.back')}</figcaption>
              </figure>
            ))
          )}
        </div>
        <KeyValue labelCase="sentence" items={model.facts.map((fact) => ({ label: t(fact.label), value: say(fact.value) }))} />
      </div>
      {model.sizes && (
        <section className="fw-pd-sheet-part" aria-label={t('sheet.sizeTable')}>
          <h2 className="fw-pd-sheet-h2">{t('sheet.sizeTable')}</h2>
          <SummaryTable
            label={t('sheet.sizeTable')}
            columns={[t('sheet.point'), ...model.sizes.columns.map((size) => (size === model.sizes?.base ? t('sheet.baseColumn', { size }) : size)), t('sheet.tolerance')]}
            align={[undefined, ...model.sizes.columns.map(() => 'right' as const), 'right']}
            rows={model.sizes.rows.map((row) => ({ id: row.code, cells: [`${row.code} · ${row.name}`, ...row.values.map((value) => value ?? '—'), row.tolerance ?? '—'] }))}
          />
          <p className="fw-pd-sheet-note">{t('sheet.inMm')}</p>
        </section>
      )}
      {model.howTo.length > 0 && (
        <section className="fw-pd-sheet-part" aria-label={t('sheet.howTo')}>
          <h2 className="fw-pd-sheet-h2">{t('sheet.howTo')}</h2>
          <ol className="fw-pd-sheet-how">
            {model.howTo.map((row) => (
              <li key={row.code}>
                <b>{row.name}</b> {row.text ?? t('sheet.noHowTo')}
              </li>
            ))}
          </ol>
        </section>
      )}
      {model.protectors.length > 0 && <ProtectorsPart protectors={model.protectors} />}
      <p className="fw-pd-sheet-note">{t('sheet.noPrice')}</p>
    </article>
  )
}

function ProtectorsPart({ protectors }: { protectors: ProductSheet['protectors'] }) {
  const { t } = useProductWords()
  // The protector words are the Sizes tab's own (`products-prepacks` protectors.*).
  const tr = useT('products-prepacks')
  return (
    <section className="fw-pd-sheet-part" aria-label={t('sheet.protectors')}>
      <h2 className="fw-pd-sheet-h2">{t('sheet.protectors')}</h2>
      <ul className="fw-pd-sheet-prot">
        {protectors.map((row, index) => (
          <li key={`${row.pocket}:${index}`}>
            <b>{tr(`protectors.pocket.${row.pocket}`)}</b> {tr('protectors.level', { level: row.level })}
            {row.sizes.length > 0 ? ` · ${row.sizes.join(' · ')}` : ''}
          </li>
        ))}
      </ul>
    </section>
  )
}
