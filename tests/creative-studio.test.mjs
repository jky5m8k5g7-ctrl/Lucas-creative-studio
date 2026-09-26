// Behavior tests for .claude/workflows/creative-studio.js with stub agents (no model calls).
// Run: node tests/creative-studio.test.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkflow } from './load-workflow.mjs'
import { makeStub } from './stub-agents.mjs'
const run = await loadWorkflow(path.join(path.dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/creative-studio.js'))
const noop = () => {}
const J = x => JSON.parse(JSON.stringify(x))
let fails = 0
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++ }
const IDEA = 'Emberline makes a cast-iron skillet, pre-seasoned with flaxseed oil. A dad teaching his kid breakfast before school.'

// 1. IDEA: script needs a revision to reach A; QC flags the camera once; panel sends a note to the copywriter once.
const s1 = makeStub({
  score: (dept, label) => (dept === 'copywriter' && label.endsWith('review 1') ? 6 : 8),
  qc: (label, calls) => (calls.filter(c => /^integrity QC/.test(c.label)).length === 1 ? ['cinematographer'] : []),
  panel: (lens, round) => (round === 1 && lens === 'client' ? { ok: false, notes: [{ responsible: 'copywriter', target: 'D01 B2', note: 'end on the product name', source: 'brief' }], questions: ['Should the brand name change?'] } : { ok: true }),
})
const r1 = await run({ command: 'IDEA', idea: IDEA, craft: { copywriter: 'CRAFT-COPY-MARKER' }, tasteNotes: 'TASTE-MARKER', qualityBar: 'BAR-MARKER' }, s1.agent, s1.parallel, noop, noop)
ok(r1.pending_gate && r1.pending_gate.gate_id === 'production_plan', 'IDEA run stops at production_plan (one review at the end)')
ok(r1.pending_gate.selected_route_id === 'R2' && r1.pending_gate.route_options.length === 3, 'gate carries the recommended route and all three options')
ok(r1.package_review && r1.package_review.grade === 'A' && r1.package_review.round === 2, 'package panel reached A on round 2')
ok(r1.department_grades.length === 12 && r1.department_grades.every(g => g.grade === 'A'), 'all 12 graded departments are A: ' + r1.department_grades.map(g => g.key + ':' + g.grade).join(' '))
ok(r1.department_grades.find(g => g.key === 'script').rounds >= 2, 'script took more than one review round')
ok(!Object.values(r1.project_state.artifacts).some(a => a.status === 'stale'), 'nothing stale in the package presented')
ok(!r1.pending_gate.blocked_by_stale, 'gate not blocked by stale work')
ok(r1.project_state.artifacts.quality_reports.content.recommendation === 'approve', 'final integrity report is clean and current')
ok(r1.open_questions.some(q => q.includes('brand name')), 'panel direction question surfaced to Lucas')
ok(r1.needs_human_input.includes('Is Emberline the final brand name?'), 'development questions surfaced')
ok(r1.project_state.brief.verified_product_facts[0] === 'Pre-seasoned with flaxseed oil', 'verified fact carried into the brief')
const cw = s1.calls.find(c => c.label === 'copywriter')
ok(cw.prompt.includes('CRAFT-COPY-MARKER') && cw.prompt.includes('TASTE-MARKER') && cw.prompt.includes(IDEA), 'copywriter prompt has craft brief, taste notes and Lucas\'s idea')
ok(s1.calls.some(c => /review/.test(c.label) && c.prompt.includes('BAR-MARKER')), 'critic prompt has the quality bar')
ok(s1.calls.filter(c => /^panel/.test(c.label)).length === 6, 'panel ran two rounds of three lenses')
const rev1 = s1.calls.find(c => c.label === 'copywriter · review 1'), rev2 = s1.calls.find(c => c.label === 'copywriter · review 2')
ok(rev1.prompt.includes('"assumptions":[') && !rev1.prompt.includes('This is a revision'), 'reviewers see the assumptions; a first review has no earlier notes')
ok(rev2.prompt.includes('This is a revision') && rev2.prompt.includes('name the object'), 'a second review checks the first review\'s notes')
ok(s1.calls.find(c => c.label === 'strategist').prompt.includes('Your lane: you decide the audience tension'), 'the strategist gets its own lane')
ok(s1.calls.every(c => c.prompt.startsWith('Work only from this prompt. Do not use tools')), 'every prompt starts with the no-tools instruction')
ok(r1.approval_log.some(e => e.gate_id === 'concept' && e.decision === 'provisional'), 'route logged as provisional, not approved')
ok(r1.budget_ledger.agent_calls_allowed_per_run === 220 && !r1.budget_ledger.limit_reached, 'quality budget 220, not exhausted')
const rebuilt = s1.calls.filter(c => c.label === 'storyboard_artist' || c.label === 'generation_supervisor')
ok(rebuilt.some(c => c.prompt.includes('Your last version')), 'stale departments rebuild from their last version')

// 2. APPROVE same route: no agent calls for review; production blocked in planning_only.
const s2 = makeStub()
const r2 = await run({ command: 'APPROVE', priorState: J(r1.project_state), approvals: { production_plan: { approved: true, selected_route_id: 'R2', approver_id: 'u_LUCAS', decided_at: '2026-09-24T22:00:00Z', comment: 'Go.', decision_id: 'dec_1' } } }, s2.agent, s2.parallel, noop, noop)
ok(s2.calls.length === 0, 'APPROVE makes no agent calls (got ' + s2.calls.length + ')')
ok(r2.approval_log.some(e => e.gate_id === 'production_plan' && e.decision === 'approved' && e.verified), 'production_plan approval recorded and verified')
ok(r2.approval_log.some(e => e.gate_id === 'concept' && e.decision === 'approved' && e.confirmed_at === 'production_plan' && e.selected_route_id === 'R2'), 'route confirmed with the package')
ok(r2.project_state.artifacts.production_readiness && r2.project_state.artifacts.production_readiness.kind === 'blocked_capability_report', 'paid production stays blocked (planning_only)')

// 3. APPROVE with a different route: rebuilds on R3 and comes back for review.
const s3 = makeStub()
const r3 = await run({ command: 'APPROVE', priorState: J(r1.project_state), approvals: { production_plan: { approved: true, selected_route_id: 'R3', approver_id: 'u_LUCAS', decision_id: 'dec_2' } } }, s3.agent, s3.parallel, noop, noop)
ok(r3.project_state.selected_concept_id === 'R3', 'route switched to R3')
ok(r3.pending_gate && r3.pending_gate.gate_id === 'production_plan' && r3.pending_gate.selected_route_id === 'R3', 'R3 package comes back for review, not auto-approved')
ok(s3.calls.some(c => c.label === 'copywriter') && s3.calls.some(c => /^panel/.test(c.label)), 'R3 rebuilt and re-reviewed (' + s3.calls.length + ' calls)')
ok(!r3.approval_log.some(e => e.gate_id === 'production_plan' && e.decision === 'approved'), 'no production approval recorded for unseen R3 work')

// 4. NOTES: routed to departments, revised, re-checked, re-reviewed.
const s4 = makeStub()
const r4 = await run({ command: 'NOTES', priorState: J(r1.project_state), notes: 'Lose the window line. Make the kid older.' }, s4.agent, s4.parallel, noop, noop)
ok(s4.calls[0].label === 'producer · route your notes', 'notes routed by the producer first')
ok(s4.calls.some(c => c.label === 'copywriter · revise from notes'), 'copywriter revised from notes')
ok(s4.calls.some(c => /^integrity QC/.test(c.label)) && s4.calls.some(c => /^panel/.test(c.label)), 'revised package re-checked and re-reviewed')
ok(r4.pending_gate && r4.pending_gate.gate_id === 'production_plan', 'back to Lucas for review')
ok(r4.project_state.human_notes.some(n => n.gate_id === 'package'), 'Lucas\'s notes kept as binding direction')
ok(s4.calls.filter(c => c.label !== 'producer · route your notes').every(c => c.prompt.includes('Lose the window line')), 'every later prompt carries Lucas\'s notes')

// 5. Budget: small budgets stop mid-way (mid-review, mid-panel); resumes finish with no lost work.
for (const budget of [3, 5, 7, 11, 25]) {
  let st = null, runs = 0
  const s5 = makeStub({
    score: (dept, label) => (['copywriter', 'cinematographer'].includes(dept) && label.endsWith('review 1') ? 6 : 8),
    qc: (label, calls) => (calls.filter(c => /^integrity QC/.test(c.label)).length === 1 ? ['stylist'] : []),
    panel: (lens, round, calls) => (calls.filter(c => /^panel · client/.test(c.label)).length === 1 && lens === 'client' ? { ok: false, notes: [{ responsible: 'world_bible' === 'x' ? '' : 'production_designer', target: 'L1', note: 'warmer tile', source: 'taste' }] } : { ok: true }),
  })
  let r
  do {
    r = await run(st ? { command: 'APPROVE', priorState: J(st), maxAgentCalls: budget } : { command: 'IDEA', idea: IDEA, maxAgentCalls: budget }, s5.agent, s5.parallel, noop, noop)
    st = r.project_state; runs++
  } while (r.budget_ledger.limit_reached && runs < 60)
  ok(r.pending_gate && r.pending_gate.gate_id === 'production_plan' && !r.pending_gate.blocked_by_stale, `budget ${budget}: reaches review after ${runs} runs (${s5.calls.length} calls)`)
  ok(!Object.values(st.artifacts).some(a => (a.quality && a.quality.incomplete) || a.status === 'stale' || a.status === 'blocked'), `budget ${budget}: no half-reviewed, stale or blocked work left`)
  ok(r.package_review && r.package_review.grade === 'A' && !r.package_review.stale, `budget ${budget}: package review is A and current`)
  ok(r.department_grades.every(g => g.grade === 'A'), `budget ${budget}: every department A`)
}

// 6. Approval against a changed package is not applied.
const changed = J(r1.project_state)
changed.artifacts.script.revision += 1
const s6 = makeStub()
const r6 = await run({ command: 'APPROVE', priorState: changed, approvals: { production_plan: { approved: true, approver_id: 'u_LUCAS', decision_id: 'dec_3' } } }, s6.agent, s6.parallel, noop, noop)
ok(r6.approval_log.some(e => e.decision === 'not_applied') && r6.pending_gate.changed_since_review, 'approval on a changed package is refused and re-presented')

// 7. START with gates: stops at the concept gate.
const s7 = makeStub()
const r7 = await run({ command: 'START', brief: { name: 'x', brand: 'Emberline', product_or_subject: 'skillet', audience: 'a', key_message: 'k', objective: 'o', deliverables: [{ id: 'D01', type: 'video', duration_seconds: 30, aspect_ratio: '9:16' }] } }, s7.agent, s7.parallel, noop, noop)
ok(r7.pending_gate.gate_id === 'concept' && s7.calls.length === 2, 'START (gates) stops at concept after 2 calls, no quality loop by default')

// 8. Agent failure on development: stops cleanly, resume retries.
const s8 = makeStub({ fail: l => l.startsWith('development_producer') })
const r8 = await run({ command: 'IDEA', idea: IDEA }, s8.agent, s8.parallel, noop, noop)
ok(!r8.pending_gate && r8.decision_log.some(d => d.blocked) && s8.calls.length === 3, 'failed development stops without building on nothing, and skips review (' + s8.calls.map(c => c.label).join(', ') + ')')
const s8b = makeStub()
const r8b = await run({ command: 'APPROVE', priorState: J(r8.project_state) }, s8b.agent, s8b.parallel, noop, noop)
ok(r8b.pending_gate && r8b.pending_gate.gate_id === 'production_plan', 'resume retries development and completes')

// 9. Series pilot needs an outline and a screenwriter.
const s9 = makeStub({ format: 'series_pilot' })
const r9 = await run({ command: 'IDEA', idea: IDEA, maxAgentCalls: 12 }, s9.agent, s9.parallel, noop, noop)
const devMakes = s9.calls.filter(c => /^development_producer( · fix checks \d)?$/.test(c.label))
ok(devMakes.length === 3 && devMakes[1].prompt.includes('long-form formats need an outline'), 'pilot without an outline deliverable fails the check and is retried with the reason')
const dev9 = r9.project_state.artifacts.development
ok(dev9.quality && dev9.quality.grade !== 'A' && dev9.checks.failed.length > 0, 'work failing a check cannot be graded A even if the reviewer scores it 8+ (' + (dev9.quality && dev9.quality.grade) + ')')

// 10. A department the reviewer never passes: presented, flagged below A, not hidden.
const s10 = makeStub({ score: dept => (dept === 'sound_designer' ? 6 : 8) })
const r10 = await run({ command: 'IDEA', idea: IDEA }, s10.agent, s10.parallel, noop, noop)
const snd = r10.department_grades.find(g => g.key === 'sound_plan')
ok(snd.grade === 'below_A' && snd.rounds === 3, 'never-A department stops after 3 review rounds')
ok(r10.pending_gate.below_a.includes('sound_plan'), 'gate flags it for Lucas: below_a = ' + JSON.stringify(r10.pending_gate.below_a))

// 11. REVISE on the approved package: approvals invalidated, dependents rebuilt, package re-reviewed.
const s11 = makeStub()
const r11 = await run({ command: 'REVISE', priorState: J(r2.project_state), revision: { target_kind: 'world_bible', routing_key: 'location_props_palette', note: 'swap the kitchen for a camper van', reason: 'client' } }, s11.agent, s11.parallel, noop, noop)
ok(r11.project_state.approvals.production_plan.approved === false, 'REVISE invalidates the production approval')
ok(s11.calls.some(c => c.label === 'production_designer') && s11.calls.some(c => c.label === 'cinematographer') && !s11.calls.some(c => c.label === 'copywriter'), 'world and its dependents rebuilt, script untouched')
ok(s11.calls.some(c => /^panel/.test(c.label)) && r11.pending_gate.gate_id === 'production_plan', 'revised package re-reviewed and presented again')

// 12. Blocked strategy stops before building, surfaces the question, and Lucas's notes unblock it.
let blockOnce = true
const s12 = makeStub()
const agent12 = async (prompt, o) => {
  if (o.label === 'strategist' && blockOnce) { blockOnce = false; s12.calls.push({ label: o.label, prompt }); return { status: 'blocked', based_on: [], content: { audience_tension: '', desired_behavior: '', product_relevance: '', single_minded_proposition: '', proof_points: [], success_criteria: [], supplied_facts: [], sourced_research: [], hypotheses: [] }, assumptions: [], sources: [], blockers: [{ issue: 'No product is named in the idea', responsible_agent: 'producer', resolution: 'Ask Lucas what the product is' }] } }
  return s12.agent(prompt, o)
}
const r12 = await run({ command: 'IDEA', idea: IDEA }, agent12, s12.parallel, noop, noop)
ok(r12.pending_gate && r12.pending_gate.gate_id === 'concept' && r12.pending_gate.blocked_by.includes('strategy'), 'blocked strategy stops at the concept stage')
ok(r12.open_questions.some(q => q.includes('No product is named')), 'the blocker is a question for Lucas')
ok(!s12.calls.some(c => c.label === 'copywriter'), 'nothing is built on blocked direction')
const s12b = makeStub()
const r12b = await run({ command: 'NOTES', priorState: J(r12.project_state), notes: 'The product is the Emberline 10-inch skillet.' }, s12b.agent, s12b.parallel, noop, noop)
ok(s12b.calls.some(c => c.label === 'strategist' && c.prompt.includes('Emberline 10-inch')) && r12b.pending_gate.gate_id === 'production_plan', 'his notes reach the strategist and the build completes')

// 13. Cast and world are broken down from the finished script; a character the script names
// by an ID that casting doesn't have fails casting's check.
const s13 = makeStub()
const agent13 = async (prompt, o) => {
  const r = await s13.agent(prompt, o)
  if (o.label.startsWith('copywriter') && !o.label.includes('review') && r && r.content && r.content.story) {
    r.content.story.beat_sheet[0].characters = ['C1', 'ROSA']
  }
  return r
}
const r13 = await run({ command: 'IDEA', idea: IDEA }, agent13, s13.parallel, noop, noop)
const firstCast = s13.calls.findIndex(c => c.label === 'casting_director')
const firstScript = s13.calls.findIndex(c => c.label === 'copywriter')
ok(firstScript >= 0 && firstCast > s13.calls.findIndex(c => c.label === 'copywriter · review 1'), 'casting starts after the script is written and reviewed')
ok(s13.calls[firstCast].prompt.includes('INT. KITCHEN'), 'casting sees the script')
const cast13 = r13.project_state.artifacts.casting_bible
ok(cast13.checks.failed.some(x => x.includes('ROSA')) && cast13.quality.grade !== 'A', 'an uncast script character fails the casting check and blocks an A')

// ---- audit fixes ----
const wrap = (stub, fn) => async (prompt, o) => { const r = await stub.agent(prompt, o); return fn(r, o, prompt) || r }
const approve = extra => ({ approved: true, approver_id: 'u_LUCAS', decided_at: '2026-09-26T10:00:00Z', decision_id: 'dec_' + Math.abs(JSON.stringify(extra || {}).length), ...(extra || {}) })

// A. A department blocked at presentation, then approved as it is: the approval applies to
// exactly what Lucas saw, with no rebuild or re-review; the blocked department stays blocked.
const sA = makeStub()
const agentA = async (prompt, o) => {
  if (o.label === 'generation_supervisor') { sA.calls.push({ label: o.label, prompt }); return { status: 'blocked', based_on: [], content: { jobs: [], missing_capabilities: [] }, assumptions: [], sources: [], blockers: [{ issue: 'no product photos', responsible_agent: 'producer', resolution: 'supply photos' }] } }
  return sA.agent(prompt, o)
}
const rA = await run({ command: 'IDEA', idea: IDEA }, agentA, sA.parallel, noop, noop)
ok(rA.pending_gate.gate_id === 'production_plan' && rA.project_state.artifacts.generation_plan.status === 'blocked', 'A: package presented with a blocked department')
const a0 = sA.calls.length
const rA2 = await run({ command: 'APPROVE', priorState: J(rA.project_state), approvals: { production_plan: approve({ decision_id: 'dec_A', selected_route_id: 'R2' }) } }, agentA, sA.parallel, noop, noop)
ok(sA.calls.length === a0 && !rA2.approval_log.some(e => e.decision === 'not_applied') && rA2.stage_reached === '09_production_plan_approved', 'A: approving it as seen applies at once, with no agent calls')
ok(rA2.project_state.artifacts.generation_plan.status === 'blocked', 'A: the blocked department stays blocked after approval')

// B. After the approval is applied, later runs don't revoke it or repeat it, and make no calls.
const sB = makeStub()
const rB = await run({ command: 'APPROVE', priorState: J(rA2.project_state), mode: 'connected_tools' }, sB.agent, sB.parallel, noop, noop)
ok(sB.calls.length === 0 && !rB.approval_log.some(e => e.decision === 'not_applied') && rB.approval_log.filter(e => e.gate_id === 'production_plan' && e.decision === 'approved').length === 1, 'B: an applied approval survives later runs, once, with no agent calls')

// B2. An approval that doesn't match is refused, names what changed, and keeps Lucas's comment.
const drifted = J(rA.project_state)
drifted.artifacts.script.revision += 1
const sB2 = makeStub()
const rB2 = await run({ command: 'APPROVE', priorState: drifted, approvals: { production_plan: approve({ decision_id: 'dec_B2', selected_route_id: 'R2', comment: 'Bigger end card.' }) } }, sB2.agent, sB2.parallel, noop, noop)
ok(rB2.approval_log.some(e => e.decision === 'not_applied') && rB2.pending_gate.changed.includes('script'), 'B2: a mismatched approval is refused and the gate names the changed department')
ok(rB2.project_state.human_notes.some(n => n.note === 'Bigger end card.'), 'B2: the refused approval\'s comment is kept as Lucas\'s note')

// B3. A replayed "rebuild on route X" for the route already built is never an approval.
const sB3 = makeStub()
const rB3 = await run({ command: 'APPROVE', priorState: J(rA.project_state), approvals: { production_plan: approve({ decision_id: 'dec_B3', selected_route_id: 'R2', route_change: true }) } }, sB3.agent, sB3.parallel, noop, noop)
ok(!rB3.approval_log.some(e => e.gate_id === 'production_plan' && e.decision === 'approved') && rB3.pending_gate && rB3.pending_gate.gate_id === 'production_plan', 'B3: a replayed route change is not applied as an approval')

// C. Integrity fixes after the panel's last look are named in full, and the grade says it saw earlier versions.
const sC = makeStub({
  qc: (label, calls) => (calls.filter(c => /^integrity QC/.test(c.label)).length === 2 ? ['copywriter'] : []),
  panel: (lens, round) => (round === 1 && lens === 'client' ? { ok: false, notes: [{ responsible: 'stylist', target: 'LK1', note: 'warmer', source: 'x' }] } : { ok: true }),
})
const rC = await run({ command: 'IDEA', idea: IDEA }, sC.agent, sC.parallel, noop, noop)
const prC = rC.package_review
ok(prC && prC.grade_on_earlier_versions && prC.revised_after_review.includes('script') && prC.revised_after_review.includes('storyboard'), 'C: the post-panel fixes are listed with everything they rebuilt: ' + JSON.stringify(prC && prC.revised_after_review))

// D. A route switch rebuilds from the new route, not from the old route's work.
const sD = makeStub({ panel: (lens, round, calls) => (lens === 'client' && calls.filter(c => /^panel · client/.test(c.label)).length === 1 ? { ok: false, questions: ['Is R2 too quiet?'] } : { ok: true }) })
const rD0 = await run({ command: 'IDEA', idea: IDEA }, sD.agent, sD.parallel, noop, noop)
const before = sD.calls.length
const rD = await run({ command: 'APPROVE', priorState: J(rD0.project_state), approvals: { production_plan: approve({ decision_id: 'dec_D', selected_route_id: 'R3' }) } }, sD.agent, sD.parallel, noop, noop)
const dCalls = sD.calls.slice(before)
ok(dCalls.filter(c => ['copywriter', 'casting_director', 'cinematographer'].includes(c.label)).every(c => !c.prompt.includes('Your last version')), 'D: the new route is built fresh, not from the old route\'s work')
ok(!rD.open_questions.some(q => q.includes('Is R2 too quiet')) && rD.approval_log.some(e => e.decision === 'route_change'), 'D: the old route\'s panel questions are gone; the decision is logged as a route change')

// E. A budget stop during a revision pass keeps every later department's notes.
const sE = makeStub({ panel: (lens, round, calls) => (calls.filter(c => /^panel · client/.test(c.label)).length === 1 && lens === 'client' ? { ok: false, notes: [{ responsible: 'stylist', target: 'LK1', note: 'NOTE-FOR-STYLE', source: 'x' }, { responsible: 'sound_designer', target: 'Q1', note: 'NOTE-FOR-SOUND', source: 'x' }] } : { ok: true }) })
let stE = null, rE, runsE = 0
const firstPanel = async () => { let s0 = null; do { rE = await run(s0 ? { command: 'APPROVE', priorState: J(s0), maxAgentCalls: 4 } : { command: 'IDEA', idea: IDEA, maxAgentCalls: 4 }, sE.agent, sE.parallel, noop, noop); s0 = rE.project_state; runsE++ } while (rE.budget_ledger.limit_reached && runsE < 80); return s0 }
stE = await firstPanel()
ok(sE.calls.some(c => c.label.startsWith('sound_designer') && c.prompt.includes('NOTE-FOR-SOUND')), 'E: the sound designer still gets its note after budget stops (' + runsE + ' runs)')

// F. QC's rights/production issues become questions for Lucas, worded as decisions.
const sF = makeStub({ qc: (label, calls) => (calls.filter(c => /^integrity QC/.test(c.label)).length === 1 ? ['producer'] : []) })
const rF = await run({ command: 'IDEA', idea: IDEA }, sF.agent, sF.parallel, noop, noop)
ok(rF.open_questions.some(q => q.startsWith('Rights or production decision needed')), 'F: a producer issue reaches Lucas as a decision to make')

// G. A words-only script note rebuilds only what carries the words; a structural one rebuilds all.
const sG = makeStub()
const rG0 = await run({ command: 'IDEA', idea: IDEA }, sG.agent, sG.parallel, noop, noop)
let wordsOnly = true
const agentG = wrap(sG, (r, o) => { if (o.label === 'copywriter · revise from notes' && r && r.content) { const b = r.content.deliverable_scripts[0].beats; b[1].on_screen_text = 'Emberline. Yours for life.'; if (!wordsOnly) b[0].picture = 'A woman sears a steak in a black skillet on a gas ring while rain hits the window' } })
const g0 = sG.calls.length
await run({ command: 'NOTES', priorState: J(rG0.project_state), notes: 'Change the end card.' }, agentG, sG.parallel, noop, noop)
const gLabels = sG.calls.slice(g0).map(c => c.label)
ok(gLabels.includes('storyboard_artist') && gLabels.includes('sound_designer') && !gLabels.includes('casting_director') && !gLabels.includes('cinematographer'), 'G: a words-only change rebuilds sound, board and generation, not cast or camera')
wordsOnly = false
const g1 = sG.calls.length
await run({ command: 'NOTES', priorState: J(rG0.project_state), notes: 'Change the opening.' }, agentG, sG.parallel, noop, noop)
const gLabels2 = sG.calls.slice(g1).map(c => c.label)
ok(gLabels2.includes('casting_director') && gLabels2.includes('cinematographer'), 'G: a structural change rebuilds everything built on the script')

// H. Gates mode: "rebuild on another route" at the package gate is never an approval.
const sH = makeStub()
const rH0 = await run({ command: 'IDEA', idea: IDEA, review: 'gates' }, sH.agent, sH.parallel, noop, noop)
const rH1 = await run({ command: 'APPROVE', priorState: J(rH0.project_state), approvals: { concept: approve({ decision_id: 'dec_H1', selected_route_id: 'R2' }) } }, sH.agent, sH.parallel, noop, noop)
ok(rH1.pending_gate.gate_id === 'production_plan', 'H: gates mode reaches the package gate after the route is approved')
const rH2 = await run({ command: 'APPROVE', priorState: J(rH1.project_state), approvals: { production_plan: approve({ decision_id: 'dec_H2', selected_route_id: 'R3' }) } }, sH.agent, sH.parallel, noop, noop)
ok(rH2.project_state.selected_concept_id === 'R3' && rH2.pending_gate.gate_id === 'production_plan' && !rH2.approval_log.some(e => e.gate_id === 'production_plan' && e.decision === 'approved'), 'H: a route change rebuilds on R3 and records no package approval')
ok(rH2.project_state.approvals.concept.selected_route_id === 'R3', 'H: the route decision moves to R3')

// I. Notes at the route choice revise the routes.
const sI = makeStub()
const rI0 = await run({ command: 'IDEA', idea: IDEA, review: 'gates' }, sI.agent, sI.parallel, noop, noop)
const i0 = sI.calls.length
const rI = await run({ command: 'NOTES', priorState: J(rI0.project_state), notes: 'None of these; make them funnier.' }, sI.agent, sI.parallel, noop, noop)
const iCalls = sI.calls.slice(i0)
ok(iCalls.some(c => c.label === 'creative_director · revise from notes' && c.prompt.includes('make them funnier')) && rI.pending_gate.gate_id === 'concept', 'I: notes at the route choice revise the routes and bring them back')
ok(rI.project_state.artifacts.concepts.revision === 2, 'I: the routes are a new version')

// J. An unseen announcer isn't a character to cast.
const sJ = makeStub()
const agentJ = wrap(sJ, (r, o) => { if (o.label === 'copywriter' && r && r.content) r.content.deliverable_scripts[0].beats[1].vo = 'VO: Find yours at emberline.example.' })
const rJ = await run({ command: 'IDEA', idea: IDEA }, agentJ, sJ.parallel, noop, noop)
ok(!rJ.project_state.artifacts.casting_bible.checks.failed.some(x => x.includes('VO')), 'J: a VO line doesn\'t have to be cast')

// K. The board is joined onto the camera plan; a shot without a panel fails the board's check.
const sb = rJ.project_state.artifacts.storyboard.content.panels
ok(sb.length === 3 && sb[0].lens_intent === '35mm at T2.8' && sb[0].location_id === 'L1' && sb[0].board_note === 'reads at phone size', 'K: each stored panel carries the camera plan\'s fields and the board\'s')
const sK = makeStub()
const agentK = wrap(sK, (r, o) => { if (o.label.startsWith('storyboard_artist') && !o.label.includes('review') && r && r.content) r.content.panels = r.content.panels.slice(0, 2) })
const rK = await run({ command: 'IDEA', idea: IDEA }, agentK, sK.parallel, noop, noop)
ok(rK.project_state.artifacts.storyboard.checks.failed.some(x => x.includes('missing: K1')), 'K: a camera-plan shot with no panel fails the board check')

// L. A check-fix retry of a revision doesn't carry the previous version twice.
const sL = makeStub({ score: (dept, label) => (dept === 'cinematographer' && label.endsWith('review 1') ? 6 : 8) })
let brokeOnce = false
const agentL = wrap(sL, (r, o) => { if (o.label === 'cinematographer · revise 1' && !brokeOnce && r && r.content) { brokeOnce = true; r.content.shots[0].lens_intent = 'wide' } })
await run({ command: 'IDEA', idea: IDEA }, agentL, sL.parallel, noop, noop)
const retry = sL.calls.find(c => c.label === 'cinematographer · revise 1 · fix checks 1')
ok(retry && !retry.prompt.includes('YOUR PREVIOUS VERSION') && retry.prompt.includes('Last attempt:'), 'L: the retry has the failed attempt, not the previous version too')

// M. A direction change in notes at the package gate is redeveloped, not left as a question.
const sM = makeStub({ router: () => ({ routes: [], switch_route_to: '', direction_change: 'make it about pride, not guilt' }) })
const rM0 = await run({ command: 'IDEA', idea: IDEA }, sM.agent, sM.parallel, noop, noop)
const m0 = sM.calls.length
const rM = await run({ command: 'NOTES', priorState: J(rM0.project_state), notes: 'None of these routes. Make it about pride.' }, sM.agent, sM.parallel, noop, noop)
const mLabels = sM.calls.slice(m0).map(c => c.label)
ok(mLabels.includes('strategist · revise from notes') && mLabels.includes('creative_director') && mLabels.includes('copywriter') && rM.pending_gate.gate_id === 'production_plan', 'M: a direction change redevelops strategy and routes and rebuilds the package')
ok(sM.calls.find(c => c.label === 'strategist · revise from notes').prompt.includes('make it about pride'), 'M: the strategist gets the direction change')
ok(!rM.open_questions.some(q => q.includes('Confirm and the studio')), 'M: no dead-end confirmation question')

// N. Notes that change nothing keep the panel's open question.
const sN = makeStub({ panel: (lens, round, calls) => (lens === 'client' && calls.filter(c => /^panel · client/.test(c.label)).length === 1 ? { ok: false, questions: ['Which market?'] } : { ok: true }), router: () => ({ routes: [], switch_route_to: '', direction_change: '' }) })
const rN0 = await run({ command: 'IDEA', idea: IDEA }, sN.agent, sN.parallel, noop, noop)
const rN = await run({ command: 'NOTES', priorState: J(rN0.project_state), notes: 'Looks good so far.' }, sN.agent, sN.parallel, noop, noop)
ok(rN.open_questions.some(q => q.includes('Which market?')), 'N: notes that revise nothing leave the open question in place')
ok((rN.project_state.earlier_questions || []).includes('Is Emberline the final brand name?') && !rN.project_state.needs_human_input.length, 'N: development questions asked before the notes move to earlier questions')

// O. A revision call that fails outright never replaces good work, and its notes survive.
let failsLeft = 3
const sO = makeStub({ router: () => ({ routes: [{ responsible: 'storyboard_artist', note: 'NOTE-FOR-BOARD' }], switch_route_to: '', direction_change: '' }) })
const agentO = async (prompt, o) => { if (o.label.startsWith('storyboard_artist · revise from notes') && failsLeft > 0) { failsLeft--; sO.calls.push({ label: o.label, prompt }); return null } return sO.agent(prompt, o) }
const rO0 = await run({ command: 'IDEA', idea: IDEA }, sO.agent, sO.parallel, noop, noop)
const boardBefore = rO0.project_state.artifacts.storyboard.artifact_id
const rO = await run({ command: 'NOTES', priorState: J(rO0.project_state), notes: 'Board note.' }, agentO, sO.parallel, noop, noop)
const boardAfter = rO.project_state.artifacts.storyboard
ok(boardAfter.status !== 'blocked' && boardAfter.content.panels.length === 3, 'O: a failed revision leaves a complete storyboard, not an empty blocked one')
ok(sO.calls.some(c => c.label.startsWith('storyboard_artist · revise from notes') && c.prompt.includes('NOTE-FOR-BOARD')) && boardAfter.artifact_id !== boardBefore && !failsLeft, 'O: the note is applied once the call succeeds')

// P. The board can't overwrite the camera plan's values.
const sP = makeStub()
const agentP = wrap(sP, (r, o) => { if (o.label === 'storyboard_artist' && r && r.content) r.content.panels[0].duration_frames = 999 })
const rP = await run({ command: 'IDEA', idea: IDEA }, agentP, sP.parallel, noop, noop)
ok(rP.project_state.artifacts.storyboard.content.panels[0].duration_frames === 360, 'P: a board that restates a shot length keeps the camera plan\'s value')

// Q. A REVISE request's note reaches the department that rebuilds the target.
const sQ = makeStub()
await run({ command: 'REVISE', priorState: J(rA2.project_state), revision: { target_kind: 'world_bible', routing_key: 'location_props_palette', note: 'SWAP-TO-CAMPER-VAN', reason: 'client' } }, sQ.agent, sQ.parallel, noop, noop)
ok(sQ.calls.some(c => c.label === 'production_designer' && c.prompt.includes('SWAP-TO-CAMPER-VAN')), 'Q: the revision note reaches the production designer')

// R. Lucas's direction reaches only the departments it names (and QC and the panel); a bar above
// A keeps the camera plan in its review loop until every score reaches it.
const DIR = [{ id: 'LD-01', note: 'DIRECTION-35MM-MARKER', departments: ['cinematographer', 'storyboard_artist', 'generation_supervisor', 'not_a_department'], lucas_words: 'shot in 35mm' }]
const camScores = { 1: [8, 8, 9, 9], 2: [9, 9, 9, 9], 3: [10, 10, 10, 10] }
const sR = makeStub({ scores: (dept, label) => (dept === 'cinematographer' ? camScores[+label.split(' ').pop()] : null) })
const rR = await run({ command: 'IDEA', idea: IDEA, direction: DIR, targets: { cinematographer: { min: 10, rounds: 5 } } }, sR.agent, sR.parallel, noop, noop)
const qR = rR.project_state.artifacts.camera_plan.quality
const has = (label, text) => { const c = sR.calls.find(x => x.label === label); return !!(c && c.prompt.includes(text)) }
ok(['cinematographer', 'storyboard_artist', 'generation_supervisor'].every(d => has(d, 'DIRECTION-35MM-MARKER') && has(d, "LUCAS'S DIRECTION FOR THIS DEPARTMENT")), 'R: the direction reaches the camera, board and generation makers')
ok(['development_producer', 'copywriter', 'director', 'stylist', 'sound_designer', 'production_designer'].every(d => !has(d, 'DIRECTION-35MM-MARKER') && !has(`${d} · review 1`, 'DIRECTION-35MM-MARKER')), 'R: departments the direction doesn\'t name never see it')
ok(has('cinematographer · review 1', 'DIRECTION-35MM-MARKER') && has('cinematographer · review 1', "bar at 10 on every criterion") && !has('storyboard_artist · review 1', 'bar at 10'), 'R: the camera reviewer sees the direction and the bar; the board reviewer sees only the direction')
ok(has('cinematographer · revise 1', "Lucas has set this department's bar at 10") && sR.calls.filter(c => / · revise \d+$/.test(c.label) && !c.label.startsWith('cinematographer')).every(c => c.prompt.includes('A needs 8 or more')), 'R: the camera reviser is told the bar; other revisers keep the A line')
ok(qR.rounds === 3 && qR.min === 10 && qR.target === 10 && qR.met_target === true && qR.grade === 'A', 'R: the camera plan kept revising past A (9s) until it reached 10s on round 3')
ok(sR.calls.some(c => /^integrity QC/.test(c.label) && c.prompt.includes('DIRECTION-35MM-MARKER')) && sR.calls.some(c => /^panel · /.test(c.label) && c.prompt.includes('DIRECTION-35MM-MARKER')), 'R: integrity QC and the panel check the package against the direction')
ok(rR.project_state.direction.length === 1 && rR.project_state.direction[0].departments.join() === 'cinematographer,storyboard_artist,generation_supervisor', 'R: the direction is kept in the state, unknown departments dropped')
ok(rR.pending_gate.department_grades.find(g => g.key === 'camera_plan').met_target === true && rR.pending_gate.below_target.length === 0, 'R: the gate reports the bar as met')

// S. A bar that isn't reached stops after its rounds, reports it, and keeps the best version.
const sS = makeStub({ scores: (dept, label) => (dept === 'cinematographer' ? { 1: [9, 9, 9, 9], 2: [8, 8, 9, 8], 3: [9, 9, 9, 8] }[+label.split(' ').pop()] : null) })
const rS = await run({ command: 'IDEA', idea: IDEA, targets: { cinematographer: { min: 10, rounds: 3 } } }, sS.agent, sS.parallel, noop, noop)
const qS = rS.project_state.artifacts.camera_plan.quality
ok(qS.rounds === 3 && qS.kept_round === 1 && qS.min === 9 && qS.met_target === false && qS.history.length === 3, 'S: after 3 rounds below the bar, round 1\'s best version is kept: ' + JSON.stringify({ r: qS.rounds, k: qS.kept_round, m: qS.min }))
ok(rS.pending_gate.below_target.some(b => b.key === 'camera_plan' && b.target === 10 && b.lowest === 9), 'S: the gate lists the camera plan as below Lucas\'s bar')
ok(!sS.calls.some(c => c.label === 'cinematographer · review 4'), 'S: no review beyond the rounds Lucas allowed')

// T. Direction and a bar added to a finished project: built work is revised against the direction,
// and work below the new bar goes back into review with the bar's rounds on top.
const sT = makeStub({ scores: (dept, label, calls) => (dept === 'cinematographer' ? (calls.filter(c => c.label.startsWith('cinematographer · review')).length >= 4 ? [10, 10, 10, 10] : [9, 9, 9, 9]) : null) })
const rT0 = await run({ command: 'IDEA', idea: IDEA }, sT.agent, sT.parallel, noop, noop)
const camRounds0 = rT0.project_state.artifacts.camera_plan.quality.rounds
const rT = await run({ command: 'APPROVE', priorState: J(rT0.project_state), targets: { cinematographer: { min: 10, rounds: 4 } }, direction: [{ id: 'LD-01', note: 'BOARD-DIRECTION-MARKER', departments: ['storyboard_artist'] }] }, sT.agent, sT.parallel, noop, noop)
const qT = rT.project_state.artifacts.camera_plan.quality
ok(sT.calls.some(c => c.label === 'cinematographer · resume revision' && c.prompt.includes("bar at 10")) && qT.met_target === true && qT.rounds > camRounds0, 'T: a bar set later sends reviewed work back into its loop until it is met: ' + JSON.stringify({ before: camRounds0, after: qT.rounds, met: qT.met_target }))
ok(sT.calls.some(c => c.label.startsWith('storyboard_artist') && c.prompt.includes('BOARD-DIRECTION-MARKER')) && rT.project_state.artifacts.storyboard.status !== 'stale', 'T: the board is rebuilt with the new direction')
ok(rT.pending_gate && rT.pending_gate.gate_id === 'production_plan' && rT.project_state.decision_log.some(d => d.stage === 'direction'), 'T: the project comes back to the gate with the direction logged')

// U. A bar set on reviewed work never replaces it with a worse revision.
const camReviews = calls => calls.filter(c => c.label.startsWith('cinematographer · review')).length
const sU = makeStub({ scores: (dept, label, calls) => (dept === 'cinematographer' ? (camReviews(calls) <= 1 ? [9, 9, 9, 9] : [7, 7, 7, 7]) : null) })
const rU0 = await run({ command: 'IDEA', idea: IDEA }, sU.agent, sU.parallel, noop, noop)
const camU0 = rU0.project_state.artifacts.camera_plan, boardU0 = rU0.project_state.artifacts.storyboard
const rU = await run({ command: 'APPROVE', priorState: J(rU0.project_state), targets: { cinematographer: { min: 10, rounds: 3 } } }, sU.agent, sU.parallel, noop, noop)
const camU = rU.project_state.artifacts.camera_plan
ok(camU.artifact_id === camU0.artifact_id && camU.quality.min === 9 && camU.quality.kept_round === 1 && camU.quality.grade === 'A' && camU.quality.met_target === false, 'U: worse revisions after a new bar keep the reviewed 9s version: ' + JSON.stringify({ id: camU.artifact_id, min: camU.quality.min, k: camU.quality.kept_round }))
ok(rU.project_state.artifacts.storyboard.artifact_id === boardU0.artifact_id && !rU.project_state.artifacts.camera_plan.quality.incomplete, 'U: keeping the earlier version leaves the board built on it alone')
// Z. The next review of a kept version is told that version's scores, not the discarded round's.
const zStart = sU.calls.length
await run({ command: 'APPROVE', priorState: J(rU.project_state), targets: { cinematographer: { min: 10, rounds: 1 } } }, sU.agent, sU.parallel, noop, noop)
const zReview = sU.calls.slice(zStart).find(c => c.label.startsWith('cinematographer · review'))
ok(zReview && zReview.prompt.includes('The previous review scored it specificity 9') && !zReview.prompt.includes('specificity 7,'), 'Z: a kept version is reviewed against its own scores')

// V. A budget stop right after a worse round saves the better version to revise next.
const vScores = (dept, label, calls) => (dept === 'cinematographer' ? (camReviews(calls) === 1 ? [9, 9, 9, 9] : camReviews(calls) === 2 ? [7, 7, 7, 7] : [8, 8, 8, 8]) : null)
const sV1 = makeStub({ scores: vScores })
await run({ command: 'IDEA', idea: IDEA, targets: { cinematographer: { min: 10, rounds: 5 } } }, sV1.agent, sV1.parallel, noop, noop)
const stopAt = sV1.calls.findIndex(c => c.label === 'cinematographer · review 3')
const sV = makeStub({ scores: vScores })
const rV0 = await run({ command: 'IDEA', idea: IDEA, targets: { cinematographer: { min: 10, rounds: 5 } }, maxAgentCalls: stopAt }, sV.agent, sV.parallel, noop, noop)
const qV0 = rV0.project_state.artifacts.camera_plan.quality
ok(qV0.incomplete && qV0.pending === 'revise' && qV0.min === 9 && qV0.kept_round === 1, 'V: the paused camera plan is the 9s version, waiting to be revised: ' + JSON.stringify({ p: qV0.pending, m: qV0.min, k: qV0.kept_round }))
const rV = await run({ command: 'APPROVE', priorState: J(rV0.project_state) }, sV.agent, sV.parallel, noop, noop)
const qV = rV.project_state.artifacts.camera_plan.quality
ok(qV.min === 9 && !qV.incomplete && qV.rounds === 5, 'V: after resuming, 8s never replace the 9s version: ' + JSON.stringify({ m: qV.min, r: qV.rounds, k: qV.kept_round }))

// W. Direction after the package was approved reopens it and revises the work.
const sW = makeStub()
const rW0 = await run({ command: 'IDEA', idea: IDEA }, sW.agent, sW.parallel, noop, noop)
const rW1 = await run({ command: 'APPROVE', priorState: J(rW0.project_state), approvals: { production_plan: approve({ decision_id: 'dec_W', selected_route_id: 'R2' }) } }, sW.agent, sW.parallel, noop, noop)
const w0 = sW.calls.length
const rW = await run({ command: 'APPROVE', priorState: J(rW1.project_state), direction: [{ id: 'LD-01', note: 'LATE-DIRECTION-MARKER', departments: ['cinematographer'] }] }, sW.agent, sW.parallel, noop, noop)
ok(rW1.project_state.production_plan_applied && sW.calls.slice(w0).some(c => c.label === 'cinematographer · revise from notes' && c.prompt.includes('LATE-DIRECTION-MARKER')), 'W: direction after approval revises the camera plan')
ok(!rW.project_state.production_plan_applied && rW.pending_gate && rW.pending_gate.gate_id === 'production_plan' && rW.project_state.approval_log.some(e => e.gate_id === 'production_plan' && e.decision === 'reopened'), 'W: the package is reopened and comes back to Lucas')

// X. Gates mode: direction for the routes reopens the route approval instead of reusing it.
const sX = makeStub()
const rX0 = await run({ command: 'IDEA', idea: IDEA, review: 'gates' }, sX.agent, sX.parallel, noop, noop)
const rX1 = await run({ command: 'APPROVE', priorState: J(rX0.project_state), approvals: { concept: approve({ decision_id: 'dec_X1', selected_route_id: 'R2' }) } }, sX.agent, sX.parallel, noop, noop)
const rX = await run({ command: 'APPROVE', priorState: J(rX1.project_state), direction: [{ id: 'LD-01', note: 'ROUTES-DIRECTION-MARKER', departments: ['creative_director'] }] }, sX.agent, sX.parallel, noop, noop)
ok(rX.pending_gate && rX.pending_gate.gate_id === 'concept' && rX.project_state.approval_log.some(e => e.gate_id === 'concept' && e.decision === 'reopened') && !rX.project_state.approval_log.filter(e => e.gate_id === 'concept' && e.decision === 'approved').some(e => e.decision_id !== 'dec_X1'), 'X: revised routes go back to Lucas; his earlier route approval is not reused')

// Y. Direction for development on a saved project reaches the development producer.
const sY = makeStub()
const rY0 = await run({ command: 'IDEA', idea: IDEA }, sY.agent, sY.parallel, noop, noop)
const y0 = sY.calls.length
const rY = await run({ command: 'APPROVE', priorState: J(rY0.project_state), direction: [{ id: 'LD-01', note: 'DEV-DIRECTION-MARKER', departments: ['development_producer'] }] }, sY.agent, sY.parallel, noop, noop)
ok(sY.calls.slice(y0).some(c => c.label === 'development_producer · revise from notes' && c.prompt.includes('DEV-DIRECTION-MARKER')) && !(rY.project_state.pending_notes || {}).development, 'Y: development is revised with the direction')

// V2. Under a bar, a budget stop before a revision is reviewed keeps the best reviewed version.
const v2Scores = (dept, label, calls) => (dept === 'cinematographer' ? (camReviews(calls) === 1 ? [9, 9, 9, 9] : [7, 7, 7, 7]) : null)
const sV2a = makeStub({ scores: v2Scores })
await run({ command: 'IDEA', idea: IDEA, targets: { cinematographer: { min: 10, rounds: 5 } } }, sV2a.agent, sV2a.parallel, noop, noop)
const stopV2 = sV2a.calls.findIndex(c => c.label === 'cinematographer · review 2')
const sV2 = makeStub({ scores: v2Scores })
const rV2a = await run({ command: 'IDEA', idea: IDEA, targets: { cinematographer: { min: 10, rounds: 5 } }, maxAgentCalls: stopV2 }, sV2.agent, sV2.parallel, noop, noop)
const qV2a = rV2a.project_state.artifacts.camera_plan.quality
const rV2 = await run({ command: 'APPROVE', priorState: J(rV2a.project_state) }, sV2.agent, sV2.parallel, noop, noop)
const qV2 = rV2.project_state.artifacts.camera_plan.quality
ok(qV2a.pending === 'revise' && qV2a.min === 9 && !qV2a.kept_round && qV2.min === 9 && !qV2.incomplete, 'V2: a stop before reviewing a revision keeps the 9s version through the resume: ' + JSON.stringify({ paused: qV2a.pending, m: qV2.min, k: qV2.kept_round }))

// B4. Blocked work is never kept as the best version.
let blockNext = false
const sB4 = makeStub({ scores: (dept, label, calls) => (dept === 'cinematographer' ? (camReviews(calls) <= 1 ? [9, 9, 9, 9] : [8, 8, 8, 8]) : null) })
const agentB4 = async (prompt, o) => { if (blockNext && o.label === 'cinematographer · resume revision') { blockNext = false; return { status: 'blocked', based_on: [], content: { shots: [] }, asset_uri: null, assumptions: [], sources: [], blockers: ['Need an answer'] } } return sB4.agent(prompt, o) }
const rB40 = await run({ command: 'IDEA', idea: IDEA }, agentB4, sB4.parallel, noop, noop)
blockNext = true
const rB41 = await run({ command: 'APPROVE', priorState: J(rB40.project_state), targets: { cinematographer: { min: 10, rounds: 2 } } }, agentB4, sB4.parallel, noop, noop)
const rB4 = await run({ command: 'APPROVE', priorState: J(rB41.project_state) }, agentB4, sB4.parallel, noop, noop)
const camB4 = rB4.project_state.artifacts.camera_plan
ok(camB4.status !== 'blocked' && camB4.content.shots.length > 0, 'B4: a blocked version is never kept over real work: ' + JSON.stringify({ st: camB4.status, shots: (camB4.content.shots || []).length }))

// X2. Gates mode: after direction reopens the routes, picking a different route rebuilds on it.
const sX2 = makeStub()
const rX20 = await run({ command: 'IDEA', idea: IDEA, review: 'gates' }, sX2.agent, sX2.parallel, noop, noop)
const rX21 = await run({ command: 'APPROVE', priorState: J(rX20.project_state), approvals: { concept: approve({ decision_id: 'dec_X21', selected_route_id: 'R2' }) } }, sX2.agent, sX2.parallel, noop, noop)
const rX22 = await run({ command: 'APPROVE', priorState: J(rX21.project_state), direction: [{ id: 'LD-01', note: 'ROUTES-NOTE', departments: ['creative_director'] }] }, sX2.agent, sX2.parallel, noop, noop)
ok(rX22.pending_gate.gate_id === 'concept' && rX22.project_state.selected_concept_id === 'R2', 'X2: reopened routes keep the route built until Lucas picks again')
const x2 = sX2.calls.length
const rX2 = await run({ command: 'APPROVE', priorState: J(rX22.project_state), approvals: { concept: approve({ decision_id: 'dec_X23', selected_route_id: 'R3' }) } }, sX2.agent, sX2.parallel, noop, noop)
const cwX2 = sX2.calls.slice(x2).find(c => c.label === 'copywriter')
ok(rX2.project_state.selected_concept_id === 'R3' && rX2.pending_gate.gate_id === 'production_plan' && rX2.project_state.approval_log.some(e => e.gate_id === 'concept' && e.decision === 'approved' && e.decision_id === 'dec_X23') && cwX2 && !cwX2.prompt.includes('Your last version'), 'X2: picking R3 rebuilds on R3 from scratch and records the approval')

// W2. An approval sent with new direction isn't applied; its comment is kept. A route change is.
const sW2 = makeStub()
const rW20 = await run({ command: 'IDEA', idea: IDEA }, sW2.agent, sW2.parallel, noop, noop)
const rW21 = await run({ command: 'APPROVE', priorState: J(rW20.project_state), approvals: { production_plan: approve({ decision_id: 'dec_W21', selected_route_id: 'R2' }) } }, sW2.agent, sW2.parallel, noop, noop)
const rW2 = await run({ command: 'APPROVE', priorState: J(rW21.project_state), approvals: { production_plan: approve({ decision_id: 'dec_W22', selected_route_id: 'R2', comment: 'APPROVAL-COMMENT' }) }, direction: [{ id: 'LD-01', note: 'D', departments: ['cinematographer'] }] }, sW2.agent, sW2.parallel, noop, noop)
ok(rW2.project_state.approval_log.some(e => e.decision === 'not_applied' && e.decision_id === 'dec_W22') && (rW2.project_state.human_notes || []).some(n => n.note === 'APPROVAL-COMMENT') && rW2.pending_gate.gate_id === 'production_plan', 'W2: an approval sent with direction is logged not applied, its comment kept, and the package returns')
const rW3 = await run({ command: 'APPROVE', priorState: J(rW20.project_state), approvals: { production_plan: approve({ decision_id: 'dec_W23', selected_route_id: 'R3', route_change: true }) }, direction: [{ id: 'LD-01', note: 'D', departments: ['cinematographer'] }] }, sW2.agent, sW2.parallel, noop, noop)
ok(rW3.project_state.selected_concept_id === 'R3' && rW3.pending_gate.gate_id === 'production_plan' && !rW3.project_state.approval_log.some(e => e.decision_id === 'dec_W23' && e.decision === 'approved' && e.gate_id === 'production_plan'), 'W2: a route change at the gate sent with direction still rebuilds on its route, unapproved')

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
if (fails) process.exit(1)
