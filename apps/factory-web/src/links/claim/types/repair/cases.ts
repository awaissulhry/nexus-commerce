import type { DesignCase } from '../../../../lib/design/design-screen'
import type { ClaimItem, ClaimPage } from '../../api'
import { EMPTY_FORM, type ClaimForm, type ClaimViewModel, type PhotoShot } from '../../model'
import type { RepairOffer } from './api'
import { EMPTY_REPAIR, OTHER_GARMENT, type RepairForm } from './model'

/**
 * SCR-197's cases of B-W2b-342 (follow-up RR1:01; made-up data only): the claim link offering Repair or alteration, its
 * item step (an item of the delivery, or another garment by its serial), its details (a repair's words and work, an
 * alteration's work), the page's own checks, the two damage photos, check and send, a refusal (the garment is with us
 * already), the end, and this link's earlier repair requests. B-W2b-198's fixtures spread them in.
 */

export interface ClaimCaseMakers {
  model: (overrides?: Partial<ClaimViewModel>) => ClaimViewModel
  page: (overrides?: Partial<ClaimPage>) => ClaimPage
  item: ClaimItem
  photos: { seam: string; sleeve: string }
}

const id = (n: number) => `0190f0e2-1970-7000-8000-${String(n).padStart(12, '0')}`

const OFFER: RepairOffer = { offered: true, kinds: ['REPAIR', 'ALTERATION'], repairs: [], photos: { max: 10, damage: 2 } }
const EARLIER: RepairOffer = {
  ...OFFER,
  repairs: [
    { id: id(3420), number: 'REP-2026-0031', kind: 'REPAIR', stage: 'ESTIMATED', channel: 'LINK', opened: '2026-11-06T09:00:00.000Z', open: true, next: { code: 'ANSWER_ESTIMATE', forYou: true }, garment: { style: { code: 'DEMO-JKT-01', name: 'Giacca in pelle demo' }, colourway: null, size: 'M', serial: '0000-DEMO-48' }, estimate: { revision: 1, status: 'SENT' } },
    { id: id(3421), number: 'REP-2026-0029', kind: 'ALTERATION', stage: 'SHIPPED', channel: 'LINK', opened: '2026-10-20T09:00:00.000Z', open: false, next: { code: 'DONE', forYou: false }, garment: { style: null, colourway: null, size: null, serial: '0000-DEMO-12' }, estimate: null },
  ],
}

export function repairClaimCases(make: ClaimCaseMakers): DesignCase<ClaimViewModel>[] {
  const types: ClaimPage['types'] = ['RETURN', 'COMPLAINT', 'REPAIR']
  const page = make.page({ types })
  const repair = (over: Partial<RepairForm>): ClaimForm => ({ ...EMPTY_FORM, type: 'REPAIR', repair: { ...EMPTY_REPAIR, ...over } })
  const filled = repair({ kind: 'REPAIR', itemKey: make.item.key, serial: '0000-DEMO-48', problem: 'Dopo una scivolata la cucitura della spalla sinistra si è aperta.', workWanted: 'Ricucire la spalla e controllare la protezione.' })
  const alteration = repair({ kind: 'ALTERATION', itemKey: OTHER_GARMENT, serial: '0000-DEMO-77', problem: '', workWanted: 'Allungare le maniche di 2 cm.' })
  const shots: PhotoShot[] = [
    { id: id(3430), group: 'case', src: make.photos.seam, marks: 1 },
    { id: id(3431), group: 'case', src: make.photos.sleeve, marks: 0 },
  ]
  const at = (overrides: Partial<ClaimViewModel>) => make.model({ page, repairOffer: OFFER, ...overrides })
  return [
    { id: 'w2b-342-type', label: 'B-W2b-342 · What do you need? · Repair or alteration offered', model: at({ form: repair({}) }), note: 'Return · Report a quality problem · Repair or alteration (RR1:01); remake and safety still go to the sender.' },
    { id: 'w2b-342-item', label: 'B-W2b-342 · Which item · a repair', model: at({ form: filled, step: 'item' }), note: 'One garment of the delivery, or Another garment; the serial scanned from the label or typed.' },
    { id: 'w2b-342-item-other', label: 'B-W2b-342 · Which item · another garment without its serial', model: at({ form: repair({ itemKey: OTHER_GARMENT }), step: 'item', checked: ['item'] }), note: 'Another garment needs the serial on its label: said at the field.' },
    { id: 'w2b-342-details', label: 'B-W2b-342 · Tell us more · a repair', model: at({ form: filled, step: 'details' }), note: 'A repair or an alteration; what is wrong (needed for a repair); the work wanted; no payment data here.' },
    { id: 'w2b-342-details-alteration', label: 'B-W2b-342 · Tell us more · an alteration', model: at({ form: alteration, step: 'details' }) },
    { id: 'w2b-342-details-check', label: 'B-W2b-342 · Tell us more · Continue with nothing written', model: at({ form: repair({ itemKey: make.item.key }), step: 'details', checked: ['item', 'details'] }) },
    { id: 'w2b-342-photos', label: 'B-W2b-342 · Photos · two needed for a damage', model: at({ form: filled, step: 'photos', checked: ['photos'] }), note: 'At least two photos of the damage, marked to circle the problem; an alteration’s fit photos are optional.' },
    { id: 'w2b-342-photos-added', label: 'B-W2b-342 · Photos · two added', model: at({ form: filled, step: 'photos', photos: shots }) },
    { id: 'w2b-342-review', label: 'B-W2b-342 · Check and send · a repair', model: at({ form: { ...filled, typedName: 'Anna Esempio' }, step: 'review', photos: shots }) },
    { id: 'w2b-342-refused', label: 'B-W2b-342 · Refused · the garment is with us already', model: at({ form: filled, step: 'item', photos: shots, problem: 'returns-repair:refusal.open', issues: [{ step: 'item', field: 'repair.serial', key: 'returns-repair:refusal.serial' }] }) },
    {
      id: 'w2b-342-done',
      label: 'B-W2b-342 · Sent · a repair request, its photos with it',
      model: make.model({
        page: make.page({ types, link: { expiresAt: '2026-12-05T23:00:00.000Z', usesLeft: 4, live: true } }),
        repairOffer: { ...OFFER, repairs: [{ ...EARLIER.repairs[0]!, id: id(3440), number: 'REP-2026-0044', stage: 'AWAITING_GOODS', next: { code: 'SEND_GARMENT', forYou: true }, estimate: null }] },
        form: filled,
        photos: shots,
        done: { sent: { type: 'REPAIR', id: id(3440), number: 'REP-2026-0044', answerBy: '2026-11-14' }, form: { ...filled, typedName: 'Anna Esempio' }, uploads: { [id(3430)]: 'sent', [id(3431)]: 'sent' } },
      }),
      note: 'EndState: the request number, when we answer, send the garment with a DDT, an estimate before any work; this link’s repair requests under it.',
    },
    { id: 'w2b-342-earlier', label: 'B-W2b-342 · This link’s earlier repair requests', model: at({ repairOffer: EARLIER, form: repair({}) }), note: 'Where each stands and the next step (“Your move:” when it is theirs); the estimate is answered in the portal or by phone or mail (the link holds no price).' },
  ]
}
