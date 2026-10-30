'use client'

import type { ReactNode } from 'react'
import { ShieldOff } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import type { CrViStatus, HideState, MoveReason, QualityStatus, Uom } from './api'
import { convertArea, CR_VI_TONE, decimalValue, HIDE_TONE, isArea, otherAreaUnit, QUALITY_TONE, quantity, REASON_TONE, STOCK_NAMESPACES } from './model'
import './stock.css'

/**
 * View parts every warehouse stock screen draws the same way (Stock, Movements, Locations, Hides, Lots): the state pills
 * in words (never colour alone), a quantity with its unit, leather's two numbers (hides · area, the other area unit in
 * the title and in words), and the page states (no right, a failed read with Try again). They speak the `stock`
 * catalogue; a page wraps its view in <StockMessages extra={['its-own']} />.
 */

export function StockMessages({ extra = [], children }: { extra?: readonly string[]; children?: ReactNode }) {
  return <WithMessages namespaces={[...STOCK_NAMESPACES, ...extra]}>{children}</WithMessages>
}

/** The words of a unit ("m²", "pz"). */
export function useUnitWord(): (uom: Uom) => string {
  const t = useT('stock')
  return (uom) => t(`uom.${uom}`)
}

export function QualityPill({ status }: { status: QualityStatus }) {
  const t = useT('stock')
  return <Pill tone={QUALITY_TONE[status]}>{t(`quality.${status}`)}</Pill>
}

/** Cr VI in words, with the value against the limit when tested ("Cr VI pass · 1,2 < 3 mg/kg"). */
export function CrViPill({ status, value, limit }: { status: CrViStatus; value?: string | null; limit?: string | null }) {
  const t = useT('stock')
  const locale = useLocale()
  const shown = value && limit ? t(status === 'FAIL' ? 'crVi.valueFail' : 'crVi.value', { value: quantity(value, locale, 3), limit: quantity(limit, locale, 3) }) : null
  return (
    <span className="fw-st-inline">
      <Pill tone={CR_VI_TONE[status]}>{t(`crVi.${status}`)}</Pill>
      {shown && <span className="fw-st-sub">{shown}</span>}
    </span>
  )
}

export function HideStatePill({ state }: { state: HideState }) {
  const t = useT('stock')
  return <Pill tone={HIDE_TONE[state]}>{t(`hideState.${state}`)}</Pill>
}

export function ReasonTag({ reason }: { reason: MoveReason }) {
  const t = useT('stock')
  return <Tag tone={REASON_TONE[reason]}>{t(`reason.${reason}`)}</Tag>
}

/** A quantity with its unit ("12,5 m²"); an area also says the other unit in its title ("134,5 ft²"). */
export function Qty({ value, uom, decimals = 2, strong }: { value: string | number | null | undefined; uom: Uom; decimals?: number; strong?: boolean }) {
  const t = useT('stock')
  const locale = useLocale()
  const number = typeof value === 'number' ? value : decimalValue(value)
  const other = number !== null && isArea(uom) ? otherAreaUnit(uom) : null
  const converted = other && number !== null ? convertArea(number, uom, other) : null
  const text = `${quantity(number, locale, decimals)} ${t(`uom.${uom}`)}`
  const title = converted !== null && other ? `${quantity(converted, locale, decimals)} ${t(`uom.${other}`)}` : undefined
  return (
    <span className={strong ? 'fw-st-num strong' : 'fw-st-num'} title={title}>
      {text}
    </span>
  )
}

/**
 * Leather's two numbers side by side (design DualQuantityCell): "37 hides · 412,5 m²"; the other area unit under it in
 * words ("4.440 ft²") when `both`.
 */
export function Dual({ hides, area, uom, both = false }: { hides: number | null; area: string | number | null | undefined; uom: Uom; both?: boolean }) {
  const t = useT('stock')
  const locale = useLocale()
  const number = typeof area === 'number' ? area : decimalValue(area)
  const other = isArea(uom) ? otherAreaUnit(uom) : null
  const converted = other && number !== null ? convertArea(number, uom, other) : null
  const count = hides === null ? '—' : t('hides', { count: hides })
  const first = `${quantity(number, locale)} ${t(`uom.${uom}`)}`
  const second = converted !== null && other ? `${quantity(converted, locale)} ${t(`uom.${other}`)}` : null
  return (
    <span className="fw-st-dual" title={second ?? undefined}>
      <span className="fw-st-num">{t('dual', { count, area: first })}</span>
      {both && second && <span className="fw-st-sub">{second}</span>}
    </span>
  )
}

/** The page says which permission is missing (design R9), never an empty list. */
export function NoAccess({ permission }: { permission: string }) {
  const t = useT('stock')
  return <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('problem.forbidden')} description={t('problem.noPermission', { permission })} />
}

/** A failed read in words with Try again (never drawn as an empty list). */
export function ReadFailed({ problem, onRetry }: { problem: string; onRetry?: () => void }) {
  const t = useT('stock')
  return (
    <Banner
      tone="danger"
      title={t(problem)}
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            {t('problem.retry')}
          </Button>
        ) : undefined
      }
    />
  )
}
