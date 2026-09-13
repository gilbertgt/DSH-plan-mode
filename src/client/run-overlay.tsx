import React, { useEffect, useRef, useState } from 'react'
import { phaseLabel } from './role-route-ui.ts'

export class RunOverlayService {
  #runId: string | undefined
  #listeners = new Set<() => void>()
  #returnFocus: HTMLElement | null = null
  get runId() { return this.#runId }
  open(runId: string) {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      this.#returnFocus = document.activeElement
    }
    this.#runId = runId
    this.#emit()
  }
  close() {
    if (this.#runId === undefined) return
    this.#runId = undefined
    this.#emit()
    const target = this.#returnFocus
    this.#returnFocus = null
    if (target?.isConnected) queueMicrotask(() => target.focus())
  }
  subscribe(listener: () => void) { this.#listeners.add(listener); return () => this.#listeners.delete(listener) }
  #emit() { for (const listener of this.#listeners) listener() }
}

const TERMINAL_PHASES = ['COMPLETE', 'FAILED', 'BLOCKED', 'CANCELLED']

export function RunOverlay({ service, rpc, t }: any) {
  const [runId, setRunId] = useState<string | undefined>(service.runId)
  const [run, setRun] = useState<any>()
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement | null>(null)
  const titleId = 'planx-run-dialog-title'

  useEffect(() => service.subscribe(() => setRunId(service.runId)), [service])
  useEffect(() => {
    if (!runId) { setRun(undefined); return }
    let live = true
    const load = async () => {
      try { const value = await rpc('run-detail', { runId }); if (live) { setRun(value); setError('') } }
      catch (e: any) { if (live) setError(e.message) }
    }
    void load()
    const timer = setInterval(load, 2_500)
    return () => { live = false; clearInterval(timer) }
  }, [runId, rpc])
  useEffect(() => {
    if (!runId) return
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); service.close() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [runId, service])

  if (!runId) return null
  const terminal = TERMINAL_PHASES.includes(run?.phase)
  return <div className="planx-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) service.close() }}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="planx-dialog" tabIndex={-1}>
      <div className="planx-row planx-between"><b id={titleId}>{t('run.title')} {runId}</b><button aria-label={t('run.close')} onClick={() => service.close()}>×</button></div>
      {error && <div role="alert" className="planx-error">{error}</div>}
      {!run ? <p>{t('loading')}</p> : <>
        <p><b>{phaseLabel(t, run.phase)}</b>{run.message ? ` · ${run.message}` : ''}</p>
        <progress aria-label={t('run.progressAria')} max={Math.max(1, run.tasksTotal ?? 1)} value={run.tasksDone ?? 0}/>
        <p>{t('run.tasks', { done: run.tasksDone ?? 0, total: run.tasksTotal ?? 0, round: run.reviewRound ?? 0 })}</p>
        {run.activeTaskIds?.length > 0 && <p>{t('run.active')} {run.activeTaskIds.join(', ')}</p>}
        {run.review && <div className="planx-card"><b>{t('run.review')}</b><pre>{JSON.stringify(run.review, null, 2)}</pre></div>}
        {Array.isArray(run.receipts) && <div className="planx-card"><b>{t('run.receipts')}</b><pre>{JSON.stringify(run.receipts, null, 2)}</pre></div>}
        {run.usage && <div className="planx-card"><b>{t('run.usage')}</b><pre>{JSON.stringify(run.usage, null, 2)}</pre></div>}
        {Array.isArray(run.worktrees) && run.worktrees.length > 0 && <div className="planx-card"><b>{t('run.worktrees')}</b><pre>{JSON.stringify(run.worktrees.map((w:any)=>({taskId:w.taskId,status:w.status,baseHead:w.baseHead})), null, 2)}</pre></div>}
        <div className="planx-row">
          {!terminal && <button onClick={() => rpc('run-cancel', { runId }).then(() => setRun((r:any)=>({...r,phase:'CANCELLED'}))).catch((e:any)=>setError(e.message))}>{t('stop')}</button>}
          {run.phase === 'INTERRUPTED' && <button onClick={async () => { try { const result = await rpc('run-resume', { runId }); if (!result?.ok) setError(result?.reason ?? t('run.resumeBlocked')) } catch (e:any) { setError(e.message) } }}>{t('resume')}</button>}
          {terminal && <button onClick={async () => { if (confirm(t('run.cleanupConfirm'))) { try { await rpc('run-cleanup', { runId }); service.close() } catch (e:any) { setError(e.message) } } }}>{t('run.cleanup')}</button>}
        </div>
      </>}
    </section>
  </div>
}
