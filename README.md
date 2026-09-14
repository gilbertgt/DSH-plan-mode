# DSH Plan Mode Orchestrator

`@gilbertgt/dsh-plan-orchestrator` augments DeepSeek Harness native Plan Mode. It does **not** replace `/plan`, `exit_plan_mode`, native Plan Review, settings, subagents, LSP, or token metering.

## Safety contract

- Plans are runtime-validated before native approval.
- Approval transitions into a host-owned deterministic orchestration run; the parent Planner is fenced from editing.
- Every mutating role is bounded by exact file ownership.
- Parallel workers use detached Git worktrees and separate DSH SDK runtimes.
- Validation evidence is host-produced and hashed; model self-reports are never treated as proof.
- Reviewer verdicts are strict and targeted fixes are bounded.
- Restart recovery is fail-closed and never runs destructive Git recovery.
- Ordinary Plan Mode never commits, pushes, or merges. External Issue Mode may publish a PR only after current validation + Reviewer PASS, and never auto-merges.

## Reporting

Every terminal outcome reaches the parent conversation exactly once, and only through `OrchestrationService.finalize`:

- `COMPLETE`, `BLOCKED` and `FAILED` use a **waking** delivery, so the parent conversation gains a turn and actually reads the outcome.
- `CANCELLED` uses a **non-waking** delivery, so a run the user stopped does not force a turn.
- The report is bounded, composed only from the approved plan, the run projection, `completion.json` and the validation receipt index fields. Validation `stdout`/`stderr` bodies never enter the conversation.
- A delivery failure never changes the recorded terminal phase, and a run is never reported twice.

The Plan Mode sidebar chip and overlay remain the detailed JSON surface, and a finished run clears its active tasks there.

Failures are durable: `failure.json` records the terminal message plus the cause chain, and the manifest indexes it, so a finished run stays diagnosable after the process is gone.

## Compatibility

Supported DSH releases: `0.1.5-rc.1` and `0.1.5-rc.2`. `npm run compat:check` verifies the runtime that actually resolved rather than the declared manifest: a graph mixing two DSH releases fails the check, because no single test result describes a hybrid runtime. An unsupported or mixed runtime is reported at mount and through the plugin's diagnostics.

## Install

```powershell
dsh.cmd plugin --profile web add @gilbertgt/dsh-plan-orchestrator
```

Development:

```powershell
dsh.cmd plugin --profile plan-dev add C:\path\to\DSH-plan-mode
```

## Verification

```powershell
npm test               # unit + integration
npm run typecheck
npm run build
npm run pack:check
npm run compat:check
npm run e2e:plan       # production pipeline: approval -> workers -> validation -> review -> report
npm run e2e:rc1        # packaged install / profile / web boot / uninstall smoke
```

`npm run e2e:plan` drives the shipping `OrchestrationService` and engine against a real Git repository: real ownership guards, real parallel worktree leases, real patch capture and compare-and-swap apply, real host validation executing a real package script, the real Reviewer protocol and the real terminal report. Only the model provider and DSH's in-process `spawn` backing are supplied through explicit, restorable seams, because CI can provide neither.

Settings appear as a first-class **Plan Mode** section. Normal sessions keep the large Planner policy out of model context; the policy is injected only while native Plan Mode is active.
