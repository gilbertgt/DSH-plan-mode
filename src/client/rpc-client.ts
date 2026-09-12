export type PlanRpc = (method: string, body?: unknown, signal?: AbortSignal) => Promise<any>

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Call the Host-owned exact `/api/plan-orchestrator/*` routes. DSH's web
 * carrier authenticates these requests with the browser session cookie before
 * dispatch, so this intentionally uses same-origin Fetch rather than the
 * logical `ctx.connection.rpc` surface (which only exposes call/open in rc.1).
 */
export function createRpc(fetcher: FetchLike = globalThis.fetch.bind(globalThis)): PlanRpc {
  return async (method: string, body: unknown = {}, signal?: AbortSignal) => {
    const response = await fetcher(`/api/plan-orchestrator/${encodeURIComponent(method)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    let value: any
    try { value = await response.json() }
    catch { throw new Error(`Plan Mode RPC returned invalid JSON (${response.status})`) }
    if (!response.ok || !value?.ok) {
      throw new Error(value?.error?.message ?? `Plan Mode RPC failed (${response.status})`)
    }
    return value.data
  }
}
