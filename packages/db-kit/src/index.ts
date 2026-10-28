// @nexus/db-kit: generic database tools for the factory packages (no factory names in here; roles and setting names
// are parameters). The fail-closed tenant adapter, the runtime-role audit and the policy generator come in their own
// step. Today it holds the loopback URL guard that the factory env loaders use.
export { describeUrlHost, isLoopbackHost, isLoopbackUrl } from './url-guard'
