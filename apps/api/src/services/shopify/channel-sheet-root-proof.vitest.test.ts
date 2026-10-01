import { beforeEach, describe, expect, it } from 'vitest'
import { matchesRootCreationProof, recordRootCreationProof, ROOT_CREATION_PROOF_TTL_MS, type RootProofScope } from './channel-sheet-root-proof.js'

const now = new Date('2026-09-30T12:00:00.000Z')
const root = { id: 'root-created-by-action-a', createdAt: new Date('2026-09-30T12:00:00.001Z') }
const scope: RootProofScope = { workspaceId: 'nexus_legacy_workspace', accountId: 'store-a', familyId: 'family-a',
  market: 'GLOBAL', aliasKey: '', actorUserId: 'actor-a', operationId: 'action-a' }
type Receipt = { workspaceId: string; scope: string; keyHash: string; requestHash: string; actorUserId: string | null;
  status: string; httpStatus: number | null; response: unknown; expiresAt: Date }
let receipts: Map<string, Receipt>
const tx = { commandReceipt: {
  create: async ({ data }: { data: Receipt }) => {
    if (receipts.has(data.keyHash)) throw Object.assign(new Error('Proof already exists'), { code: 'P2002' })
    const saved = structuredClone(data); receipts.set(data.keyHash, saved); return saved
  },
  findUnique: async ({ where }: { where: Record<string, { keyHash: string }> }) => {
    const found = receipts.get(Object.values(where)[0].keyHash)
    return found ? structuredClone(found) : null
  },
} }
beforeEach(() => { receipts = new Map() })
const mint = () => recordRootCreationProof(tx as never, scope, null, root, now)
const matches = (context = scope, owner = root, at = now) => matchesRootCreationProof(tx as never, context, owner, at)

describe('server-owned proof of an absent root created by one action', () => {
  it('mints only for an actual absent-to-present transition', async () => {
    expect(await recordRootCreationProof(tx as never, scope, root, root, now)).toBe(false)
    expect(receipts.size).toBe(0)
    expect(await mint()).toBe(true)
    expect(await matches()).toBe(true)
  })
  it.each(['workspaceId', 'accountId', 'familyId', 'market', 'aliasKey', 'actorUserId', 'operationId'] as const)('does not cross %s', async key => {
    await mint()
    expect(await matches({ ...scope, [key]: `${scope[key]}-other` })).toBe(false)
  })
  it('binds the physical ID and creation time even when other data is equal', async () => {
    await mint()
    expect(await matches(scope, { ...root, id: 'recreated-root' })).toBe(false)
    expect(await matches(scope, { ...root, createdAt: new Date(root.createdAt.getTime() + 1) })).toBe(false)
    expect(await matches()).toBe(true)
  })
  it('has a fixed expiry and refuses at and after the deadline', async () => {
    await mint()
    expect(await matches(scope, root, new Date(now.getTime() + ROOT_CREATION_PROOF_TTL_MS - 1))).toBe(true)
    expect(await matches(scope, root, new Date(now.getTime() + ROOT_CREATION_PROOF_TTL_MS))).toBe(false)
    expect(await matches(scope, root, new Date(now.getTime() + ROOT_CREATION_PROOF_TTL_MS + 1))).toBe(false)
    expect([...receipts.values()][0].expiresAt.getTime()).toBe(now.getTime() + ROOT_CREATION_PROOF_TTL_MS)
  })
  it('cannot retarget or renew an existing proof after deletion/recreation', async () => {
    await mint()
    const before = structuredClone([...receipts.values()][0])
    await expect(recordRootCreationProof(tx as never, scope, null, { ...root, id: 'new-root' }, new Date(now.getTime() + ROOT_CREATION_PROOF_TTL_MS + 1))).rejects.toThrow('Proof already exists')
    expect([...receipts.values()][0]).toEqual(before)
  })
  it('fails closed for missing, malformed, pending, copied-scope or altered records', async () => {
    expect(await matches()).toBe(false)
    await mint()
    const [key, saved] = [...receipts.entries()][0]
    for (const patch of [{ response: null }, { response: { version: 999 } }, { status: 'pending' }, { scope: 'public-command-scope' },
      { workspaceId: 'other-business' }, { actorUserId: 'other-actor' }, { requestHash: 'different-request' }]) {
      receipts.set(key, { ...saved, ...patch })
      expect(await matches(), JSON.stringify(patch)).toBe(false)
    }
    receipts.delete(key)
    expect(await matches()).toBe(false)
  })
})
