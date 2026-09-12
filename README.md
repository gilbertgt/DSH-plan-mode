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

## Compatibility

Production baseline: DSH `0.1.5-rc.1`. `0.1.5-rc.2` remains a preview lane until the complete compatibility suite passes.

## Install

```powershell
dsh.cmd plugin --profile web add @gilbertgt/dsh-plan-orchestrator
```

Development:

```powershell
dsh.cmd plugin --profile plan-dev add C:\path\to\DSH-plan-mode
```

Settings appear as a first-class **Plan Mode** section. Normal sessions keep the large Planner policy out of model context; the policy is injected only while native Plan Mode is active.
