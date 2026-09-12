import { RPC_METHODS, assertRpcBody, boundedId } from './contract/rpc.ts'
import { modelCatalog, routeValidate } from './model-catalog.ts'

const MAX_RESPONSE = 2 * 1024 * 1024

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new Error('application/json required')
  }
  return assertRpcBody(await request.json())
}

function safeError(error: unknown): string {
  const raw = String((error as Error)?.message ?? error)
  return raw.replace(/[A-Za-z]:\\[^\s]+|\/(?:[^\s/]+\/){2,}[^\s]*/g, '<redacted-path>').slice(0, 1000)
}

function response(value: unknown, status = 200): Response {
  let json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > MAX_RESPONSE) {
    json = JSON.stringify({ ok: false, error: { code: 'PLAN_ORCHESTRATOR_RESPONSE_TOO_LARGE', message: 'response exceeds bounded API payload' } })
    status = 413
  }
  return new Response(json, { status, headers: { 'content-type': 'application/json' } })
}

export function registerRpc(connection: any, deps: any) {
  const disposers: Array<() => void> = []
  for (const method of RPC_METHODS) {
    disposers.push(connection.fetch.register({
      path: `/api/plan-orchestrator/${method}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request: Request) {
        try {
          const input = await body(request)
          let data: unknown
          switch (method) {
            case 'model-catalog': data = await modelCatalog(deps.ctx); break
            case 'route-validate': data = await routeValidate(deps.ctx, input.route as any); break
            case 'run-list': data = deps.runList?.({ sessionId: typeof input.sessionId === 'string' ? boundedId(input.sessionId, 'sessionId') : undefined }) ?? []; break
            case 'run-detail': data = await deps.runDetail?.({ runId: boundedId(input.runId, 'runId') }); break
            case 'run-cancel': data = await deps.runCancel?.({ runId: boundedId(input.runId, 'runId') }); break
            case 'run-resume':
              if (deps.isEnabled && !deps.isEnabled()) throw new Error('Plan Orchestrator is disabled in Settings → Plan Mode.')
              if (deps.canResume && !deps.canResume()) throw new Error('Safe Resume is disabled in Settings → Plan Mode.')
              data = await deps.runResume?.({ runId: boundedId(input.runId, 'runId') })
              break
            case 'run-cleanup': data = await deps.runCleanup?.({ runId: boundedId(input.runId, 'runId') }); break
            case 'diagnostics': data = await deps.diagnostics?.(input); break
            case 'external-preflight': data = await deps.externalPreflight?.(input); break
          }
          return response({ ok: true, data })
        } catch (error) {
          return response({ ok: false, error: { code: 'PLAN_ORCHESTRATOR_RPC', message: safeError(error) } }, 400)
        }
      },
    }))
  }
  return () => disposers.forEach(dispose => dispose?.())
}
