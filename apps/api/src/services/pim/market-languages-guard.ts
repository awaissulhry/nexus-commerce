import ts from 'typescript'

/** Owner's Step 2 exemption: the live Amazon flat-file/import services and batch
 * feed service are untouchable. Their existing language maps deliberately stay. */
export const MARKET_LANGUAGE_EXEMPTIONS = [
  /^services\/amazon\/flat-file[^/]*\.ts$/,
  /^services\/channel-batch\/amazon-batch-feed\.service\.ts$/,
] as const

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
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && /^[a-z]{2,3}_[A-Z]{2}$/.test(node.text) && path !== 'services/pim/market-languages.ts') report(node, 'literal regional language tag; use languageTag(language, code)')
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
