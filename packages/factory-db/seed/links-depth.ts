import { createHash } from 'node:crypto'
import type { Prisma } from '../src/generated/prisma/client'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedCapa } from './capa'
import { seed as seedFiles } from './files'
import { seed as seedLinks } from './links'
import { seed as seedParties } from './parties'

/**
 * The links-in-depth seed (W2b schema wave 19/22, B-W2b-154), per tenant of seed/_core.ts. The office's rows are written in
 * the tenant's office scope, the party's own acts (a draft saved, a download, the receipt, an approval answered) in the
 * partner scope of party P1, through its link, as the app does. The CLI runs the seed files in name order and this one
 * sorts before links.ts and parties.ts, so it runs the links, files, parties and CAPA seeds first (each idempotent).
 * Every name is made up; files are rows only (no object in any store).
 *
 *   file set     a DOCUMENT_VIEW link for P1 sharing two documents of company A (a DoC and a care leaflet), not opened
 *                yet.
 *   secure file  a SECURE_FILE link for P1 with two office-only files (a tech pack, a size chart) and a password (a
 *                made-up scrypt hash: no password opens it): one wrong password, one download (a counted use, evidence
 *                DOWNLOADED), and the receipt "I received these files" (evidence RECEIVED).
 *   draft        a MEASUREMENTS link for P1's rider profile, live for 21 days from the day it runs, with the rider's
 *                draft (made-up sealed text, not decryptable), purged 7 days after the link expires.
 *   shares       company A's purchase order shared with supplier P2 (view only, no link yet) and a sample style shared
 *                with P1 through its RECORD_INVITE link (view and comment).
 *   approvals    a sample of the style asked of P1 (OPEN); a design proof withdrawn by the office; and a second concession
 *                on the CAPA seed's open NCR (SEED-NCR-0001: the API tests count SEED-NCR-0002's concessions), asked by an
 *                approval request and answered by P1 through its APPROVAL link
 *                (approved with changes, typed name, the marked-up photo), the concession then ACCEPTED by P1 itself
 *                (recordedById null).
 *   renewal      a new PO_CONFIRM link for P2 renewing the links seed's one, sent to P2's order desk.
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id and insert the
 * copy: so the first link file is on the unopened DOCUMENT_VIEW link, the first draft is P1's live one, the first share has
 * no link (one share per link) and the first approval request is the OPEN sample. Every other row of this seed in a table
 * other seeds also fill (links, files, evidence, the concession) has an id from `lateId`, so the copies stay the other
 * seeds' rows.
 */

/** Fixed instants, so the rows never depend on the clock (the live link of the draft aside). */
const AT = new Date('2026-10-28T08:00:00.000Z')
const OPENED_AT = new Date('2026-10-28T09:15:00.000Z')
const ANSWERED_AT = new Date('2026-10-29T10:42:00.000Z')
const DUE_AT = new Date('2026-11-07T17:00:00.000Z')
const EXPIRES_AT = new Date('2026-11-11T08:00:00.000Z')
const SHARE_ENDS_AT = new Date('2026-11-30T17:00:00.000Z')
const DAY_MS = 86_400_000

/** Today in Europe/Rome as a UTC midnight. */
function romeToday(): Date {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(`${iso}T00:00:00.000Z`)
}

export interface LinksDepthSeed {
  readonly links: { readonly fileSet: string; readonly secureFile: string; readonly measurements: string; readonly invite: string; readonly approval: string; readonly renewal: string }
  readonly files: { readonly doc: string; readonly leaflet: string; readonly techPack: string; readonly sizeChart: string; readonly photo: string; readonly markup: string }
  readonly linkFiles: readonly string[]
  readonly draft: string
  readonly shares: { readonly supplier: string; readonly invite: string }
  readonly approvals: { readonly sample: string; readonly proof: string; readonly concession: string }
  readonly concessionId: string
  readonly partyId: string
  readonly supplierId: string
  readonly companyId: string
  readonly tenantId: string
}

export async function seed(context: SeedContext): Promise<LinksDepthSeed> {
  const { db, namespace } = context
  await seedLinks(context)
  await seedFiles(context)
  await seedParties(context)
  const capa = await seedCapa(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const hex = (text: string): string => createHash('sha256').update(`seed links-depth ${namespace} ${text}`).digest('hex')
  const b64 = (text: string, length: number): string => createHash('sha256').update(`seed links-depth ${namespace} ${text}`).digest('base64url').slice(0, length)
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const partyP1 = id('party:P1')
  const partyP2 = id('party:P2')
  const buyer = id('party-contact:P1:buyer')
  const orderDesk = id('party-contact:P2:orders')
  const store = id('files:account:r2')
  const today = romeToday()

  const links = {
    fileSet: lateId('links-depth:link:file-set'),
    secureFile: lateId('links-depth:link:secure-file'),
    measurements: lateId('links-depth:link:measurements'),
    invite: lateId('links-depth:link:invite'),
    approval: lateId('links-depth:link:approval'),
    renewal: lateId('links-depth:link:renewal'),
  }
  const files = {
    doc: lateId('links-depth:file:doc'),
    leaflet: lateId('links-depth:file:leaflet'),
    techPack: lateId('links-depth:file:tech-pack'),
    sizeChart: lateId('links-depth:file:size-chart'),
    photo: lateId('links-depth:file:photo'),
    markup: lateId('links-depth:file:markup'),
  }
  const approvals = {
    sample: firstId('links-depth:approval:sample'),
    proof: id('links-depth:approval:proof'),
    concession: id('links-depth:approval:concession'),
  }
  const concessionId = lateId('links-depth:concession')
  const shares = { supplier: firstId('links-depth:share:supplier'), invite: id('links-depth:share:invite') }
  const linkFiles = [firstId('links-depth:link-file:doc'), id('links-depth:link-file:leaflet'), id('links-depth:link-file:tech-pack'), id('links-depth:link-file:size-chart')]
  const draft = firstId('links-depth:draft')
  const styleId = id('product:style:JKT-01')
  const profileId = id('measurement:P1:rider:JACKET:1')
  const office = { audience: 'office', tenantId, actorId } as const
  // A link session runs in its party's scope; its actor is the link (platform/links).
  const asLink = (linkId: string) => ({ audience: 'partner', tenantId, actorId: linkId, partyId: partyP1 }) as const
  const notAToken = (linkId: string): string => createHash('sha256').update(`seed link ${linkId}: no token opens it`).digest('hex')
  // A PHC-format scrypt hash of nothing anyone can type: made-up salt and hash.
  const passwordHash = `$scrypt$ln=15,r=8,p=3$${b64('salt', 22)}$${b64('hash', 43)}`
  // Sealed-looking text (key, iv, ciphertext, tag), made up: it opens with no key.
  const sealedDraft = `l1.${b64('draft iv', 16)}.${b64('draft ciphertext 1', 43)}${b64('draft ciphertext 2', 43)}.${b64('draft tag', 22)}`

  // Files (company A; rows only).
  const available = { status: 'AVAILABLE', availableAt: AT, storeAccountId: store, createdAt: AT, updatedAt: AT, createdById: actorId } as const
  const file = (
    fileId: string,
    name: string,
    kind: 'DOCUMENT' | 'PHOTO',
    record: { type: string; id: string },
    visibility: ('OFFICE' | 'LINK')[],
  ): Prisma.StoredFileCreateManyInput => ({
    id: fileId,
    companyId: companyA,
    recordType: record.type,
    recordId: record.id,
    kind,
    originalName: name,
    contentType: kind === 'PHOTO' ? 'image/jpeg' : 'application/pdf',
    sizeBytes: 4096,
    sha256: hex(`file ${name}`),
    storageKey: `t/${tenantId}/c/${companyA}/2026/${id(`links-depth:key:${name}`)}`,
    visibility,
    partyId: visibility.includes('LINK') ? partyP1 : null,
    ...available,
  })
  const style = { type: 'Style', id: styleId }
  const request = { type: 'ApprovalRequest', id: approvals.concession }
  const fileRows = [
    file(files.doc, 'Seed declaration of conformity JKT-01 v3.pdf', 'DOCUMENT', style, ['OFFICE', 'LINK']),
    file(files.leaflet, 'Seed care leaflet JKT-01.pdf', 'DOCUMENT', style, ['OFFICE', 'LINK']),
    file(files.techPack, 'Seed tech pack JKT-01.pdf', 'DOCUMENT', style, ['OFFICE']),
    file(files.sizeChart, 'Seed size chart JKT-01.pdf', 'DOCUMENT', style, ['OFFICE']),
    file(files.photo, 'Seed shade photo, standard and actual.jpg', 'PHOTO', request, ['OFFICE', 'LINK']),
    file(files.markup, 'Seed shade photo, marked.jpg', 'PHOTO', request, ['OFFICE', 'LINK']),
  ]

  const link = (
    linkId: string,
    data: Pick<Prisma.OneOffLinkCreateManyInput, 'partyId' | 'purpose' | 'recordType' | 'recordId' | 'maxUses'> & Partial<Prisma.OneOffLinkCreateManyInput>,
  ): Prisma.OneOffLinkCreateManyInput => ({
    id: linkId,
    companyId: companyA,
    tokenHash: notAToken(linkId),
    email: data.partyId === partyP1 ? 'buyer.p1@example.com' : 'orders.p2@example.com',
    contactId: data.partyId === partyP1 ? buyer : orderDesk,
    expiresAt: EXPIRES_AT,
    createdAt: AT,
    updatedAt: AT,
    createdById: actorId,
    ...data,
  })
  const linkRows: Prisma.OneOffLinkCreateManyInput[] = [
    link(links.fileSet, { partyId: partyP1, purpose: 'DOCUMENT_VIEW', recordType: 'StoredFile', recordId: files.doc, maxUses: 20, note: 'Seed: the DoC and the care leaflet' }),
    link(links.secureFile, { partyId: partyP1, purpose: 'SECURE_FILE', recordType: 'StoredFile', recordId: files.techPack, maxUses: 5, passwordHash }),
    link(links.measurements, {
      partyId: partyP1,
      purpose: 'MEASUREMENTS',
      recordType: 'MeasurementProfile',
      recordId: profileId,
      maxUses: 1,
      contactId: id('party-contact:P1:rider'),
      email: null,
      createdAt: new Date(today.getTime() - 2 * DAY_MS),
      updatedAt: new Date(today.getTime() - 2 * DAY_MS),
      expiresAt: new Date(today.getTime() + 19 * DAY_MS),
    }),
    link(links.invite, { partyId: partyP1, purpose: 'RECORD_INVITE', recordType: 'Style', recordId: styleId, maxUses: 1000, expiresAt: SHARE_ENDS_AT }),
    link(links.approval, { partyId: partyP1, purpose: 'APPROVAL', recordType: 'ApprovalRequest', recordId: approvals.concession, maxUses: 1 }),
    link(links.renewal, { partyId: partyP2, purpose: 'PO_CONFIRM', recordType: 'PurchaseOrder', recordId: id('link:P2:record'), maxUses: 1, renewalOfId: id('link:P2') }),
  ]

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      await tx.storedFile.createMany({ data: fileRows, skipDuplicates: true })
      // The concession is asked first (ASKED), then its approval request names it, then it names the request.
      await tx.ncrConcession.createMany({
        data: [
          {
            id: concessionId,
            siteId: capa.siteId,
            ncrId: capa.openNcrId,
            seq: 2,
            partyId: partyP1,
            contactId: buyer,
            ask: 'Accept the jackets of lot 12 in a shade slightly darker than the standard (ΔE 1.8)',
            proposal: 'Ship them as they are, with a 3 % reduction on the lot',
            askedAt: AT,
            askedById: actorId,
            createdAt: AT,
            updatedAt: AT,
            createdById: actorId,
          },
        ],
        skipDuplicates: true,
      })
      const stamp = { companyId: companyA, partyId: partyP1, contactId: buyer, dueAt: DUE_AT, createdAt: AT, updatedAt: AT, createdById: actorId }
      await tx.approvalRequest.createMany({
        data: [
          { id: approvals.sample, ...stamp, recordType: 'Style', recordId: styleId, kind: 'SAMPLE', question: 'Approve the fit sample of JKT-01 in size 50 (photos front, side, back).' },
          { id: approvals.proof, ...stamp, recordType: 'Style', recordId: styleId, kind: 'PROOF', question: 'Approve the final print of the team logo on the back panel.' },
          { id: approvals.concession, ...stamp, recordType: 'NcrConcession', recordId: concessionId, kind: 'CONCESSION', question: 'Accept the shade of lot 12: slightly darker than the standard (ΔE 1.8).' },
        ],
        skipDuplicates: true,
      })
      const proof = await tx.approvalRequest.findUnique({ where: { id: approvals.proof }, select: { status: true } })
      if (proof?.status === 'OPEN') {
        await tx.approvalRequest.update({
          where: { id: approvals.proof },
          data: { status: 'WITHDRAWN', withdrawnAt: OPENED_AT, withdrawnById: actorId, withdrawReason: 'The logo artwork changes first.', version: 2, updatedAt: OPENED_AT },
          select: { id: true },
        })
      }
      await tx.ncrConcession.updateMany({ where: { id: concessionId, approvalRequestId: null }, data: { approvalRequestId: approvals.concession, version: { increment: 1 }, updatedAt: AT } })
      await tx.oneOffLink.createMany({ data: linkRows, skipDuplicates: true })
      await tx.linkFile.createMany({
        data: [
          { id: linkFiles[0]!, partyId: partyP1, linkId: links.fileSet, fileId: files.doc, position: 1, createdAt: AT },
          { id: linkFiles[1]!, partyId: partyP1, linkId: links.fileSet, fileId: files.leaflet, position: 2, createdAt: AT },
          { id: linkFiles[2]!, partyId: partyP1, linkId: links.secureFile, fileId: files.techPack, position: 1, createdAt: AT },
          { id: linkFiles[3]!, partyId: partyP1, linkId: links.secureFile, fileId: files.sizeChart, position: 2, createdAt: AT },
        ],
        skipDuplicates: true,
      })
      await tx.recordShare.createMany({
        data: [
          {
            id: shares.supplier,
            companyId: companyA,
            recordType: 'PurchaseOrder',
            recordId: id('link:P2:record'),
            partyId: partyP2,
            contactId: orderDesk,
            email: 'orders.p2@example.com',
            permissions: ['VIEW'],
            expiresAt: SHARE_ENDS_AT,
            createdAt: AT,
            updatedAt: AT,
            createdById: actorId,
          },
          {
            id: shares.invite,
            companyId: companyA,
            recordType: 'Style',
            recordId: styleId,
            partyId: partyP1,
            contactId: buyer,
            email: 'buyer.p1@example.com',
            permissions: ['VIEW', 'COMMENT'],
            expiresAt: SHARE_ENDS_AT,
            linkId: links.invite,
            createdAt: AT,
            updatedAt: AT,
            createdById: actorId,
          },
        ],
        skipDuplicates: true,
      })
    }),
  )

  // The party's own acts, through its links (once: each is skipped when its evidence row exists).
  const evidence = (key: string, linkId: string, action: Prisma.LinkEvidenceCreateManyInput['action'], at: Date, more: Partial<Prisma.LinkEvidenceCreateManyInput> = {}): Prisma.LinkEvidenceCreateManyInput => ({
    id: lateId(`links-depth:evidence:${key}`),
    partyId: partyP1,
    linkId,
    action,
    useNumber: null,
    typedName: null,
    emailCheck: 'NOT_ASKED',
    ipHash: hex('client address'),
    userAgent: 'Seed browser',
    at,
    requestId: `seed-links-depth-${key}`,
    ...more,
  })
  const done = (key: string) => db.withScope(office, (client) => client.linkEvidence.findUnique({ where: { id: lateId(`links-depth:evidence:${key}`) }, select: { id: true } }))

  // The rider saves a draft of the measurements (not a counted use).
  await db.withScope(asLink(links.measurements), (client) =>
    client.linkDraft.createMany({
      data: [{ id: draft, partyId: partyP1, linkId: links.measurements, dataEnc: sealedDraft, purgeAfter: new Date(today.getTime() + 26 * DAY_MS) }],
      skipDuplicates: true,
    }),
  )

  // The secure file: opened, one wrong password, one download, the receipt.
  if (!(await done('secure-file:received'))) {
    await db.withScope(asLink(links.secureFile), (client) =>
      client.$transaction(async (tx) => {
        await tx.linkEvidence.createMany({ data: [evidence('secure-file:opened', links.secureFile, 'OPENED', OPENED_AT)], skipDuplicates: true })
        await tx.oneOffLink.updateMany({ where: { id: links.secureFile, passwordTries: 0 }, data: { passwordTries: 1 } })
        await tx.oneOffLink.updateMany({ where: { id: links.secureFile }, data: { passwordTries: 0, uses: 1, lastUsedAt: OPENED_AT } })
        await tx.linkEvidence.createMany({ data: [evidence('secure-file:downloaded', links.secureFile, 'DOWNLOADED', OPENED_AT, { useNumber: 1 })], skipDuplicates: true })
        await tx.oneOffLink.updateMany({ where: { id: links.secureFile }, data: { receivedAt: ANSWERED_AT, receivedName: 'Seed Buyer One' } })
        await tx.linkEvidence.createMany({ data: [evidence('secure-file:received', links.secureFile, 'RECEIVED', ANSWERED_AT, { typedName: 'Seed Buyer One' })], skipDuplicates: true })
      }),
    )
  }

  // The concession: P1 opens its APPROVAL link and approves with changes, then the concession takes the same answer.
  if (!(await done('approval:approved'))) {
    await db.withScope(asLink(links.approval), (client) =>
      client.$transaction(async (tx) => {
        await tx.linkEvidence.createMany({ data: [evidence('approval:opened', links.approval, 'OPENED', OPENED_AT)], skipDuplicates: true })
        await tx.oneOffLink.updateMany({ where: { id: links.approval }, data: { uses: 1, lastUsedAt: ANSWERED_AT } })
        await tx.approvalRequest.updateMany({
          where: { id: approvals.concession, status: 'OPEN' },
          data: {
            status: 'APPROVED_WITH_CHANGES',
            answer: 'Accepted for lot 12 only; keep the darker jackets together in one carton.',
            typedName: 'Seed Buyer One',
            markupFileId: files.markup,
            answeredAt: ANSWERED_AT,
            answeredViaLinkId: links.approval,
            answerRequestId: 'seed-links-depth-approval:approved',
            answerIpHash: hex('client address'),
            answerUserAgent: 'Seed browser',
            version: 2,
            updatedAt: ANSWERED_AT,
          },
        })
        await tx.linkEvidence.createMany({
          data: [evidence('approval:approved', links.approval, 'APPROVED', ANSWERED_AT, { useNumber: 1, typedName: 'Seed Buyer One', emailCheck: 'MATCHED' })],
          skipDuplicates: true,
        })
        await tx.ncrConcession.updateMany({
          where: { id: concessionId, status: 'ASKED' },
          data: {
            status: 'ACCEPTED',
            answer: 'Accepted for lot 12 only; keep the darker jackets together in one carton.',
            answeredAt: ANSWERED_AT,
            answeredBy: 'Seed Buyer One',
            version: { increment: 1 },
            updatedAt: ANSWERED_AT,
          },
        })
      }),
    )
  }

  return { links, files, linkFiles, draft, shares, approvals, concessionId, partyId: partyP1, supplierId: partyP2, companyId: companyA, tenantId }
}
