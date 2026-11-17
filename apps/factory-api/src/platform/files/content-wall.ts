import type { FactoryClient } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { CommandCaller, CommandTx } from '../../core/command'
import type { RequestContext } from '../../core/context'
import { systemContext } from '../outbox/system'
import { wallPartyOf } from '../threads/records'
import { fileRecordScope, type FileRecordScope } from './record-scope'

/**
 * fix-wall-1 (the brand wall, ABSOLUTE — Owner rule 2026-11-16: "One brand must not be able to see anything related to any other
 * brand. But we, as the production unit, should be able to see it all. And manage it all as well."; walls W25 / T25, B-TH-024,
 * B-PR-19): WHOSE A FILE'S CONTENT IS, for every portal and link read of files — the one rule, at the source.
 *
 * A file shared with a customer sits on that customer's own record (row-level security and B-TH-003), but its CONTENT may be
 * another record's: a copy (Use on, B-TH-024, and every module's prepareFileCopy) names its source, and before B-TH-024's wall a
 * mixed lot's photo (a work order of several customers) could be copied onto one customer's order and shared with it. That old
 * copy showed the goods of the other customers on the portal's generic file list, its download and preview, and the record
 * thread's files. So a portal or link reader of customer P is shown a file only when EVERY record of its content names P or no
 * customer:
 *
 *   the file's own record, then its source's record, its source's source's … (a copy of a copy), up to MAX_COPY_HOPS
 *   each record named as the office's file reads name it (./record-scope.ts fileRecordScope, B-PR-44): a record's thread resolver
 *   and its wall party (a work order's customer; the every-party marker for a work order of several customers or of none), a
 *   child record through its parent, a work order's record through its work order's customer, any other table naming its party
 *   a record whose customer cannot be read (gone), a source row that cannot be read, a chain longer than MAX_COPY_HOPS: hidden
 *   (fail closed)
 *
 * This is B-TH-024's write rule (a file of one customer's record goes only to a record of the same customer or of none) read
 * back on every old copy, and the production lane's quality read (B-PR-19 photoShown) for every file and every hop.
 * The refusal toward the customer is neutral: a walled file is left out of a list, uncounted, and by id it is "File not found."
 * (404) as a wrong id — never a word that another customer exists. The office, the floor and the system read as before: the
 * production unit sees it all, and the office's file list still shows where each copy came from (files.ts withOrigins).
 *
 * The chain is read as the tenant's system (row-level security forced to the tenant): a portal or link session cannot read the
 * other customer's source row, nor the `sourceFileId` column (the partner role has no grant on it).
 */

type Reader = FactoryClient | CommandTx

/** Whose a record of the content is: one customer or supplier, none (`partyId` null), or it cannot be read. */
export type ContentOwner = { readonly kind: 'party'; readonly partyId: string | null } | { readonly kind: 'unknown' }

const UNKNOWN: ContentOwner = Object.freeze({ kind: 'unknown' })

/** A copy of a copy of … is followed this far; a longer chain is not shown outside the office. */
export const MAX_COPY_HOPS = 8

/** A record as the office's file reads name it → its owner for the wall (several customers: the every-party marker). */
export function contentOwnerOf(found: FileRecordScope): ContentOwner {
  switch (found.kind) {
    case 'record':
      return { kind: 'party', partyId: wallPartyOf(found.scope) }
    case 'customer':
      return { kind: 'party', partyId: found.partyId }
    case 'unknown':
      return UNKNOWN
    default:
      return { kind: 'party', partyId: null }
  }
}

/** Pure: a reader of `partyId` is shown the file only when every record of its content is its own or of no customer. */
export function contentShownTo(owners: readonly ContentOwner[], partyId: string): boolean {
  return owners.length > 0 && owners.every((owner) => owner.kind === 'party' && (owner.partyId === null || owner.partyId === partyId))
}

const NODE = { id: true, tenantId: true, recordType: true, recordId: true, sourceFileId: true } as const
type Node = { readonly id: string; readonly tenantId: string; readonly recordType: string; readonly recordId: string; readonly sourceFileId: string | null }

/**
 * The owners of each file's content, by file id: its own record first, then each source's. `client` reads every file of the
 * tenant (the office's, the system's, a module's tenant scope). An id not found is one UNKNOWN owner.
 */
export async function contentOwnersOf(client: Reader, fileIds: Iterable<string>): Promise<Map<string, ContentOwner[]>> {
  const wanted = [...new Set([...fileIds].filter((id) => isUuid(id)))]
  const nodes = new Map<string, Node>()
  let frontier = wanted
  for (let hop = 0; hop <= MAX_COPY_HOPS && frontier.length > 0; hop++) {
    const rows = (await client.storedFile.findMany({ where: { id: { in: frontier } }, select: NODE })) as Node[]
    for (const row of rows) nodes.set(row.id, row)
    frontier = [...new Set(rows.flatMap((row) => (row.sourceFileId && !nodes.has(row.sourceFileId) ? [row.sourceFileId] : [])))]
  }
  const byRecord = new Map<string, ContentOwner>()
  for (const node of nodes.values()) {
    const key = `${node.recordType}:${node.recordId}`
    if (!byRecord.has(key)) byRecord.set(key, contentOwnerOf(await fileRecordScope(client, node.tenantId, node)))
  }
  const out = new Map<string, ContentOwner[]>()
  for (const id of wanted) {
    const owners: ContentOwner[] = []
    const seen = new Set<string>()
    let at: string | null = id
    while (at !== null) {
      const node = nodes.get(at)
      if (!node || seen.has(at) || seen.size > MAX_COPY_HOPS) {
        owners.push(UNKNOWN)
        break
      }
      seen.add(at)
      owners.push(byRecord.get(`${node.recordType}:${node.recordId}`) ?? UNKNOWN)
      at = node.sourceFileId
    }
    out.set(id, owners)
  }
  return out
}

/** The ids among `fileIds` a reader of `partyId` must not be shown (read with a client that reads every file of the tenant). */
export async function contentWalledFor(client: Reader, partyId: string, fileIds: Iterable<string>): Promise<Set<string>> {
  const ids = [...new Set(fileIds)]
  if (ids.length === 0) return new Set()
  const owners = await contentOwnersOf(client, ids)
  return new Set(ids.filter((id) => !contentShownTo(owners.get(id) ?? [UNKNOWN], partyId)))
}

/** The reader's customer when it reads files from outside the office (a portal or a link), else null (the office sees it all). */
export function outsidePartyOf(context: RequestContext | null): string | null {
  return context && (context.audience === 'partner' || context.audience === 'link') ? context.partyId : null
}

/** The request as its tenant's system context (as files.ts systemCallerOf), or null for a caller that is no request. */
function tenantSystemOf(caller: CommandCaller, tenantId: string): CommandCaller | null {
  if (!('server' in (caller as object))) return null
  const view = Object.create(caller) as CommandCaller & { factoryContext: RequestContext | null }
  view.factoryContext = systemContext(tenantId, String((caller as { id?: unknown }).id ?? 'content-wall'))
  return view
}

/**
 * The ids among `fileIds` the caller must not be shown: for a portal or a link reader, every file whose content is not its own
 * customer's or of none (read as the tenant's system, outside the caller's own transaction); for the office, the floor and the
 * system, none. A caller that cannot be read as its tenant's system (no request) is shown none of them (fail closed).
 */
export async function walledForOutside(caller: CommandCaller, fileIds: Iterable<string>): Promise<Set<string>> {
  const context = caller.factoryContext
  const partyId = outsidePartyOf(context)
  const ids = [...new Set(fileIds)]
  if (partyId === null || ids.length === 0 || !context || context.audience === 'platform') return new Set()
  const system = tenantSystemOf(caller, context.tenantId)
  if (!system) return new Set(ids)
  return system.withClient((client) => contentWalledFor(client, partyId, ids))
}
