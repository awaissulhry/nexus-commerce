import ts from 'typescript'

/**
 * Owner's Step 2 exemption, narrowed to the files that actually carry a map.
 *
 * LX.F P2-10: the glob `flat-file[^/]*\.ts` matched **13** files, of which only
 * `flat-file.service.ts` (18 regional-tag literals) and
 * `channel-batch/amazon-batch-feed.service.ts` (6) carry anything to exempt. The
 * other 11 had NOTHING to exempt and were silently unguarded forever — breadth
 * read as necessity. Exact paths now, so a new map in `flat-file-merge.ts` is
 * caught like any other file. The two named files stay exempt because the Owner's
 * rule makes the live flat-file editors untouchable, not because they are right.
 */
export const MARKET_LANGUAGE_EXEMPTIONS = [
  /^services\/amazon\/flat-file\.service\.ts$/,
  /^services\/channel-batch\/amazon-batch-feed\.service\.ts$/,
] as const

/**
 * Does this file participate in the language axis at all?
 *
 * DERIVED from its own imports rather than from a path list (a path list is a set
 * claim that rots): a module that imports the authority, the normaliser or the
 * content resolver knows the rule exists, so a hardcoded language inside it is a
 * defect. A customer-communication module that hardcodes `?? 'it'` for an email
 * template is a different axis and is not this guard's business — measured: the
 * fallback rule fired on 11 such files (email, PDF, AI alt-text, insights,
 * review/return comms) before this predicate.
 */
const CONTENT_LANGUAGE_MODULES = /(market-languages|content-language|content-locale|content-resolver|content-read|@nexus\/shared\/content-language)/
const participatesInTheAxis = (text: string) => text.split('\n').some(line => /^\s*(import|export)\b.*from\s+['"][^'"]+['"]/.test(line) && CONTENT_LANGUAGE_MODULES.test(line))

export function marketLanguageViolations(path: string, text: string): string[] {
  if (MARKET_LANGUAGE_EXEMPTIONS.some(pattern => pattern.test(path)) || /(?:\.test\.tsx?$|\/__tests__\/)/.test(path)) return []
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const violations: string[] = []
  const report = (node: ts.Node, reason: string) => violations.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${reason}`)
  const initializers = new Map<string, ts.Expression>()
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) initializers.set(node.name.text, node.initializer)
    ts.forEachChild(node, collect)
  }
  collect(file)
  const properties = (node: ts.Node, names = new Set<string>(), seen = new Set<ts.Node>()) => {
    if (seen.has(node)) return names
    seen.add(node)
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) names.add(node.name.getText(file).replace(/['"]/g, ''))
    if (ts.isIdentifier(node) && initializers.has(node.text)) properties(initializers.get(node.text)!, names, seen)
    ts.forEachChild(node, child => { properties(child, names, seen) })
    return names
  }
  // LX.F P2-9 — three shapes Appendix A deletes that the guard could not see.
  //
  // The twelve definitions it was written for are market→language maps written
  // with TWO-LETTER codes (`{ DE: 'de', BE: 'fr' }`), none of which matches a
  // regional-tag literal or a channel-less lookup; nor did `?? 'it'`; nor the
  // dash form, which `normalizeLanguage` accepts everywhere
  // (`content-language.ts:28` splits on `[-_]`), so `'de-DE'` was a usable
  // literal that passed. The dash rule is deliberately NARROW: 59 files carry
  // `'en-US'`-shaped literals and almost all are `Intl.DateTimeFormat` display
  // locales, which are not content languages — so a dash tag is reported only
  // where it is USED as a language (a language/locale-named target or a value in
  // a market map), never on its own.
  const LANGUAGE_TARGET = /^(language|languages|locale|locales|lang|languageTag|contentLanguage|sourceLanguage|defaultLocale)$/i
  const MARKET_CODE = /^[A-Z]{2}$/
  const LANGUAGE_TAG = /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/
  // DERIVED, not a hardcoded list of languages: ICU knows a language code when it
  // can name it. `de` → "German" (a language), `eur` → "eur" (a currency map's
  // value, not a language), `zz` → "zz". Without this, `{ DE:'eur', UK:'gbp' }`
  // read as a market→language map.
  const names = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' })
  const isLanguageCode = (value: string) => {
    const language = value.toLowerCase().split(/[-_]/, 1)[0]
    if (!/^[a-z]{2,3}$/.test(language)) return false
    try { return (names.of(language) ?? language).toLowerCase() !== language } catch { return false }
  }
  const marketLanguageMap = (node: ts.ObjectLiteralExpression) => {
    const entries = node.properties.filter(ts.isPropertyAssignment)
    if (entries.length < 2 || entries.length !== node.properties.length) return false
    const keys = entries.map(entry => entry.name.getText(file).replace(/['"]/g, ''))
    if (!keys.every(key => MARKET_CODE.test(key))) return false
    return entries.every(entry => ts.isStringLiteralLike(entry.initializer) && LANGUAGE_TAG.test(entry.initializer.text) && isLanguageCode(entry.initializer.text))
  }
  /**
   * R-LX-29 — the OTHER DIRECTION, which this guard could not see for the whole programme.
   *
   * Every rule above reads market → language. `TranslationsLens.tsx` held the inverse —
   * `MARKETPLACE_FOR_LOCALE`, a map from a locale to the marketplace it "belongs to" — and the guard
   * reported **1 violation before and after that map was deleted**, i.e. it was blind to the shape in
   * both states. A language does not name a market: `it` is sold on IT and on CH, `nl` on NL and BE,
   * `en` on UK, US, IE, AU, SG and IN, and which market a language reaches is a property of
   * `Marketplace`, not of the language code. A literal in this direction is the same defect written
   * backwards, and it is worse in one respect: it reads as harmless (`{ de: 'DE' }` looks like an
   * identity), so nobody deletes it.
   *
   * Both rules below are deliberately narrow, and the case discriminates them from the rules above
   * with no ambiguity: a market→language map has UPPERCASE keys (`{ DE: 'de' }`), a language→market
   * map has lowercase keys and uppercase values (`{ de: 'DE' }`), so no object can match both.
   */
  const languageMarketMap = (node: ts.ObjectLiteralExpression) => {
    const entries = node.properties.filter(ts.isPropertyAssignment)
    if (entries.length < 2 || entries.length !== node.properties.length) return false
    const keys = entries.map(entry => entry.name.getText(file).replace(/['"]/g, ''))
    if (!keys.every(key => LANGUAGE_TAG.test(key) && isLanguageCode(key))) return false
    return entries.every(entry => ts.isStringLiteralLike(entry.initializer) && MARKET_CODE.test(entry.initializer.text))
  }
  /**
   * The same mapping written as control flow: `switch (language) { case 'it': return 'IT' }`.
   *
   * One pair is enough when the subject is language-named (`language`, `locale`, `lang`, …) — that
   * names the direction out loud. Otherwise two pairs are required, because a single
   * `case '<two letters>': return '<TWO LETTERS>'` inside a switch on something else is as likely to
   * be a country, a currency region or a unit as a market, and a guard that fires there teaches lanes
   * to ignore it. A `case` that returns an ENUM MEMBER rather than a string literal
   * (`return Marketplace.IT`) is NOT seen: this rule is about literals, which is what R-LX-29 names.
   */
  const languageSwitchYieldsMarket = (node: ts.SwitchStatement) => {
    const subject = node.expression.getText(file).split(/[.?[\]()]/).filter(Boolean).pop() ?? ''
    const marketLiterals = (start: ts.Node) => {
      let found = 0
      const walk = (child: ts.Node) => {
        if (ts.isStringLiteralLike(child) && MARKET_CODE.test(child.text)) found += 1
        ts.forEachChild(child, walk)
      }
      walk(start)
      return found
    }
    let pairs = 0
    for (const clause of node.caseBlock.clauses) {
      if (!ts.isCaseClause(clause) || !ts.isStringLiteralLike(clause.expression)) continue
      const key = clause.expression.text
      if (!LANGUAGE_TAG.test(key) || !isLanguageCode(key)) continue
      if (clause.statements.some(statement => marketLiterals(statement) > 0)) pairs += 1
    }
    return pairs >= 2 || (pairs === 1 && LANGUAGE_TARGET.test(subject))
  }
  /** The authority and this guard are the two files allowed to write either direction down. */
  const authority = /^(?:services\/pim\/market-languages(?:-guard)?\.ts)$/.test(path)
  const namedTarget = (node: ts.Node): string | null => {
    const parent = node.parent
    if (!parent) return null
    if (ts.isPropertyAssignment(parent)) return parent.name.getText(file).replace(/['"]/g, '')
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    if (ts.isBinaryExpression(parent) && (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const left = parent.left.getText(file)
      return LANGUAGE_TARGET.test(left.split(/[.?[\]]/).filter(Boolean).pop() ?? '') ? 'language' : namedTarget(parent)
    }
    return null
  }
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && /^[a-z]{2,3}_[A-Z]{2}$/.test(node.text) && path !== 'services/pim/market-languages.ts') report(node, 'literal regional language tag; use languageTag(language, code)')
    if (ts.isObjectLiteralExpression(node) && marketLanguageMap(node) && path !== 'services/pim/market-languages-guard.ts') report(node, 'market to language map; the only authority is Marketplace.languages')
    // R-LX-29 — the reverse direction, reasoned above.
    if (ts.isObjectLiteralExpression(node) && !authority && languageMarketMap(node)) report(node, 'language to market map; a language does not name a market — read the coordinate, never derive it from a language code')
    if (ts.isSwitchStatement(node) && !authority && languageSwitchYieldsMarket(node)) report(node, 'switch on a language that yields a market; a language does not name a market — read the coordinate, never derive it from a language code')
    if (ts.isStringLiteralLike(node) && /^[a-z]{2,3}[-_][A-Za-z0-9]{2,8}$/.test(node.text) && !/^(services\/pim\/(market-languages|content-language)\.ts|.*guard\.ts)$/.test(path)) {
      const target = namedTarget(node)
      if (target && LANGUAGE_TARGET.test(target)) report(node, 'regional tag used as a content language; normalizeLanguage() keeps one language-only spelling')
    }
    if (ts.isStringLiteralLike(node) && /^[a-z]{2,3}$/.test(node.text) && ts.isBinaryExpression(node.parent)
      && (node.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      && node.parent.right === node && !/^services\/pim\/(content-locale|market-languages|content-language)\.ts$/.test(path)) {
      const left = node.parent.left.getText(file).split(/[.?[\]()]/).filter(Boolean).pop() ?? ''
      if (LANGUAGE_TARGET.test(left) && isLanguageCode(node.text) && participatesInTheAxis(text)) report(node, 'hardcoded language fallback; read the language from Marketplace.languages or PRIMARY_CONTENT_LOCALE')
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText(file)
      if (/(?:^|\.)marketplace$/.test(receiver) && /^(find|update|delete|upsert)/.test(node.expression.name.text)) {
        const argument = node.arguments[0]
        const args = argument && ts.isIdentifier(argument) ? initializers.get(argument.text) : argument
        if (args && ts.isObjectLiteralExpression(args)) {
          const where = args.properties.find(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(file) === 'where')
          if (where) { const keys = properties(where); if (keys.has('code') && !keys.has('channel')) report(node, 'Marketplace lookup by code without channel') }
        }
      }
      if (/marketplace/i.test(receiver) && node.expression.name.text === 'find') {
        const callback = node.arguments[0]?.getText(file) ?? ''
        if (/\.code\b/.test(callback) && !/\.channel\b/.test(callback)) report(node, 'Marketplace array lookup by code without channel')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return violations
}
