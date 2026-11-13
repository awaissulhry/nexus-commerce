import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { designScreen as register } from '../../fixtures'
import type { RegisterListModel } from '../../model'
import { RegisterListView } from '../../view/RegisterListView'

/**
 * SCR-113-accident-log (B-W2b-357; design compliance.register page.h "Accident log (W2b)", SAL-423) — the PPE register's ⋯
 * with the item to the accident log: open for quality, held with why for a role without product-safety reports. Made-up
 * data only: SCR-113's own register.
 */

const list = (id: string): RegisterListModel => (register.cases.find((entry) => entry.id === id)!.model as { list: RegisterListModel }).list
const PREFIX = '/w/DEMO'

export const designScreen = defineDesignScreen<RegisterListModel>({
  screen: 'SCR-113-accident-log',
  title: 'PPE register & recalls › ⋯ Accident log',
  view: RegisterListView,
  cases: [
    { id: 'menu', label: 'The register’s ⋯ holds Accident log (quality)', model: { ...list('inspector'), accidentLog: { href: `${PREFIX}/compliance/register/accidents`, held: false } }, note: 'Open ⋯ at the right of the list’s toolbar: Accident log opens the log.' },
    { id: 'menu-held', label: 'Without product-safety reports: the item held with why', model: { ...list('read-only'), accidentLog: { href: `${PREFIX}/compliance/register/accidents`, held: true } } },
  ],
})
