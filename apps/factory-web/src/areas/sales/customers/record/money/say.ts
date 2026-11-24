import { formatDate } from '../../../../../lib/i18n/format'
import type { Locale } from '../../../../../lib/i18n/locales'
import type { Translate } from '../../../../../lib/i18n/messages'
import { money } from '../../../quotes/model'
import { dayInstant } from '../../../orders/model'
import { pctOf } from '../../../orders/record/money/view/say'
import type { MoneyWord } from '../../../orders/record/money/word'

/**
 * F-CM-101 (18-lead-settles Z15) — how the customer's Money tab says its rules' words: the order Money's own way (rec/money/view/say.ts
 * useSay — amounts in a currency, days, instants, percents, inner words), over `namespace:key` keys: the tab's own words are
 * `customer-money`'s (no prefix); a word reused from another catalogue names it (`orders:moneyTab.plan.kind.DEPOSIT`,
 * `sales-customers-depth:reason.CREDIT`) — never a second word, and never a customer word asked of the `orders` catalogue. The shared
 * parts (cm-k1) say their ORDER words with their own `useSay`. Pure: `t` is a scoped translator (useScopedT / createScopedTranslator).
 */
export type CustomerSay = (said: MoneyWord) => string

export function sayOf(t: Translate, locale: Locale, currency: string): CustomerSay {
  const say: CustomerSay = (said) => {
    const values: Record<string, string | number> = { ...(said.params ?? {}) }
    for (const [name, amount] of Object.entries(said.money ?? {})) values[name] = money(amount, currency, locale)
    for (const [name, day] of Object.entries(said.days ?? {})) values[name] = formatDate(dayInstant(day), { locale })
    for (const [name, at] of Object.entries(said.instants ?? {})) values[name] = formatDate(at, { locale })
    for (const [name, pct] of Object.entries(said.pcts ?? {})) values[name] = pctOf(pct, locale)
    for (const [name, inner] of Object.entries(said.words ?? {})) values[name] = say(inner)
    return t(said.key, values)
  }
  return say
}
