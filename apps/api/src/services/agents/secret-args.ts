/**
 * Owner item 7 — a tool's secret arguments (AgentTool.secretArgs: a creator's partnership ad code, an authenticator code)
 * are never kept in plain text by Nexus.
 *
 *   seal   where a request is STORED (approval-gate.service.ts runOrQueueTool, change-plan.service.ts queuePlan, the
 *          Approvals edit): each secret argument's value becomes `{ __enc: <blob> }`, the blob from lib/crypto
 *          encryptCredentials (KMS envelope; the env key when KMS is not set up). Idempotent: a sealed value stays as it is.
 *          No secret in the call → the same object back, and no key is needed.
 *   open   in the one door (call-tool.ts callTool / executeTool), right before the tool's schema and its handler or
 *          execute read the arguments: every dry run, re-check and run gets the plain value back, and nothing else does.
 *   mask   what a record or a view keeps of a call's arguments (a run's input and steps, the Approvals lists and edit form,
 *          an audit row, a fleet exemplar, a change's planned undo): each secret argument, sealed or not, as SECRET_MASK; a
 *          change plan's steps each by their own tool.
 *
 * Code that reads STORED arguments outside the door (labels, strategy, consequencesFor …) sees a sealed value: none of
 * it may depend on a secret argument's value.
 */
import { decryptCredentials, encryptCredentials } from '../../lib/crypto.js'
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

/** Before a request is stored: each secret argument's value sealed. */
export async function sealSecretArgs(tool: SecretTool | undefined, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keys = (tool?.secretArgs ?? []).filter((key) => args[key] != null && !isSealed(args[key]))
  if (!keys.length) return args
  const out = { ...args }
  for (const key of keys) {
    try {
      out[key] = { [ENC]: (await encryptCredentials({ value: args[key] })).blob }
    } catch {
      // Fail closed, never stored in plain text; the message names no value.
      throw new Error(`${tool!.name}: Nexus could not encrypt its secret argument ${key} (no encryption key is set up), so the request was not stored.`)
    }
  }
  return out
}

/** In the door, right before the tool reads them: each sealed secret argument opened. A plain value passes as it is. */
export async function openSecretArgs(tool: SecretTool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keys = (tool.secretArgs ?? []).filter((key) => isSealed(args[key]))
  if (!keys.length) return args
  const out = { ...args }
  for (const key of keys) {
    try {
      out[key] = (await decryptCredentials((args[key] as Sealed)[ENC])).value
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      throw new Error(`${tool.name}: its secret argument ${key} could not be decrypted${typeof code === 'string' ? ` (${code})` : ''}. Nothing was run.`)
    }
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
