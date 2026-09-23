# Lucas-creative-studio
Full Lucas production studio

## Creative studio workflow

[`.claude/workflows/creative-studio.js`](.claude/workflows/creative-studio.js) implements the
studio's blueprint (see [`spec/creative_studio_agents.json`](spec/creative_studio_agents.json))
as a runnable [Claude Code Workflow](https://code.claude.com/docs/en/claude-code-on-the-web):
one campaign brief flows through the studio's 14 specialist roles, in dependency order, with
human approval gates enforced in code rather than in a prompt.

### What it does

- Runs the brief through intake → strategy → concepts → (script, casting, world in parallel) →
  (direction, styling, sound in parallel) → camera → storyboard → generation plan →
  pre-production review, and stops at the first pending approval.
- Enforces four human approval gates (`concept`, `production_plan`, `visual_lock`, `final_cut`) —
  nothing downstream of a gate runs until it is explicitly approved.
- Every artifact carries the studio's artifact contract (ID, revision, owner, `based_on`,
  status, blockers) and is tracked in a `decision_log` / `approval_log` / `budget_ledger`.
- Runs a bounded quality-control revision loop (max 2 rounds) before requesting the
  `production_plan` approval, routing critical issues back to the responsible department. If a
  fix invalidates a downstream artifact, that artifact is marked `stale` rather than silently
  carried forward — a `stale` artifact blocks the gate even if the human already approved it,
  until it's regenerated on a follow-up run.
- Skips inapplicable departments explicitly (e.g. sound design for a stills-only brief) rather
  than silently omitting them.
- Defaults to `planning_only`: the connected-tools production stages (reference stills, motion,
  audio, edit, final review, delivery) are blocked by default and return a
  `blocked_capability_report` with a ready-to-use prompt handoff, since no image/video/audio/
  editing tool and no media budget are authorized out of the box. Real media generation only
  runs if the caller explicitly sets `mode: 'connected_tools'`, supplies `toolBindings`, and
  authorizes `brief.budget.media_and_render_cap`.
- Enforces the blueprint's runtime limits in code: at most 3 concurrent department calls, at
  most 40 agent calls per run (further work is saved and returned rather than looped forever),
  and at most 2 revision rounds per stage.

### Running it

Invoke it with the Workflow tool:

```js
Workflow({
  scriptPath: '.claude/workflows/creative-studio.js',
  args: { command: 'START', brief: { /* see spec/creative_studio_brief_example.json */ } },
})
```

`args`:

- `command` — `START` (default), `APPROVE`, `REVISE`, `STATUS`, `EXPORT_STATE`, or `EXPORT_PLAN`.
- `brief` — the campaign brief (`START` only). Missing core fields (brand, product, audience,
  key message, objective, deliverables) are filled with labeled assumptions, capped at five,
  rather than blocking the run — budget, rights, and human approval are never assumed.
- `priorState` — the `project_state` object returned by a previous run, required for every
  command except `START`. This workflow has no storage binding, so the caller carries state
  between runs (per the blueprint's `storage_binding: null` rule).
- `approvals` — e.g. `{ concept: { approved: true, selected_route_id: 'R1' } }`, merged into
  `priorState.approvals`. `APPROVE` is just `START` with `priorState` plus a new approval.
- `revision` — `{ target_kind, routing_key, note, reason, estimated_cost_impact }` for `REVISE`;
  marks the target artifact and its dependents stale and invalidates the approval gate(s) that
  covered them, so the next run regenerates exactly what changed.
- `mode` / `toolBindings` — opt into the connected-tools production stages (see above).

Each run returns `project_state` — pass it back in as `priorState` on the next call to resume,
check `STATUS`, or `EXPORT_PLAN`/`EXPORT_STATE` once the campaign is done.
