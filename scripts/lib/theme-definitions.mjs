import postcss from 'postcss'

/** Read theme declarations by selector, including generated selector lists. */
export function themeDefinitions(css) {
  const light = new Map()
  const dark = new Map()
  postcss.parse(css).walkRules(rule => {
    const targets = []
    if (rule.selectors.includes(':root')) targets.push(light)
    if (rule.selectors.includes('.dark')) targets.push(dark)
    if (!targets.length) return
    for (const node of rule.nodes) {
      if (node.type !== 'decl' || !node.prop.startsWith('--nds-')) continue
      for (const target of targets) target.set(node.prop, node.value.trim())
    }
  })
  return { light, dark }
}
