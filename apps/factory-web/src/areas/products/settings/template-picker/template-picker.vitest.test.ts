import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { COMPANY_ID } from '../../library/demo'
import { DEMO_TEMPLATES, OLD_JACKET_TEMPLATE } from './fixtures'
import { NS, templateChoices } from './model'
import { TemplatePicker } from './view/TemplatePicker'

/** B-W2b-283 (FU1:03): a product type picks its measurement template from the active ones of its garment and company. */

describe('the templates a type may pick', () => {
  it('the active ones of its kind of garment, of its company or every company (a type of every company: every company’s only)', () => {
    expect(templateChoices(DEMO_TEMPLATES, { productType: 'JACKET', companyId: COMPANY_ID }).map((template) => template.code)).toEqual(['DEMO-MTM-JKT', 'DEMO-MTM-JKT-A'])
    expect(templateChoices(DEMO_TEMPLATES, { productType: 'JACKET', companyId: null }).map((template) => template.code)).toEqual(['DEMO-MTM-JKT'])
    expect(templateChoices(DEMO_TEMPLATES, { productType: 'GLOVES', companyId: COMPANY_ID })).toEqual([])
  })

  it('draws the pick, the one no longer offered, and the reading and failed states, in both languages', () => {
    const draw = (locale: (typeof LOCALES)[number], templates: Parameters<typeof TemplatePicker>[0]['templates'], measurementTemplateId: string | null) =>
      renderToString(
        createElement(
          I18nProvider,
          { locale, messages: messagesFor(locale, [NS]) },
          createElement(TemplatePicker, { label: 'Template', templates, draft: { productType: 'JACKET', companyId: COMPANY_ID, measurementTemplateId }, current: null, inherits: null, emptyOption: '—', onPick: () => undefined }),
        ),
      )
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]![NS]!
      const picked = draw(locale, { value: DEMO_TEMPLATES, problem: null }, OLD_JACKET_TEMPLATE.id)
      expect(picked).toContain('DEMO-MTM-JKT-A')
      expect(picked).not.toContain('DEMO-MTM-TRS')
      expect(picked).toContain(words['templates.notOffered']!.replace('{template}', '').trim().slice(2, 10))
      expect(draw(locale, null, null)).toContain(words['templates.reading']!)
      expect(draw(locale, { value: null, problem: 'problem.read.unavailable' }, null)).toContain(words['templates.failed']!.slice(0, 20))
      expect(picked).not.toMatch(/\btemplates\.[a-zA-Z]+/)
    }
  })
})
