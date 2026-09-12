import React, { useEffect, useState } from 'react'

export function RunChip({ rpc, sessionId, overlay }: any) {
  const [run, setRun] = useState<any>()
  useEffect(() => {
    let live = true
    const load = () => rpc('run-list', { sessionId }).then((rows: any[]) => { if (live) setRun(rows[0]) }).catch(() => {})
    void load()
    const timer = setInterval(load, 2_500)
    return () => { live = false; clearInterval(timer) }
  }, [rpc, sessionId])
  if (!run) return null
  return <button className="planx-chip" aria-label={`Plan Run ${run.phase}`} onClick={() => overlay.open(run.runId)}>
    Plan Run · {run.tasksDone ?? 0}/{run.tasksTotal ?? 0} · {run.phase}
  </button>
}
