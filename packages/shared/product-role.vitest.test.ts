import { describe, expect, it } from 'vitest'
import { productRoleOf } from './master-sheet.js'

describe('product role', () => {
  it.each([
    [{ parentId: null, isParent: false }, 'standalone'],
    [{ parentId: null, isParent: true }, 'parent'],
    [{ parentId: null, isParent: false, childCount: 2 }, 'parent'],
    [{ parentId: 'root', isParent: false }, 'child'],
    [{ parentId: 'root', isParent: true, childCount: 0 }, 'child'],
  ] as const)('resolves %j to %s', (product, role) => expect(productRoleOf(product)).toBe(role))
})
