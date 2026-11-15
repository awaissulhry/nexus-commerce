import type { FastifyRequest } from 'fastify'
import { DomainError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { countryName } from '@nexus/factory-domain/documents/i18n'
import { fromLine, messageIdFor } from '@nexus/factory-domain/email/headers'
import { localeOf } from '@nexus/factory-domain/email/rules'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import {
  BROKER_PACK_LINK,
  BROKER_PACK_MAIL_TEMPLATE,
  BROKER_PACK_REFUSAL_WORDS,
  brokerPackMail,
  brokerPackRefusalPath,
  ORIGIN_FILES_MAX,
  PRICED_PARTS,
  type BrokerPackRefusal,
  type PackPart,
  type PackPartState,
} from '@nexus/factory-domain/shipping/broker-pack/rules'
import { SHIPPING_CUSTOMS_MANAGE } from '@nexus/factory-domain/shipping/customs/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { sendingIdentity, suppressedAmong } from '../../../platform/email-out/outbound'
import { processEmail } from '../../../platform/email-out/service'
import { storeCall, systemCallerOf } from '../../../platform/files/files'
import type { FilesRuntime } from '../../../platform/files/service'
import { deliverLinkMail } from '../../../platform/links/mail'
import { linkCommand } from '../../../platform/links/use'
import { readDocuments } from '../documents/read'
import { mergePdfs, PdfMergeError } from '../shipment-pack/pdf-merge'
import { packingListFingerprint } from '../shipments/packing-list'
import { readContents, type ShipmentHeader } from '../store'
import { changed, declarationOf } from '../customs/declarations'
import { countryOf } from '../customs/facts'
import { customsShipment, seesValuesOf } from '../customs/papers'

/**
 * The document pack for the broker, office side (B-W2b-409; LOG-097, LOG-088; factory-domain shipping/broker-pack). Office only:
 *
 *   GET  /shipping/shipments/:shipmentId/export/pack[?originFileIds]        shipping.view: the pack's parts as the papers
 *                                                                          stand (READY, MISSING with words, NONE), the files
 *                                                                          of the shipment that may go as papers of origin
 *   GET  /shipping/shipments/:shipmentId/export/pack/pdf[?originFileIds]    shipping.view + the price grain: the parts as ONE
 *                                                                          PDF (shipment-pack/pdf-merge.ts), the download the
 *                                                                          office hands to the broker or the carrier itself
 *   POST /shipping/shipments/:shipmentId/export/pack/link                  shipping.customs.manage + the price grain: the
 *                                                                          papers by a BROKER_PACK link of the declaration
 *                                                                          (while PACK_SENT, to its broker, only while the
 *                                                                          site's switch is ON: refused in words before the
 *                                                                          database refuses it), the files as LinkFile rows,
 *                                                                          mailed to the broker's contacts (FAKE locally) or
 *                                                                          passed on (its address in this answer once)
 *
 * The broker answers on its own page (link.ts): it downloads the papers and types the MRN back once.
 */

export function refused(code: BrokerPackRefusal, message: string = BROKER_PACK_REFUSAL_WORDS[code]): never {
  throw new DomainError('conflict', message, [{ path: brokerPackRefusalPath(code), message }])
}

const FILE = { id: true, companyId: true, originalName: true, contentType: true, sizeBytes: true, storeAccountId: true, storageKey: true, status: true } as const

type FileRow = { readonly id: string; readonly companyId: string | null; readonly originalName: string; readonly contentType: string; readonly sizeBytes: bigint | number; readonly storeAccountId: string; readonly storageKey: string; readonly status: string }

export interface PartRead {
  readonly part: PackPart
  readonly state: PackPartState
  readonly words: string | null
  readonly files: readonly FileRow[]
}

const pdfFile = async (db: CommandTx, id: string | null | undefined): Promise<FileRow | null> =>
  id ? db.storedFile.findFirst({ where: { id, status: 'AVAILABLE', contentType: 'application/pdf' }, select: FILE }) : null

/** The newest version of a kind of the shipment, its file when available. */
async function newestFile(db: CommandTx, shipmentId: string, kinds: readonly string[]): Promise<FileRow | null> {
  const row = await db.generatedDocument.findFirst({ where: { recordType: 'Shipment', recordId: shipmentId, kind: { in: [...kinds] as ('COMMERCIAL_INVOICE' | 'CN22' | 'CN23')[] } }, select: { fileId: true }, orderBy: [{ createdAt: 'desc' }, { version: 'desc' }] })
  return pdfFile(db, row?.fileId)
}

/** The files of the shipment the office may add as papers of origin (AVAILABLE PDFs of the shipment and its company). */
export async function originCandidatesOf(db: CommandTx, shipment: ShipmentHeader) {
  const generated = await db.generatedDocument.findMany({ where: { recordType: 'Shipment', recordId: shipment.id }, select: { fileId: true } })
  return db.storedFile.findMany({
    where: { recordType: 'Shipment', recordId: shipment.id, status: 'AVAILABLE', contentType: 'application/pdf', companyId: shipment.companyId, id: { notIn: generated.map((row) => row.fileId) } },
    select: { id: true, originalName: true, sizeBytes: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
  })
}

/** Every part of the pack as the papers stand; the origin files asked must be candidates (else ORIGIN_FILE). */
export async function readPack(db: CommandTx, shipment: ShipmentHeader, originFileIds: readonly string[]): Promise<PartRead[]> {
  const parts: PartRead[] = []
  const invoice = await newestFile(db, shipment.id, ['COMMERCIAL_INVOICE'])
  parts.push(invoice ? { part: 'COMMERCIAL_INVOICE', state: 'READY', words: null, files: [invoice] } : { part: 'COMMERCIAL_INVOICE', state: 'MISSING', words: BROKER_PACK_REFUSAL_WORDS.NO_COMMERCIAL_INVOICE, files: [] })

  const newestList = await db.generatedDocument.findFirst({ where: { recordType: 'Shipment', recordId: shipment.id, kind: 'PACKING_LIST' }, select: { fileId: true, fingerprint: true }, orderBy: { version: 'desc' } })
  const listFile = await pdfFile(db, newestList?.fileId)
  if (newestList && listFile && newestList.fingerprint === packingListFingerprint(await readContents(db, shipment.id))) parts.push({ part: 'PACKING_LIST', state: 'READY', words: null, files: [listFile] })
  else parts.push({ part: 'PACKING_LIST', state: 'MISSING', words: newestList ? 'The packing list no longer matches the parcels: print it again.' : 'Print the packing list first.', files: [] })

  const postal = await newestFile(db, shipment.id, ['CN22', 'CN23'])
  parts.push(postal ? { part: 'POSTAL_FORM', state: 'READY', words: null, files: [postal] } : { part: 'POSTAL_FORM', state: 'NONE', words: 'No CN 22 or CN 23: only a postal parcel needs one.', files: [] })

  // The declarations of conformity of the PPE styles on the shipment (the revision each work order froze).
  const { facts } = await readDocuments(db, shipment)
  const ppe = facts.styles.filter((style) => style.documentsRequired)
  const docs: FileRow[] = []
  const missing: string[] = []
  for (const style of ppe) {
    const onFile = style.onFile.DECLARATION_OF_CONFORMITY[0]
    const file = onFile ? await pdfFile(db, onFile.file.id) : null
    if (file) docs.push(file)
    else missing.push(style.code)
  }
  if (ppe.length === 0) parts.push({ part: 'CONFORMITY', state: 'NONE', words: 'No PPE on this shipment: no declaration of conformity goes.', files: [] })
  else if (missing.length > 0) parts.push({ part: 'CONFORMITY', state: 'MISSING', words: `No declaration of conformity on file for ${missing.join(', ')}.`, files: docs })
  else parts.push({ part: 'CONFORMITY', state: 'READY', words: null, files: docs })

  if (originFileIds.length > ORIGIN_FILES_MAX) throw new ValidationError(`At most ${ORIGIN_FILES_MAX} papers of origin go in one pack.`, [{ path: 'originFileIds', message: 'Too many.' }])
  const candidates = new Set((await originCandidatesOf(db, shipment)).map((row) => row.id))
  const origin: FileRow[] = []
  for (const id of [...new Set(originFileIds)]) {
    const file = candidates.has(id) ? await pdfFile(db, id) : null
    if (!file) refused('ORIGIN_FILE')
    origin.push(file!)
  }
  parts.push(origin.length > 0 ? { part: 'ORIGIN', state: 'READY', words: null, files: origin } : { part: 'ORIGIN', state: 'NONE', words: 'No paper of origin added: add the shipment\'s certificate of origin when the broker asks for one.', files: [] })
  return parts
}

const filesOf = (parts: readonly PartRead[]): FileRow[] => {
  const seen = new Set<string>()
  return parts.flatMap((part) => part.files).filter((file) => (seen.has(file.id) ? false : (seen.add(file.id), true)))
}

const pricedIn = (parts: readonly PartRead[]): boolean => parts.some((part) => PRICED_PARTS.includes(part.part) && part.files.length > 0)

const partView = (part: PartRead) => ({ part: part.part, state: part.state, words: part.words, files: part.files.map((file) => ({ fileId: file.id, name: file.originalName, sizeBytes: Number(file.sizeBytes) })) })

const idsOf = (value: string | readonly string[] | undefined): string[] => (value === undefined ? [] : (Array.isArray(value) ? value : String(value).split(',')).map((id) => id.trim()).filter((id) => id !== ''))

/** GET …/export/pack. */
export async function getPack(caller: CommandCaller, shipmentId: string, query: { readonly originFileIds?: string | undefined }) {
  const { context, shipment } = await customsShipment(caller, shipmentId)
  const asked = idsOf(query.originFileIds)
  if (asked.some((id) => !isUuid(id))) refused('ORIGIN_FILE')
  return caller.withClient(async (db) => {
    const parts = await readPack(db, shipment, asked)
    const declaration = await declarationOf(db, shipment.id)
    const settings = await db.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { brokerPackOn: true } })
    const linkHeld: BrokerPackRefusal | null = !declaration ? null : declaration.status !== 'PACK_SENT' ? 'NOT_WAITING' : declaration.brokerPartyId === null ? 'NO_BROKER' : !settings?.brokerPackOn ? 'SWITCH_OFF' : parts[0]!.state !== 'READY' ? 'NO_COMMERCIAL_INVOICE' : !seesValuesOf(context) ? 'PRICE_GRAIN' : null
    return {
      shipment: { id: shipment.id, number: shipment.number },
      parts: parts.map(partView),
      originCandidates: (await originCandidatesOf(db, shipment)).map((row) => ({ fileId: row.id, name: row.originalName, sizeBytes: Number(row.sizeBytes), createdAt: toUtcIso(row.createdAt) })),
      /** Downloading the pack needs the price grain when it carries values. */
      downloadHeld: pricedIn(parts) && !seesValuesOf(context) ? ('PRICE_GRAIN' as const) : filesOf(parts).length === 0 ? ('NO_COMMERCIAL_INVOICE' as const) : null,
      /** Why the pack cannot go by link now (null: it may; no declaration yet: open it first). */
      linkHeld,
      linkWords: linkHeld ? BROKER_PACK_REFUSAL_WORDS[linkHeld] : null,
      brokerPackOn: settings?.brokerPackOn ?? false,
    }
  })
}

const PACK_MAX_BYTES = 30 * 1024 * 1024

/** GET …/export/pack/pdf: the parts as one PDF. */
export async function packPdf(files: FilesRuntime, caller: CommandCaller, shipmentId: string, query: { readonly originFileIds?: string | undefined }): Promise<{ pdf: Buffer; fileName: string }> {
  const { context, shipment } = await customsShipment(caller, shipmentId)
  const asked = idsOf(query.originFileIds)
  if (asked.some((id) => !isUuid(id))) refused('ORIGIN_FILE')
  const parts = await caller.withClient((db) => readPack(db, shipment, asked))
  if (pricedIn(parts) && !seesValuesOf(context)) throw new ForbiddenError(BROKER_PACK_REFUSAL_WORDS.PRICE_GRAIN)
  const list = filesOf(parts)
  if (list.length === 0) refused('NO_COMMERCIAL_INVOICE')
  const bodies: Uint8Array[] = []
  let total = 0
  for (const file of list) {
    const body = await storeCall(() => files.storage.read(caller, file.storeAccountId, file.storageKey, PACK_MAX_BYTES))
    if (!body) refused('FILES_GONE')
    total += body!.byteLength
    if (total > PACK_MAX_BYTES) throw new DomainError('conflict', 'The papers are too large for one PDF: download them one by one.', [{ path: 'refusal/TOO_LARGE', message: 'Over 30 MB.' }])
    bodies.push(body!)
  }
  try {
    const merged = mergePdfs(bodies, { title: `${shipment.number} export papers` })
    return { pdf: merged.pdf, fileName: `${shipment.number.replace(/[\\/]/g, '-')} export papers.pdf` }
  } catch (error) {
    if (error instanceof PdfMergeError) throw new DomainError('conflict', `The papers could not be put in one PDF: ${error.message}`, [{ path: 'refusal/MERGE', message: error.message }])
    throw error
  }
}

/** The broker's contacts that may get the link (active, with an e-mail address), each address once. */
export async function brokerRecipientsOf(db: CommandTx, partyId: string) {
  const contacts = await db.partyContact.findMany({ where: { partyId, status: 'ACTIVE', email: { not: null } }, select: { id: true, name: true, email: true, language: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  const seen = new Set<string>()
  return contacts.flatMap((contact) => {
    const email = contact.email!.trim().toLowerCase()
    if (email === '' || seen.has(email)) return []
    seen.add(email)
    return [{ contactId: contact.id, name: contact.name, email, language: contact.language }]
  })
}

export interface LinkBody {
  readonly originFileIds?: readonly string[] | undefined
  /** Mail it to the broker's contacts (all, or those named); false: one link to pass on. */
  readonly send?: boolean | undefined
  readonly contactIds?: readonly string[] | undefined
}

/** POST …/export/pack/link: the link and its papers in ONE command, then each mail sent with the link in memory. */
export async function sendPackLink(request: FastifyRequest, shipmentId: string, body: LinkBody, idempotencyKey?: string) {
  const { context, shipment } = await customsShipment(request, shipmentId, SHIPPING_CUSTOMS_MANAGE)
  const asked = [...(body.originFileIds ?? [])]
  if (asked.some((id) => !isUuid(id))) refused('ORIGIN_FILE')
  const read = await request.withClient(async (db) => {
    const declaration = await declarationOf(db, shipment.id)
    const settings = await db.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { brokerPackOn: true } })
    const parts = await readPack(db, shipment, asked)
    return { declaration, settings, parts }
  })
  const { declaration, parts } = read
  if (!declaration) throw new NotFoundError('Open the export declaration first: the pack goes to its broker.')
  if (declaration.status !== 'PACK_SENT') refused('NOT_WAITING')
  if (declaration.brokerPartyId === null) refused('NO_BROKER')
  if (!read.settings?.brokerPackOn) refused('SWITCH_OFF')
  if (parts[0]!.state !== 'READY') refused('NO_COMMERCIAL_INVOICE')
  if (!seesValuesOf(context)) refused('PRICE_GRAIN')
  const brokerId = declaration.brokerPartyId!
  const send = body.send !== false
  const all = await request.withClient((db) => brokerRecipientsOf(db, brokerId))
  const unknown = (body.contactIds ?? []).filter((id) => !all.some((recipient) => recipient.contactId === id))
  if (unknown.length > 0) throw new ValidationError("Choose among the broker's contacts.", [{ path: 'body/contactIds', message: "One of these is not an active contact of the broker with an e-mail address." }])
  const to = send ? (body.contactIds && body.contactIds.length > 0 ? all.filter((recipient) => body.contactIds!.includes(recipient.contactId)) : all) : []
  if (send && to.length === 0) refused('NO_RECIPIENT')
  const files = filesOf(parts)
  const auth = officeAuthOf(request.server)
  const words = await request.withClient(async (db) => {
    const company = await db.company.findUnique({ where: { id: shipment.companyId }, select: { legalName: true, tradeName: true } })
    const broker = await db.party.findUnique({ where: { id: brokerId }, select: { language: true } })
    const user = await db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
    return { companyName: company?.tradeName ?? company?.legalName ?? '', brokerLanguage: broker?.language ?? null, user }
  })
  const country = countryOf(shipment.shipTo) ?? ''
  const linkId = newId()
  const token = mintLinkToken({ tenantId: context.tenantId, partyId: brokerId, linkId }).value
  const { result, replayed } = await linkCommand(request, { name: 'shipping.brokerPackLink', idempotencyKey, input: { shipmentId, originFileIds: asked, send, to: to.map((recipient) => recipient.email) } }, async (tools) => {
    const { tx, now } = tools
    const current = await declarationOf(tx, shipment.id)
    if (!current || current.id !== declaration.id) throw new NotFoundError('The export declaration is gone.')
    if (current.status !== 'PACK_SENT') refused('NOT_WAITING')
    const settings = await tx.shippingSettings.findUnique({ where: { id: shipment.siteId }, select: { brokerPackOn: true } })
    if (!settings?.brokerPackOn) refused('SWITCH_OFF')
    const expiresAt = new Date(now.getTime() + BROKER_PACK_LINK.expiryDays * 86_400_000)
    const suppressed = await suppressedAmong(tx, to.map((recipient) => recipient.email))
    const going = to.filter((recipient) => !suppressed.has(recipient.email))
    if (send && going.length === 0) refused('NO_RECIPIENT', "Every address of the broker's contacts bounced or complained (it is suppressed): correct it, or pass the link on.")
    await tx.oneOffLink.createMany({
      data: [
        {
          id: linkId,
          companyId: shipment.companyId,
          partyId: brokerId,
          purpose: 'BROKER_PACK',
          recordType: 'CustomsDeclaration',
          recordId: declaration.id,
          tokenHash: linkTokenHash(token),
          email: going[0]?.email ?? null,
          contactId: going[0]?.contactId ?? null,
          note: BROKER_PACK_LINK.note,
          expiresAt,
          maxUses: 1,
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
        },
      ],
    })
    await tx.linkFile.createMany({ data: files.map((file, index) => ({ id: newId(), partyId: brokerId, linkId, fileId: file.id, position: index + 1, createdAt: now })) })
    tools.audit({ action: 'links.create', recordType: 'OneOffLink', recordId: linkId, companyId: shipment.companyId, siteId: shipment.siteId, after: { purpose: 'BROKER_PACK', recordType: 'CustomsDeclaration', recordId: declaration.id, partyId: brokerId, email: going[0]?.email ?? null, expiresAt: toUtcIso(expiresAt), maxUses: 1, files: files.length } })
    tools.audit({ action: 'shipping.brokerPackLink', recordType: 'Shipment', recordId: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, after: { declarationId: declaration.id, linkId, files: files.map((file) => file.id), parts: parts.filter((part) => part.files.length > 0).map((part) => part.part), mailed: going.length } })
    changed(tools, shipment, declaration.id, 'PACK_LINKED', 'PACK_SENT', 'OFFICE')
    const mails: Array<{ outboundId: string; locale: 'it' | 'en' }> = []
    if (going.length > 0) {
      const identity = await sendingIdentity(tx, shipment.companyId, null, 'CONVERSATION')
      const from = fromLine(identity, words.user ? { name: words.user.displayName, email: words.user.email } : null)
      for (const recipient of going) {
        const locale = localeOf(recipient.language ?? words.brokerLanguage) === 'en' ? 'en' : 'it'
        const outboundId = newId()
        const mail = brokerPackMail({ locale, companyName: words.companyName, shipmentNumber: shipment.number, destination: countryName(country, locale), openUntil: businessDate(expiresAt) }, null)
        await tx.emailOutbound.create({
          data: { id: outboundId, companyId: identity.companyId, identityId: identity.id, recordType: 'OneOffLink', recordId: linkId, templateKey: BROKER_PACK_MAIL_TEMPLATE, locale, fromAddress: from.address, fromName: from.name, to: [recipient.email], subject: mail.subject, emailMessageId: messageIdFor(outboundId, identity.domain), status: 'QUEUED', queuedAt: now, createdAt: now, updatedAt: now, createdById: context.actorId },
          select: { id: true },
        })
        tools.audit({ recordType: 'EmailOutbound', recordId: outboundId, companyId: identity.companyId, after: { templateKey: BROKER_PACK_MAIL_TEMPLATE, linkId, identityId: identity.id, recipients: 1, status: 'QUEUED' } })
        mails.push({ outboundId, locale })
      }
    }
    return { linkId, mails, openUntil: businessDate(expiresAt) }
  })
  // A repeat: its mails went the first time; the token of that first answer is gone.
  if (replayed) return { url: null, linkId: result.linkId }
  const linkUrl = auth.link('/l', token)
  for (const mail of result.mails) {
    const text = brokerPackMail({ locale: mail.locale, companyName: words.companyName, shipmentNumber: shipment.number, destination: countryName(country, mail.locale), openUntil: result.openUntil }, linkUrl).body
    await deliverLinkMail(processEmail(), systemCallerOf(request)(context.tenantId), mail.outboundId, text, words.user?.displayName ?? null, auth.clock)
  }
  return { url: send ? null : linkUrl, linkId: result.linkId }
}
