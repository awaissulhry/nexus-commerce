import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { CATALOGUE, createTranslator } from '../../../../../lib/i18n/messages'
import { LOCALES, type Locale } from '../../../../../lib/i18n/locales'
import type { SendCheck } from '../../../../sales/quotes/api'
import { sendModel } from '../../../../sales/quotes/record/fixtures'
import { sendItems } from '../../../../sales/quotes/record/send-model'
import { DocumentSendPreview, type DocumentSendPreviewModel } from '../../view/DocumentSendView'
import { MTM_FIX_NAMESPACE, type FixUnit } from './model'

/**
 * SCR-037-fix-mtm — the send dialog's fix tab for the made-to-measure line checks (B-W2b-368, XF1:04) with a made-up quote: each
 * MTM_* check in words of its unit (line, rider, garment, revision) with "Open the rider profile"; the measures outside the
 * certified range blocking Send (held with the check's words); made-to-measure not started (the off state in words); an older
 * revision and old measures (warnings); a person who may not see measurements (no link); the units not read (the general words).
 */

const PREFIX = '/w/DEMO'
const QUOTE = '0190f0e2-3681-7000-8000-000000000001'
const UNITS: FixUnit[] = [
  { lineId: '0190f0e2-3681-7000-8000-000000000101', seq: 10, profile: { id: '0190f0e2-3681-7000-8000-000000000201', riderName: 'Marco Esempio', garmentType: 'JACKET', revision: 2, latestRevision: 2 } },
  { lineId: '0190f0e2-3681-7000-8000-000000000102', seq: 20, profile: { id: '0190f0e2-3681-7000-8000-000000000202', riderName: 'Sara Prova', garmentType: 'JACKET', revision: 1, latestRevision: 3 } },
]
const check = (code: string, severity: 'BLOCKS' | 'WARNING', lineId: string | null): SendCheck['checks'][number] => ({ code, severity, path: lineId ? `lines/${lineId}` : 'lines', message: '', lineId, size: null })
const L1 = UNITS[0]!.lineId
const L2 = UNITS[1]!.lineId

function both(checks: SendCheck['checks'], options: { units?: readonly FixUnit[] | null; mayOpen?: boolean } = {}): DocumentSendPreviewModel {
  return Object.fromEntries(
    LOCALES.map((locale: Locale) => {
      const t = createTranslator(locale, CATALOGUE[locale].sales ?? {})
      const fixT = createTranslator(locale, CATALOGUE[locale][MTM_FIX_NAMESPACE] ?? {})
      const items = sendItems({ checks }, t, (tab) => `${PREFIX}/sales/quotes/${QUOTE}?tab=${tab}`, { units: options.units === undefined ? UNITS : options.units, t: fixT, prefix: PREFIX, mayOpen: options.mayOpen ?? true })
      return [locale, sendModel({ checks: { status: 'ready', items } }, locale, checks)]
    }),
  ) as DocumentSendPreviewModel
}

export const designScreen = defineDesignScreen<DocumentSendPreviewModel>({
  screen: 'SCR-037-fix-mtm',
  title: 'Send a document › the made-to-measure line checks (fix tab)',
  view: DocumentSendPreview,
  cases: [
    { id: 'outside-range', label: 'Held: a unit outside the certified range; another waits for the review', model: both([check('MTM_OUTSIDE_RANGE', 'BLOCKS', L1), check('MTM_NOT_CONFIRMED', 'WARNING', L1)]), note: 'Send is held with the first blocking check, in words of its unit; Open the rider profile goes to the profile.' },
    { id: 'not-started', label: 'Held: made-to-measure has not started for the template (the off state in words)', model: both([check('MTM_NOT_STARTED', 'BLOCKS', L1)]) },
    { id: 'older-revision', label: 'Warnings: made to an older revision; measures older than 12 months', model: both([check('MTM_NOT_LATEST', 'WARNING', L2), check('MTM_OLD_MEASURES', 'WARNING', L2)]) },
    { id: 'no-right', label: 'A person who may not see measurements: the words, no link', model: both([check('MTM_NOT_CONFIRMED', 'WARNING', L1)], { mayOpen: false }) },
    { id: 'units-unread', label: 'The units could not be read: the general words, no link', model: both([check('MTM_NOT_CONFIRMED', 'WARNING', L1)], { units: null }) },
  ],
})
