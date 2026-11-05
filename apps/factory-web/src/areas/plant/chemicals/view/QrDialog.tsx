'use client'

import { Printer, QrCode } from 'lucide-react'
import { EmptyState, Field } from '@nexus/ui/components'
import { LabelPreview, type LabelLayout } from '@nexus/ui/components/LabelPreview/index'
import { Button, Select } from '@nexus/ui/primitives'
import { cabinetAddress } from '@nexus/factory-domain/safety/chemicals/rules'
import { Modal } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Cabinet } from '../api'
import type { ChemicalsPageActions, ChemicalsPageModel, QrState } from '../view-model'
import { CabinetQr, SectionFailed, SectionLoading, useWords } from './parts'

/** The cabinet sheet's tab (design plant.chemicals/tab:cabinet "Products in that cabinet with pictograms, for the wall"). */
export const cabinetHref = (prefix: string, siteId: string, code: string): string => `${prefix}/plant/chemicals/cabinet?site=${encodeURIComponent(siteId)}&code=${encodeURIComponent(code)}`

/** The cabinet's label: its code big, its site and places, and the QR to its list (the floor page that reads it offline). */
export function cabinetLabel(t: Translate, cabinet: Pick<Cabinet, 'code' | 'site' | 'places'>, address: string): LabelLayout {
  return {
    name: t('qr.labelName', { cabinet: cabinet.code }),
    widthMm: 90,
    heightMm: 50,
    blocks: [
      {
        kind: 'row',
        blocks: [
          {
            kind: 'fields',
            columns: 1,
            fields: [
              { label: t('qr.labelCabinet'), value: cabinet.code, size: 'xl' },
              { label: t('qr.labelSite'), value: cabinet.site.name, size: 'sm' },
              { label: t('qr.labelPlace'), value: cabinet.places.join(' · ') || '—', size: 'sm' },
            ],
          },
          { kind: 'qr', value: address, sizeMm: 30 },
        ],
      },
      { kind: 'fill' },
      { kind: 'text', text: t('qr.labelScan'), size: 'sm', bold: true },
    ],
  }
}

/**
 * Print cabinet QR (design pop:qr: "LabelPreview: cabinet name + QR to its list", action Print): the cabinets of the top
 * bar's site (a cabinet is the code a chemical names), the label to scale with the QR that opens that cabinet's products and
 * their current sheets on the site's tablets — from what each tablet keeps, so it reads offline — and Print, which opens the
 * cabinet sheet (the label and every product with its pictograms) in a new tab for the wall.
 */
export function QrDialog({ model, state, actions }: { model: ChemicalsPageModel; state: QrState; actions?: ChemicalsPageActions | undefined }) {
  const t = useWords()
  const close = () => actions?.onAddress?.({ qr: false })
  const cabinets = state.cabinets.status === 'ready' ? state.cabinets.value : null
  const chosen = cabinets?.find((cabinet) => `${cabinet.siteId}|${cabinet.code}` === state.chosen) ?? null
  const address = chosen && model.origin ? cabinetAddress(model.origin, chosen.code) : null
  return (
    <Modal
      open
      onClose={close}
      title={t('qr.title')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.close')}</Button>
          {chosen ? (
            <Button asChild variant="primary">
              <a href={cabinetHref(model.prefix, chosen.siteId, chosen.code)} target="_blank" rel="noopener noreferrer">
                <Printer size={14} aria-hidden /> {t('qr.print')}
              </a>
            </Button>
          ) : (
            <Button variant="primary" heldReason={cabinets ? t('held.noCabinet') : t('common.reading')}>
              <Printer size={14} aria-hidden /> {t('qr.print')}
            </Button>
          )}
        </>
      }
    >
      {state.cabinets.status === 'error' ? (
        <SectionFailed title={t('qr.failed')} problem={state.cabinets.problem} onRetry={actions?.onRetryCabinets} />
      ) : !cabinets ? (
        <SectionLoading rows={3} />
      ) : cabinets.length === 0 ? (
        <EmptyState icon={<QrCode size={22} aria-hidden />} title={t('qr.emptyTitle')} description={t('qr.empty')} />
      ) : (
        <div className="fw-ch-qr">
          <div className="fw-ch-form">
            <Field label={t('qr.cabinet')}>
              <Select value={state.chosen ?? ''} onChange={(event) => actions?.onQrChoose?.(event.target.value)}>
                {cabinets.map((cabinet) => (
                  <option key={`${cabinet.siteId}|${cabinet.code}`} value={`${cabinet.siteId}|${cabinet.code}`}>
                    {model.scope.allSites ? `${cabinet.code} · ${cabinet.site.name}` : cabinet.code}
                  </option>
                ))}
              </Select>
            </Field>
            {chosen && (
              <>
                <p className="fw-ch-muted">{t('qr.products', { count: chosen.products })}</p>
                {chosen.withoutSheet > 0 && <p className="fw-ch-warn">{t('qr.withoutSheet', { count: chosen.withoutSheet })}</p>}
                <p className="fw-ch-muted">{t('qr.howItWorks')}</p>
              </>
            )}
          </div>
          {chosen && address && (
            <LabelPreview
              layout={cabinetLabel(t, chosen, address)}
              scale={4}
              renderQr={(value) => <CabinetQr value={value} label={t('qr.codeLabel', { cabinet: chosen.code })} />}
              codeLabel={() => t('qr.codeLabel', { cabinet: chosen.code })}
            />
          )}
        </div>
      )}
    </Modal>
  )
}
