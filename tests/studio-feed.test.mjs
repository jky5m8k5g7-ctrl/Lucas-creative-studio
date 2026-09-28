// Tests for tools/studio-feed.mjs against a scratch projects folder (passed with --projects) that
// it deletes. Run: node tests/studio-feed.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEPTS, KEY } from '../tools/studio-depts.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(ROOT, 'tools/studio-feed.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-feed-'))
const P = path.join(tmp, 'projects')
const OUT = path.join(tmp, 'out')
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

const MIN = 60 * 1000
const setAge = (f, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(f, t, t) }
const scores = n => ({ specificity: n, distinctiveness: n, fit: n, craft: n })
// Every department's work, graded A at 8 unless overridden.
function artifacts(over = {}) {
  const a = {}
  Object.values(KEY).forEach((k, i) => { a[k] = { artifact_id: `${k}-${String(i + 1).padStart(3, '0')}`, revision: 1, status: 'draft', quality: { grade: 'A', min: 8, rounds: 2, scores: scores(8) }, blockers: [] } })
  for (const [k, v] of Object.entries(over)) { if (v === null) delete a[k]; else a[k] = { ...a[k], ...v } }
  return a
}
function state(over = {}) {
  return { project_id: 'P', brief: { name: 'Brief Name', format: 'ad_spot', budget: {} }, artifacts: artifacts(), approvals: {}, decision_log: [], approval_log: [], pending_gate: null, needs_human_input: [], open_questions: [], stage_reached: '08_generation_plan', limit_reached: false, settings: { idea_mode: true, quality: true, review_at_end: true }, ...over }
}
// A run's journal, last changed `ageMs` ago.
function journal(name, ageMs) {
  const dir = path.join(tmp, 'runs', name)
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'journal.jsonl')
  fs.writeFileSync(f, JSON.stringify({ type: 'launched' }) + '\n')
  setAge(f, ageMs)
  return dir
}
function project(slug, st, extra = {}) {
  const dir = path.join(P, slug)
  fs.mkdirSync(dir, { recursive: true })
  if (st !== undefined) fs.writeFileSync(path.join(dir, 'state.json'), typeof st === 'string' ? st : JSON.stringify(st))
  if (extra.idea) fs.writeFileSync(path.join(dir, 'idea.json'), JSON.stringify(extra.idea))
  if (extra.direction) fs.writeFileSync(path.join(dir, 'direction.json'), JSON.stringify(extra.direction))
  if (extra.live) fs.writeFileSync(path.join(dir, '.live-run'), JSON.stringify(extra.live))
  return dir
}
let n = 0
function feed(...extra) {
  const out = path.join(OUT, `studio${++n}.json`)
  const r = spawnSync('node', [TOOL, '--out', out, '--projects', P, ...extra], { cwd: ROOT, encoding: 'utf8' })
  let snap = null
  try { snap = JSON.parse(fs.readFileSync(out, 'utf8')) } catch {}
  return { snap, stdout: r.stdout, stderr: r.stderr, code: r.status }
}
const proj = (s, slug) => s.projects.find(p => p.slug === slug)
const dept = (p, id) => p.departments.find(d => d.dept === id)

try {
  const long = 'A logline that runs on and on. '.repeat(12)
  // Approved, with Lucas's bars (one met, one missed), a department below A, one not graded and one not built.
  project('alpha', state({
    stage_reached: '09_production_plan_approved', production_plan_applied: true,
    approvals: { concept: { approved: true }, production_plan: { approved: true, approver_id: 'u1' } },
    settings: { idea_mode: true, quality: true, review_at_end: true, targets: { cinematographer: { min: 10, rounds: 5 }, storyboard_artist: { min: 9, rounds: 3 } } },
    artifacts: artifacts({
      development: { content: { working_title: 'Alpha Title', format: 'music_video', logline: long } },
      camera_plan: { quality: { grade: 'A', min: 9, rounds: 5, scores: scores(9), target: 10, met_target: false } },
      storyboard: { quality: { grade: 'A', min: 9, rounds: 2, scores: scores(9), target: 9, met_target: true } },
      script: { quality: { grade: 'below_A', min: 7, rounds: 3, scores: scores(7) }, blockers: [{ issue: 'Which city?', responsible_agent: 'Lucas' }] },
      sound_plan: { quality: undefined },
      generation_plan: null,
    }),
    package_review: { round: 3, grade: 'below_A', approvals: 1, of: 3, complete: true, lenses: [] },
    direction: [{ id: 'LD-01', note: 'Film look', departments: ['cinematographer'] }],
    needs_human_input: ['Q1'], open_questions: ['Q1', 'Q2'],
  }), { direction: { direction: [{ id: 'LD-01' }, { id: 'LD-02', note: 'More grain', departments: ['cinematographer'] }], targets: {} }, live: { journals: [{ dir: journal('alpha', 24 * 60 * MIN) }], finished: 'Approved' } })

  // Waiting on the package gate, with bars set in direction.json the saved state doesn't have yet.
  const bravo = project('bravo', state({
    pending_gate: { gate_id: 'production_plan', artifacts_for_review: [] }, stage_reached: '10_package_review',
    artifacts: artifacts({ script: { quality: { grade: 'A', min: 9, rounds: 2, scores: scores(9) } }, camera_plan: { quality: { grade: 'A', min: 9, rounds: 2, scores: scores(9) } } }),
    package_review: { round: 1, grade: 'A', approvals: 3, of: 3, complete: true, lenses: [] },
  }), { direction: { direction: [], targets: { copywriter: { min: 9, rounds: 3 }, cinematographer: { min: 10, rounds: 3 } } } })
  setAge(path.join(bravo, 'state.json'), 90 * MIN)

  // Building: a fresh journal on an unfinished run (its saved state is at the route gate, gates mode).
  project('charlie', state({ pending_gate: { gate_id: 'concept' }, stage_reached: '03_concepts', settings: { idea_mode: true, quality: true, review_at_end: false } }), { live: { journals: [{ dir: journal('charlie-1', 300 * MIN), lines: 5 }, { dir: journal('charlie-2', 1 * MIN) }], run: 'wf_c' } })
  // Paused: an unfinished run whose journal has been quiet for two hours.
  project('delta', state(), { live: { journal: journal('delta', 120 * MIN) } })
  // Blocked: the strategy came back blocked and needs Lucas's answers.
  project('foxtrot', state({ pending_gate: { gate_id: 'concept', blocked_by: ['strategy'] }, stage_reached: '03_concepts' }))
  // Blocked: the package gate can't be approved while work is stale.
  project('hotel', state({ pending_gate: { gate_id: 'production_plan', blocked_by_stale: ['storyboard', 'generation_plan'] } }))
  // A new project: an idea and no saved state yet.
  project('golf', undefined, { idea: { idea: 'A short film about a lighthouse keeper who collects lost umbrellas.', hints: {} } })
  // Never listed: test and scratch projects, dot folders, a corrupt state, a folder with nothing in it.
  project('test-hidden', state())
  project('zz-hidden', state())
  project('.hidden', state())
  project('echo', '{"stage_reached": "02_str')
  project('empty')

  const a = feed()
  const s = a.snap
  ok(a.code === 0 && !!s, 'runs and writes a snapshot: ' + a.stderr.trim())
  ok(s && JSON.stringify(Object.keys(s)) === JSON.stringify(['written_at', 'floor_project', 'building', 'agents_working', 'totals', 'projects', 'production']), 'the snapshot has the studio fields, in order')
  const slugs = s.projects.map(p => p.slug).sort()
  ok(JSON.stringify(slugs) === JSON.stringify(['alpha', 'bravo', 'charlie', 'delta', 'foxtrot', 'golf', 'hotel']), 'test-, zz-, dot, corrupt and empty folders are not listed: ' + slugs.join(','))
  ok(/echo/.test(a.stderr) && /state\.json/.test(a.stderr), 'a corrupt state.json is skipped with a warning')
  ok(a.stdout.trim().split('\n').length === 1 && /7 projects/.test(a.stdout), 'prints one summary line: ' + a.stdout.trim())
  ok(fs.readdirSync(OUT).every(f => !f.endsWith('.tmp')), 'no temp file is left behind')
  const p0 = proj(s, 'alpha')
  ok(JSON.stringify(Object.keys(p0)) === JSON.stringify(['slug', 'title', 'format', 'logline', 'status', 'status_text', 'stage', 'gate', 'package', 'departments', 'open_questions', 'direction', 'next', 'updated_at']), 'each project has the contract fields, in order')

  // Approved.
  ok(p0.status === 'approved' && p0.gate === null && p0.stage === '09_production_plan_approved' && /approved/.test(p0.status_text) && /spend cap/.test(p0.next), 'an applied package approval reads approved: ' + JSON.stringify([p0.status, p0.status_text, p0.next]))
  ok(p0.title === 'Alpha Title' && p0.format === 'music_video' && p0.logline.length <= 220 && p0.logline.endsWith('…'), 'title, format and a clipped logline come from the development')
  ok(JSON.stringify(p0.package) === JSON.stringify({ grade: 'below_A', would_approve: 1, reviewers: 3, rounds: 3 }), 'the package panel: ' + JSON.stringify(p0.package))
  ok(p0.direction === 2 && p0.open_questions === 3, "Lucas's direction notes (state and direction.json) and open questions are counted: " + JSON.stringify([p0.direction, p0.open_questions]))

  // Departments.
  ok(JSON.stringify(p0.departments.map(d => [d.dept, d.name])) === JSON.stringify(DEPTS.map(([d, nm]) => [d, nm])), 'the twelve departments, with the live feed\'s ids and names')
  const cam = dept(p0, 'cinematographer')
  ok(cam.grade === 'A' && cam.min === 9 && cam.target === 10 && cam.met_target === false, 'a bar of 10 missed at 9: ' + JSON.stringify(cam))
  const sb = dept(p0, 'storyboard_artist')
  ok(sb.grade === 'A' && sb.target === 9 && sb.met_target === true, 'a bar of 9 met')
  ok(dept(p0, 'copywriter').grade === 'below_A' && dept(p0, 'copywriter').min === 7, 'a department below A')
  ok(dept(p0, 'sound_designer').grade === 'not_graded' && dept(p0, 'generation_supervisor').grade === null && dept(p0, 'generation_supervisor').min === null, 'work with no review is not_graded; work not built has no grade')
  ok(dept(p0, 'director').target === null && dept(p0, 'director').met_target === null, 'no bar: target and met_target are null')
  const pb = proj(s, 'bravo')
  ok(dept(pb, 'copywriter').target === 9 && dept(pb, 'copywriter').met_target === true && dept(pb, 'cinematographer').target === 10 && dept(pb, 'cinematographer').met_target === false, 'bars from direction.json that the state has not reviewed against yet: met and missed')

  // Waiting.
  ok(pb.status === 'waiting' && pb.gate && pb.gate.id === 'production_plan' && pb.gate.label && /review/.test(pb.status_text) && /Approval Desk/.test(pb.next), 'waiting at the production_plan gate: ' + JSON.stringify([pb.status, pb.gate, pb.status_text]))
  ok(pb.gate.since === fs.statSync(path.join(bravo, 'state.json')).mtime.toISOString(), 'the gate is waiting since its state was saved')
  ok(pb.package.grade === 'A' && pb.package.would_approve === 3, 'a package graded A')

  // Building, paused, blocked, new.
  const pc = proj(s, 'charlie')
  ok(pc.status === 'building' && pc.gate === null && /Building now/.test(pc.status_text) && /Approval Desk/.test(pc.next), 'a fresh journal on an unfinished run is building: ' + JSON.stringify([pc.status, pc.status_text, pc.next]))
  const pd = proj(s, 'delta')
  ok(pd.status === 'paused' && /stopped without finishing/.test(pd.status_text) && /resume delta/.test(pd.next), 'an unfinished run with a stale journal is paused: ' + JSON.stringify([pd.status, pd.status_text]))
  const pf = proj(s, 'foxtrot')
  ok(pf.status === 'blocked' && pf.gate && pf.gate.id === 'concept' && /answers/.test(pf.status_text), 'blocked direction needs Lucas: ' + JSON.stringify([pf.status, pf.status_text]))
  const ph = proj(s, 'hotel')
  ok(ph.status === 'blocked' && /2 pieces are out of date/.test(ph.status_text) && /resume hotel/.test(ph.next), 'a package gate with stale work is blocked: ' + ph.status_text)
  const pg = proj(s, 'golf')
  ok(pg.status === 'in_progress' && pg.stage === '00_idea' && pg.title === 'Golf' && /lighthouse/.test(pg.logline) && pg.departments.every(d => d.grade === null), 'a new project with only its idea is listed: ' + JSON.stringify([pg.status, pg.title]))

  // The studio: floor, building, totals, order.
  ok(s.floor_project === 'charlie' && s.building === 'charlie' && s.agents_working === 0, 'without --run the floor is the newest journal, and no agents are counted: ' + JSON.stringify([s.floor_project, s.building, s.agents_working]))
  ok(JSON.stringify(s.totals) === JSON.stringify({ projects: 7, building: 1, waiting_on_you: 3, approved: 1 }), 'totals (blocked and waiting both wait on Lucas): ' + JSON.stringify(s.totals))
  ok(s.projects[0].slug === 'charlie' && s.projects[s.projects.length - 1].slug === 'alpha', 'the building project comes first, approved work last: ' + s.projects.map(p => p.slug).join(','))
  ok(s.production.locked === true && s.production.stages.length === 5 && /spend cap/.test(s.production.reason), 'paid media is locked')

  // --run: the floor's snapshot supplies the agents working on the building project.
  const runFile = path.join(tmp, 'run.json')
  fs.writeFileSync(runFile, JSON.stringify({ project: 'charlie', phase: 'Camera', finished: null, calls: { started: 10, done: 6, running: 4 } }))
  const r = feed('--run', runFile).snap
  ok(r.floor_project === 'charlie' && r.agents_working === 4 && proj(r, 'charlie').status_text === 'Building now: Camera.', '--run supplies the agents working and the phase: ' + JSON.stringify([r.agents_working, proj(r, 'charlie').status_text]))
  fs.writeFileSync(runFile, JSON.stringify({ project: 'alpha', phase: 'Approved', finished: 'Approved', calls: { started: 9, done: 9, running: 0 } }))
  const r2 = feed('--run', runFile).snap
  ok(r2.floor_project === 'alpha' && r2.building === 'charlie' && r2.agents_working === 0, 'a --run for another project names the floor but counts no agents on the building one')
  const r3 = feed('--run', path.join(tmp, 'missing.json'))
  ok(r3.code === 0 && r3.snap.floor_project === 'charlie' && /run snapshot/.test(r3.stderr), 'an unreadable --run is warned about and ignored')

  // Nothing building: agents_working is 0 and building is null.
  fs.rmSync(path.join(P, 'charlie', '.live-run'))
  const q = feed().snap
  ok(q.building === null && q.agents_working === 0 && q.totals.building === 0 && proj(q, 'charlie').status === 'waiting', 'with no build running, the saved state decides: ' + proj(q, 'charlie').status)

  const u = spawnSync('node', [TOOL], { encoding: 'utf8' })
  ok(u.status === 2 && /usage/.test(u.stderr), 'no --out prints usage')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
if (fails) process.exit(1)
