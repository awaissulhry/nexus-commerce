export const AMAZON_NOTIFICATIONS_PRINCIPAL = '437568002678'
const REQUIRED = ['sqs:SendMessage', 'sqs:GetQueueAttributes']
const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
  : Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []

/** Necessary static checks for Amazon's documented queue policy; never a substitute for portal registration/delivery proof. */
export function rotationQueuePolicyProblem(raw: string, queueArn: string | undefined): string | null {
  if (!queueArn || !/^arn:aws(?:-[a-z-]+)?:sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_.-]+$/.test(queueArn)) {
    return 'The credential queue did not identify a valid QueueArn; automatic rotation is held.'
  }
  let policy: Record<string, unknown>
  try { policy = JSON.parse(raw) } catch { return 'The credential queue policy is not valid JSON.' }
  const statements = Array.isArray(policy?.Statement) ? policy.Statement : policy?.Statement ? [policy.Statement] : []
  const permitted = new Set<string>()
  for (const value of statements) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'The credential queue policy contains an invalid statement.'
    const statement = value as Record<string, unknown>
    if ('NotPrincipal' in statement || 'NotAction' in statement || 'NotResource' in statement) {
      return 'The credential queue uses exclusions this preflight cannot prove. Keep its protections and obtain an AWS policy review before automatic rotation.'
    }
    if (statement.Effect === 'Deny' || statement.Condition !== undefined) {
      return 'This static preflight cannot prove a credential queue policy with denials or conditions. Keep its protections and obtain an AWS policy review before automatic rotation.'
    }
    const principal = statement.Principal as Record<string, unknown> | string | undefined
    const principals = strings(typeof principal === 'string' ? principal : principal?.AWS)
    if (!principals.some(id => [AMAZON_NOTIFICATIONS_PRINCIPAL, `arn:aws:iam::${AMAZON_NOTIFICATIONS_PRINCIPAL}:root`, '*'].includes(id))) continue
    const resources = strings(statement.Resource)
    if (!resources.includes(queueArn) && !resources.includes('*')) continue
    // An applicable denial or condition is not an Allow. Never guess the request
    // context or suggest removing protections merely to pass this static check.
    if (statement.Effect !== 'Allow') continue
    if (principals.includes('*') || !resources.includes(queueArn)) {
      return 'The credential queue needs an explicit Amazon principal and queue ARN for this preflight.'
    }
    const actions = strings(statement.Action).map(action => action.toLowerCase())
    for (const action of REQUIRED) {
      if (actions.includes(action.toLowerCase()) || actions.includes('sqs:*') || actions.includes('*')) permitted.add(action)
    }
  }
  return REQUIRED.every(action => permitted.has(action)) ? null
    : 'The preflight could not establish explicit grants for Amazon to send messages and read queue attributes on this queue.'
}
