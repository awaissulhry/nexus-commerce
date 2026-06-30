import { describe, it, expect } from 'vitest'
import { decorateBrowseNodeColumn } from './flat-file.service.js'

describe('decorateBrowseNodeColumn', () => {
  const nodes = [
    { id: '2420941031', path: '… > Giacche' },
    { id: '2420943031', path: '… > Pantaloni' },
  ]
  it('turns a browse-node column into an enum with id→path labels', () => {
    const col = {
      id: 'recommended_browse_nodes_1',
      fieldRef: 'recommended_browse_nodes[marketplace_id=APJ6JRA9NG5V4]#1.value',
      kind: 'text' as const,
      options: undefined,
      optionLabels: undefined,
    }
    const out = decorateBrowseNodeColumn(col as any, nodes)
    expect(out.kind).toBe('enum')
    expect(out.selectionOnly).toBe(false)
    expect(out.options).toEqual(['2420941031', '2420943031'])
    expect(out.optionLabels).toEqual({ '2420941031': '… > Giacche', '2420943031': '… > Pantaloni' })
  })
  it('leaves non-browse-node columns untouched', () => {
    const col = { id: 'color', fieldRef: 'color#1.value', kind: 'text' as const }
    expect(decorateBrowseNodeColumn(col as any, nodes)).toBe(col)
  })
})
