/**
 * Owner item 7 — a tool's secret arguments (AgentTool.secretArgs: a creator's partnership ad code, an authenticator code)
 * are never kept in plain text by Nexus.
 *
 *   seal   where a request is STORED (approval-gate.service.ts runOrQueueTool, change-plan.service.ts queuePlan, the
 *          Approvals edit): each secret argument's value becomes `{ __enc: <blob> }`, the blob from lib/crypto
 *          encryptCredentials (KMS envelope; the env key when KMS is not set up) of `{ value, tool, key, workspaceId }`:
 *          the value bound to its tool, its argument and the business of the request. Idempotent: a sealed value stays as
 *          it is (every seal point first dry-runs the call through the door, which opened it and checked its binding).
 *          No secret in the call → the same object back, and no key is needed. No key → refused (503), never stored.
 *   open   in the one door (call-tool.ts callTool / executeTool), right before the tool's schema and its handler or
 *          execute read the arguments: every dry run, re-check and run gets the plain value back, and nothing else does.
 *          Only for the tool, the argument and the business it was sealed for: a value copied from another request (of
 *          another business, tool or argument), or one that does not decrypt, is refused (409) and nothing runs.
 *   mask   what a record or a view keeps of a call's arguments (a run's input and steps, the Approvals lists and edit form,
 *          an audit row, a fleet exemplar, a change's planned undo): each secret argument, sealed or not, as SECRET_MASK; a
 *          change plan's steps each by their own tool.
 *
 * Code that reads STORED arguments outside the door (labels, strategy, consequencesFor …) sees a sealed value: none of
 * it may depend on a secret argument's value.
 *
 * A change of the local env key (NEXUS_CREDENTIAL_ENC_KEY, when KMS is not set up) leaves the requests in flight unopenable:
 * they answer "could not be decrypted" and wait or expire (cx-credentials-rotate never re-encrypts approval rows).
 */
import { decryptCredentials, encryptCredentials } from '../../lib/crypto.js'
import { LEGACY_WORKSPACE_ID, workspaceContext } from '../../lib/workspace-context.js'
import { ToolAccessError, type ToolPrincipal } from './call-tool.js'
import { getTool } from './tool-registry.js'
import { PLAN_TOOL, type AgentTool } from './tool-types.js'

export const SECRET_MASK = '[redacted]'
const ENC = '__enc'

type Sealed = { [ENC]: string }
type SecretTool = Pick<AgentTool, 'name' | 'secretArgs'>

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function isSealed(value: unknown): value is Sealed {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value[ENC] === 'string'
}

/**
 * The business a call runs in, which a sealed value is bound to: the person's verified business, else the one this work
 * is bound to (a request, a sweep, a worker job), else the original business while business profiles are off.
 */
export function callBusinessId(principal?: ToolPrincipal | null): string | null {
  if (principal?.kind === 'user' && principal.workspace) return principal.workspace.workspaceId
  const bound = workspaceContext()
  if (bound) return bound.workspaceId
  return process.env.NEXUS_WORKSPACES_ENABLED === '1' ? null : LEGACY_WORKSPACE_ID
}

/** Before a request is stored: each secret argument's value sealed, bound to the tool, the argument and the business. */
export async function sealSecretArgs(
  tool: SecretTool | undefined,
  args: Record<string, unknown>,
  workspaceId: string | null,
): Promise<Record<string, unknown>> {
  const keys = (tool?.secretArgs ?? []).filter((key) => args[key] != null && !isSealed(args[key]))
  if (!tool || !keys.length) return args
  const out = { ...args }
  for (const key of keys) {
    try {
      out[key] = { [ENC]: (await encryptCredentials({ value: args[key], tool: tool.name, key, workspaceId })).blob }
    } catch {
      // Fail closed, never stored in plain text; the message names no value.
      throw new ToolAccessError(
        'secret_unavailable',
        `${tool.name}: Nexus could not encrypt its secret argument ${key} (no encryption key is set up), so the request was not stored.`,
        503,
      )
    }
  }
  return out
}

/**
 * In the door, right before the tool reads them: each sealed secret argument opened, only in a call of the tool, for the
 * argument and in the business it was sealed for. A plain value (a request stored before item 7) passes as it is.
 */
export async function openSecretArgs(
  tool: SecretTool,
  args: Record<string, unknown>,
  workspaceId: string | null,
): Promise<Record<string, unknown>> {
  const keys = (tool.secretArgs ?? []).filter((key) => isSealed(args[key]))
  if (!keys.length) return args
  const out = { ...args }
  for (const key of keys) {
    let sealed: Record<string, unknown>
    try {
      sealed = await decryptCredentials((args[key] as Sealed)[ENC])
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      throw new ToolAccessError(
        'secret_refused',
        `${tool.name}: its secret argument ${key} could not be decrypted${typeof code === 'string' ? ` (${code})` : ''}. Nothing was run.`,
        409,
      )
    }
    if (sealed.tool !== tool.name || sealed.key !== key || sealed.workspaceId !== workspaceId || !('value' in sealed)) {
      // The words name no value and no other business.
      throw new ToolAccessError(
        'secret_refused',
        `${tool.name}: its secret argument ${key} does not belong to this request (it was sealed for another tool, argument or business profile). Nothing was run.`,
        409,
      )
    }
    out[key] = sealed.value
  }
  return out
}

/** What a record or a view keeps of a call's arguments (the tool, or its name). The same object when nothing is secret. */
export function maskSecretArgs(which: string | SecretTool, args: unknown): unknown {
  if (!isRecord(args)) return args
  const tool = typeof which === 'string' ? getTool(which) : which
  let out = args
  for (const key of tool?.secretArgs ?? []) {
    if (args[key] !== undefined) out = { ...out, [key]: SECRET_MASK }
  }
  if ((typeof which === 'string' ? which : which.name) === PLAN_TOOL && Array.isArray(args.steps)) {
    let masked = false
    const steps = args.steps.map((step: unknown) => {
      if (!isRecord(step) || typeof step.tool !== 'string') return step
      const stepArgs = maskSecretArgs(step.tool, step.args)
      if (stepArgs === step.args) return step
      masked = true
      return { ...step, args: stepArgs }
    })
    if (masked) out = { ...out, steps }
  }
  return out
}

/**
 * A run's legacy steps (the in-app assistant's, tool-loop.service.ts: `{ type: 'tool', name, args, … }`) as a view shows
 * them: each tool step's secret arguments as the mask. Steps are masked when written; this covers the runs written before.
 */
export function maskRunSteps(steps: unknown): unknown {
  if (!Array.isArray(steps)) return steps
  return steps.map((step: unknown) => {
    if (!isRecord(step) || typeof step.name !== 'string' || !('args' in step)) return step
    const args = maskSecretArgs(step.name, step.args)
    return args === step.args ? step : { ...step, args }
  })
}
