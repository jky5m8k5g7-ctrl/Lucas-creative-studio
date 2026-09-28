// Tests for tools/studio-feed.mjs against scratch projects folders (passed with --projects) that
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
// A run's journal, last changed `ageMs` ago; with `agentMs`, an agent's transcript beside it (and
// its meta file, from when the call started) last changed that long ago.
function journal(name, ageMs, agentMs) {
  const dir = path.join(tmp, 'runs', name)
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'journal.jsonl')
  fs.writeFileSync(f, JSON.stringify({ type: 'launched' }) + '\n')
  setAge(f, ageMs)
  if (agentMs != null) {
    fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), '{}')
    setAge(path.join(dir, 'agent-a1.meta.json'), ageMs)
    fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), '{}\n')
    setAge(path.join(dir, 'agent-a1.jsonl'), agentMs)
  }
  return dir
}
function project(slug, st, extra = {}, root = P) {
  const dir = path.join(root, slug)
  fs.mkdirSync(dir, { recursive: true })
  if (st !== undefined) fs.writeFileSync(path.join(dir, 'state.json'), typeof st === 'string' ? st : JSON.stringify(st))
  if (extra.idea) fs.writeFileSync(path.join(dir, 'idea.json'), JSON.stringify(extra.idea))
  if (extra.direction) fs.writeFileSync(path.join(dir, 'direction.json'), JSON.stringify(extra.direction))
  if (extra.live) fs.writeFileSync(path.join(dir, '.live-run'), JSON.stringify(extra.live))
  return dir
}
let n = 0
const feed = (...extra) => feedIn(P, ...extra)
function feedIn(projects, ...extra) {
  const out = path.join(OUT, `studio${++n}.json`)
  const r = spawnSync('node', [TOOL, '--out', out, '--projects', projects, ...extra], { cwd: ROOT, encoding: 'utf8' })
  let snap = null
  try { snap = JSON.parse(fs.readFileSync(out, 'utf8')) } catch {}
  return { snap, stdout: r.stdout, stderr: r.stderr, code: r.status }
}
const proj = (s, slug) => s.projects.find(p => p.slug === slug)
const dept = (p, id) => p.departments.find(d => d.dept === id)
const runSnap = (name, v) => { const f = path.join(tmp, `${name}.json`); fs.writeFileSync(f, JSON.stringify(v)); return f }
// A scratch projects folder of its own, for a case that must not change the main one's totals.
const folder = name => { const d = path.join(tmp, 'folders', name); fs.mkdirSync(d, { recursive: true }); return d }

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
  // Lucas approved the route; the next run applies it.
  project('india', state({ pending_gate: { gate_id: 'concept' }, approvals: { concept: { approved: true } }, stage_reached: '03_concepts' }))
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
  ok(JSON.stringify(slugs) === JSON.stringify(['alpha', 'bravo', 'charlie', 'delta', 'foxtrot', 'golf', 'hotel', 'india']), 'test-, zz-, dot, corrupt and empty folders are not listed: ' + slugs.join(','))
  ok(/echo/.test(a.stderr) && /state\.json/.test(a.stderr), 'a corrupt state.json is skipped with a warning')
  ok(a.stdout.trim().split('\n').length === 1 && /8 projects/.test(a.stdout), 'prints one summary line: ' + a.stdout.trim())
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
  ok(JSON.stringify(Object.keys(p0.departments[0])) === JSON.stringify(['dept', 'name', 'state', 'grade', 'min', 'target', 'met_target']), 'each department row has its state, grade, lowest score and bar')
  const cam = dept(p0, 'cinematographer')
  ok(cam.grade === 'A' && cam.min === 9 && cam.target === 10 && cam.met_target === false, 'a bar of 10 missed at 9: ' + JSON.stringify(cam))
  const sb = dept(p0, 'storyboard_artist')
  ok(sb.grade === 'A' && sb.target === 9 && sb.met_target === true, 'a bar of 9 met')
  ok(dept(p0, 'copywriter').grade === 'below_A' && dept(p0, 'copywriter').min === 7, 'a department below A')
  ok(dept(p0, 'sound_designer').grade === 'not_graded' && dept(p0, 'sound_designer').state === 'done' && dept(p0, 'generation_supervisor').grade === null && dept(p0, 'generation_supervisor').min === null && dept(p0, 'generation_supervisor').state === 'not_built', 'work with no review is done and not_graded; work not built has no grade: ' + JSON.stringify([dept(p0, 'sound_designer'), dept(p0, 'generation_supervisor')]))
  ok(dept(p0, 'director').target === null && dept(p0, 'director').met_target === null, 'no bar: target and met_target are null')
  const pb = proj(s, 'bravo')
  ok(dept(pb, 'copywriter').target === 9 && dept(pb, 'copywriter').met_target === true && dept(pb, 'cinematographer').target === 10 && dept(pb, 'cinematographer').met_target === false, 'bars from direction.json that the state has not reviewed against yet: met and missed')

  // Waiting.
  ok(pb.status === 'waiting' && pb.gate && pb.gate.id === 'production_plan' && pb.gate.label === 'Package approval' && /review/.test(pb.status_text) && /Approval Desk/.test(pb.next), 'waiting at the production_plan gate: ' + JSON.stringify([pb.status, pb.gate, pb.status_text]))
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
  const pi = proj(s, 'india')
  ok(pi.status === 'in_progress' && pi.gate === null && pi.status_text === 'You approved the route. The next run applies it.', 'a gate decision the next run has yet to apply: ' + pi.status_text)
  const pg = proj(s, 'golf')
  ok(pg.status === 'in_progress' && pg.stage === '00_idea' && pg.title === 'Golf' && /lighthouse/.test(pg.logline) && pg.departments.every(d => d.grade === null), 'a new project with only its idea is listed: ' + JSON.stringify([pg.status, pg.title]))

  // The studio: floor, building, totals, order.
  ok(s.floor_project === 'charlie' && s.building === 'charlie' && s.agents_working === null, 'without --run the floor is the newest journal, and the agents working are unknown (null): ' + JSON.stringify([s.floor_project, s.building, s.agents_working]))
  ok(/charlie building \(agents unknown/.test(a.stdout), 'the summary line says the agents are unknown: ' + a.stdout.trim())
  ok(JSON.stringify(s.totals) === JSON.stringify({ projects: 8, building: 1, waiting_on_you: 3, approved: 1 }), 'totals (blocked and waiting both wait on Lucas): ' + JSON.stringify(s.totals))
  const order = s.projects.map(p => p.status)
  ok(JSON.stringify(order) === JSON.stringify(['waiting', 'blocked', 'blocked', 'building', 'paused', 'in_progress', 'in_progress', 'approved']), 'what waits on Lucas comes first, then the build, approved work last: ' + s.projects.map(p => `${p.slug} ${p.status}`).join(', '))
  ok(s.projects.every(p => !/;|: /.test(p.status_text) && !/;|: /.test(p.next || '')), 'status lines and next steps are plain sentences, with no colons or semicolons')
  ok(s.production.locked === true && s.production.stages.length === 5 && /spend cap/.test(s.production.reason), 'paid media is locked')

  // --run: the floor's snapshot supplies the agents working on the building project.
  const runFile = path.join(tmp, 'run.json')
  fs.writeFileSync(runFile, JSON.stringify({ project: 'charlie', phase: 'Camera', finished: null, calls: { started: 10, done: 6, running: 4 } }))
  const r = feed('--run', runFile).snap
  ok(r.floor_project === 'charlie' && r.agents_working === 4 && proj(r, 'charlie').status_text === 'Building now, at the camera stage.', '--run supplies the agents working and the phase: ' + JSON.stringify([r.agents_working, proj(r, 'charlie').status_text]))
  fs.writeFileSync(runFile, JSON.stringify({ project: 'alpha', phase: 'Approved', finished: 'Approved', calls: { started: 9, done: 9, running: 0 } }))
  const r2 = feed('--run', runFile).snap
  ok(r2.floor_project === 'alpha' && r2.building === 'charlie' && r2.agents_working === null, 'a --run for another project names the floor, and the building one\'s agents are unknown (null): ' + JSON.stringify([r2.floor_project, r2.building, r2.agents_working]))
  const r4 = feed('--run', runSnap('charlie-finished', { project: 'charlie', phase: 'Wrapped', finished: 'Wrapped', calls: { started: 10, done: 9, running: 1 } })).snap
  ok(r4.building === 'charlie' && r4.agents_working === 0, 'a finished run snapshot for the building project counts no agents, even with a call it never saw return: ' + JSON.stringify([r4.building, r4.agents_working]))
  const r3 = feed('--run', path.join(tmp, 'missing.json'))
  ok(r3.code === 0 && r3.snap.floor_project === 'charlie' && /run snapshot/.test(r3.stderr), 'an unreadable --run is warned about and ignored')

  // Nothing building: agents_working is 0 and building is null.
  fs.rmSync(path.join(P, 'charlie', '.live-run'))
  const q = feed().snap
  ok(q.building === null && q.agents_working === 0 && q.totals.building === 0 && proj(q, 'charlie').status === 'waiting', 'with no build running, the saved state decides: ' + proj(q, 'charlie').status)

  // A long call: the journal has been quiet 50 minutes, but the agent's transcript changed just now.
  {
    const d = folder('long-call')
    project('kilo', state({ stage_reached: '05_direction_style_sound' }), { live: { journals: [{ dir: journal('kilo', 50 * MIN, 2 * MIN) }], run: 'wf_k' } }, d)
    project('lima', state({ stage_reached: '05_direction_style_sound' }), { live: { journals: [{ dir: journal('lima', 50 * MIN, 50 * MIN) }], run: 'wf_l' } }, d)
    const x = feedIn(d, '--run', runSnap('kilo-run', { project: 'kilo', phase: 'Camera', finished: null, calls: { started: 9, done: 8, running: 1 } })).snap
    const k = proj(x, 'kilo'), l = proj(x, 'lima')
    ok(k.status === 'building' && x.building === 'kilo' && x.agents_working === 1 && !/resume/.test(k.next), 'a call that runs longer than the quiet limit keeps its build building (its transcript changes): ' + JSON.stringify([k.status, k.next, x.agents_working]))
    ok(l.status === 'paused' && l.next === 'Tell Claude "resume lima" to pick it up where it stopped', 'a run whose journal and transcripts are all quiet is paused: ' + JSON.stringify([l.status, l.next]))
    ok(Date.parse(k.updated_at) > Date.now() - 5 * MIN, 'a building project was updated when its transcript last changed: ' + k.updated_at)
  }

  // Two builds at once: the floor's build stays the one building, whichever journal wrote last.
  {
    const d = folder('two-builds')
    const jm = journal('mike', 2 * MIN)
    const jn = journal('november', 1 * MIN)
    project('mike', state(), { live: { journals: [{ dir: jm }], run: 'wf_m' } }, d)
    project('november', state(), { live: { journals: [{ dir: jn }], run: 'wf_n' } }, d)
    const onMike = runSnap('mike-run', { project: 'mike', phase: 'Camera', finished: null, calls: { started: 10, done: 7, running: 3 } })
    const seen = []
    const x1 = feedIn(d, '--run', onMike).snap; seen.push([x1.building, x1.agents_working])
    fs.appendFileSync(path.join(jm, 'journal.jsonl'), '{"type":"result"}\n')
    const x2 = feedIn(d, '--run', onMike).snap; seen.push([x2.building, x2.agents_working])
    fs.appendFileSync(path.join(jn, 'journal.jsonl'), '{"type":"result"}\n')
    const x3 = feedIn(d, '--run', onMike).snap; seen.push([x3.building, x3.agents_working])
    ok(seen.every(([b, n]) => b === 'mike' && n === 3) && x3.totals.building === 2, 'with two builds running, building stays the floor\'s project and its agents are counted on every write: ' + JSON.stringify(seen))
    const x4 = feedIn(d, '--run', runSnap('mike-done', { project: 'mike', phase: 'Wrapped', finished: 'Wrapped', calls: { started: 10, done: 10, running: 0 } })).snap
    ok(x4.building === 'november' && x4.agents_working === null, 'when the floor\'s run is finished, the other build (the most recently active) is building, agents unknown: ' + JSON.stringify([x4.building, x4.agents_working]))
    const x5 = feedIn(d).snap
    ok(x5.building === 'november' && x5.agents_working === null, 'without a run snapshot, the most recently active build: ' + x5.building)
  }

  // A build that finished at the package gate a moment ago: its journal is fresh, but it is done.
  {
    const d = folder('just-finished')
    project('oscar', state({ pending_gate: { gate_id: 'production_plan' }, stage_reached: '10_package_review' }), { live: { journals: [{ dir: journal('oscar', 2 * MIN, 2 * MIN) }], run: 'wf_o', finished: 'Wrapped: ready for your review on the Approval Desk.' } }, d)
    const x = feedIn(d, '--run', runSnap('oscar-run', { project: 'oscar', phase: 'Package review', finished: 'Wrapped: ready for your review on the Approval Desk.', calls: { started: 50, done: 50, running: 0 } })).snap
    const o = proj(x, 'oscar')
    ok(o.status === 'waiting' && o.gate && o.gate.id === 'production_plan' && x.building === null && x.agents_working === 0 && x.totals.building === 0 && x.totals.waiting_on_you === 1, 'a finished run with a fresh journal is not building; the gate it stopped at waits on Lucas: ' + JSON.stringify([o.status, x.building, x.agents_working, x.totals]))
  }

  // An idea that couldn't be developed into a brief (no gate), with and without questions for Lucas.
  {
    const d = folder('dev-blocked')
    const dev = { stage: '01_development', summary: 'Development blocked', blocked: true }
    project('papa', state({ stage_reached: '01_development', artifacts: {}, decision_log: [{ stage: '01_intake', summary: 'Idea in' }, dev], needs_human_input: ['Who is the artist?'] }), {}, d)
    project('quebec', state({ stage_reached: '01_development', artifacts: {}, decision_log: [dev] }), {}, d)
    const x = feedIn(d).snap
    const pp = proj(x, 'papa'), pq = proj(x, 'quebec')
    ok(pp.status === 'blocked' && pp.gate === null && pp.status_text === "The idea couldn't be developed into a brief this run." && pp.next === 'Answer the studio\'s questions, or tell Claude "resume papa" to retry' && pp.open_questions === 1, 'an idea blocked in development, with questions: ' + JSON.stringify([pp.status, pp.status_text, pp.next]))
    ok(pq.status === 'blocked' && pq.next === 'Tell Claude "resume quebec" to retry' && x.totals.waiting_on_you === 2, 'an idea blocked in development, no questions, waits on Lucas: ' + JSON.stringify([pq.status, pq.next, x.totals]))
  }

  // Department states: blocked, unfinished, stale and never run; failed checks under a new bar.
  {
    const d = folder('dept-states')
    project('romeo', state({
      stage_reached: '10_package_review', pending_gate: { gate_id: 'production_plan' },
      settings: { idea_mode: true, quality: true, review_at_end: true, targets: { cinematographer: { min: 10, rounds: 5 } } },
      artifacts: artifacts({
        casting_bible: { status: 'blocked', blockers: [{ issue: 'Cast a real athlete?', responsible_agent: 'Lucas' }] },
        camera_plan: { quality: { grade: 'A', min: 9, rounds: 3, scores: scores(9), incomplete: true, pending: 'revise', target_from_round: 3 } },
        storyboard: { status: 'stale' },
        generation_plan: { not_run: true, quality: undefined },
        script: { quality: { grade: 'A', min: 9, rounds: 2, scores: scores(9) }, checks: { failed: ['VO line over the speech rate'] } },
        world_bible: { quality: { grade: 'A', min: 9, rounds: 2, scores: scores(9) }, checks: { failed: [] } },
      }),
    }), { direction: { direction: [], targets: { copywriter: { min: 9, rounds: 3 }, production_designer: { min: 9, rounds: 3 } } } }, d)
    const r = proj(feedIn(d).snap, 'romeo')
    const pick = id => { const x = dept(r, id); return [x.state, x.grade, x.min, x.met_target] }
    ok(JSON.stringify(pick('casting_director')) === JSON.stringify(['blocked', null, null, null]), 'a blocked department is blocked, not ungraded work: ' + JSON.stringify(pick('casting_director')))
    ok(JSON.stringify(pick('cinematographer')) === JSON.stringify(['unfinished', null, 9, null]) && dept(r, 'cinematographer').target === 10, 'an unfinished review has no grade, keeps its lowest score so far and has not met the bar yet: ' + JSON.stringify(pick('cinematographer')))
    ok(JSON.stringify(pick('storyboard_artist')) === JSON.stringify(['stale', null, null, null]), 'stale work is out of date, with no grade: ' + JSON.stringify(pick('storyboard_artist')))
    ok(JSON.stringify(pick('generation_supervisor')) === JSON.stringify(['not_built', null, null, null]), 'work refused for budget (not_run) is not built: ' + JSON.stringify(pick('generation_supervisor')))
    ok(dept(r, 'copywriter').met_target === false && dept(r, 'production_designer').met_target === true, 'a new bar is not met while code checks fail, and met when they pass: ' + JSON.stringify([dept(r, 'copywriter'), dept(r, 'production_designer')]))
    ok(r.open_questions === 1 && r.status === 'waiting', 'the blocked department\'s question is counted: ' + r.open_questions)
  }

  // Open questions, counted as the desk counts them: the run's questions, plus blockers for Lucas on
  // current work made since his last notes (notes_at_seq), not on stale work, without repeats.
  {
    const d = folder('questions')
    project('sierra', state({
      notes_at_seq: 5,
      needs_human_input: ['Which city?'], open_questions: ['Which city?', 'Night or day?'],
      artifacts: artifacts({
        script: { blockers: [{ issue: 'Before his notes', responsible_agent: 'Lucas' }] },
        world_bible: { status: 'blocked', blockers: [{ issue: 'A real bar or a set?', responsible_agent: 'production_designer' }] },
        camera_plan: { blockers: [{ issue: 'Anamorphic?', resolution: 'or spherical', responsible_agent: 'Lucas' }, { issue: 'Night or day?', responsible_agent: 'Lucas' }, { issue: 'Crane budget', responsible_agent: 'producer' }] },
        storyboard: { status: 'stale', blockers: [{ issue: 'Out of date question', responsible_agent: 'Lucas' }] },
      }),
    }), {}, d)
    const q = proj(feedIn(d).snap, 'sierra').open_questions
    ok(q === 4, 'questions: 2 asked, 1 on blocked work, 1 new blocker for Lucas; none from before his notes, stale work, other owners or repeats: ' + q)
  }

  // Between runs after the call budget ran out; each next step a building project shows, exactly.
  {
    const d = folder('next-steps')
    const gates = { idea_mode: true, quality: true, review_at_end: false }
    const fresh = name => ({ journals: [{ dir: journal(name, 1 * MIN) }], run: `wf_${name}` })
    project('tango', state({ stage_reached: '06_camera', limit_reached: true }), {}, d)
    project('uniform', state(), { live: fresh('uniform') }, d)
    project('victor', state({ settings: gates, pending_gate: { gate_id: 'concept' }, stage_reached: '03_concepts' }), { live: fresh('victor') }, d)
    project('whiskey', state({ settings: gates, stage_reached: '02_strategy' }), { live: fresh('whiskey') }, d)
    project('xray', state({ settings: gates, approvals: { concept: { approved: true } } }), { live: fresh('xray') }, d)
    project('yankee', undefined, { idea: { idea: 'Gates from the start.', run_options: { review: 'gates' } }, live: fresh('yankee') }, d)
    project('zulu', undefined, { idea: { idea: 'Review at the end.' }, live: fresh('zulu') }, d)
    const x = feedIn(d).snap
    const t = proj(x, 'tango')
    ok(t.status === 'in_progress' && t.status_text === 'Between runs. The last run used its call budget at camera.' && t.next === 'Tell Claude "resume tango" to continue', 'a run that used its call budget: ' + JSON.stringify([t.status_text, t.next]))
    const nexts = Object.fromEntries(['uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu'].map(k => [k, proj(x, k).next]))
    ok(JSON.stringify(nexts) === JSON.stringify({
      uniform: 'The whole package comes to you on the Approval Desk',
      victor: 'When it stops, whatever needs you shows on the Approval Desk',
      whiskey: 'You pick the route on the Approval Desk',
      xray: 'The whole package comes to you on the Approval Desk',
      yankee: 'You pick the route on the Approval Desk',
      zulu: 'The whole package comes to you on the Approval Desk',
    }), 'where each build stops for Lucas next: ' + JSON.stringify(nexts))
  }

  // Paid media: locked until a project has reference stills that aren't blocked.
  {
    const d = folder('media')
    project('alfa2', state({ artifacts: artifacts({ reference_stills: { status: 'blocked', quality: undefined } }) }), {}, d)
    ok(feedIn(d).snap.production.locked === true, 'blocked reference stills keep paid media locked')
    project('bravo2', state({ artifacts: artifacts({ reference_stills: { status: 'draft', quality: undefined } }) }), {}, d)
    const pr = feedIn(d).snap.production
    ok(pr.locked === false && pr.reason === 'Paid media has started on a project.' && pr.stages.length === 5, 'reference stills made unlock paid media: ' + JSON.stringify(pr))
  }

  // The write is atomic: a new file is renamed over the old one, never written into it.
  {
    const d = folder('atomic')
    const dest = path.join(OUT, 'atomic.json')
    const other = path.join(OUT, 'atomic-other-link.json')
    fs.writeFileSync(dest, 'OLD')
    fs.linkSync(dest, other)
    const ino = fs.statSync(dest).ino
    const r = spawnSync('node', [TOOL, '--out', dest, '--projects', d], { cwd: ROOT, encoding: 'utf8' })
    ok(r.status === 0 && fs.statSync(dest).ino !== ino && fs.readFileSync(other, 'utf8') === 'OLD' && JSON.parse(fs.readFileSync(dest, 'utf8')).totals.projects === 0, 'the snapshot replaces the old file by a rename, so a reader never sees a half-written one')
  }

  // Times from git: a checkout stamps every file with the checkout time, so a saved state that git
  // reports unchanged is dated by its last commit; one saved since, by its own time.
  {
    const repo = folder('repo')
    const G = (...a) => spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' } })
    const d = path.join(repo, 'projects')
    project('echo2', state({ pending_gate: { gate_id: 'production_plan' } }), {}, d)
    project('foxtrot2', state({ pending_gate: { gate_id: 'production_plan' } }), {}, d)
    const init = G('init', '-q')
    G('add', '-A'); const commit = G('commit', '-q', '-m', 'Saved states')
    if (init.status !== 0 || commit.status !== 0) ok(false, 'git repo for the times test: ' + init.stderr + commit.stderr)
    else {
      // Both files are rewritten now, as a checkout does; foxtrot2 is then changed (saved here since).
      for (const slug of ['echo2', 'foxtrot2']) { const f = path.join(d, slug, 'state.json'); fs.writeFileSync(f, fs.readFileSync(f)) }
      fs.writeFileSync(path.join(d, 'foxtrot2', 'state.json'), JSON.stringify(state({ pending_gate: { gate_id: 'production_plan' }, stage_reached: '10_package_review' })))
      project('golf2', state({ pending_gate: { gate_id: 'production_plan' } }), {}, d)
      const x = feedIn(d).snap
      const e = proj(x, 'echo2'), f = proj(x, 'foxtrot2'), g = proj(x, 'golf2')
      ok(e.gate.since === '2026-01-02T03:04:05.000Z' && e.updated_at === '2026-01-02T03:04:05.000Z', 'a state unchanged since its commit waits since the commit, not the checkout: ' + JSON.stringify([e.gate.since, e.updated_at]))
      ok(Date.parse(f.gate.since) > Date.now() - 5 * MIN && Date.parse(g.gate.since) > Date.now() - 5 * MIN, 'a state changed since, or never committed, waits since it was saved: ' + JSON.stringify([f.gate.since, g.gate.since]))
      ok(!fs.existsSync(path.join(repo, '.git', 'index.lock')), 'git is only read (no index lock left)')
    }
  }

  const u = spawnSync('node', [TOOL], { encoding: 'utf8' })
  ok(u.status === 2 && /usage/.test(u.stderr), 'no --out prints usage')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
if (fails) process.exit(1)
