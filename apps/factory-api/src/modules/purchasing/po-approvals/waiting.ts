import { z } from 'zod'
import { id, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * B-W2b-305 (SCM-078): the request a purchase order waits for, as the send answers it (202) and Send n lists it: its id
 * (Home › Approvals opens it), who it waits for (a role or a person, by name), and by when it is due (null: no time set).
 * Its own file: the purchasing contract and po-approvals/contract.ts both read it.
 */
export const waitingView = output({
  taskId: id(),
  approver: output({ kind: z.enum(['ROLE', 'PERSON']), id: id(), name: z.string() }).nullable(),
  dueAt: instant().nullable(),
})
