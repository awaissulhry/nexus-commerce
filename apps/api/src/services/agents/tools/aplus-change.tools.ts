/**
 * Amazon A+ content (2026-10-19) — the change tools; aplus-content (aplus-read.tools.ts) reads.
 *
 *   set-aplus-content     make (create), change (update) or duplicate (copy) an A+ or Brand Story document as a DRAFT on
 *                         Amazon; a new image is checked here and uploaded to Amazon only when the approved request runs
 *   set-aplus-asins       which ASINs a document is applied to (the whole set, or add and remove)
 *   submit-aplus-content  send a document for Amazon's approval (how it goes live), or suspend it (off every ASIN at once)
 *
 * Each is a request a person approves in Nexus (alwaysAsk, ask at most). The preview is built from Amazon's live state,
 * with Amazon's own check (validateContentDocumentAsinRelations) whenever every image is already at Amazon; the gate's
 * re-check (ctx.approvalId) reads again without asking Amazon to check twice. The run happens only as the approved
 * request, only while Amazon publishing is live in Nexus, and only when nothing it stands on moved (stale-preview.ts).
 *
 * Each preview says the Amazon behaviours that apply to it: an update or an ASIN change makes an APPROVED document a
 * DRAFT again while its approved version stays live; approving a document silently replaces the one of the same family
 * published on its ASINs; removing an ASIN (or a suspend) takes the A+ off at once.
 *
 * Amazon's document is the record: nothing is written to Nexus's A+ rows (the AgentChange keeps before and after). Every
 * call goes through aplus-client.ts (the channel gateway); a live call works only in the deployed API.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { factHash, type AgentTool, type PlanEntities, type ToolChange, type ToolContext, type ToolResult, type ToolUndo } from '../tool-types.js'
import { staleRefusal } from './stale-preview.js'
import {
  aplusLiveState, createContentDocument, getContentDocument, listAllAsinRelations, postContentDocumentApprovalSubmission,
  postContentDocumentAsinRelations, postContentDocumentSuspendSubmission, resolveAplusMarket, updateContentDocument,
  validateContentDocumentAsinRelations,
  type AplusAsin, type AplusDocument, type AplusMarket, type AplusMetadata, type AplusStatus, type AplusTarget,
} from '../../aplus/aplus-client.js'
import {
  APLUS_MODULE_TYPES, checkAplusDocument, documentHash, normalizeAmazonDocument, summarizeModules,
  type AplusTier, type CheckedAplusDocument, type ModuleSummary,
} from '../../aplus/aplus-modules.js'
import {
  APLUS_MAX_NEW_IMAGES, finalizeAplusDocument, imagesPreview, inspectAplusImages, planHashOf, uploadAplusImages,
  type InspectedImage,
} from '../../aplus/aplus-images.js'
import {
  amazonSaid, answered, aplusAccountArg, aplusAsinsEntity, aplusEntity, aplusKeyArg, aplusMarketArg, ASIN_FAILED, asinArg,
  asinsNamed, failureSentence, ineligibleOf, kindWord, languageOf, listed, lower, NOT_CHECKED, NOTHING_CHANGED, NOTHING_QUEUED,
  plural, publishedOf, publishModeWarning, readDocument, recordKeyOf, replacedOn, runRefusal, sortedAsins, targetOf, upper,
  type AmazonCheck,
} from './aplus-change-kit.js'

/** The preview keys the approval gate compares (approval-inbox MATERIAL_PREVIEW_FIELDS), and execute again. */
const CONTENT_MATERIAL = ['op', 'target', 'basis', 'plan', 'images', 'asins'] as const
const ASINS_MATERIAL = ['target', 'basis', 'plan'] as const
const SUBMIT_MATERIAL = ['op', 'target', 'basis'] as const

const MAX_ASINS = 250
/** Amazon's check is asked on at most this many of a document's ASINs (the ASIN set travels in the address). */
const CHECK_ASINS = 100
/** A preview keeps to 20 lines: at most this many "module N" lines, and this many warnings. */
const MODULE_LINES = 12
const WARNING_LINES = 6
const BUYERS_SEE_NOTHING = 'buyers see nothing until it is submitted (submit-aplus-content) and Amazon approves it'
const STATUS_RESET: Partial<Record<AplusStatus, string>> = {
  APPROVED: 'Amazon makes the APPROVED document a DRAFT again: its approved version stays live on its ASINs until this one is submitted (submit-aplus-content) and approved.',
  SUBMITTED: 'Amazon is reviewing this document (SUBMITTED): this makes it a DRAFT again, so it must be submitted again; an approved version stays live until then.',
}

const contentKeyArg = aplusKeyArg.describe('the document: its contentReferenceKey, as aplus-content view list shows it')
const recordOf = (change: ToolChange, side: 'before' | 'after') => (change[side] ?? {}) as Record<string, unknown>
const cap = (lines: string[], n = WARNING_LINES) => lines.filter(Boolean).slice(0, n)

// ── set-aplus-content ───────────────────────────────────────────────────────────────────────────────────────────

const moduleArg = z.object({
  contentModuleType: z.preprocess(upper, z.enum(APLUS_MODULE_TYPES))
    .describe('the module type, e.g. PREMIUM_IMAGE_TEXT (aplus-content view modules lists every type with its fields)'),
}).catchall(z.unknown())

const setContentInput = z.object({
  op: z.preprocess(lower, z.enum(['create', 'update', 'copy']))
    .describe('create (a new document from modules), update (a document\'s name or its whole module list) or copy (a new draft duplicating a document)'),
  market: aplusMarketArg,
  accountId: aplusAccountArg,
  contentReferenceKey: aplusKeyArg.optional()
    .describe('update: the document; copy: the source document (contentReferenceKey from aplus-content view list)'),
  fromMarket: aplusMarketArg.optional()
    .describe('copy: the market of the source document (default: market); it must be on the same Amazon account'),
  name: z.string().trim().min(1).max(100).optional()
    .describe('the document\'s name, which buyers never see (create: required; copy: default "<source name> (copy)"; update: default unchanged)'),
  kind: z.preprocess(lower, z.enum(['a-plus', 'brand-story'])).optional()
    .describe('create: a-plus (an A+ document, the default) or brand-story (a Brand Story document)'),
  language: z.string().trim().min(2).max(10).optional()
    .describe('the document\'s language, e.g. it or de (create and copy: default the market\'s first language; update: it stays the document\'s own)'),
  modules: z.array(moduleArg).min(1).max(20).optional()
    .describe('create: the modules in order; update: the whole new module list (it replaces every module); not for copy. Amazon\'s own module objects, as aplus-content view document shows them'),
  asins: z.array(asinArg).min(1).max(MAX_ASINS).optional()
    .describe('create and copy: ASINs the new draft is applied to right after it is made (it shows nothing there until submitted and approved)'),
  summary: z.string().trim().min(1).max(1000).optional()
    .describe('what the text says, in English, for the person who approves it: required with modules or a name unless the language is en'),
})
type ContentArgs = z.infer<typeof setContentInput>

interface ContentPlan {
  op: ContentArgs['op']
  market: AplusMarket
  target: AplusTarget
  /** update: the document; create and copy: null (Amazon gives the new one its key). */
  key: string | null
  /** copy: where it is copied from. */
  source: { market: string; marketplaceId: string; contentReferenceKey: string; name: string; locale: string } | null
  /** update: the document now; copy: the source. */
  current: AplusDocument | null
  metadata: AplusMetadata | null
  /** update: the ASINs it is applied to now, and those it is published on. */
  applied: string[]
  published: string[]
  checked: CheckedAplusDocument
  images: InspectedImage[]
  /** Every image already at Amazon: the exact document that is sent (no upload first). */
  document: AplusDocument | null
  /** create and copy: the ASINs it is applied to right after. */
  asins: string[] | null
  basis: string
  check: AmazonCheck
  summary: string | null
  warnings: string[]
}

const TIER_WORD: Record<AplusTier, string> = { PREMIUM: 'Premium A+', STANDARD: 'A+', BRAND_STORY: 'Brand Story' }
const COPY_NAME_TAIL = ' (copy)'
const copyName = (name: string) => `${name.slice(0, 100 - COPY_NAME_TAIL.length).trimEnd()}${COPY_NAME_TAIL}`
const isBrandStory = (modules: readonly { contentModuleType?: string }[]) => modules.every((m) => String(m.contentModuleType ?? '').startsWith('BRAND_STORY_'))

/** What a request asks that no Amazon read is needed to refuse. */
function contentArgsProblem(a: ContentArgs): string | null {
  if (a.op === 'create') {
    if (!a.name) return 'op create needs a name (1 to 100 characters; buyers never see it).'
    if (!a.modules) return 'op create needs modules: Amazon\'s module objects, in order (aplus-content view modules lists each type\'s fields).'
    if (a.contentReferenceKey) return 'op create makes a new document: leave out contentReferenceKey (op update changes a document, op copy duplicates one).'
  } else if (!a.contentReferenceKey) {
    return `op ${a.op} needs contentReferenceKey: the document${a.op === 'copy' ? ' to copy' : ''} (aplus-content view list shows each key).`
  }
  if (a.op !== 'copy' && a.fromMarket) return 'fromMarket is for op copy only.'
  if (a.op !== 'create' && a.kind) return `op ${a.op} keeps the kind of ${a.op === 'copy' ? 'the source' : 'the document'}: leave out kind.`
  if (a.op === 'update' && !a.name && !a.modules) return 'Name what op update changes: name, modules (the whole new list), or both.'
  if (a.op === 'update' && a.asins) return 'The ASINs of an existing document change with set-aplus-asins.'
  if (a.op === 'copy' && a.modules) return 'op copy takes the source\'s modules as they are: change the copy afterwards with op update, or make a new document with op create.'
  return null
}

/** A document Nexus may change: a seller's A+ or Brand Story document read with its modules. */
function changeable(document: AplusDocument | null): { document: AplusDocument & { contentType: 'EBC' | 'BrandStory' } } | { error: string } {
  if (!document) return { error: 'Amazon sent this document without its modules; read it with aplus-content view document.' }
  if (document.contentType !== 'EBC' && document.contentType !== 'BrandStory') return { error: 'This is a vendor (EMC) document: Nexus changes seller A+ and Brand Story documents only.' }
  return { document: document as AplusDocument & { contentType: 'EBC' | 'BrandStory' } }
}

/**
 * The plan of a set-aplus-content request, from Amazon's live state: pure checks, then the market and account, then
 * Amazon's reads, then the new images (each fetched once, nothing uploaded). `amazonChecks`: ask Amazon's own check too
 * (the asker's preview only — never the gate's re-check, never the run, which checks after its uploads).
 */
async function planContent(a: ContentArgs, amazonChecks: boolean, nothing: string): Promise<ContentPlan | { error: string }> {
  const refuse = (why: string) => ({ error: `${why} ${nothing}` })
  const problem = contentArgsProblem(a)
  if (problem) return refuse(problem)
  const account = a.accountId ? { accountId: a.accountId } : {}
  const market = await resolveAplusMarket({ market: a.market, ...account, ...(a.op !== 'update' && a.language ? { language: a.language } : {}) })
  if ('error' in market) return refuse(market.error)
  const target = targetOf(market)
  const warnings: string[] = []
  let current: AplusDocument | null = null
  let metadata: AplusMetadata | null = null
  let source: ContentPlan['source'] = null
  let applied: AplusAsin[] = []
  let language = market.language
  let draft: { name: string; contentType: 'EBC' | 'BrandStory'; locale: string; modules: readonly unknown[] }

  if (a.op === 'update') {
    const read = await readDocument(target, a.contentReferenceKey!)
    const ok = changeable(read.document)
    if ('error' in ok) return refuse(ok.error)
    current = ok.document
    metadata = read.metadata
    const own = languageOf(current.locale) ?? current.locale
    if (a.language && languageOf(a.language) !== own) {
      return refuse(`An update keeps the document's own language (${current.locale}); for ${a.language}, make a new document with op create (or op copy, then update the copy).`)
    }
    language = own
    applied = (await listAllAsinRelations(target, a.contentReferenceKey!, { metadata: true })).asins
    draft = { name: a.name ?? current.name, contentType: ok.document.contentType, locale: current.locale, modules: a.modules ?? current.contentModuleList }
  } else if (a.op === 'copy') {
    const from = !a.fromMarket || a.fromMarket === a.market ? market : await resolveAplusMarket({ market: a.fromMarket, ...account })
    if ('error' in from) return refuse(from.error)
    if (from.accountId !== market.accountId) return refuse(`A copy stays on one Amazon account: Amazon ${from.market} and Amazon ${market.market} are on different accounts here.`)
    const read = await readDocument(targetOf(from), a.contentReferenceKey!)
    const ok = changeable(read.document)
    if ('error' in ok) return refuse(ok.error)
    current = ok.document
    metadata = read.metadata
    source = { market: from.market, marketplaceId: from.marketplaceId, contentReferenceKey: a.contentReferenceKey!, name: current.name, locale: current.locale }
    if (languageOf(current.locale) !== market.language) {
      warnings.push(`The text stays in the source's language (${current.locale}) in a ${market.locale} document: to translate it, read it with aplus-content and make the translated document with op create.`)
    }
    draft = { name: a.name ?? copyName(current.name), contentType: ok.document.contentType, locale: market.locale, modules: current.contentModuleList }
  } else {
    const modules = a.modules!
    const contentType = a.kind === 'brand-story' || (!a.kind && isBrandStory(modules)) ? 'BrandStory' : 'EBC'
    draft = { name: a.name!, contentType, locale: market.locale, modules }
  }

  if ((a.op === 'create' || a.modules || a.name) && language !== 'en' && !a.summary) {
    return refuse(`Give summary: what the ${a.modules || a.op === 'create' ? 'text' : 'name'} says in English, for the person who approves it (the document is in ${language}).`)
  }

  const checkedOut = checkAplusDocument(draft)
  if ('problems' in checkedOut) {
    const more = checkedOut.problems.length > 6 ? ` And ${plural(checkedOut.problems.length - 6, 'more problem')}.` : ''
    return refuse(`The document does not keep Amazon's A+ rules: ${checkedOut.problems.slice(0, 6).join(' ')}${more}`)
  }
  const checked = checkedOut.doc
  warnings.push(...(checked.notes ?? []))
  const newUses = checked.images.filter((use) => use.source.kind !== 'amazon')
  if (newUses.length > APLUS_MAX_NEW_IMAGES) {
    return refuse(`At most ${APLUS_MAX_NEW_IMAGES} new images go in one request (this has ${newUses.length}): send the rest in a later update.`)
  }
  const inspected = newUses.length ? await inspectAplusImages(newUses) : { images: [] as InspectedImage[], problems: [] as string[] }
  if (inspected.problems.length) {
    const more = inspected.problems.length > 5 ? ` And ${plural(inspected.problems.length - 5, 'more photo problem')}.` : ''
    return refuse(`${inspected.problems.slice(0, 5).join(' ')}${more}`)
  }
  const heavy = inspected.images.map((image) => image.warning).filter((w): w is string => !!w)
  warnings.push(...heavy.slice(0, 2), ...(heavy.length > 2 ? [`And ${plural(heavy.length - 2, 'more photo')} with a warning (images).`] : []))

  const document = newUses.length ? null : { name: checked.name, contentType: checked.contentType, locale: checked.locale, contentModuleList: checked.modules }
  if (a.op === 'update' && document && documentHash(document) === documentHash(current!)) {
    return refuse('Nothing to change: the document already has this name and these modules.')
  }
  const asins = a.op !== 'update' && a.asins ? sortedAsins(a.asins) : null
  const appliedAsins = sortedAsins(applied.map((r) => r.asin))
  let check = NOT_CHECKED
  if (amazonChecks && document) {
    const on = (a.op === 'update' ? appliedAsins : asins ?? []).slice(0, CHECK_ASINS)
    const out = await validateContentDocumentAsinRelations(target, document, on.length ? on : undefined)
    check = { ran: true, errors: out.errors.map(amazonSaid), warnings: out.warnings.map(amazonSaid) }
    if (check.errors.length) {
      const elsewhere = source && source.market !== market.market
        ? ' A copy into another market may not reach the source\'s images: give those images as assetId or url (they are uploaded again) with op create.'
        : ''
      return refuse(`Amazon's check refused it: ${listed(check.errors, 5)}.${elsewhere}`)
    }
    // An ASIN this request applies it to that Amazon would not show it on (outside the brand, invalid) is left out by the person.
    const refusedAsins = sortedAsins(out.warnings.filter((w) => w.code === ASIN_FAILED).flatMap((w) => asinsNamed(w, asins ?? [])))
    if (refusedAsins.length) return refuse(`Amazon would not show this A+ on ${listed(refusedAsins)}: leave ${refusedAsins.length === 1 ? 'it' : 'them'} out of asins.`)
  }
  const basis = a.op === 'create'
    ? factHash({ marketplaceId: market.marketplaceId, accountId: market.accountId, locale: market.locale })
    : factHash({ documentHash: documentHash(current!), status: metadata?.status ?? null, updateTime: metadata?.updateTime ?? null })
  return {
    op: a.op, market, target, key: a.op === 'update' ? a.contentReferenceKey! : null, source, current, metadata,
    applied: appliedAsins, published: publishedOf(applied), checked, images: inspected.images, document, asins, basis, check,
    summary: a.summary ?? null, warnings,
  }
}

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)
const moduleText = (s: ModuleSummary | undefined) =>
  s ? `${s.type}${s.headline ? ` "${clip(s.headline, 60)}"` : ''}, ${plural(s.images, 'image')}, ${plural(s.textChars, 'character')}` : null
/** Modules compared as Amazon keeps them (no nulls, no empty decorators): a position whose module differs is a change. */
const comparable = (doc: { name: string; contentType: AplusDocument['contentType']; locale: string }, modules: readonly unknown[]) =>
  normalizeAmazonDocument({ name: doc.name, contentType: doc.contentType, locale: doc.locale, contentModuleList: modules as AplusDocument['contentModuleList'] }).contentModuleList

/** The before → after lines: the name, the module types, one line per changed module, the ASINs. */
function contentChanges(plan: ContentPlan): { changes: Record<string, { from: unknown; to: unknown }>; changedModules: number } {
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  const before = plan.op === 'update' ? plan.current : null
  if (!before || before.name !== plan.checked.name) changes.name = { from: before?.name ?? null, to: plan.checked.name }
  const oldModules = before ? comparable(before, before.contentModuleList) : []
  const newModules = comparable(plan.checked, plan.checked.modules)
  const oldTypes = oldModules.map((m) => m.contentModuleType)
  const newTypes = newModules.map((m) => m.contentModuleType)
  if (!before || oldTypes.join() !== newTypes.join()) changes.modules = { from: before ? oldTypes : null, to: newTypes }
  const oldSummary = summarizeModules(oldModules)
  const newSummary = summarizeModules(newModules)
  const changed: number[] = []
  for (let i = 0; i < Math.max(oldModules.length, newModules.length); i++) {
    if (factHash(oldModules[i] ?? null) !== factHash(newModules[i] ?? null)) changed.push(i)
  }
  for (const i of changed.slice(0, MODULE_LINES)) {
    changes[`module ${i + 1} (${(newSummary[i] ?? oldSummary[i]).type})`] = { from: moduleText(oldSummary[i]), to: moduleText(newSummary[i]) }
  }
  if (plan.asins) changes.ASINs = { from: [], to: plan.asins }
  return { changes, changedModules: changed.length }
}

function contentPreview(plan: ContentPlan): Record<string, unknown> {
  const { market, checked } = plan
  const kind = TIER_WORD[checked.tier]
  const newImages = plan.images.length
  const atAmazon = checked.images.filter((use) => use.source.kind === 'amazon').length
  const { changes, changedModules } = contentChanges(plan)
  const where = `Amazon ${market.market}`
  const onAsins = plan.asins ? `, applied to ${plural(plan.asins.length, 'ASIN')}` : ''
  const imagesWord = newImages ? `, ${plural(newImages, 'new image')}` : ''
  let summary: string
  if (plan.op === 'create') {
    summary = `Creates a new ${kind} draft "${checked.name}" (${plural(checked.modules.length, 'module')}${imagesWord}) in ${where}${onAsins}; ${BUYERS_SEE_NOTHING}.`
  } else if (plan.op === 'copy') {
    summary = `Copies the ${kind} document "${plan.source!.name}" (Amazon ${plan.source!.market}) as a new draft "${checked.name}" in ${where}${onAsins}; ${BUYERS_SEE_NOTHING}.`
  } else {
    const what = [changes.name ? 'its name' : null, changedModules ? `${changedModules} of ${plural(checked.modules.length, 'module')}` : null, newImages ? plural(newImages, 'new image') : null]
      .filter(Boolean).join(', ')
    const buyers = plan.published.length
      ? `buyers keep seeing its approved version on ${plural(plan.published.length, 'ASIN')} until this one is submitted (submit-aplus-content) and approved`
      : BUYERS_SEE_NOTHING
    summary = `Changes the ${kind} document "${plan.current!.name}" in ${where} (${what}) as a draft; ${buyers}.`
  }
  const status = plan.op === 'update' ? plan.metadata?.status ?? null : null
  const warnings = cap([
    publishModeWarning(market.publishMode) ?? '',
    (status && STATUS_RESET[status]) ?? '',
    plan.asins ? 'On its ASINs it shows nothing until submitted and approved; once approved it replaces the A+ published there now (submit-aplus-content names those documents).' : '',
    newImages ? `Amazon checks the document when it runs, after the new images are uploaded; if it refuses, nothing is ${plan.op === 'update' ? 'changed' : 'created'} (the uploaded images stay unused in Amazon's media library).` : '',
    checked.contentType === 'BrandStory' && plan.op !== 'update' ? 'A Brand Story needs the brand\'s Brand Registry: without it Amazon refuses to make it.' : '',
    ...plan.warnings,
    ...plan.check.warnings.slice(0, 2).map((w) => `Amazon's check warns: ${w}`),
  ])
  return {
    action: 'set-aplus-content',
    op: plan.op,
    summary,
    changes,
    totals: { modules: checked.modules.length, newImages, imagesAtAmazon: atAmazon, asins: plan.asins?.length ?? plan.applied.length },
    ...(warnings.length ? { warnings } : {}),
    destination: { channel: 'AMAZON', market: market.market },
    target: { market: market.market, marketplaceId: market.marketplaceId, accountId: market.accountId, contentReferenceKey: plan.key, locale: checked.locale, contentType: checked.contentType },
    ...(plan.source ? { source: plan.source } : {}),
    modules: summarizeModules(checked.modules),
    images: imagesPreview(plan.images),
    plan: planHashOf(checked, plan.images),
    basis: plan.basis,
    asins: plan.asins,
    amazonCheck: plan.check,
    englishSummary: plan.summary,
    publishMode: market.publishMode,
  }
}

type ContentRecord = { op: ContentArgs['op']; market: string; marketplaceId: string; accountId: string; contentReferenceKey: string | null; name: string | null; documentHash: string | null }

/** The document as Amazon keeps it now, in the shape of a change's `after`. */
async function contentNow(base: Omit<ContentRecord, 'contentReferenceKey' | 'name' | 'documentHash'>, t: AplusTarget, key: string, fallback: AplusDocument) {
  const { record } = await getContentDocument(t, key, 'CONTENTS,METADATA')
  const doc = record.contentDocument ?? fallback
  return { ...base, contentReferenceKey: key, name: record.contentMetadata?.name ?? doc.name, documentHash: documentHash(doc), status: record.contentMetadata?.status ?? null }
}

async function runContent(a: ContentArgs, ctx: ToolContext): Promise<ToolResult> {
  const refused = runRefusal(ctx)
  if (refused) return { ok: false, error: refused }
  const plan = await planContent(a, false, NOTHING_CHANGED)
  if ('error' in plan) return { ok: false, error: plan.error }
  const stale = staleRefusal(ctx.approvedPreview, contentPreview(plan), CONTENT_MATERIAL, 'the A+ document')
  if (stale) return { ok: false, error: stale }
  const { target, market } = plan
  const made = plan.op === 'update' ? 'changed' : 'created'
  // The new images go to Amazon first; then Amazon checks the whole document, as it is sent.
  const uploaded = plan.images.length ? await uploadAplusImages(target, plan.images) : {}
  const document = finalizeAplusDocument(plan.checked, plan.images, uploaded)
  const on = (plan.op === 'update' ? plan.applied : plan.asins ?? []).slice(0, CHECK_ASINS)
  const check = await validateContentDocumentAsinRelations(target, document, on.length ? on : undefined)
  if (check.errors.length) {
    const left = plan.images.length ? '; the uploaded images stay unused in Amazon\'s media library' : ''
    return { ok: false, error: `Amazon's check refused it: ${listed(check.errors.map(amazonSaid), 5)}. Nothing was ${made}${left}.` }
  }
  let key = plan.key ?? ''
  try {
    if (plan.op === 'update') await updateContentDocument(target, key, document)
    else key = (await createContentDocument(target, document)).contentReferenceKey
  } catch (error) {
    return { ok: false, error: failureSentence(error, NOTHING_CHANGED, true) }
  }
  // From here the document is made or changed: whatever fails after it is a warning, never a failed run (a failed run
  // goes back to waiting, and approving it again would make a second document).
  const warnings: string[] = []
  const base = { op: plan.op, market: market.market, marketplaceId: market.marketplaceId, accountId: market.accountId }
  let asins: string[] | undefined
  if (plan.op !== 'update') {
    asins = []
    if (plan.asins?.length) {
      try {
        await postContentDocumentAsinRelations(target, key, plan.asins)
        asins = plan.asins
        try {
          const back = await listAllAsinRelations(target, key)
          if (back.complete) asins = sortedAsins(back.asins.map((r) => r.asin))
        } catch { /* the set it posted */ }
      } catch (error) {
        warnings.push(`The draft was made, but Amazon did not take its ASINs: ${failureSentence(error, '').trim()} Apply them with set-aplus-asins.`)
      }
    }
  }
  let after: ContentRecord & { status?: unknown; asins?: string[] }
  try {
    after = await contentNow(base, target, key, document)
  } catch {
    after = { ...base, contentReferenceKey: key, name: document.name, documentHash: documentHash(document) }
    warnings.push('Nexus could not read the document back from Amazon: aplus-content shows it.')
  }
  const { status, ...afterRecord } = after
  const before = plan.op === 'update'
    ? { ...base, contentReferenceKey: plan.key, name: plan.current!.name, documentHash: documentHash(plan.current!), document: normalizeAmazonDocument(plan.current!) }
    : { ...base, contentReferenceKey: null, name: null, documentHash: null, asins: [] as string[] }
  return {
    ok: true,
    data: {
      contentReferenceKey: key, name: after.name, status: status ?? null, ...(asins ? { asins } : {}),
      ...(warnings.length ? { warnings } : {}),
      note: `A draft on Amazon ${market.market}: ${BUYERS_SEE_NOTHING}. Read its status with aplus-content.`,
    },
    change: { before, after: { ...afterRecord, ...(asins ? { asins } : {}) } },
  }
}

/** C2 — undo: an update puts the document back as it was; a new draft is taken off the ASINs it was applied to. */
const CONTENT_UNDO: ToolUndo = {
  async current(change) {
    const after = recordOf(change, 'after')
    const named = recordKeyOf(after)
    if (!named) return { missing: true }
    try {
      const t = targetOf(named)
      const { record } = await getContentDocument(t, named.contentReferenceKey, 'CONTENTS,METADATA')
      const doc = record.contentDocument
      const now: Record<string, unknown> = {
        op: after.op, market: named.market, marketplaceId: named.marketplaceId, accountId: named.accountId, contentReferenceKey: named.contentReferenceKey,
        name: record.contentMetadata?.name ?? doc?.name ?? null, documentHash: doc ? documentHash(doc) : null,
      }
      if ('asins' in after) {
        const relations = await listAllAsinRelations(t, named.contentReferenceKey)
        now.asins = relations.complete ? sortedAsins(relations.asins.map((r) => r.asin)) : 'more ASINs than Nexus reads in one go'
      }
      return now
    } catch (error) {
      return { ...after, documentHash: null, unreadable: failureSentence(error, '').trim() }
    }
  },
  request(change) {
    const before = recordOf(change, 'before')
    const after = recordOf(change, 'after')
    const named = recordKeyOf(after)
    if (!named) return { refusal: 'This change does not name the A+ document it made or changed.' }
    const account = { accountId: named.accountId }
    if (before.op === 'update') {
      const document = before.document as AplusDocument | undefined
      if (!document?.contentModuleList?.length || typeof before.name !== 'string') return { refusal: 'This change does not record the document as it was before.' }
      return {
        tool: 'set-aplus-content',
        args: {
          op: 'update', market: named.market, ...account, contentReferenceKey: named.contentReferenceKey, name: before.name,
          language: document.locale.split('-')[0], modules: document.contentModuleList,
          summary: 'Undo: puts back the A+ document as it was before the change.',
        },
      }
    }
    const asins = Array.isArray(after.asins) ? (after.asins as string[]) : []
    if (asins.length) {
      return { tool: 'set-aplus-asins', args: { market: named.market, ...account, contentReferenceKey: named.contentReferenceKey, remove: asins.slice(0, MAX_ASINS) } }
    }
    return { refusal: 'Amazon has no way to delete an A+ document. This draft is applied to no ASIN, so no buyer sees it; leave it or change it with set-aplus-content op update.' }
  },
}

const setAplusContent: AgentTool = {
  name: 'set-aplus-content',
  title: 'Make or change Amazon A+ content',
  input: setContentInput,
  requires: [F.aplusManage],
  category: 'listings',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: an update is put back by the document as it was (it must be submitted again to go live), a new draft is
  // taken off its ASINs, and Amazon cannot delete a document.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: CONTENT_UNDO,
  description:
    'Make or change an Amazon A+ or Brand Story document as a DRAFT on Amazon: op create (a new document from modules), '
    + 'update (replace a document\'s name or its whole module list) or copy (duplicate a document as a new draft in its own '
    + 'market or another market of the same Amazon account, like Seller Central\'s Duplicate; to translate, read it with '
    + 'aplus-content and create with the translated modules). Buyers see nothing: a draft goes live only after '
    + 'submit-aplus-content and Amazon\'s approval; updating an approved document makes it a draft again while the approved '
    + 'version stays live. modules are Amazon\'s own module objects as aplus-content view document shows them '
    + '({ contentModuleType, premiumImageText: {…} }); aplus-content view modules lists each type\'s fields, text limits and '
    + 'image sizes. At most 7, all Standard or all Premium; Brand Story (kind brand-story) in its own document with one '
    + 'BRAND_STORY_IMAGE_WITH_LOGO. An image is { altText, and one of uploadDestinationId (already at Amazon, with its '
    + 'imageCropSpecification), assetId (a photo from image-library) or url (an https JPEG or PNG) }; Nexus checks its size, '
    + 'crops a new one to the module\'s shape unless imageCropSpecification is given, and uploads it to Amazon only when the '
    + 'approved request runs. Videos only as already at Amazon. create and copy may apply the new draft to asins. Give '
    + 'summary (what it says, in English) unless the language is en. Amazon checks the document first when every image is '
    + 'already at Amazon. A person approves it in Nexus.',
  planEntities(args): PlanEntities {
    const key = args.contentReferenceKey
    if (args.op === 'update') return { reads: [aplusEntity(args.market, key)], writes: [aplusEntity(args.market, key)] }
    if (args.op === 'copy') return { reads: [aplusEntity(args.fromMarket ?? args.market, key)], writes: [] }
    return { reads: [], writes: [] }
  },
  handler: (args, ctx) => answered(NOTHING_QUEUED, async () => {
    const plan = await planContent(args as ContentArgs, !ctx.approvalId, NOTHING_QUEUED)
    return 'error' in plan ? { ok: false, error: plan.error } : { ok: true, preview: contentPreview(plan) }
  }),
  execute: (args, ctx) => answered(NOTHING_CHANGED, () => runContent(args as ContentArgs, ctx)),
}

// ── set-aplus-asins ─────────────────────────────────────────────────────────────────────────────────────────────

const setAsinsInput = z.object({
  market: aplusMarketArg,
  accountId: aplusAccountArg,
  contentReferenceKey: contentKeyArg,
  asins: z.array(asinArg).min(1).max(MAX_ASINS).optional()
    .describe('the WHOLE new set of ASINs it is applied to (it replaces the set); or give add and remove instead'),
  add: z.array(asinArg).min(1).max(MAX_ASINS).optional()
    .describe('ASINs it is applied to as well (they show it only once it is submitted and approved)'),
  remove: z.array(asinArg).min(1).max(MAX_ASINS).optional()
    .describe('ASINs it is taken off (the A+ goes off them at once)'),
})
type AsinsArgs = z.infer<typeof setAsinsInput>

interface AsinsPlan {
  market: AplusMarket
  target: AplusTarget
  key: string
  document: AplusDocument
  metadata: AplusMetadata | null
  current: string[]
  next: string[]
  added: string[]
  removed: string[]
  published: string[]
  basis: string
  warnings: string[]
}

async function planAsins(a: AsinsArgs, amazonChecks: boolean, nothing: string): Promise<AsinsPlan | { error: string }> {
  const refuse = (why: string) => ({ error: `${why} ${nothing}` })
  if (a.asins && (a.add || a.remove)) return refuse('Give asins (the whole new set) or add and remove, not both.')
  if (!a.asins && !a.add && !a.remove) return refuse('Name the ASINs: asins (the whole new set), or add and remove.')
  const both = (a.add ?? []).filter((asin) => (a.remove ?? []).includes(asin))
  if (both.length) return refuse(`${listed(sortedAsins(both))} cannot be added and removed at once.`)
  const market = await resolveAplusMarket({ market: a.market, ...(a.accountId ? { accountId: a.accountId } : {}) })
  if ('error' in market) return refuse(market.error)
  const target = targetOf(market)
  const key = a.contentReferenceKey
  const read = await readDocument(target, key)
  if (!read.document) return refuse('Amazon sent this document without its modules; read it with aplus-content view document.')
  const relations = await listAllAsinRelations(target, key, { metadata: true })
  if (!relations.complete) return refuse('This document is applied to more ASINs than Nexus reads in one go: change its ASINs in Seller Central.')
  const current = sortedAsins(relations.asins.map((r) => r.asin))
  const removing = new Set(a.remove ?? [])
  const next = a.asins ? sortedAsins(a.asins) : sortedAsins([...current.filter((asin) => !removing.has(asin)), ...(a.add ?? [])])
  const added = next.filter((asin) => !current.includes(asin))
  const removed = current.filter((asin) => !next.includes(asin))
  if (!added.length && !removed.length) return refuse(`Nothing to change: the document is applied to exactly ${next.length ? 'these ASINs' : 'no ASIN'} already.`)
  if (next.length > MAX_ASINS) return refuse(`Nexus applies a document to at most ${MAX_ASINS} ASINs (this would be ${next.length}).`)

  const warnings: string[] = []
  if (amazonChecks && added.length) {
    // Amazon's check on the new set: an ASIN it would not show the A+ on (outside the brand, invalid) refuses the add.
    const out = await validateContentDocumentAsinRelations(target, read.document, next.slice(0, CHECK_ASINS))
    if (out.errors.length) return refuse(`Amazon's check refused it: ${listed(out.errors.map(amazonSaid), 5)}.`)
    const failed = out.warnings.filter((w) => w.code === ASIN_FAILED)
    const refusedAdds = sortedAsins(failed.flatMap((w) => asinsNamed(w, added)))
    if (refusedAdds.length) {
      const why = failed.find((w) => asinsNamed(w, added).length)
      return refuse(`Amazon would not show this A+ on ${listed(refusedAdds)}${why ? `: ${amazonSaid(why)}` : ''}. Leave ${refusedAdds.length === 1 ? 'it' : 'them'} out.`)
    }
    warnings.push(...out.warnings.slice(0, 2).map((w) => `Amazon's check warns: ${amazonSaid(w)}`))
    warnings.push(...await replacedOn(target, key, read.document.contentType, added))
  }
  const ineligible = ineligibleOf(relations.asins.filter((r) => next.includes(r.asin)))
  if (ineligible.length) warnings.push(`Amazon shows no A+ on ${listed(ineligible, 3)}: take ${ineligible.length === 1 ? 'it' : 'them'} off, or check the brand in Seller Central.`)
  const status = read.metadata?.status ?? null
  return {
    market, target, key, document: read.document, metadata: read.metadata, current, next, added, removed,
    published: publishedOf(relations.asins),
    basis: factHash({ asins: current, status, updateTime: read.metadata?.updateTime ?? null, documentHash: documentHash(read.document) }),
    warnings,
  }
}

function asinsPreview(plan: AsinsPlan): Record<string, unknown> {
  const { market } = plan
  const name = plan.metadata?.name ?? plan.document.name
  const kind = kindWord(plan.document.contentType, plan.metadata?.badgeSet)
  const offNow = plan.removed.filter((asin) => plan.published.includes(asin))
  const parts = [
    plan.added.length ? `applies it to ${plural(plan.added.length, 'more ASIN')}` : null,
    plan.removed.length ? `takes it off ${plural(plan.removed.length, 'ASIN')}` : null,
  ].filter(Boolean).join(' and ')
  const status = plan.metadata?.status ?? null
  const warnings = cap([
    publishModeWarning(market.publishMode) ?? '',
    offNow.length ? `Removing takes this A+ off ${listed(offNow)} at once: buyers there see another approved document's A+, or none.` : '',
    (status && STATUS_RESET[status]) ?? '',
    plan.added.length ? `The added ${plan.added.length === 1 ? 'ASIN shows' : 'ASINs show'} nothing until the document is submitted (submit-aplus-content) and approved.` : '',
    ...plan.warnings,
  ])
  return {
    action: 'set-aplus-asins',
    summary: `Sets the ASINs of the ${kind} document "${name}" in Amazon ${market.market}: ${parts}, ${plural(plan.next.length, 'ASIN')} in all.`,
    changes: {
      ASINs: { from: plan.current, to: plan.next },
      ...(plan.added.length ? { 'ASINs added': { from: null, to: plan.added } } : {}),
      ...(plan.removed.length ? { 'ASINs removed': { from: plan.removed, to: null } } : {}),
    },
    totals: { added: plan.added.length, removed: plan.removed.length, total: plan.next.length },
    ...(warnings.length ? { warnings } : {}),
    added: plan.added,
    removed: plan.removed,
    destination: { channel: 'AMAZON', market: market.market },
    target: { market: market.market, marketplaceId: market.marketplaceId, accountId: market.accountId, contentReferenceKey: plan.key, locale: plan.document.locale, contentType: plan.document.contentType },
    basis: plan.basis,
    plan: factHash(plan.next),
    publishMode: market.publishMode,
  }
}

async function runAsins(a: AsinsArgs, ctx: ToolContext): Promise<ToolResult> {
  const refused = runRefusal(ctx)
  if (refused) return { ok: false, error: refused }
  const plan = await planAsins(a, false, NOTHING_CHANGED)
  if ('error' in plan) return { ok: false, error: plan.error }
  const stale = staleRefusal(ctx.approvedPreview, asinsPreview(plan), ASINS_MATERIAL, 'the A+ document or its ASINs')
  if (stale) return { ok: false, error: stale }
  try {
    await postContentDocumentAsinRelations(plan.target, plan.key, plan.next)
  } catch (error) {
    return { ok: false, error: failureSentence(error, NOTHING_CHANGED, true) }
  }
  let now = plan.next
  let note: string | null = null
  try {
    const back = await listAllAsinRelations(plan.target, plan.key)
    if (back.complete) now = sortedAsins(back.asins.map((r) => r.asin))
  } catch {
    note = 'Nexus could not read the ASINs back from Amazon: aplus-content shows them.'
  }
  const base = { market: plan.market.market, marketplaceId: plan.market.marketplaceId, accountId: plan.market.accountId, contentReferenceKey: plan.key }
  return {
    ok: true,
    data: { contentReferenceKey: plan.key, asins: now, added: plan.added, removed: plan.removed, ...(note ? { note } : {}) },
    change: { before: { ...base, asins: plan.current }, after: { ...base, asins: now } },
  }
}

/** C2 — undo: the set the document had before, through the same tool (the ones it was given taken off, when it had none). */
const ASINS_UNDO: ToolUndo = {
  async current(change) {
    const after = recordOf(change, 'after')
    const named = recordKeyOf(after)
    if (!named) return { missing: true }
    try {
      const relations = await listAllAsinRelations(targetOf(named), named.contentReferenceKey)
      return { ...after, asins: relations.complete ? sortedAsins(relations.asins.map((r) => r.asin)) : 'more ASINs than Nexus reads in one go' }
    } catch (error) {
      return { ...after, asins: null, unreadable: failureSentence(error, '').trim() }
    }
  },
  request(change) {
    const before = recordOf(change, 'before')
    const after = recordOf(change, 'after')
    const named = recordKeyOf(after)
    if (!named || !Array.isArray(before.asins)) return { refusal: 'This change does not record the ASINs of the document before it.' }
    const was = before.asins as string[]
    const is = Array.isArray(after.asins) ? (after.asins as string[]) : []
    if (was.length > MAX_ASINS) return { refusal: `The document had ${was.length} ASINs before: more than the ${MAX_ASINS} Nexus sets in one request. Set them in Seller Central.` }
    const args = { market: named.market, accountId: named.accountId, contentReferenceKey: named.contentReferenceKey }
    if (was.length) return { tool: 'set-aplus-asins', args: { ...args, asins: was } }
    if (!is.length) return { refusal: 'The document was applied to no ASIN before and is applied to none now: there is nothing to put back.' }
    return { tool: 'set-aplus-asins', args: { ...args, remove: is.slice(0, MAX_ASINS) } }
  },
}

const setAplusAsins: AgentTool = {
  name: 'set-aplus-asins',
  title: 'Set the ASINs of Amazon A+ content',
  input: setAsinsInput,
  requires: [F.aplusManage, F.marketingPublish],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: the set is put back, but a removal took the A+ off at once, and an approved document became a draft.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: ASINS_UNDO,
  description:
    'Set which ASINs an Amazon A+ or Brand Story document is applied to: asins (the whole new set), or add and remove. '
    + 'Amazon checks the document on the new set first; an ASIN it refuses is named and nothing is queued. The preview '
    + 'names the document published on each added ASIN now (approving this one replaces it there). Removing an ASIN takes '
    + 'the A+ off it at once; adding one shows nothing until the document is submitted and approved (submit-aplus-content). '
    + 'Any change makes an approved document a draft again; its approved version stays live until it is submitted and '
    + 'approved again. A person approves it in Nexus.',
  planEntities(args): PlanEntities {
    const key = args.contentReferenceKey
    return { reads: [aplusEntity(args.market, key), aplusAsinsEntity(args.market, key)], writes: [aplusAsinsEntity(args.market, key), aplusEntity(args.market, key)] }
  },
  handler: (args, ctx) => answered(NOTHING_QUEUED, async () => {
    const plan = await planAsins(args as AsinsArgs, !ctx.approvalId, NOTHING_QUEUED)
    return 'error' in plan ? { ok: false, error: plan.error } : { ok: true, preview: asinsPreview(plan) }
  }),
  execute: (args, ctx) => answered(NOTHING_CHANGED, () => runAsins(args as AsinsArgs, ctx)),
}

// ── submit-aplus-content ────────────────────────────────────────────────────────────────────────────────────────

const submitInput = z.object({
  op: z.preprocess(lower, z.enum(['submit', 'suspend']))
    .describe('submit (send it for Amazon\'s approval: how it goes live) or suspend (take it off every ASIN at once)'),
  market: aplusMarketArg,
  accountId: aplusAccountArg,
  contentReferenceKey: contentKeyArg,
})
type SubmitArgs = z.infer<typeof submitInput>

interface SubmitPlan {
  op: SubmitArgs['op']
  market: AplusMarket
  target: AplusTarget
  key: string
  name: string
  kind: string
  status: AplusStatus | null
  asins: string[]
  published: string[]
  complete: boolean
  basis: string
  warnings: string[]
}

async function planSubmit(a: SubmitArgs, amazonChecks: boolean, nothing: string): Promise<SubmitPlan | { error: string }> {
  const refuse = (why: string) => ({ error: `${why} ${nothing}` })
  const market = await resolveAplusMarket({ market: a.market, ...(a.accountId ? { accountId: a.accountId } : {}) })
  if ('error' in market) return refuse(market.error)
  const target = targetOf(market)
  const key = a.contentReferenceKey
  const read = await readDocument(target, key)
  const relations = await listAllAsinRelations(target, key, { metadata: true })
  const asins = sortedAsins(relations.asins.map((r) => r.asin))
  const published = publishedOf(relations.asins)
  const status = read.metadata?.status ?? null
  const warnings: string[] = []
  if (a.op === 'submit') {
    if (!read.document) return refuse('Amazon sent this document without its modules; read it with aplus-content view document.')
    if (!relations.complete) return refuse('This document is applied to more ASINs than Nexus reads in one go: submit it in Seller Central.')
    if (!asins.length) return refuse('It is applied to no ASIN: apply it first with set-aplus-asins.')
    if (status === 'SUBMITTED') return refuse('It is already waiting for Amazon\'s review (SUBMITTED): read its status with aplus-content, at most once an hour.')
    if (status === 'APPROVED') return refuse('It is already approved and published on its ASINs: to change it, update it with set-aplus-content, then submit that.')
    const ineligible = ineligibleOf(relations.asins)
    if (ineligible.length) return refuse(`Amazon says ${listed(ineligible, 5)} cannot show A+ from this brand: take ${ineligible.length === 1 ? 'it' : 'them'} off with set-aplus-asins first.`)
    if (amazonChecks) {
      const out = await validateContentDocumentAsinRelations(target, read.document, asins.slice(0, CHECK_ASINS))
      if (out.errors.length) return refuse(`Amazon's check refused it: ${listed(out.errors.map(amazonSaid), 5)}.`)
      const failed = out.warnings.filter((w) => w.code === ASIN_FAILED && asinsNamed(w, asins).length)
      if (failed.length) {
        const on = sortedAsins(failed.flatMap((w) => asinsNamed(w, asins)))
        return refuse(`Amazon would not show it on ${listed(on)}: ${amazonSaid(failed[0])}. Take ${on.length === 1 ? 'it' : 'them'} off with set-aplus-asins first.`)
      }
      warnings.push(...out.warnings.slice(0, 2).map((w) => `Amazon's check warns: ${amazonSaid(w)}`))
      warnings.push(...await replacedOn(target, key, read.document.contentType, asins))
    }
    if (status === 'REJECTED') warnings.push('Amazon REJECTED it before: unless what Amazon objected to was changed, it may be rejected again.')
  } else if (!published.length && status !== 'SUBMITTED' && status !== 'APPROVED') {
    return refuse('It is shown on no ASIN and is not waiting for review: there is nothing to suspend.')
  }
  return {
    op: a.op, market, target, key, name: read.metadata?.name ?? read.document?.name ?? key,
    kind: kindWord(read.document?.contentType, read.metadata?.badgeSet), status, asins, published, complete: relations.complete,
    basis: factHash({ status, updateTime: read.metadata?.updateTime ?? null, documentHash: read.document ? documentHash(read.document) : null, asins, publishedAsins: published }),
    warnings,
  }
}

function submitPreview(plan: SubmitPlan): Record<string, unknown> {
  const { market } = plan
  const where = `Amazon ${market.market}`
  const submit = plan.op === 'submit'
  const summary = submit
    ? `Sends the ${plan.kind} document "${plan.name}" in ${where} for Amazon's approval; once Amazon approves it, it is published on its ${plural(plan.asins.length, 'ASIN')}, replacing any ${plan.kind === 'Brand Story' ? 'Brand Story' : 'A+'} shown there now.`
    : `Takes the ${plan.kind} document "${plan.name}" off ${plan.published.length ? `the ${plural(plan.published.length, 'ASIN')} it is shown on` : 'every ASIN'} in ${where} at once; the document and its ASINs stay, and it comes back only when submitted and approved again.`
  const warnings = cap([
    publishModeWarning(market.publishMode) ?? '',
    submit ? 'Amazon reviews it (minutes to days; some accounts at once): read its status with aplus-content, at most once an hour.' : '',
    !submit ? 'A suspend also takes off an older approved version of this document that is live now: nothing of it shows until it is submitted and approved again.' : '',
    !submit && plan.status === 'SUBMITTED' ? 'It is waiting for Amazon\'s review (SUBMITTED): after the suspend it shows on no ASIN until it is submitted and approved again.' : '',
    !plan.complete ? 'Nexus read only part of its ASINs: Amazon takes it off all of them.' : '',
    ...plan.warnings,
  ])
  return {
    action: 'submit-aplus-content',
    op: plan.op,
    summary,
    changes: submit
      ? { status: { from: plan.status, to: 'SUBMITTED (Amazon reviews it)' } }
      : { 'shown on': { from: plan.published, to: [] } },
    totals: { asins: plan.asins.length, published: plan.published.length },
    ...(warnings.length ? { warnings } : {}),
    destination: { channel: 'AMAZON', market: market.market },
    target: { market: market.market, marketplaceId: market.marketplaceId, accountId: market.accountId, contentReferenceKey: plan.key },
    basis: plan.basis,
    publishMode: market.publishMode,
  }
}

async function runSubmit(a: SubmitArgs, ctx: ToolContext): Promise<ToolResult> {
  const refused = runRefusal(ctx)
  if (refused) return { ok: false, error: refused }
  const plan = await planSubmit(a, false, NOTHING_CHANGED)
  if ('error' in plan) return { ok: false, error: plan.error }
  const stale = staleRefusal(ctx.approvedPreview, submitPreview(plan), SUBMIT_MATERIAL, 'the A+ document')
  if (stale) return { ok: false, error: stale }
  try {
    if (plan.op === 'submit') await postContentDocumentApprovalSubmission(plan.target, plan.key)
    else await postContentDocumentSuspendSubmission(plan.target, plan.key)
  } catch (error) {
    return { ok: false, error: failureSentence(error, NOTHING_CHANGED, true) }
  }
  let status: AplusStatus | null = null
  try {
    status = (await getContentDocument(plan.target, plan.key, 'METADATA')).record.contentMetadata?.status ?? null
  } catch { /* aplus-content reads it */ }
  const base = { op: plan.op, market: plan.market.market, marketplaceId: plan.market.marketplaceId, accountId: plan.market.accountId, contentReferenceKey: plan.key }
  const was = plan.op === 'suspend' && plan.published.length ? 'published' : (plan.status ?? 'DRAFT').toLowerCase()
  return {
    ok: true,
    data: {
      contentReferenceKey: plan.key, name: plan.name, op: plan.op, status,
      note: plan.op === 'submit'
        ? 'Sent for Amazon\'s approval: read its status with aplus-content, at most once an hour.'
        : 'Taken off its ASINs: it comes back only when submitted and approved again.',
    },
    change: { before: { ...base, phase: was }, after: { ...base, phase: plan.op === 'submit' ? 'submitted' : 'suspended' } },
  }
}

/** C2 — undo: a submit is undone by a suspend of the same document, a suspend by a submit. */
const SUBMIT_UNDO: ToolUndo = {
  async current(change) {
    const after = recordOf(change, 'after')
    const named = recordKeyOf(after)
    if (!named) return { missing: true }
    try {
      const state = await aplusLiveState(targetOf(named), named.contentReferenceKey)
      const phase = after.op === 'submit'
        ? state.status === 'SUBMITTED' || state.status === 'APPROVED' ? 'submitted' : (state.status ?? 'unknown').toLowerCase()
        : state.publishedAsins.length ? 'published' : 'suspended'
      return { ...after, phase }
    } catch (error) {
      return { ...after, phase: null, unreadable: failureSentence(error, '').trim() }
    }
  },
  request(change) {
    const after = recordOf(change, 'after')
    const named = recordKeyOf(after)
    const op = after.op ?? recordOf(change, 'before').op
    if (!named || (op !== 'submit' && op !== 'suspend')) return { refusal: 'This change does not name the A+ document it submitted or suspended.' }
    return {
      tool: 'submit-aplus-content',
      args: { op: op === 'submit' ? 'suspend' : 'submit', market: named.market, accountId: named.accountId, contentReferenceKey: named.contentReferenceKey },
    }
  },
}

const submitAplusContent: AgentTool = {
  name: 'submit-aplus-content',
  title: 'Submit or suspend Amazon A+ content',
  input: submitInput,
  requires: [F.aplusManage, F.marketingPublish],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: a submit is undone by a suspend (which also takes off an older approved version), a suspend by a new
  // submit that Amazon must approve again.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: SUBMIT_UNDO,
  description:
    'Send an Amazon A+ or Brand Story document for Amazon\'s approval (op submit) — this is how it goes live: once Amazon '
    + 'approves it (minutes to days; some accounts at once) it is published on every ASIN it is applied to, replacing the '
    + 'document published there now (the preview names them). op suspend takes it off every ASIN at once; the document and '
    + 'its ASINs stay, and it comes back only when submitted and approved again. Refused when it is applied to no ASIN, is '
    + 'already waiting for review or approved, or Amazon says an ASIN is not in the brand. Follow it with aplus-content '
    + '(status; at most hourly). A person approves it in Nexus.',
  planEntities(args): PlanEntities {
    const key = args.contentReferenceKey
    return { reads: [aplusEntity(args.market, key), aplusAsinsEntity(args.market, key)], writes: [aplusEntity(args.market, key)] }
  },
  handler: (args, ctx) => answered(NOTHING_QUEUED, async () => {
    const plan = await planSubmit(args as SubmitArgs, !ctx.approvalId, NOTHING_QUEUED)
    return 'error' in plan ? { ok: false, error: plan.error } : { ok: true, preview: submitPreview(plan) }
  }),
  execute: (args, ctx) => answered(NOTHING_CHANGED, () => runSubmit(args as SubmitArgs, ctx)),
}

export const APLUS_CHANGE_TOOLS: AgentTool[] = [setAplusContent, setAplusAsins, submitAplusContent]
