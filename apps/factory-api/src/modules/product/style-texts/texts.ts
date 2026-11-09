import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { editRefusal } from '@nexus/factory-domain/product/lifecycle/rules'
import type { PutTextBody, RemoveTextBody, TextsView } from '@nexus/factory-domain/product/style-texts/contracts'
import { everyName, normaliseLanguage, resolveText, textProblems, type ResolvedText, type StoredText, type StyleWords } from '@nexus/factory-domain/product/style-texts/rules'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { editRuleOf, requireEditRule } from '../lifecycle/edit-rule'
import { assertMayWrite, contextOf, isUniqueViolation, lockStyle, readStyle } from '../styles/store'

/**
 * A style's names and descriptions per language (B-W2b-227; PRD-019; factory-domain product/style-texts). One StyleText row
 * per style and language (B-W2b-206). Office: read with product.styles.view, written with product.styles.manage over the
 * style's company; a text is the style's DETAILS, so its edit rule (B-W2b-221) refuses it only when the style's state is
 * blocked, and an archived style keeps its texts.
 *
 *   GET  /product/styles/:styleId/texts[?language=]          every language written, W1's own names (Style.nameI18n), the
 *                                                           company's language, what a reader in `language` gets
 *   PUT  /product/styles/:styleId/texts/:language            {version?, name, shortDescription?, longDescription?} write a
 *                                                           language (no version: a new one; the row's: a change)
 *   POST /product/styles/:styleId/texts/:language/remove     {version} the language goes; readers fall back
 *
 * Readers (labels, the tech pack, the portal, the search) take a text with `styleTextsOf` + factory-domain resolveText:
 * the language, its base language, W1's name in it, the company's language, the style's own name.
 */

const TEXT_COLUMNS = { id: true, language: true, name: true, shortDescription: true, longDescription: true, version: true, createdAt: true, updatedAt: true, createdById: true } as const

type Reader = FactoryClient | CommandTx

/** The texts of these styles (every language), by style id. */
export async function styleTextsOf(db: Reader, styleIds: readonly string[]): Promise<Map<string, StoredText[]>> {
  const out = new Map<string, StoredText[]>()
  if (styleIds.length === 0) return out
  const rows = await db.styleText.findMany({ where: { styleId: { in: [...new Set(styleIds)] } }, select: { styleId: true, language: true, name: true, shortDescription: true, longDescription: true }, orderBy: [{ styleId: 'asc' }, { language: 'asc' }] })
  for (const row of rows) out.set(row.styleId, [...(out.get(row.styleId) ?? []), { language: row.language, name: row.name, shortDescription: row.shortDescription, longDescription: row.longDescription }])
  return out
}

/** The language a style's texts fall back to: its company's (Company.locale), a tenant-wide style's the tenant's. */
export async function companyLanguageOf(db: Reader, style: { readonly tenantId?: string; readonly companyId: string | null }): Promise<string> {
  if (style.companyId !== null) {
    const company = await db.company.findUnique({ where: { id: style.companyId }, select: { locale: true } })
    if (company) return company.locale
  }
  const tenant = style.tenantId ? await db.tenant.findUnique({ where: { id: style.tenantId }, select: { defaultLocale: true } }) : null
  return tenant?.defaultLocale ?? 'it'
}

const wordsOf = (style: { name: string; nameI18n: unknown; description: string | null }): StyleWords => ({
  name: style.name,
  nameI18n: (style.nameI18n as Record<string, string> | null) ?? null,
  description: style.description,
})

/** The text of each style in `language` (labels, the portal, the tech pack), with its fallback. */
export async function resolvedTextsOf(db: Reader, styleIds: readonly string[], language: string): Promise<Map<string, ResolvedText>> {
  const out = new Map<string, ResolvedText>()
  if (styleIds.length === 0) return out
  const styles = await db.style.findMany({ where: { id: { in: [...new Set(styleIds)] } }, select: { id: true, tenantId: true, companyId: true, name: true, nameI18n: true, description: true } })
  const texts = await styleTextsOf(db, styleIds)
  const languages = new Map<string, string>()
  for (const style of styles) {
    const key = style.companyId ?? `tenant:${style.tenantId}`
    if (!languages.has(key)) languages.set(key, await companyLanguageOf(db, style))
    out.set(style.id, resolveText(texts.get(style.id) ?? [], wordsOf(style), language, languages.get(key)!))
  }
  return out
}

/** What the portal's catalogue reads of a style's texts: every name (its search), Italian and English (the card), the person's language. */
export interface CatalogueTexts {
  readonly names: readonly string[]
  /** The card's names: Italian and English where a text or W1's name gives one (not the style's bare name). */
  readonly nameI18n: { it?: string; en?: string }
  /** The text in the reader's language, with its fallback. */
  readonly own: ResolvedText
}

export async function catalogueTextsOf(db: Reader, styleIds: readonly string[], locale: string): Promise<Map<string, CatalogueTexts>> {
  const out = new Map<string, CatalogueTexts>()
  if (styleIds.length === 0) return out
  const styles = await db.style.findMany({ where: { id: { in: [...new Set(styleIds)] } }, select: { id: true, tenantId: true, companyId: true, name: true, nameI18n: true, description: true } })
  const texts = await styleTextsOf(db, styleIds)
  const languages = new Map<string, string>()
  for (const style of styles) {
    const key = style.companyId ?? `tenant:${style.tenantId}`
    if (!languages.has(key)) languages.set(key, await companyLanguageOf(db, style))
    const rows = texts.get(style.id) ?? []
    const words = wordsOf(style)
    const resolve = (language: string) => resolveText(rows, words, language, languages.get(key)!)
    const it = resolve('it')
    const en = resolve('en')
    out.set(style.id, {
      names: everyName(rows, words),
      nameI18n: { ...(it.source === 'STYLE' ? {} : { it: it.name }), ...(en.source === 'STYLE' ? {} : { en: en.name }) },
      own: resolve(locale),
    })
  }
  return out
}

/** Every name of each style in any language (the search's words, the portal's search). */
export async function namesOf(db: Reader, styles: readonly { readonly id: string; readonly name: string; readonly nameI18n: unknown }[]): Promise<Map<string, string[]>> {
  const texts = await styleTextsOf(
    db,
    styles.map((style) => style.id),
  )
  return new Map(styles.map((style) => [style.id, everyName(texts.get(style.id) ?? [], wordsOf({ ...style, description: null }))]))
}

/** The texts view of a style (a read, or a command's answer with its transaction). */
export async function textsViewOf(db: Reader, styleId: string, language: string | undefined): Promise<TextsView> {
  const style = await db.style.findUniqueOrThrow({ where: { id: styleId }, select: { id: true, tenantId: true, code: true, name: true, nameI18n: true, description: true, companyId: true, status: true, version: true } })
  const rows = await db.styleText.findMany({ where: { styleId }, select: TEXT_COLUMNS, orderBy: { language: 'asc' } })
  const companyLanguage = await companyLanguageOf(db, style)
  const rule = await editRuleOf(db, styleId)
  const refusal = style.status === 'ARCHIVED' ? { code: 'STYLE_ARCHIVED', message: `Style ${style.code} is archived: reactivate it before changing its texts.` } : editRefusal(rule.rule, 'DETAILS', rule.facts)
  const names = Object.fromEntries(Object.entries((style.nameI18n as Record<string, unknown> | null) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const asked = language === undefined ? null : normaliseLanguage(language)
  if (language !== undefined && asked === null) throw new ValidationError('The language is not valid.', [{ path: 'query/language', message: 'A language tag: "it", "en", "de-CH".' }])
  return {
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, version: style.version },
    companyLanguage,
    styleNames: names,
    texts: rows.map((row) => ({ ...row, createdAt: toUtcIso(row.createdAt), updatedAt: toUtcIso(row.updatedAt) })),
    resolved: asked === null ? null : resolveText(rows, wordsOf(style), asked, companyLanguage),
    editRefusal: refusal ? { code: refusal.code, message: refusal.message } : null,
  }
}

/** GET /product/styles/:styleId/texts */
export async function readTexts(caller: CommandCaller, styleId: string, query: { readonly language?: string | undefined }): Promise<TextsView> {
  await readStyle(caller, styleId)
  return caller.withClient((client) => textsViewOf(client, styleId, query.language))
}

function languageOf(value: string): string {
  const tag = normaliseLanguage(value)
  if (tag === null) throw new ValidationError('The language is not valid.', [{ path: 'params/language', message: 'A language tag: "it", "en", "de-CH" (2 or 3 letters, then subtags).' }])
  return tag
}

/** The style locked, open and its DETAILS allowed by its edit rule (inside a command). */
async function lockForText(tx: CommandTx, styleId: string): Promise<{ code: string; companyId: string | null }> {
  const locked = await lockStyle(tx, styleId)
  if (locked.status === 'ARCHIVED') throw new InvalidStateError(`Style ${locked.code} is archived: reactivate it before changing its texts.`)
  await requireEditRule(tx, styleId, 'DETAILS')
  return locked
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** PUT /product/styles/:styleId/texts/:language */
export async function putText(caller: CommandCaller, styleId: string, rawLanguage: string, body: PutTextBody, idempotencyKey?: string): Promise<TextsView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  const language = languageOf(rawLanguage)
  const text = { name: body.name.trim(), shortDescription: blank(body.shortDescription), longDescription: body.longDescription === undefined || body.longDescription === null || body.longDescription.trim() === '' ? null : body.longDescription.replace(/\s+$/, '') }
  const problems = textProblems(text)
  if (problems.length > 0) throw new ValidationError(`The ${language} text is not valid.`, problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))

  const { result } = await command(caller, { name: 'product.styles.putText', idempotencyKey, input: { styleId, language, ...body } }, async (tools) => {
    const { tx, now, context: actor } = tools
    const style = await lockForText(tx, styleId)
    const current = await tx.styleText.findFirst({ where: { styleId, language }, select: TEXT_COLUMNS })
    const before = current ? { name: current.name, shortDescription: current.shortDescription, longDescription: current.longDescription } : null
    let rowId: string
    if (current) {
      if (body.version === undefined) throw new ConflictError(`Style ${style.code} has a ${language} text already: load it and change it (send its version).`)
      if (body.version !== current.version) throw new StaleVersionError('StyleText', current.id, current.version, body.version)
      const { count } = await tx.styleText.updateMany({ where: { id: current.id, version: current.version }, data: { ...text, version: current.version + 1, updatedAt: now } })
      if (count !== 1) throw new StaleVersionError('StyleText', current.id, current.version + 1, body.version)
      rowId = current.id
    } else {
      if (body.version !== undefined) throw new ConflictError(`The ${language} text of style ${style.code} was removed meanwhile: load the style again.`)
      rowId = newId()
      await tx.styleText.create({ data: { id: rowId, styleId, language, ...text, createdAt: now, updatedAt: now, createdById: actor.audience === 'office' ? actor.actorId : null }, select: { id: true } })
    }
    tools.audit({
      action: 'product.styles.putText',
      recordType: 'StyleText',
      recordId: rowId,
      companyId: style.companyId,
      before: before ? { styleId, language, ...before } : null,
      after: { styleId, language, ...text },
      ...(body.reason ? { reason: body.reason } : {}),
    })
    tools.emit({ type: 'style.texts_changed', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, language, change: 'SET' } })
    return textsViewOf(tx, styleId, language)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError(`Another ${language} text of this style was written at the same time: load the style again.`)
    throw error
  })
  return result
}

/** POST /product/styles/:styleId/texts/:language/remove */
export async function removeText(caller: CommandCaller, styleId: string, rawLanguage: string, body: RemoveTextBody, idempotencyKey?: string): Promise<TextsView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  const language = languageOf(rawLanguage)
  const { result } = await command(caller, { name: 'product.styles.removeText', idempotencyKey, input: { styleId, language, ...body } }, async (tools) => {
    const { tx } = tools
    const style = await lockForText(tx, styleId)
    const current = await tx.styleText.findFirst({ where: { styleId, language }, select: TEXT_COLUMNS })
    if (!current) throw new NotFoundError(`Style ${style.code} has no ${language} text.`)
    if (current.version !== body.version) throw new StaleVersionError('StyleText', current.id, current.version, body.version)
    await tx.styleText.delete({ where: { id: current.id }, select: { id: true } })
    tools.audit({
      action: 'product.styles.removeText',
      recordType: 'StyleText',
      recordId: current.id,
      companyId: style.companyId,
      before: { styleId, language, name: current.name, shortDescription: current.shortDescription, longDescription: current.longDescription },
      after: null,
      ...(body.reason ? { reason: body.reason } : {}),
    })
    tools.emit({ type: 'style.texts_changed', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, language, change: 'REMOVED' } })
    return textsViewOf(tx, styleId, language)
  })
  return result
}
