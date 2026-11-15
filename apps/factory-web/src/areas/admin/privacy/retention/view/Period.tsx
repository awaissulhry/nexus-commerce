'use client'

import { useT } from '../../../../../lib/i18n/provider'
import { periodParts } from '../model'

/** "10 years", "2 years and 6 months", "18 months" in the page's language (the API's English period is never drawn). */
export function Period({ months }: { months: number }) {
  const t = useT('admin-privacy-depth')
  const parts = periodParts(months)
  const years = parts.years > 0 ? t('dp.ret.period.years', { count: parts.years }) : ''
  const rest = parts.months > 0 ? t('dp.ret.period.months', { count: parts.months }) : ''
  return <span>{years && rest ? t('dp.ret.period.both', { years, months: rest }) : years || rest}</span>
}
