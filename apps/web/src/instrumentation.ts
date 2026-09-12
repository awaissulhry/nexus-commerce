export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PUBLIC_WORKSPACES_ENABLED === '1') {
    const { installWebWorkspaceRuntime } = await import('./lib/workspaces/server')
    installWebWorkspaceRuntime()
  }
}
