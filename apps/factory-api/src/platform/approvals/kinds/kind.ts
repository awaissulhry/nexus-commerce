import type { FactoryClient } from '@nexus/factory-db'
import type { ApprovalField, ApprovalMeaning, ApprovalTaskKind, Facts, PreviewChange, Words } from '@nexus/factory-domain/approvals/rules'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { CommandTools, CommandTx } from '../../../core/command'

/**
 * An approval kind (B-W2b-282; plan "Approval kinds are files in platform/approvals/kinds, so a later step adds a kind without
 * touching the engine"): the port between the engine and the module that owns the subject. One file per kind, listed in
 * ./index.ts; the engine never reads a module's tables itself.
 *
 *   fields     the facts its rules may test (the RuleBuilder's fields): amount, margin, discount, quantity, supplier status …
 *              A money fact names its grain: its value, and a rule's threshold on it, only with the grain.
 *   read       the subject as it stands, in the given client's scope: its company and site, its label and summary (no
 *              money), the facts, the snapshot the fingerprint covers (the subject as it will be written), the change the
 *              request shows when the asker names none, and why it may not be asked now
 *   lock       in the ask's and the yes's command, before the read: holds the subject row, so it cannot change between the
 *              re-read and the commit (a module's own write then waits, and finds the request decided)
 *   recent     the kind's latest subjects, for a rule's test ("would have asked for 4 of the last 50")
 *   onApproved / onRejected / onWithdrawn / onStale
 *              in the decision's command: what the module does with it (B-W2b-305 sends a purchase order on its yes)
 */

export type Reader = FactoryClient | CommandTx

export interface ApprovalSubject {
  readonly companyId: string
  readonly siteId: string | null
  /** The record in words, no money: "SEED-PO-0002 · Conceria Seed". */
  readonly label: string
  /** The request in one line, no money (1 to 500 characters): "SEED-PO-0002 to Conceria Seed: 3 lines, to be sent". */
  readonly summary: string
  /** The values of the kind's fields (null: unknown, a rule on it does not hold). */
  readonly facts: Facts
  /** What the fingerprint covers: the subject as it will be written (plain JSON; dates and decimals become text). */
  readonly snapshot: unknown
  /** The change the request shows when the asker names none (a purchase order: status DRAFT → SENT). */
  readonly changes: readonly PreviewChange[]
  /** Why a yes may not be asked on it now, in words (null: it may). */
  readonly held: string | null
}

/** A request as a kind's hook sees it. */
export interface TaskRef {
  readonly id: string
  readonly kind: ApprovalTaskKind
  readonly recordType: string
  readonly recordId: string
  readonly companyId: string
  readonly siteId: string | null
  readonly requestedById: string | null
  readonly requestedByWorkerId: string | null
  readonly signatureMeaning: ApprovalMeaning | null
  readonly decidedById: string | null
}

export interface ApprovalKindDefinition {
  readonly kind: ApprovalTaskKind
  /** The subject's model name ("PurchaseOrder"). */
  readonly recordType: string
  /** The kind in words ("Purchase order" / "Ordine d'acquisto"). */
  readonly label: Words
  /** Seeing a subject of the kind and its requests (beyond approvals.view), over the subject's company and site. */
  readonly view: Permission
  /** Asking for a yes on it from the generic route and taking it back (beyond approvals.request); null: only its module asks. */
  readonly ask: Permission | null
  readonly fields: readonly ApprovalField[]
  read(client: Reader, recordId: string): Promise<ApprovalSubject | null>
  lock?(tx: CommandTx, recordId: string): Promise<void>
  recent(client: Reader, companyId: string | null, limit: number): Promise<string[]>
  onApproved?(tools: CommandTools, task: TaskRef): Promise<void>
  onRejected?(tools: CommandTools, task: TaskRef): Promise<void>
  onWithdrawn?(tools: CommandTools, task: TaskRef): Promise<void>
  onStale?(tools: CommandTools, task: TaskRef): Promise<void>
}
