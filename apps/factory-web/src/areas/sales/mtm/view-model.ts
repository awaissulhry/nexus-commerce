import type { LiveState } from '../../quality/_shared/model'
import type { ContactOption, LinkAnswer, MtmCheck, PartyOption, Person, ProfileRow, StyleDetail, StyleOption, TemplateOption, Tiles } from './api'
import type { FormDraft, FormPoint, LinkDraft, ListAddress, MtmCan, Notice, Phrase, QuoteDraft, RowVerb } from './model'
import type { FormFlag } from './view/MeasurementForm'

/** A read in its three states: reading (items null, no problem), read, failed (a problem key). */
export interface Read<T> {
  readonly items: T | null
  readonly problem: string | null
}

/**
 * The measurement dialog (design pop:mtm.new "New measurements", and the record's New revision): who (customer and rider, new
 * only), the garment type (picks the template), the privacy notice given, who measured and where, the MeasurementForm, the base
 * size (typed; suggested from the measures against a style, PRD-202).
 */
export interface MeasurementsDialogModel {
  readonly mode: 'new' | 'revision'
  /** New: the customers found (parties.view), the search typed, the one picked, its contacts, the rider. */
  readonly customers?: Read<readonly PartyOption[]>
  readonly customerQ?: string
  readonly partyId?: string
  readonly contacts?: Read<readonly ContactOption[]>
  /** The rider: a contact of the customer (RIDER role first), or a name typed (contactId ''). */
  readonly contactId?: string
  readonly riderName?: string
  /** New: the garment types (measurement templates) and the one picked. */
  readonly templates?: Read<readonly TemplateOption[]>
  readonly garmentType?: string
  /** Revision: whose measures, fixed. */
  readonly fixed?: { readonly riderName: string; readonly customer: string; readonly garmentType: string; readonly revision: number }
  /** The template picked (its made-to-measure rules on or off, GATE-MTM). */
  readonly template: { readonly id: string; readonly code: string; readonly name: string; readonly rulesOn: boolean } | null
  /** Its points; null while read. */
  readonly points: readonly FormPoint[] | null
  readonly pointsProblem: string | null
  readonly draft: FormDraft
  /** Office people a measurer may be (null: only the person themself). */
  readonly people: readonly Person[] | null
  readonly me: Person
  /** What is wrong, per field, in words (the form's own checks and the API's refusal read in our words). */
  readonly problems: Readonly<Record<string, Phrase>>
  /** The rules broken while typing (only while the template's rules are on). */
  readonly flags: readonly FormFlag[]
  readonly checking: boolean
  /** The MTM styles for the base size suggestion, the one picked, and what the measures suggest against it. */
  readonly styles: readonly StyleOption[] | null
  readonly styleId: string
  readonly suggested: { readonly size: string | null; readonly how: 'INSIDE' | 'NEAREST' | null } | null
  readonly busy: boolean
  readonly offline: boolean
  readonly notice: Notice | null
  /** Esc with typed values asks to keep or discard them. */
  readonly leaving: boolean
}

export interface MeasurementsDialogActions {
  onCustomerQ?: (q: string) => void
  onCustomer?: (partyId: string) => void
  onRider?: (patch: { contactId?: string; riderName?: string }) => void
  onGarment?: (code: string) => void
  onDraft?: (patch: Partial<FormDraft>) => void
  onValue?: (code: string, value: string) => void
  onConfirm?: (code: string, checked: boolean) => void
  onStyle?: (styleId: string) => void
  onSave?: () => void
  /** Esc / Cancel: closes at once without typed values, else asks first. */
  onClose?: () => void
  onKeep?: () => void
  onDiscard?: () => void
}

/** Send a measurement link (design pop:mtm.link): the rider, the address, language, photos, expiry, what the rider will see. */
export interface LinkDialogModel {
  /** From the band: the riders to pick from (the list's rows); null when the record opened it (its rider is fixed). */
  readonly choices: readonly ProfileRow[] | null
  readonly profileId: string
  readonly riderName: string
  readonly garmentType: string
  /** The rider is a contact of the customer (the link goes to the contact's address when none is typed). */
  readonly hasContact: boolean
  /** The template's points (the preview counts them); null while unknown. */
  readonly pointCount: number | null
  readonly draft: LinkDraft
  readonly busy: boolean
  readonly offline: boolean
  readonly notice: Notice | null
  /** The answer: mailed, or the address shown ONCE to pass on. */
  readonly sent: LinkAnswer | null
  readonly copied: boolean
}

export interface LinkDialogActions {
  onPick?: (profileId: string) => void
  onDraft?: (patch: Partial<LinkDraft>) => void
  onSend?: () => void
  onCopy?: () => void
  onClose?: () => void
}

/** Use in a new quote: a unit of an MTM style on a new DRAFT quote of the rider's customer, on the newest revision. */
export interface QuoteDialogModel {
  readonly riderName: string
  readonly customer: string
  readonly revision: number
  readonly styles: Read<readonly StyleOption[]>
  readonly style: StyleDetail | null
  readonly draft: QuoteDraft
  /** The style's check against the newest revision (base size suggested, made-to-measure started). */
  readonly check: MtmCheck | null
  readonly checking: boolean
  readonly busy: boolean
  readonly offline: boolean
  readonly notice: Notice | null
}

export interface QuoteDialogActions {
  onDraft?: (patch: Partial<QuoteDraft>) => void
  onCreate?: () => void
  onClose?: () => void
}

/** SCR-036 — Sales › Made-to-measure: tiles, notices, the rider profiles, New measurements, Send a measurement link. */
export interface MtmListModel {
  readonly prefix: string
  readonly me: string
  readonly companyId: string | null
  readonly can: MtmCan
  readonly address: ListAddress
  readonly rows: { readonly items: readonly ProfileRow[] | null; readonly more: boolean; readonly problem: string | null; readonly matching: number | null }
  /** The tiles' counts; null while unknown (each tile says "—"); `tilesFailed`: the count failed. */
  readonly tiles: Tiles | null
  readonly tilesFailed: boolean
  /** The garment types (templates) for the filter and their made-to-measure state (GATE-MTM). */
  readonly templates: readonly TemplateOption[] | null
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly notice: Notice | null
  readonly measurements: MeasurementsDialogModel | null
  readonly link: LinkDialogModel | null
  readonly quote: QuoteDialogModel | null
  /** B-W2b-371 (XF2:03): the customers for the "By customer" filter (null: not read, or no right to read customers). */
  readonly customers?: readonly PartyOption[] | null
  /** Design only: the rows picked, the focused row, the keys panel open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface MtmListActions {
  onAddress?: (patch: Partial<ListAddress>) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onMore?: () => void
  onOpen?: (profileId: string) => void
  onRowVerb?: (row: ProfileRow, verb: RowVerb) => void
  onNew?: () => void
  onLink?: () => void
  measurements?: MeasurementsDialogActions
  link?: LinkDialogActions
  quote?: QuoteDialogActions
  /** Copy the selected riders (rider, customer, garment type, revision) as lines. */
  onCopy?: (lines: readonly string[]) => void
  onDismissNotice?: () => void
}
