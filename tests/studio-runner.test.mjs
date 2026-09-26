// End-to-end test of tools/studio.mjs with stub agents: new -> run -> save -> package.md and
// desk.json -> approve (version-checked) -> run -> save. Uses a scratch project it deletes.
// Run: node tests/studio-runner.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadWorkflow } from './load-workflow.mjs'
import { makeStub } from './stub-agents.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SLUG = 'zz-runner-test'
const DIR = path.join(ROOT, 'projects', SLUG)
const studio = (...a) => execFileSync('node', [path.join(ROOT, 'tools/studio.mjs'), ...a], { cwd: ROOT, encoding: 'utf8' })
const studioFails = (...a) => { try { studio(...a); return null } catch (e) { return String(e.stderr || e.message) } }
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const tmp = fs.mkdtempSync(path.join(fs.mkdtempSync('/tmp/studio-'), 'x'))

async function runOnce(outName, stub) {
  const run = await loadWorkflow(path.join(DIR, '.run.js'))
  const s = stub || makeStub()
  const result = await run({}, s.agent, s.parallel, () => {}, () => {})
  const out = path.join(tmp, outName)
  fs.writeFileSync(out, JSON.stringify({ result, totalTokens: 123456 }))
  return out
}

fs.rmSync(DIR, { recursive: true, force: true })
try {
  studio('new', SLUG, 'Emberline makes a cast-iron skillet, pre-seasoned with flaxseed oil, $38 and $$ and $& kept literally. A dad teaching his kid breakfast.', '--idea-id', 'idea-zz')
  ok(fs.readFileSync(path.join(DIR, '.run.js'), 'utf8').includes('$$ and $& kept literally'), 'the idea is embedded literally, $ patterns included')
  studio('save', SLUG, await runOnce('1.json', makeStub({ score: (d, l) => (d === 'sound_designer' ? 6 : 8), panel: (lens, round) => (lens === 'client' ? { ok: false, notes: [{ responsible: 'copywriter', target: 'B2', note: 'PANEL-NOTE-X', source: 's' }] } : { ok: true }) })))
  const pkg = fs.readFileSync(path.join(DIR, 'package.md'), 'utf8')
  const desk = JSON.parse(fs.readFileSync(path.join(DIR, 'desk.json'), 'utf8'))
  const gate = desk.find(d => d.collection === 'gates').data
  ok(pkg.includes('### D01 · 30s 9:16') && /\| S2 \| 15\.0s \|/.test(pkg) && /### D02 · 1 still\(s\) 4:5[\s\S]*?\| K1 \|/.test(pkg), 'package.md has the board as timed tables per deliverable')
  ok(pkg.includes('Every shot in full') && pkg.includes('#### S1') && pkg.includes('board note'), 'package.md has every shot in full, with the board\'s fields')
  ok(pkg.includes('Every job in full') && pkg.includes('acceptance checks') && pkg.includes('method'), 'package.md has every generation job in full')
  ok(pkg.includes('Open panel notes') && pkg.includes('PANEL-NOTE-X'), 'package.md lists the open panel notes when below A')
  ok(pkg.includes('What keeps these below A') && pkg.includes('name the object'), 'package.md says why a department is below A')
  ok(pkg.includes('0.12M tokens'), 'package.md reports the run\'s tokens')
  ok(gate.panel.lenses.some(l => l.notes.some(n => n.note === 'PANEL-NOTE-X')) && gate.departments.some(x => x.grade === 'below_A' && x.notes.length), 'the desk gets lens notes and department reasons')
  ok(desk.some(d => d.collection === 'ideas' && d.id === 'idea-zz' && d.data.status === 'in_review'), 'the idea card moves to in review')
  const decision = f => { const p = path.join(tmp, f.name); fs.writeFileSync(p, JSON.stringify(f)); return p }
  const shown = gate.review_items.map(i => `${i.artifact_id}@r${i.revision}`)
  const stale = studioFails('approve', SLUG, decision({ name: 'd1.json', id: 'dec1', gate_id: 'production_plan', decision: 'approved', selected_route_id: gate.built_route_id, approver_id: 'u_L', decided_at: 'x', artifact_ids_and_revisions: shown.slice(1) }))
  ok(stale && stale.includes('the desk card showed'), 'an approval of versions that differ from the current package is refused')
  const wrongGate = studioFails('approve', SLUG, decision({ name: 'd2.json', id: 'dec2', gate_id: 'concept', decision: 'approved', approver_id: 'u_L', artifact_ids_and_revisions: shown }))
  ok(wrongGate && wrongGate.includes('not waiting on the concept gate'), 'an approval for a gate the project isn\'t at is refused')
  // A route change rebuilds and comes back unapproved; replaying the same decision is refused.
  const other = gate.routes.map(r => r.route_id).find(id => id !== gate.built_route_id)
  const rc = decision({ name: 'rc.json', id: 'dec_rc', gate_id: 'production_plan', decision: 'route_change', selected_route_id: other, approver_id: 'u_L', decided_at: 'x', artifact_ids_and_revisions: shown })
  studio('approve', SLUG, rc)
  studio('save', SLUG, await runOnce('rc-out.json'))
  const afterRc = JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf8'))
  ok(afterRc.selected_concept_id === other && afterRc.pending_gate.gate_id === 'production_plan' && !afterRc.approval_log.some(e => e.gate_id === 'production_plan' && e.decision === 'approved'), 'a route change rebuilds on the new route and comes back unapproved')
  const replay = studioFails('approve', SLUG, rc)
  ok(replay && (replay.includes('already applied') || replay.includes('already built')), 'replaying the same route change is refused')
  const gate2 = JSON.parse(fs.readFileSync(path.join(DIR, 'desk.json'), 'utf8')).find(d => d.collection === 'gates').data
  const shown2 = gate2.review_items.map(i => `${i.artifact_id}@r${i.revision}`)
  studio('approve', SLUG, decision({ name: 'd3.json', id: 'dec3', gate_id: 'production_plan', decision: 'approved', selected_route_id: gate2.built_route_id, approver_id: 'u_L', decided_at: 'x', artifact_ids_and_revisions: shown2 }))
  studio('save', SLUG, await runOnce('2.json'))
  const st = JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf8'))
  ok(st.approval_log.some(e => e.gate_id === 'production_plan' && e.decision === 'approved' && e.decision_id === 'dec3') && st.production_plan_applied, 'the checked approval is applied')
  ok(studio('status', SLUG).includes('package approved'), 'status says the package is approved')
  const idea = JSON.parse(fs.readFileSync(path.join(DIR, 'desk.json'), 'utf8')).find(d => d.collection === 'ideas')
  ok(idea && idea.data.status === 'done', 'the idea card reaches done once the package is approved')
} finally {
  fs.rmSync(DIR, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
if (fails) process.exit(1)
