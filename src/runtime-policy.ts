let timeoutResolver: (cwd?: string) => number = () => 900_000

export function configureRoleTimeoutResolver(resolver: (cwd?: string) => number): () => void {
  const previous = timeoutResolver
  timeoutResolver = resolver
  return () => { if (timeoutResolver === resolver) timeoutResolver = previous }
}

export function roleTimeoutMs(cwd?: string): number {
  const value = timeoutResolver(cwd)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) throw new Error('invalid Plan Orchestrator role timeout')
  return value
}

export function withRoleTimeout(cwd: string | undefined, signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(roleTimeoutMs(cwd))])
}
