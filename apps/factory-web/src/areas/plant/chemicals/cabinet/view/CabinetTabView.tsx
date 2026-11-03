'use client'

import { Printer } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { cabinetAddress, type QuantityUnit } from '@nexus/factory-domain/safety/chemicals/rules'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { CabinetSheet } from '../../api'
import '../../chemicals.css'
import { quantityOf } from '../../model'
import { CabinetQr, CHEMICALS_NAMESPACES, GhsMarks, NoChemicalsAccess, SignalWord, useDay, useWords } from '../../view/parts'

/** SCR-213-cabinet — one cabinet's sheet for the wall: one view model, nothing fetched. */
export interface CabinetTabModel {
  readonly canView: boolean
  readonly person: string
  readonly at: string
  /** This web's address: the QR holds the cabinet's floor page under it. */
  readonly origin: string
  readonly cabinet: { readonly value: CabinetSheet | null; readonly problem: string | null }
}

/**
 * Plant › Chemicals & waste › Cabinet sheet (design plant.chemicals/tab:cabinet): the cabinet's code, site and places, its
 * QR (a tablet of the site that scans it opens the cabinet's products and their current safety data sheets from what it
 * keeps, offline), and every product in the cabinet with its pictograms, signal word, H and P statements, the most kept,
 * the PPE to wear and its current sheets. Printed from the browser for the wall (the Print button is not printed).
 */
export function CabinetTabView({ model }: { model: CabinetTabModel }) {
  return (
    <WithMessages namespaces={CHEMICALS_NAMESPACES}>
      <Sheet model={model} />
    </WithMessages>
  )
}

function Sheet({ model }: { model: CabinetTabModel }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const locale = useLocale()
  if (!model.canView) return <NoChemicalsAccess />
  const cabinet = model.cabinet.value
  const unit = (code: QuantityUnit) => t(`unit.${code}`)
  return (
    <article className="fw-ch-tab">
      {model.cabinet.problem ? (
        <Banner tone="danger" title={t('cabinetTab.failed')}>
          {t(model.cabinet.problem)}
        </Banner>
      ) : !cabinet ? (
        <p className="fw-ch-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : (
        <>
          <header className="fw-ch-sheet-head">
            <div className="fw-ch-stack">
              <h1 className="fw-ch-h">{t('cabinetTab.title', { cabinet: cabinet.code })}</h1>
              <p className="fw-ch-muted">{`${cabinet.company.name} · ${cabinet.site.name} · ${cabinet.places.join(' · ')}`}</p>
              <span className="fw-ch-row">
                <LawRef law={cabinet.law.register} plain={t('law.register')} labels={ds.lawRef} />
                <LawRef law={cabinet.law.sds} plain={t('law.sds')} labels={ds.lawRef} />
              </span>
              <p className="fw-ch-muted">{t('cabinetTab.scan')}</p>
              <p className="fw-ch-muted">{t('print.meta', { at: formatDateTime(model.at, { locale }), person: model.person })}</p>
              <span className="fw-ch-noprint">
                <Button variant="secondary" onClick={() => window.print()}>
                  <Printer size={14} aria-hidden /> {t('cabinetTab.print')}
                </Button>
              </span>
            </div>
            <div className="fw-ch-sheet-qr">{model.origin && <CabinetQr value={cabinetAddress(model.origin, cabinet.code)} label={t('qr.codeLabel', { cabinet: cabinet.code })} />}</div>
          </header>
          <div className="fw-ch-sheet-items">
            {cabinet.chemicals.map((chemical) => (
              <section key={chemical.id} className="fw-ch-sheet-item" aria-label={chemical.name}>
                <span className="fw-ch-row">
                  <strong>{chemical.name}</strong>
                  <SignalWord word={chemical.signalWord} say={t} />
                </span>
                <span className="fw-ch-muted">{[t(`use.${chemical.use}`), chemical.supplier].filter(Boolean).join(' · ')}</span>
                <GhsMarks codes={chemical.ghsPictograms} say={t} big />
                <span className="fw-ch-codes">{chemical.hazardStatements.join(' ') || '—'}</span>
                <span className="fw-ch-codes">{chemical.precautionStatements.join(' ') || '—'}</span>
                <span className="fw-ch-muted">{t('cabinetTab.most', { quantity: quantityOf(chemical, unit) ?? '—' })}</span>
                <span className="fw-ch-muted">{t('cabinetTab.ppe', { ppe: chemical.ppe.join(', ') || t('window.noPpe') })}</span>
                <span className="fw-ch-muted">{chemical.current.length === 0 ? t('sds.none') : t('cabinetTab.sds', { sheets: chemical.current.map((sheet) => `${sheet.versionLabel} (${sheet.language}, ${day(sheet.revisedOn)})`).join(' · ') })}</span>
              </section>
            ))}
          </div>
        </>
      )}
    </article>
  )
}
