import { formatNumber } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import type { FlowValue } from './api'

/** Today's value per stage (B-W2b-435), pure. */

/** The cost grain's money of a stage in the company's currency (minor units), said; null when not known. */
export function stageValueText(value: number | null | undefined, currency: string | null, locale: Locale): string | null {
  if (value === null || value === undefined || !currency) return null
  const amount = value / 100
  return formatNumber(amount, locale, { style: 'currency', currency, maximumFractionDigits: Math.abs(amount) >= 10_000 ? 0 : 2 })
}

/** The whole flow's value (null when a stage's value is not known). */
export function totalOf(flow: FlowValue): number | null {
  if (flow.mixedCurrencies || flow.stages.some((stage) => stage.value === null || stage.value === undefined)) return null
  return flow.stages.reduce((total, stage) => total + (stage.value ?? 0), 0)
}

/** Whether the strip shows: the work-order lens is the one shown and the reader holds the cost grain. */
export const flowValueShown = (lens: string | null, flow: FlowValue | null): boolean => lens === 'WORK_ORDERS' && flow !== null && flow.valued
