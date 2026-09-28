#!/usr/bin/env node
// Studio feed: every project at a glance, for the control room page (the overview above the live
// floor). Reads each project's saved state and its live-run pointer, and writes one snapshot:
// where each project is, what is waiting on Lucas, the department grades and the package panel,
// and which build is running now.
//
//   node tools/studio-feed.mjs --out <studio.json> [--projects <dir>] [--run <run-snapshot.json>]
//
// --projects defaults to the repo's projects/. Each folder with a state.json is a project (a new
// one with only an idea.json is listed too, so its first build shows while it runs); folders whose
// names start with "test-", "zz-" or "." are never listed or opened. --run is the run snapshot
// tools/live-feed.mjs wrote for the live floor: its project is the floor's project, and when that
// project is building, its running calls are the agents working now.
//
// A project's status, first match wins:
//   building     its .live-run is unfinished and its newest journal changed in the last 45 minutes
//   paused       its .live-run is unfinished but the journal has been quiet longer than that
//   blocked      it stopped on something only Lucas can unblock (questions it can't build past,
//                a package gate with stale work, an idea that couldn't be developed)
//   waiting      a gate is waiting for Lucas's decision on the Approval Desk
//   approved     Lucas's package approval was applied
//   in_progress  anything else (between runs)
// Writes are atomic (a temp file, then a rename). Prints one summary line.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEPTS, KEY } from './studio-depts.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const out = opt('--out')
const projectsDir = path.resolve(opt('--projects') || path.join(ROOT, 'projects'))
const runFile = opt('--run')
if (!out) {
  console.error('usage: node tools/studio-feed.mjs --out <studio.json> [--projects <dir>] [--run <run-snapshot.json>]')
  process.exit(2)
}

const FRESH_MS = 45 * 60 * 1000
const NOW = Date.now()
const warn = m => console.error(`studio-feed: ${m}`)
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const mtimeMs = f => { try { return fs.statSync(f).mtimeMs } catch { return null } }
const iso = ms => (ms == null ? null : new Date(Math.round(ms)).toISOString())
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s }
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x)
const hidden = name => name.startsWith('.') || name.startsWith('test-') || name.startsWith('zz-')

const GATE_LABEL = { concept: 'Route choice', production_plan: 'Package approval', visual_lock: 'Visual lock', final_cut: 'Final cut' }
// What Lucas approved at each gate, for a decision the next run has yet to apply.
const GATE_NOUN = { concept: 'route', production_plan: 'package', visual_lock: 'reference stills', final_cut: 'cut' }
const STAGE = {
  '00_idea': 'the idea', '01_intake': 'the brief', '01_development': 'development', '02_strategy': 'strategy',
  '03_concepts': 'the routes', '04_script_cast_world': 'script, cast and world', '05_direction_style_sound': 'direction, style and sound',
  '06_camera': 'camera', '07_storyboard': 'the storyboard', '08_generation_plan': 'the generation plan',
  '09_preproduction_review': 'the integrity check', '10_package_review': 'the package panel', '09_production_plan_approved': 'the approved package',
  '10_reference_stills': 'reference stills', '11_motion': 'motion', '12_audio': 'audio', '13_edit': 'the edit', '14_review': 'the review cut', '15_delivery': 'delivery',
}
const PRODUCTION_STAGES = ['Reference stills', 'Motion', 'Audio', 'Edit', 'Delivery']

// The run snapshot the live floor shows (optional).
let run = null
if (runFile) {
  run = readJson(runFile)
  if (!isObj(run)) { warn(`couldn't read the run snapshot ${runFile}; going on without it`); run = null }
}

// The run a project's .live-run points to: whether it finished, and when its journal last changed.
function liveRun(dir) {
  const f = path.join(dir, '.live-run')
  const p = readJson(f)
  if (!isObj(p)) return null
  const js = Array.isArray(p.journals) ? p.journals : p.journal ? [{ dir: p.journal }] : []
  const times = js.map(j => (j && j.dir ? mtimeMs(path.join(j.dir, 'journal.jsonl')) : null)).filter(t => t != null)
  // A run whose journal can't be found yet counts from when it was pointed to.
  const activeAt = times.length ? Math.max(...times) : mtimeMs(f)
  return { finished: p.finished || null, activeAt }
}

// Open questions for Lucas, counted as the Approval Desk lists them (tools/studio.mjs questionsFor):
// the run's questions, plus blockers addressed to him from current work made since his last notes.
function openQuestions(s) {
  const graded = new Set(Object.values(KEY))
  const seqOf = a => Number(String(a.artifact_id || '').split('-').pop()) || 0
  const asked = s.open_questions || []
  const blockers = Object.entries(s.artifacts || {})
    .filter(([k, a]) => a && graded.has(k) && a.status !== 'stale' && !a.not_run && !(s.notes_at_seq && seqOf(a) <= s.notes_at_seq))
    .flatMap(([k, a]) => (a.blockers || [])
      .filter(b => b && (/lucas/i.test(b.responsible_agent || '') || a.status === 'blocked'))
      .map(b => `${b.issue}${b.resolution ? ` (${b.resolution})` : ''}`)
      .filter(q => !asked.includes(q))
      .map(q => `${k}: ${q}`))
  return new Set([...(s.needs_human_input || []), ...asked, ...blockers]).size
}

// Each department's grade from the saved state, with Lucas's bar where he set one. The bar is the
// latest he gave (direction.json, then the state's settings); whether the work met it is the
// workflow's own verdict when it reviewed against that bar.
function departments(s, targets) {
  return DEPTS.map(([dept, name]) => {
    const a = s && s.artifacts && s.artifacts[KEY[dept]]
    const q = a && isObj(a.quality) ? a.quality : null
    const target = Number(targets[dept] && targets[dept].min) || (q && q.target) || null
    let grade = null
    let min = null
    let met = null
    // Missing, stale (being replaced), blocked or never run: no grade to show.
    if (a && a.status !== 'stale' && a.status !== 'blocked' && !a.not_run) {
      if (!q) grade = 'not_graded'
      else {
        min = q.min != null ? q.min : null
        // An unfinished review has no grade yet.
        if (!q.incomplete && q.grade) grade = q.grade === 'A' ? 'A' : 'below_A'
        if (target && grade && min != null) {
          const failed = ((a.checks && a.checks.failed) || []).length > 0
          met = q.target === target ? !!q.met_target : min >= target && !failed
        }
      }
    }
    return { dept, name, grade, min, target, met_target: met }
  })
}

// Where a running build stops for Lucas next (the page shows it after a "Next" label). A build
// running from the route choice may be applying his pick (then the package is next) or his notes
// (then the routes come back), so that case names neither.
function nextStop(s, idea) {
  const gatesMode = s ? !(s.settings && s.settings.review_at_end) : !!(idea && idea.run_options && idea.run_options.review === 'gates')
  const routePicked = !!(s && s.approvals && s.approvals.concept && s.approvals.concept.approved)
  if (!gatesMode || routePicked) return 'The whole package comes to you on the Approval Desk'
  if (s && s.pending_gate && s.pending_gate.gate_id === 'concept') return 'When it stops, whatever needs you shows on the Approval Desk'
  return 'You pick the route on the Approval Desk'
}

function project(slug) {
  const dir = path.join(projectsDir, slug)
  const statePath = path.join(dir, 'state.json')
  const ideaPath = path.join(dir, 'idea.json')
  let s = null
  if (fs.existsSync(statePath)) {
    try { s = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch (e) { warn(`skipping ${slug}: its state.json can't be read (${e.message})`); return null }
    if (!isObj(s)) { warn(`skipping ${slug}: its state.json isn't a project state`); return null }
  }
  const idea = readJson(ideaPath)
  if (!s && !isObj(idea)) return null
  const lr = liveRun(dir)
  const saved = readJson(path.join(dir, 'direction.json')) || {}
  const settings = (s && s.settings) || {}
  const targets = { ...(settings.targets || {}), ...(isObj(saved.targets) ? saved.targets : {}) }
  const directionIds = new Set([...((s && s.direction) || []), ...(Array.isArray(saved.direction) ? saved.direction : [])].map(d => d && d.id).filter(Boolean))
  const stateAt = s ? mtimeMs(statePath) : mtimeMs(ideaPath)
  const onFloor = run && run.project === slug ? run : null

  const artifacts = (s && s.artifacts) || {}
  const dev = (artifacts.development && artifacts.development.content) || {}
  const brief = (s && s.brief) || {}
  const title = dev.working_title || brief.name || (onFloor && onFloor.title) || slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  const format = dev.format || brief.format || (onFloor && onFloor.format) || (idea && idea.hints && idea.hints.format) || ''
  const logline = clip(dev.logline || brief.logline || brief.one_line_brief || (onFloor && onFloor.logline) || (idea && idea.idea) || '', 220)
  const stage = s ? s.stage_reached || null : '00_idea'
  const stageName = STAGE[stage] || stage || 'the start'
  const g = s && isObj(s.pending_gate) ? s.pending_gate : null
  const approvals = (s && s.approvals) || {}
  const gateDecided = !!(g && approvals[g.gate_id] && approvals[g.gate_id].approved)
  const resume = `Tell Claude "resume ${slug}"`
  const log = (s && s.decision_log) || []
  const lastLog = log[log.length - 1]

  let status
  let text
  let next = null
  let gate = null
  const atGate = label => ({ id: g.gate_id, label, since: iso(stateAt) })
  if (lr && !lr.finished && lr.activeAt != null && NOW - lr.activeAt <= FRESH_MS) {
    status = 'building'
    text = onFloor && !onFloor.finished && onFloor.phase ? `Building now, at the ${onFloor.phase.toLowerCase()} stage.` : 'Building now.'
    next = nextStop(s, idea)
  } else if (lr && !lr.finished) {
    status = 'paused'
    text = 'The last build stopped without finishing.'
    next = `${resume} to pick it up where it stopped`
  } else if (!s) {
    status = 'in_progress'
    text = 'Waiting for its first build.'
  } else if (g && !gateDecided && Array.isArray(g.blocked_by) && g.blocked_by.length) {
    status = 'blocked'
    const what = g.blocked_by.map(k => ({ strategy: 'strategy', concepts: 'routes', development: 'development' }[k] || k)).join(' and ')
    text = `The ${what} couldn't be finished from your idea alone. The studio needs your answers.`
    next = 'Answer the questions as notes on the Approval Desk and the studio carries on'
    gate = atGate('Your answers')
  } else if (g && !gateDecided && Array.isArray(g.blocked_by_stale) && g.blocked_by_stale.length) {
    status = 'blocked'
    const n = g.blocked_by_stale.length
    text = `The package is at your gate, but ${n} piece${n === 1 ? ' is' : 's are'} out of date, so it can't be approved yet.`
    next = `${resume} to rebuild the out-of-date work`
    gate = atGate(GATE_LABEL[g.gate_id] || g.gate_id)
  } else if (g && !gateDecided) {
    status = 'waiting'
    gate = atGate(GATE_LABEL[g.gate_id] || g.gate_id)
    if (g.gate_id === 'production_plan') {
      text = g.changed_since_review ? 'The package changed after your last approval and is back for your review.'
        : settings.review_at_end ? 'The whole package, route included, is ready for your review.' : 'The full package is ready for your review.'
      next = settings.review_at_end ? 'Approve it, pick a different route, or send notes on the Approval Desk' : 'Approve it or send notes on the Approval Desk'
    } else if (g.gate_id === 'concept') {
      const n = ((artifacts.concepts && artifacts.concepts.content && artifacts.concepts.content.routes) || []).length
      text = `${n ? `${n} routes are` : 'The routes are'} ready for you to pick from.`
      next = 'Pick a route, or send notes, on the Approval Desk'
    } else if (g.gate_id === 'visual_lock') {
      text = 'The reference stills are ready for your visual lock.'
      next = 'Approve them on the Approval Desk'
    } else if (g.gate_id === 'final_cut') {
      text = 'The cut is ready for your final approval.'
      next = 'Approve it on the Approval Desk'
    } else {
      text = `Waiting for your decision at the ${g.gate_id} gate.`
      next = 'Decide on the Approval Desk'
    }
  } else if (s.production_plan_applied && approvals.production_plan && approvals.production_plan.approved) {
    status = 'approved'
    text = 'You approved the package.'
    next = 'The enhancement phase, with a full script or paid media once you set a spend cap'
  } else if (!g && lastLog && lastLog.blocked && lastLog.stage === '01_development') {
    status = 'blocked'
    text = "The idea couldn't be developed into a brief this run."
    next = openQuestions(s) ? `Answer the studio's questions, or ${resume.charAt(0).toLowerCase() + resume.slice(1)} to retry` : `${resume} to retry`
  } else if (g && gateDecided) {
    status = 'in_progress'
    text = `You approved the ${GATE_NOUN[g.gate_id] || `${g.gate_id} gate`}. The next run applies it.`
  } else if (s.limit_reached) {
    status = 'in_progress'
    text = `Between runs. The last run used its call budget at ${stageName}.`
    next = `${resume} to continue`
  } else {
    status = 'in_progress'
    text = `Between runs. Last saved at ${stageName}.`
    next = `${resume} to continue`
  }

  const pr = s && isObj(s.package_review) ? s.package_review : null
  return {
    row: {
      slug,
      title,
      format,
      logline,
      status,
      status_text: text,
      stage,
      gate,
      package: pr && pr.grade ? { grade: pr.grade === 'A' ? 'A' : 'below_A', would_approve: Number(pr.approvals) || 0, reviewers: Number(pr.of) || (pr.lenses || []).length, rounds: Number(pr.round) || 0 } : null,
      departments: departments(s, targets),
      open_questions: s ? openQuestions(s) : 0,
      direction: directionIds.size,
      next,
      updated_at: iso(Math.max(stateAt || 0, (lr && lr.activeAt) || 0) || null),
    },
    activeAt: lr ? lr.activeAt : null,
    producing: !!(artifacts.reference_stills && artifacts.reference_stills.status !== 'blocked'),
  }
}

let names = []
try {
  names = fs.readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory() && !hidden(e.name)).map(e => e.name).sort()
} catch (e) {
  warn(`can't list ${projectsDir} (${e.message}); writing an empty studio`)
}
const found = []
for (const slug of names) {
  try {
    const p = project(slug)
    if (p) found.push({ slug, ...p })
  } catch (e) {
    warn(`skipping ${slug}: ${e.message}`)
  }
}

// What needs Lucas first, then what is running, then the rest; newest first within each.
const ORDER = { waiting: 0, blocked: 1, building: 2, paused: 3, in_progress: 4, approved: 5 }
found.sort((a, b) => ORDER[a.row.status] - ORDER[b.row.status] || String(b.row.updated_at).localeCompare(String(a.row.updated_at)) || a.slug.localeCompare(b.slug))
const newest = list => list.filter(p => p.activeAt != null).sort((a, b) => b.activeAt - a.activeAt)[0] || null
const building = newest(found.filter(p => p.row.status === 'building')) || found.find(p => p.row.status === 'building') || null
const floor = run && run.project ? run.project : (newest(found) || {}).slug || null
const rows = found.map(p => p.row)
const count = st => rows.filter(r => st.includes(r.status)).length
// Paid media runs only once a generation tool is connected and Lucas sets a spend cap; until a
// project has made production media, the stages stay locked.
const producing = found.some(p => p.producing)

const snap = {
  written_at: new Date().toISOString(),
  floor_project: floor,
  building: building ? building.slug : null,
  agents_working: building && run && run.project === building.slug && !run.finished ? Number(run.calls && run.calls.running) || 0 : 0,
  totals: { projects: rows.length, building: count(['building']), waiting_on_you: count(['waiting', 'blocked']), approved: count(['approved']) },
  projects: rows,
  production: {
    locked: !producing,
    reason: producing
      ? 'Paid media has started on a project.'
      : 'Paid media stays locked until a generation tool is connected and you set a spend cap.',
    stages: PRODUCTION_STAGES,
  },
}

const dest = path.resolve(out)
fs.mkdirSync(path.dirname(dest), { recursive: true })
const tmp = `${dest}.${process.pid}.tmp`
fs.writeFileSync(tmp, JSON.stringify(snap))
fs.renameSync(tmp, dest)
const t = snap.totals
console.log(`studio: ${t.projects} project${t.projects === 1 ? '' : 's'}, ${t.building} building, ${t.waiting_on_you} waiting on you, ${t.approved} approved; floor: ${snap.floor_project || 'none'}${snap.building ? `; ${snap.agents_working} agent${snap.agents_working === 1 ? '' : 's'} working on ${snap.building}` : ''}`)
