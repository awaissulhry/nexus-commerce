import { RECALL_MANAGE, RECALL_SEND } from '@nexus/factory-domain/compliance/recall/permissions'
import { RECALL_LAW } from '@nexus/factory-domain/compliance/recall/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../../core/command'
import { entryScope, mayOn, officeOf, visibleEntry } from './common'
import { toldOfEntry } from './distributors'
import { noticesOfEntry } from './notices'
import { recallsOfEntry } from './recalls'
import { requestsOfEntry } from './requests'

/**
 * An entry's W2b parts in one read (B-W2b-260; design compliance.register › rec "Register entry": tab:authority "Notices and
 * requests", tab:actions "recall progress (W2b)" and the distributor information log's "3 of 5"): the notices to authorities,
 * the requests it answers, its recalls and withdrawals with their progress, how many recipients were told, the law per part
 * and what the caller may do. B-W2b-271 draws the tabs from it.
 */
export async function surveillanceOf(caller: CommandCaller, entryId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const entry = await visibleEntry(db, context, entryId)
    const scope = entryScope(entry)
    return {
      entry: {
        id: entry.id,
        reference: entry.reference,
        kind: entry.kind,
        risk: entry.risk,
        status: entry.status,
        authorityNotifiedAt: entry.authorityNotifiedAt ? toUtcIso(entry.authorityNotifiedAt) : null,
        authorityReference: entry.authorityReference,
        distributorsInformedAt: entry.distributorsInformedAt ? toUtcIso(entry.distributorsInformedAt) : null,
      },
      notices: await noticesOfEntry(db, context, entry.id),
      requests: await requestsOfEntry(db, context, entry.id),
      recalls: await recallsOfEntry(db, entry.id),
      distributors: await toldOfEntry(db, entry),
      law: { ...RECALL_LAW },
      may: { manage: mayOn(context, RECALL_MANAGE, scope) && entry.status === 'OPEN', send: mayOn(context, RECALL_SEND, scope) && entry.status === 'OPEN' },
    }
  })
}
