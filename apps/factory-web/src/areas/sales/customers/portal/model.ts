import type { LiveState } from '../../../../shell/live/use-live'
import type { StepUpModel } from '../../../admin/shared/model'
import type { Askable, PartnerPerson, PartnerRequest, PortalAccess } from '../../../admin/users/partners/api'
import type { PartnerCan, PartnerInviteDraft, PersonDraft, RowAction, SettingsDraft } from '../../../admin/users/partners/model'

/**
 * Customer › Portal access and Supplier › Portal access (B-W2b-180; design sales.customers rec:Customer/customer.portal,
 * purchasing.suppliers rec:Supplier/portal, the new tab customers.portalPreview, the live line "portal user signed in"):
 * the ONE tab both sides of the party record draw (areas/parties/_shared's `portal` slot). Its view model and dialogs; the
 * rules are the partners' (areas/admin/users/partners/model.ts). Words: catalogue `portal-access`.
 */

export type PortalSide = 'customers' | 'suppliers'

export type PortalDialog =
  | { kind: 'invite' }
  | { kind: 'person'; userId: string }
  | { kind: 'confirm'; action: RowAction; userIds: readonly string[] }
  | { kind: 'ask' }
  | { kind: 'cancelRequest'; requestIds: readonly string[] }

export interface PortalNotice {
  key: string
  tone: 'success' | 'warning' | 'danger' | 'info'
  params?: Record<string, string | number>
  /** A run over many people: who was refused, with the problem (a key). */
  refused?: ReadonlyArray<{ name: string; problem: string }>
}

/** A request with where its record opens in the office (the container's: record-links). */
export type RequestRow = PartnerRequest & { href: string }

export interface RequestsModel {
  items: readonly RequestRow[] | null
  problem: string | null
  selected: readonly string[]
}

export interface PortalAccessModel {
  side: PortalSide
  /** `/w/<company>` */
  prefix: string
  /** The party's name from its record (the tab's words before its own read). */
  partyName: string
  access: PortalAccess | null
  /** The read failed (a key); the rest of the record stays usable. */
  problem: string | null
  can: PartnerCan
  /** Today in the site's zone (YYYY-MM-DD) and now (ISO): the end of access, "ends soon". */
  today: string
  now: string
  asOf: string | null
  live: LiveState
  /** The live line: the last portal person who signed in while the tab was open. */
  signedIn: { name: string; at: string; first: boolean } | null
  /** Show the people who left (deactivated). */
  showLeft: boolean
  selected: readonly string[]
  dialog: PortalDialog | null
  busy: boolean
  dialogProblem: string | null
  notice: PortalNotice | null
  stepUp: StepUpModel
  requests: RequestsModel
  /** A preview is being opened (the new tab waits for the portal's cookie). */
  previewing: boolean
  /** Design cases: the drafts a dialog or the settings card starts with. */
  inviteDraft?: PartnerInviteDraft
  personDraft?: PersonDraft
  settingsDraft?: SettingsDraft
}

export interface PortalAccessActions {
  onRetry?: () => void
  onDialog?: (dialog: PortalDialog | null) => void
  onSelected?: (ids: string[]) => void
  onShowLeft?: (show: boolean) => void
  /** Each write resolves true when done (its dialog then closes). */
  onSaveSettings?: (draft: SettingsDraft) => Promise<boolean>
  onInvite?: (draft: PartnerInviteDraft) => Promise<boolean>
  onChangePerson?: (person: PartnerPerson, draft: PersonDraft) => Promise<boolean>
  onRows?: (action: RowAction, people: readonly PartnerPerson[], reason: string) => Promise<boolean>
  onPreview?: () => void
  onAsk?: (kind: Askable, due: string) => Promise<boolean>
  onCancelRequests?: (requests: readonly PartnerRequest[]) => Promise<boolean>
  onSelectedRequests?: (ids: string[]) => void
  onRetryRequests?: () => void
  onStepUp?: (code: string) => void
  onStepUpClose?: () => void
  onDismissNotice?: () => void
  onHelp?: () => void
}

/** The person a dialog is about. */
export const personOf = (model: Pick<PortalAccessModel, 'access'>, userId: string): PartnerPerson | null => model.access?.people.find((person) => person.id === userId) ?? null

/** Suppliers and workshops never see a price (Owner answer C2): their tab has no prices column, one line says so. */
export const showsPrices = (access: Pick<PortalAccess, 'kinds'>) => access.kinds.includes('CUSTOMER') || access.kinds.includes('GUEST')
