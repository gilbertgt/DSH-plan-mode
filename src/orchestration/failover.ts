export function eligibleTransportFailure(error: unknown): boolean {
  const failure = error as any
  const s = `${failure?.code ?? ''} ${failure?.failure?.code ?? ''} ${failure?.message ?? failure ?? ''}`.toLowerCase()
  return /(timeout|rate.?limit|quota|transport|connection|network|unavailable|auth_failed|missing_credential|server|overload|503|502|504)/.test(s)
    && !/(cancel|abort|refusal|invalid.*schema|contract|policy|permission)/.test(s)
}

export async function withPreMutationFailover<T>(routes: unknown[], run: (route: any, index: number) => Promise<T>): Promise<T> {
  let last: unknown
  for (let index = 0; index < routes.length; index++) {
    try { return await run(routes[index], index) }
    catch (error) {
      last = error
      if (!eligibleTransportFailure(error) || index === routes.length - 1) throw error
    }
  }
  throw last
}

export function mayContinueAfterMutation(attempts: number): boolean { return attempts < 1 }
