# Lucas-creative-studio
Full Lucas production studio

## Creative studio workflow

[`.claude/workflows/creative-studio.js`](.claude/workflows/creative-studio.js) implements the
studio's blueprint (see [`spec/creative_studio_agents.json`](spec/creative_studio_agents.json))
as a runnable [Claude Code Workflow](https://code.claude.com/docs/en/claude-code-on-the-web).
Drop in an idea (or a written brief) and the studio develops it, builds the whole pre-production
package department by department, holds every department to an A-quality bar, and stops for
Lucas. Approval gates are enforced in code, not in a prompt.

### From an idea to a package

1. **Drop an idea** on the [Approval Desk](https://claude.ai/artifact/G3FEdafakQmFDsCStZQJmh)
   (a sentence or a page; format, length and brand are optional hints), then tell Claude
   **"pick up my ideas"**.
2. **Development.** A development producer turns the idea into a buildable brief: format,
   logline, a premise that makes the idea sharper without replacing it, audience, tone, story
   seed and deliverables sized to the format. Only facts quoted word for word from the idea may
   be stated as fact; everything else is a labeled assumption, and questions for Lucas are listed
   without blocking the run.
3. **The build.** Strategy → three routes (the creative director's recommendation is built on) →
   script → cast and world in parallel, broken down from the script (every character the script
   names is cast under the same ID) → direction, looks and sound in parallel → shot plan →
   storyboard and continuity → generation plan. Narrative formats get a screenwriter and a
   beat sheet for the whole piece; this build fully plans up to 120 seconds, and longer pieces
   plan their strongest sequence plus an outline of the rest.
4. **The A bar, per department.** Every department's work goes through code checks (timing that
   can be performed, IDs that exist upstream, hex palettes, lenses in mm, frame counts that add
   up, banned language, facts) and then a reviewer who scores it 1–10 on specificity,
   distinctiveness, fit and craft, quoting the line behind each score
   ([`spec/quality-bar.md`](spec/quality-bar.md)). **A** means 8+ on all four and no failed check.
   Below A, the department revises from the notes, up to three rounds.
5. **Integrity check.** Quality control audits facts, continuity, timing and rights across the
   package and routes critical issues back to the department that owns them.
6. **The package panel.** Three reviewers read the whole package blind to each other: a
   creative director (with the studio's taste notes), the film director who would shoot it, and
   the client (ads) or commissioner (narrative). The package is A when all three would approve
   it and every criterion averages 8+. Their notes go back to departments; questions about the
   direction itself (the idea's development, strategy, route) go to Lucas.
7. **Review.** The package lands on the desk with the grade, each reviewer's verdict, every
   department's grade (anything below A is flagged in red, never hidden), the script, open
   questions and the three routes. Lucas can:
   - **Approve the package** (this also confirms the route),
   - **Rebuild on another route** (the studio rebuilds and brings it back; nothing is approved), or
   - **Request changes**: his notes are routed to the departments that own them, revised to the
     same bar, re-checked, and the package comes back.

   An approval applies only to the exact versions Lucas was shown; if anything changed since, the
   approval is not applied and the current versions are presented again.
8. **Next: enhancement.** After approval, the next phase is either the full descriptive script
   (every scene written out) or paid media generation, which stays blocked until Lucas sets a
   budget and the tools are connected.

A run makes roughly 60–130 agent calls for a full package. Each run is capped (220 calls by
default); a run that reaches the cap saves exactly where it stopped, including half-finished
reviews and notes not yet applied, and the next run continues from there.

### The studio's standards

- [`spec/roles/`](spec/roles/): a craft brief per role (what a senior practitioner does, with
  weak and strong examples). Makers work to it and reviewers grade against it.
- [`spec/taste/notes.md`](spec/taste/notes.md): the studio's point of view (currently example
  notes; replace them with Lucas's).
- [`spec/quality-bar.md`](spec/quality-bar.md): what 6, 8, 9 and 10 mean.

Workflow scripts can't read files, so [`tools/studio.mjs`](tools/studio.mjs) embeds these, plus the
project's state, into a generated copy of the workflow for each run:

```sh
node tools/studio.mjs new <slug> "<idea>" [--format ad_spot] [--seconds 30] [--brand Name]
node tools/studio.mjs resume <slug>                   # continue after a run hit its call cap
node tools/studio.mjs approve <slug> <decision.json>  # an Approval Desk decision
node tools/studio.mjs notes <slug> "<notes>"
node tools/studio.mjs save <slug> <workflow-output>   # files state.json, package.md, desk.json
node tools/studio.mjs status <slug>
```

Each writes `projects/<slug>/.run.js` (not committed); run it with
`Workflow({ scriptPath: 'projects/<slug>/.run.js' })`. `save` writes the project's
`state.json` (what the next run resumes from), `package.md` (the full package, readable) and
`desk.json` (the documents Claude publishes to the Approval Desk).

### Calling the workflow directly

```js
Workflow({
  scriptPath: '.claude/workflows/creative-studio.js',
  args: { command: 'IDEA', idea: '...', craft: { copywriter: '...' }, tasteNotes: '...', qualityBar: '...' },
})
```

`args`:

- `command`: `IDEA` (develop an idea, quality bar on, review at the end), `START` (from a written
  `brief`; per-gate stops unless `review: 'end'`), `APPROVE`, `NOTES`, `REVISE`, `STATUS`,
  `EXPORT_STATE`, or `EXPORT_PLAN`.
- `idea` / `ideaHints`: the raw idea and optional `{ format, duration_seconds, brand }` (`IDEA`).
- `brief`: a written brief (`START`); see
  [`spec/creative_studio_brief_example.json`](spec/creative_studio_brief_example.json). Missing
  core fields are filled with labeled assumptions, capped at five.
- `priorState`: the `project_state` from the previous run, required for every command except
  `IDEA` and `START`. The workflow has no storage of its own, so the caller carries state.
- `approvals`: e.g. `{ production_plan: { approved: true, selected_route_id: 'R2', approver_id,
  decided_at, comment, decision_id } }`, merged into the state. An approval without an
  `approver_id` is logged as `verified: false`. A `comment` becomes binding direction in every
  later agent's prompt.
- `notes`: Lucas's free-text notes on the package (`NOTES`).
- `revision`: `{ target_kind, routing_key, note, reason }` (`REVISE`); marks the target and its
  dependents stale and invalidates the gates that covered them.
- `craft`, `tasteNotes`, `qualityBar`: the studio's standards as text (see above).
- `quality` (bool), `review` (`'end'` | `'gates'`), `maxAgentCalls`: override the defaults.
- `mode` / `toolBindings`: `planning_only` by default. The production stages (reference stills,
  motion, audio, edit, final review, delivery) return a `blocked_capability_report` with
  ready-to-use prompts unless the caller sets `mode: 'connected_tools'`, binds the tools, and
  authorizes `brief.budget.media_and_render_cap`.

Each run returns `project_state` plus `pending_gate` (with `package_grade`, `department_grades`,
`below_a`, `open_questions` and `route_options`), `package_review`, the `decision_log`,
`approval_log` and `budget_ledger`.

### Approving work

Gates are decided on the **Approval Desk**, a private claude.ai page
(<https://claude.ai/artifact/G3FEdafakQmFDsCStZQJmh>). Only the page's owner can send ideas,
approve, or request changes; each decision stores the approver's account id, the time, the
reviewed versions and any note. Anyone the page is shared with can read it but not decide.

After deciding, tell Claude **"pick up my approvals"** (or **"pick up my ideas"** for new ideas).
Claude reads the desk, marks what it picked up, runs the studio, and puts the result back on the
desk. A decision or idea can be undone on the desk until Claude picks it up.
