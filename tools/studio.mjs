#!/usr/bin/env node
// Studio runner: prepares each creative-studio workflow run and files what it returns.
//
// Workflow scripts can't read files, so every run gets a generated copy of the workflow with its
// inputs (craft briefs, taste notes, quality bar, the project's state) embedded. Claude runs that
// copy with Workflow({ scriptPath }), then files the output with `save`.
//
//   node tools/studio.mjs new <slug> "<idea>" [--format ad_spot] [--seconds 30] [--brand Name]
//        (or --idea-file <path> for a long idea, read word for word)
//        [--review end|gates] [--budget N]   gates: stop at the route choice before building
//   node tools/studio.mjs resume <slug>                  continue after a run hit its call budget
//   node tools/studio.mjs approve <slug> <decision.json> apply an Approval Desk decision
//        (checked against the versions the desk showed; --no-version-check for one given in chat)
//   node tools/studio.mjs notes <slug> "<notes>" [--decision-id id]
//   node tools/studio.mjs direct <slug> "<note>" --for dept1,dept2 [--words "Lucas's words"]
//        [--target dept=10 [--rounds 5]]   direction mid-build; a bar above A for one department
//   node tools/studio.mjs save <slug> <workflow-output-file>
//   node tools/studio.mjs status <slug>
//
// Files per project (projects/<slug>/):
//   idea.json    the idea as Lucas dropped it
//   state.json   the project state the next run resumes from
//   package.md   the full package, readable
//   desk.json    the documents to publish to the Approval Desk (gate + idea status)
//   direction.json  Lucas's direction given before the first run was saved (later, it lives in the state)
//   .run.js      the generated workflow for the next run (not committed)
//   .run-parts/  the saved state in parts, when it is too large to embed in .run.js (not committed)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = path.join(ROOT, '.claude/workflows/creative-studio.js')
const read = p => fs.readFileSync(p, 'utf8')
const readJSON = p => JSON.parse(read(p))
const writeJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 1) + '\n')

function projectDir(slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug || '')) die(`project slug must be lowercase letters, digits and dashes: "${slug}"`)
  return path.join(ROOT, 'projects', slug)
}

function die(msg) {
  console.error(`studio: ${msg}`)
  process.exit(1)
}

function flags(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    else out._.push(argv[i])
  }
  return out
}

// The studio's standards, passed to every run.
function studioInputs() {
  const rolesDir = path.join(ROOT, 'spec/roles')
  const craft = {}
  if (fs.existsSync(rolesDir)) {
    fs.readdirSync(rolesDir).filter(f => f.endsWith('.md')).sort().forEach(f => { craft[f.replace(/\.md$/, '')] = read(path.join(rolesDir, f)) })
  }
  const opt = p => (fs.existsSync(path.join(ROOT, p)) ? read(path.join(ROOT, p)) : '')
  return { craft, tasteNotes: opt('spec/taste/notes.md'), qualityBar: opt('spec/quality-bar.md') }
}

// The Workflow tool refuses a script over 512 KiB. A larger run keeps its saved state in part
// scripts (each returns a slice of the state's JSON) that the run loads first.
const MAX_SCRIPT_BYTES = Number(process.env.STUDIO_MAX_SCRIPT_BYTES) || 480000
const PART_BYTES = Number(process.env.STUDIO_PART_BYTES) || 440000

function splitForParts(text) {
  const parts = []
  let at = 0
  while (at < text.length) {
    // Grow a slice until its escaped, UTF-8 size would pass the part limit.
    let n = Math.min(text.length - at, PART_BYTES)
    while (n > 1 && Buffer.byteLength(JSON.stringify(text.slice(at, at + n))) > PART_BYTES) n = Math.floor(n * 0.9)
    parts.push(text.slice(at, at + n))
    at += n
  }
  return parts
}

function writeRun(slug, args) {
  const src = read(WORKFLOW)
  const marker = 'const input = args || {}'
  if (!src.includes(marker)) die('the workflow no longer has the args line this runner patches')
  const dir = projectDir(slug)
  const partsDir = path.join(dir, '.run-parts')
  fs.rmSync(partsDir, { recursive: true, force: true })
  // A run on a saved state also gets whatever of Lucas's direction the state doesn't have yet.
  if (args.priorState) {
    const pend = pendingDirection(slug, args.priorState)
    args = { ...args, direction: [...pend.direction, ...(args.direction || [])], targets: { ...pend.targets, ...(args.targets || {}) } }
    if (!args.direction.length) delete args.direction
    if (!Object.keys(args.targets).length) delete args.targets
  }
  let embedded = { ...studioInputs(), projectId: slug.toUpperCase().replace(/-/g, '_'), ...args }
  // A replacer function, so "$&" or "$$" in Lucas's text or the state is inserted literally.
  const build = e => src.replace(marker, () => `// Inputs embedded by tools/studio.mjs for project "${slug}".\nconst EMBEDDED_ARGS = ${JSON.stringify(e)}\nconst input = { ...EMBEDDED_ARGS, ...(args || {}) }`)
  let run = build(embedded)
  let note = ''
  if (Buffer.byteLength(run) > MAX_SCRIPT_BYTES && embedded.priorState) {
    const text = JSON.stringify(embedded.priorState)
    const slices = splitForParts(text)
    fs.mkdirSync(partsDir, { recursive: true })
    const files = slices.map((slice, i) => {
      const f = path.join(partsDir, `part-${String(i + 1).padStart(2, '0')}.js`)
      fs.writeFileSync(f, `export const meta = { name: 'studio-state-${slug}-${i + 1}', description: 'Saved state for ${slug}, part ${i + 1} of ${slices.length}' }\nreturn ${JSON.stringify(slice)}\n`)
      return f
    })
    const { priorState, ...rest } = embedded
    embedded = { ...rest, priorStateParts: files, priorStateLength: text.length }
    run = build(embedded)
    note = ` with its saved state in ${files.length} part${files.length === 1 ? '' : 's'} (${path.relative(ROOT, partsDir)})`
  }
  if (Buffer.byteLength(run) > MAX_SCRIPT_BYTES) die(`the run script would be ${Buffer.byteLength(run)} bytes, over the Workflow limit, even with the state split out`)
  const out = path.join(dir, '.run.js')
  fs.writeFileSync(out, run)
  const roles = Object.keys(embedded.craft)
  console.log(`Wrote ${path.relative(ROOT, out)}${note} (${args.command}; ${roles.length} craft brief${roles.length === 1 ? '' : 's'}: ${roles.join(', ') || 'none'})`)
  console.log(`Run it: Workflow({ scriptPath: '${path.relative(ROOT, out)}' })`)
}

function loadState(slug) {
  const p = path.join(projectDir(slug), 'state.json')
  if (!fs.existsSync(p)) die(`no state for ${slug} yet: run it once and save the output first`)
  return readJSON(p)
}

// ---- commands ----

function cmdNew(slug, idea, f) {
  if (f['idea-file']) idea = read(path.resolve(f['idea-file']))
  if (!idea || !idea.trim()) die('give the idea as the second argument, or --idea-file <path>')
  const dir = projectDir(slug)
  if (fs.existsSync(path.join(dir, 'state.json'))) die(`${slug} already has a state; pick another name or use resume`)
  fs.mkdirSync(dir, { recursive: true })
  const hints = {}
  if (f.format) hints.format = f.format
  if (f.seconds) hints.duration_seconds = Number(f.seconds)
  if (f.brand) hints.brand = f.brand
  writeJSON(path.join(dir, 'idea.json'), { idea: idea.trim(), hints, idea_doc_id: f['idea-id'] || null, run_options: runOptions(f) })
  const d = readDirection(slug)
  writeRun(slug, { command: 'IDEA', idea: idea.trim(), ideaHints: hints, ...(d.direction.length ? { direction: d.direction } : {}), ...(Object.keys(d.targets).length ? { targets: d.targets } : {}), ...runOptions(f) })
}

// Options any run takes: --review end|gates, --budget <agent calls per run>.
function runOptions(f) {
  const o = {}
  if (f.review) {
    if (!['end', 'gates'].includes(f.review)) die('--review is "end" or "gates"')
    o.review = f.review
  }
  if (f.budget) {
    const n = Number(f.budget)
    if (!(n >= 1)) die('--budget is a number of agent calls')
    o.maxAgentCalls = n
  }
  return o
}

function cmdResume(slug, f) {
  writeRun(slug, { command: 'APPROVE', priorState: loadState(slug), ...runOptions(f) })
}

// A decision as the Approval Desk stores it: { gate_id, decision, selected_route_id, comment,
// approver_id, decided_at, id | decision_id }.
function cmdApprove(slug, decisionFile, f) {
  const d = readJSON(decisionFile)
  // route_change: Lucas picked a different route at package review; the studio rebuilds on it
  // and brings the package back (the pipeline records no approval for work he hasn't seen).
  if (d.decision !== 'approved' && d.decision !== 'route_change') die(`that decision is "${d.decision}", not an approval; use notes for requested changes`)
  if (d.decision === 'route_change' && !d.selected_route_id) die('a route change needs selected_route_id')
  if (!d.approver_id) die('the decision has no approver_id, so it did not come from the Approval Desk')
  const state = loadState(slug)
  const g = state.pending_gate
  if (!g || g.gate_id !== d.gate_id) die(`${slug} is not waiting on the ${d.gate_id} gate (it is ${g ? `at ${g.gate_id}` : 'not at a gate'}); the desk card is out of date. Republish projects/${slug}/desk.json and ask Lucas to decide again.`)
  const did = d.decision_id || d.id
  if (did && (state.approval_log || []).some(e => e.decision_id === did && ['approved', 'route_change', 'not_applied'].includes(e.decision))) die(`decision ${did} was already applied to ${slug}; mark it picked up on the desk`)
  if (d.decision === 'route_change' && d.selected_route_id === state.selected_concept_id) die(`the package is already built on route ${d.selected_route_id}; republish projects/${slug}/desk.json and ask Lucas to review it`)
  // A decision applies only to the versions Lucas saw: the desk records them with the decision.
  if (d.decision === 'approved' || d.decision === 'route_change') {
    const shown = (d.artifact_ids_and_revisions || []).slice().sort()
    const current = (g.artifacts_for_review || []).filter(a => a.status !== 'stale').map(a => `${a.artifact_id}@r${a.revision}`).sort()
    if (!shown.length && !f['no-version-check']) die('the decision lists no versions, so it can\'t be checked against what Lucas saw. Pass --no-version-check only for an approval Lucas gave in chat about the current package.')
    if (shown.length && shown.join() !== current.join()) die(`the desk card showed ${shown.join(', ')}, but the project is now at ${current.join(', ')}. Republish projects/${slug}/desk.json and ask Lucas to decide again.`)
  }
  const approval = { approved: true, selected_route_id: d.selected_route_id || undefined, approver_id: d.approver_id, decided_at: d.decided_at, comment: d.comment || '', decision_id: did, ...(d.decision === 'route_change' ? { route_change: true } : {}) }
  writeRun(slug, { command: 'APPROVE', priorState: state, approvals: { [d.gate_id]: approval } })
}

function cmdNotes(slug, notes, f) {
  if (!notes || !notes.trim()) die('give the notes as the second argument')
  writeRun(slug, { command: 'NOTES', priorState: loadState(slug), notes: notes.trim(), decision_id: f['decision-id'] || null })
}

// Lucas's direction during a build: a note for the departments it names, and/or a bar above A
// for one department (--target cinematographer=10 --rounds 5). Everything he directs is kept in
// direction.json, and every run on a saved state is sent whatever of it that state doesn't have
// yet (see pendingDirection), so a direction is never lost to whichever run's output is saved.
// With a saved state the next run revises the named departments' work against it. Without one
// the project is re-run from its idea: a Workflow resume reuses cached calls only up to the first
// call that changed or ran in a different order, so parallel departments may be redone.
const DEPARTMENTS = ['development_producer', 'strategist', 'creative_director', 'copywriter', 'casting_director', 'production_designer', 'director', 'stylist', 'sound_designer', 'cinematographer', 'storyboard_artist', 'generation_supervisor']
function readDirection(slug) {
  const p = path.join(projectDir(slug), 'direction.json')
  const d = fs.existsSync(p) ? readJSON(p) : {}
  return { direction: d.direction || [], targets: d.targets || {} }
}
// What direction.json holds that the state doesn't yet: new notes, and bars that differ.
function pendingDirection(slug, state) {
  const saved = readDirection(slug)
  const have = new Set((state.direction || []).map(d => d.id))
  const direction = saved.direction.filter(d => !have.has(d.id))
  const cur = (state.settings && state.settings.targets) || {}
  const targets = Object.fromEntries(Object.entries(saved.targets).filter(([k, t]) => !cur[k] || cur[k].min !== t.min || cur[k].rounds !== t.rounds))
  return { direction, targets }
}
function cmdDirect(slug, note, f) {
  const dir = projectDir(slug)
  const statePath = path.join(dir, 'state.json')
  const saved = readDirection(slug)
  const state = fs.existsSync(statePath) ? readJSON(statePath) : null
  const known = [...new Map([...(state ? state.direction || [] : []), ...saved.direction].map(d => [d.id, d])).values()]
  const entries = []
  if (note && String(note).trim()) {
    const depts = String(f.for || '').split(',').map(x => x.trim()).filter(Boolean)
    if (!depts.length) die('say which departments the note is for: --for cinematographer,storyboard_artist')
    const bad = depts.filter(d => !DEPARTMENTS.includes(d))
    if (bad.length) die(`unknown department(s): ${bad.join(', ')}. Departments: ${DEPARTMENTS.join(', ')}`)
    const ids = new Set(known.map(d => d.id))
    let n = known.length + 1
    while (ids.has(`LD-${String(n).padStart(2, '0')}`)) n++
    entries.push({ id: `LD-${String(n).padStart(2, '0')}`, note: String(note).trim(), departments: depts, ...(f.words ? { lucas_words: String(f.words) } : {}) })
  }
  const targets = {}
  if (f.target) {
    const m = String(f.target).match(/^([a-z_]+)=(\d+(?:\.\d+)?)$/)
    if (!m) die('--target is department=score, e.g. --target cinematographer=10')
    if (!DEPARTMENTS.includes(m[1])) die(`unknown department: ${m[1]}`)
    const min = Number(m[2])
    if (!(min > 8 && min <= 10)) die('a target is above A (8) and at most 10')
    const rounds = f.rounds ? Number(f.rounds) : 5
    if (!(Number.isInteger(rounds) && rounds >= 1 && rounds <= 8)) die('--rounds is a whole number from 1 to 8')
    targets[m[1]] = { min, rounds }
  }
  if (!entries.length && !Object.keys(targets).length) die('give a note (with --for) and/or --target department=score')
  const all = { direction: [...saved.direction, ...entries], targets: { ...saved.targets, ...targets } }
  writeJSON(path.join(dir, 'direction.json'), all)
  if (state) {
    if (state.production_plan_applied) console.log(`${slug}'s package was approved; this direction reopens it, revises the work it names and brings the package back for review.`)
    writeRun(slug, { command: 'APPROVE', priorState: state, ...runOptions(f) })
    return
  }
  const ideaPath = path.join(dir, 'idea.json')
  if (!fs.existsSync(ideaPath)) die(`${slug} has no idea.json or state.json`)
  const idea = readJSON(ideaPath)
  console.log(`${slug} has no saved state yet, so this re-runs it from the idea with the direction. If a run is in flight, stop it and relaunch with its resumeFromRunId: cached calls are reused only up to the first call that changed or ran in a different order, so departments built in parallel may be redone. To keep finished work exactly, save a state first.`)
  writeRun(slug, { command: 'IDEA', idea: idea.idea, ideaHints: idea.hints || {}, direction: all.direction, targets: all.targets, ...(idea.run_options || {}), ...runOptions(f) })
}

function cmdSave(slug, outFile) {
  const raw = readJSON(outFile)
  const out = { ...(raw.result || raw), totalTokens: raw.totalTokens || null }
  if (!out.project_state) die(`${outFile} has no project_state: the run failed or this isn't a workflow output`)
  const dir = projectDir(slug)
  fs.mkdirSync(dir, { recursive: true })
  const state = out.project_state
  writeJSON(path.join(dir, 'state.json'), state)
  fs.writeFileSync(path.join(dir, 'package.md'), renderPackage(slug, state, out))
  writeJSON(path.join(dir, 'desk.json'), deskDocs(slug, state, out))
  console.log(summary(slug, state, out))
  const pend = pendingDirection(slug, state)
  if (pend.direction.length || Object.keys(pend.targets).length) console.log(`Not in this saved state yet: ${[...pend.direction.map(d => d.id), ...Object.keys(pend.targets).map(k => `the ${k} bar`)].join(', ')}. The next run on it (resume, approve or notes) applies them.`)
}

function cmdStatus(slug) {
  console.log(summary(slug, loadState(slug), null))
}

// ---- reading a state ----

const art = (s, k) => (s.artifacts && s.artifacts[k]) || null
const C = (s, k) => (art(s, k) && art(s, k).content) || {}
const route = s => (C(s, 'concepts').routes || []).find(r => r.route_id === s.selected_concept_id) || null
const LABELS = {
  development: 'Development', strategy: 'Strategy', concepts: 'Routes', script: 'Script', casting_bible: 'Cast',
  world_bible: 'World', directors_treatment: "Director's treatment", style_bible: 'Looks', sound_plan: 'Sound',
  camera_plan: 'Shot plan', storyboard: 'Storyboard', generation_plan: 'Generation plan',
  continuity_bible: 'Continuity', quality_reports: 'Integrity check', brief: 'Brief', idea: 'Idea',
}
const GRADED = ['development', 'strategy', 'concepts', 'script', 'casting_bible', 'world_bible', 'directors_treatment', 'style_bible', 'sound_plan', 'camera_plan', 'storyboard', 'generation_plan']

function grades(s) {
  return GRADED.filter(k => art(s, k)).map(k => {
    const q = art(s, k).quality
    const grade = q ? (q.incomplete ? 'unfinished' : q.grade) : 'not graded'
    return {
      key: k, label: LABELS[k], artifact: `${art(s, k).artifact_id} r${art(s, k).revision}`, status: art(s, k).status,
      grade, lowest: q ? q.min : null, rounds: q ? q.rounds : 0, failed_checks: (art(s, k).checks && art(s, k).checks.failed) || [], scores: q ? q.scores : null,
      // A bar Lucas set above A for this department, and whether the work reached it.
      target: q && q.target ? q.target : null, met_target: q && q.target ? !!q.met_target : null, kept_round: (q && q.kept_round) || null,
      // What a reviewer still wants, shown wherever the grade isn't A or Lucas's bar wasn't met.
      notes: grade === 'A' && !(q && q.target && !q.met_target) ? [] : ((q && q.notes) || []).map(n => (typeof n === 'string' ? n : `${n.target ? `${n.target}: ` : ''}${n.note}`)),
    }
  })
}

// Envelope items from current work only (stale work is being replaced).
const live = s => Object.entries(s.artifacts || {}).filter(([k, a]) => a && GRADED.includes(k) && a.status !== 'stale' && !a.not_run)
const seqOf = a => Number(String(a.artifact_id || '').split('-').pop()) || 0
// Blockers addressed to Lucas, from departments' current work; `before` picks those made before
// his latest notes (he may have answered them), otherwise those made since.
const lucasBlockers = (s, before) => live(s)
  .filter(([, a]) => (s.notes_at_seq ? seqOf(a) <= s.notes_at_seq : false) === !!before)
  .flatMap(([k, a]) => (a.blockers || [])
    .filter(b => /lucas/i.test(b.responsible_agent || '') || a.status === 'blocked')
    .map(b => `${b.issue}${b.resolution ? ` (${b.resolution})` : ''}`)
    .filter(q => !(s.open_questions || []).includes(q))
    .map(q => `${LABELS[k]}: ${q}`))
const questionsFor = s => [...new Set([...(s.needs_human_input || []), ...(s.open_questions || []), ...lucasBlockers(s, false)])]
const earlierQuestions = s => [...new Set([...(s.earlier_questions || []), ...lucasBlockers(s, true)])].filter(q => !questionsFor(s).includes(q))
const blockedDepartments = s => live(s).filter(([, a]) => a.status === 'blocked').map(([k]) => LABELS[k])
const panelNote = pr => (pr && pr.grade_on_earlier_versions
  ? `The panel's grade is from before these were changed: ${pr.revised_after_review.map(k => LABELS[k] || k).join(', ')}${(pr.fixed_after_review || []).length ? ` (integrity fixes to ${pr.fixed_after_review.map(k => LABELS[k] || k).join(', ')}, and what was rebuilt on them)` : ''}.`
  : '')

function summary(slug, s, out) {
  const g = s.pending_gate
  const lines = [`${slug}: ${C(s, 'development').working_title || s.brief.name || s.project_id} · stage ${s.stage_reached}`]
  if (out) lines.push(`agent calls this run: ${out.budget_ledger.agent_calls_used_this_run}/${out.budget_ledger.agent_calls_allowed_per_run}${out.totalTokens ? `, ${(out.totalTokens / 1e6).toFixed(2)}M tokens` : ''}${out.budget_ledger.limit_reached ? ' (budget reached: run `resume`)' : ''}`)
  const approved = (s.approval_log || []).some(e => e.gate_id === 'production_plan' && e.decision === 'approved')
  lines.push(g ? `waiting on Lucas: ${g.gate_id}${g.blocked_by_stale ? ' (blocked: stale work)' : ''}` : s.limit_reached ? 'paused: call budget reached (run resume)' : approved ? 'package approved: next is the enhancement phase (full script, or paid media with a budget)' : 'no gate pending')
  if (s.package_review) lines.push(`package: ${s.package_review.grade} (round ${s.package_review.round}, ${s.package_review.approvals}/${s.package_review.of} reviewers would approve)`)
  grades(s).forEach(x => lines.push(`  ${x.label.padEnd(22)} ${String(x.grade).padEnd(11)} ${x.lowest != null ? `lowest ${x.lowest}` : ''}${x.failed_checks.length ? ` · ${x.failed_checks.length} failed check(s)` : ''}`))
  questionsFor(s).forEach(q => lines.push(`  ? ${q}`))
  if (earlierQuestions(s).length) lines.push(`  (${earlierQuestions(s).length} earlier question(s), possibly answered in Lucas's notes)`)
  return lines.join('\n')
}

// ---- the readable package ----

const esc = t => String(t == null ? '' : t).replace(/\|/g, '\\|').replace(/\n/g, ' ')
const list = a => (a || []).map(x => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n')
function table(rows, cols) {
  if (!rows || !rows.length) return '_none_\n'
  return `| ${cols.map(c => c[1]).join(' | ')} |\n| ${cols.map(() => '---').join(' | ')} |\n` +
    rows.map(r => `| ${cols.map(c => esc(typeof c[0] === 'function' ? c[0](r) : Array.isArray(r[c[0]]) ? r[c[0]].join(', ') : r[c[0]])).join(' | ')} |`).join('\n') + '\n'
}
function fields(o, skip = []) {
  return Object.entries(o || {}).filter(([k, v]) => !skip.includes(k) && v != null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `- **${k.replace(/_/g, ' ')}**: ${Array.isArray(v) ? v.map(x => (typeof x === 'object' ? JSON.stringify(x) : x)).join('; ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')
}

function renderPackage(slug, s, out) {
  const dev = C(s, 'development')
  const pr = s.package_review
  const md = []
  md.push(`# ${dev.working_title || s.brief.name || slug}`)
  md.push(`_${s.pending_gate ? `Waiting for Lucas at the ${s.pending_gate.gate_id} gate` : `Stage ${s.stage_reached}`} · project ${s.project_id}_`)
  if (s.idea) md.push(`## Lucas's idea\n\n> ${s.idea}`)
  if (dev.logline) {
    md.push(`## Developed\n\n**${dev.logline}**\n\nFormat: ${dev.format}. ${dev.format_rationale || ''}\n\n${dev.premise || ''}`)
    if ((dev.what_makes_it_specific || []).length) md.push(`What makes it this idea and nobody else's:\n\n${list(dev.what_makes_it_specific)}`)
    if (dev.story_seed) md.push(`Story:\n\n${fields(dev.story_seed)}`)
    md.push(`Deliverables:\n\n${table(dev.deliverables, [['id', 'ID'], ['type', 'Type'], ['label', 'What'], [d => (d.type === 'video' ? `${d.duration_seconds}s` : d.type === 'still' ? `${d.count} still(s)` : 'outline'), 'Size'], ['aspect_ratio', 'Aspect']])}`)
    if ((dev.verified_product_facts || []).length) md.push(`Facts taken from your idea (the only claims the studio may make):\n\n${list(dev.verified_product_facts.map(f => `${f.fact} (you wrote: "${f.quoted_from_idea}")`))}`)
  }

  md.push('## Quality')
  if (pr) {
    md.push(`Package: **${pr.grade === 'A' ? 'A' : 'below A'}** after ${pr.round} panel round${pr.round === 1 ? '' : 's'}; ${pr.approvals} of ${pr.of} reviewers would approve it today. Averages: ${Object.entries(pr.averages).map(([k, v]) => `${k} ${v}`).join(', ')}.${pr.ended ? ` (${pr.ended}.)` : ''} ${panelNote(pr)}`)
    md.push(table(pr.lenses, [['lens', 'Reviewer'], [l => (l.would_approve ? 'yes' : 'no'), 'Would approve'], [l => Object.values(l.scores).join(' / '), 'Spec / Dist / Fit / Craft'], ['verdict', 'Verdict']]))
    const open = pr.grade === 'A' ? [] : pr.lenses.flatMap(l => (l.notes || []).map(n => `**${l.lens}** → ${n.responsible} · ${n.target}: ${n.note}`))
    if (open.length) md.push(`Open panel notes (not yet applied; send any you agree with as notes):\n\n${list(open)}`)
  }
  const gr = grades(s)
  const bars = gr.some(x => x.target)
  md.push(table(gr, [['label', 'Department'], ['grade', 'Grade'], ['lowest', 'Lowest score'], ...(bars ? [[x => (x.target ? `${x.target} (${x.met_target ? 'met' : 'not met'})` : ''), 'Your bar']] : []), [x => `${x.rounds}${x.kept_round ? ` (kept round ${x.kept_round})` : ''}`, 'Review rounds'], [x => x.failed_checks.length, 'Failed checks'], ['artifact', 'Version']]))
  const below = gr.filter(x => (x.grade !== 'A' || (x.target && !x.met_target)) && (x.notes.length || x.failed_checks.length))
  if (below.length) md.push(`### What keeps these below ${bars ? 'A or your bar' : 'A'}\n\n${below.map(x => `**${x.label}**${x.target && !x.met_target ? ` (your bar: ${x.target} on every score; lowest now ${x.lowest})` : ''}\n\n${list([...x.failed_checks.map(c => `Failed check: ${c}`), ...x.notes])}`).join('\n\n')}`)
  if ((s.direction || []).length) md.push(`### Your direction during the build\n\n${list(s.direction.map(d => `${d.id} (${d.departments.map(k => k.replace(/_/g, ' ')).join(', ')}): ${d.note}${d.lucas_words ? ` You said: "${d.lucas_words}"` : ''}`))}`)
  const qs = questionsFor(s)
  if (qs.length) md.push(`## Questions for you\n\n${list(qs)}`)
  const earlier = earlierQuestions(s)
  if (earlier.length) md.push(`## Earlier questions (you may have answered these in your notes)\n\n${list(earlier)}`)

  const st = C(s, 'strategy')
  if (st.single_minded_proposition) md.push(`## Strategy\n\n**${st.single_minded_proposition}**\n\n${fields(st, ['single_minded_proposition'])}`)
  const cs = C(s, 'concepts')
  if ((cs.routes || []).length) {
    md.push(`## Routes\n\nIn production: **${s.selected_concept_id || '(none)'}**. Recommended: ${cs.recommended_route_id}. ${cs.recommendation_rationale || ''}`)
    cs.routes.forEach(x => md.push(`### ${x.route_id}${x.route_id === s.selected_concept_id ? ' (in production)' : ''}: ${x.central_idea}\n\n${fields(x, ['route_id', 'central_idea'])}`))
  }
  const sc = C(s, 'script')
  if (sc.story) {
    md.push(`## Script\n\n${sc.story.logline || ''}`)
    md.push(`### Beat sheet\n\n${table(sc.story.beat_sheet, [['scene_id', 'Scene'], ['heading', 'Heading'], ['characters', 'Who'], ['what_happens', 'What happens'], ['turn', 'What turns']])}`)
    ;(sc.deliverable_scripts || []).forEach(d => md.push(`### ${d.deliverable_id} · ${d.duration_s}s: ${d.idea_in_one_line || ''}\n\n${table(d.beats, [[b => `${b.start_s}–${b.end_s}s`, 'Time'], ['picture', 'Picture'], ['sound', 'Sound'], ['vo', 'Dialogue / VO'], ['on_screen_text', 'On screen']])}${d.cta ? `\nCTA: ${d.cta}\n` : ''}`))
    if ((sc.stills_copy || []).length) md.push(`### Stills\n\n${table(sc.stills_copy, [['still_id', 'Still'], ['picture', 'Picture'], ['headline', 'Headline'], ['subline', 'Subline']])}`)
    if ((sc.decisions || []).length) md.push(`### Writing decisions\n\n${table(sc.decisions, [['choice', 'Choice'], ['reason', 'Why'], ['source', 'From']])}`)
  }
  const cast = C(s, 'casting_bible').characters || []
  if (cast.length) md.push(`## Cast\n\n${cast.map(c => `### ${c.character_id}\n\n${fields(c, ['character_id'])}`).join('\n\n')}`)
  const locs = C(s, 'world_bible').locations || []
  if (locs.length) md.push(`## World\n\n${locs.map(l => `### ${l.location_id}\n\n${fields(l, ['location_id', 'props'])}\n\nProps:\n\n${table(l.props, [['prop_id', 'Prop'], ['description', 'What'], ['persistent_state_notes', 'State to keep']])}`).join('\n\n')}`)
  const looks = C(s, 'style_bible').looks || []
  if (looks.length) md.push(`## Looks\n\n${looks.map(l => `### ${l.look_id} (${l.character_id})\n\n${fields(l, ['look_id', 'character_id'])}`).join('\n\n')}`)
  const scenes = C(s, 'directors_treatment').scenes || []
  if (scenes.length) md.push(`## Director's treatment\n\n${scenes.map(x => `### ${x.scene_id}\n\n${fields(x, ['scene_id'])}`).join('\n\n')}`)
  const cues = C(s, 'sound_plan').cues || []
  if (cues.length) md.push(`## Sound\n\n${table(cues, [['cue_id', 'Cue'], ['deliverable_ids', 'For'], ['type', 'Type'], ['timing', 'When'], ['description', 'What we hear'], ['licensing_or_consent_requirement', 'Rights']])}`)

  // Shots and panels, one section per deliverable in its running order, then every field of each.
  const shots = C(s, 'camera_plan').shots || []
  const panels = C(s, 'storyboard').panels || []
  const panelById = Object.fromEntries(panels.map(p => [p.shot_id, p]))
  const byDeliverable = (items, d) => items.filter(x => (x.deliverable_ids || []).includes(d.id))
  const boardOf = p => (p ? Object.fromEntries(['board_note', 'dialogue_or_voiceover', 'on_screen_text', 'sound_cues', 'entry_state', 'exit_state', 'generation_risk'].map(f => [f, p[f]])) : {})
  const deliverables = (s.brief.deliverables || []).filter(d => d.type !== 'outline')
  if (shots.length) {
    const blocks = []
    deliverables.forEach(d => {
      const mine = byDeliverable(shots, d)
      if (!mine.length) return
      let t = 0
      const rows = mine.map(sh => { const start = t; t += (sh.duration_frames || 0) / (sh.fps || 24); return { ...sh, ...boardOf(panelById[sh.shot_id]), start: `${start.toFixed(1)}s` } })
      blocks.push(`### ${d.id} · ${d.type === 'video' ? `${d.duration_seconds}s` : `${d.count || 1} still(s)`} ${d.aspect_ratio || ''}\n\n${table(rows, [['shot_id', 'Shot'], ['start', 'At'], [x => `${x.duration_frames}f @${x.fps}`, 'Length'], ['framing', 'Framing'], ['lens_intent', 'Lens'], ['action', 'Action'], ['dialogue_or_voiceover', 'Dialogue / VO'], ['on_screen_text', 'On screen'], ['sound_cues', 'Sound'], ['generation_risk', 'Generation risk']])}`)
    })
    const unassigned = shots.filter(sh => !deliverables.some(d => (sh.deliverable_ids || []).includes(d.id)))
    if (unassigned.length) blocks.push(`### Other shots\n\n${table(unassigned, [['shot_id', 'Shot'], ['deliverable_ids', 'For'], ['framing', 'Framing'], ['action', 'Action']])}`)
    md.push(`## Shot plan and storyboard\n\n${blocks.join('\n\n')}`)
    if (art(s, 'storyboard') && art(s, 'storyboard').status === 'stale') md.push('_The storyboard predates the current shot plan and is rebuilt on the next run._')
    md.push(`### Every shot in full\n\n${shots.map(sh => `#### ${sh.shot_id}\n\n${fields({ ...sh, ...boardOf(panelById[sh.shot_id]) }, ['shot_id'])}`).join('\n\n')}`)
    const flags = C(s, 'storyboard').contradictions_flagged || []
    if (flags.length) md.push(`### Contradictions the storyboard flagged\n\n${list(flags)}`)
  }
  const tracked = C(s, 'continuity_bible').tracked_elements || []
  if (tracked.length) md.push(`## Continuity\n\n${tracked.map(e => `- **${e.element_id}** (${e.element_type}): ${(e.states_by_shot || []).map(x => `${x.shot_id}: ${x.state}`).join('; ')}`).join('\n')}`)
  const gen = C(s, 'generation_plan')
  const jobs = gen.jobs || []
  if (jobs.length) {
    md.push(`## Generation plan (not run; no paid media without your approval and a budget)\n\n${table(jobs, [['job_id', 'Job'], ['shot_id', 'Shot'], ['job_type', 'Type'], ['method', 'Method'], [j => (j.capability_supported ? 'yes' : 'NO'), 'Supported'], ['estimated_cost_unit', 'Est. cost']])}`)
    const unsupported = jobs.filter(j => !j.capability_supported)
    if (unsupported.length || (gen.missing_capabilities || []).length) md.push(`### Not supported yet\n\n${list([...unsupported.map(j => `${j.job_id} (${j.shot_id}): ${j.capability_notes}`), ...(gen.missing_capabilities || []).map(m => `Missing capability: ${m}`)])}`)
    md.push(`### Every job in full\n\n${jobs.map(j => `#### ${j.job_id} · ${j.shot_id}\n\n${fields(j, ['job_id', 'shot_id'])}`).join('\n\n')}`)
  }
  const qc = C(s, 'quality_reports')
  if (qc.issues) {
    md.push(`## Integrity check\n\nRecommendation: ${qc.recommendation}.\n\n${table(qc.issues, [['severity', 'Severity'], ['shot_or_timecode', 'Where'], ['evidence', 'Issue'], ['responsible_agent', 'Owner']])}`)
    if ((qc.checks || []).length) md.push(`### Checks run\n\n${table(qc.checks, [['check_id', 'Check'], ['category', 'Category'], ['result', 'Result'], ['evidence', 'Evidence']])}`)
  }

  // Everything each department assumed or couldn't resolve; other pages cite these by ID.
  const env = live(s).filter(([k, a]) => LABELS[k] && ((a.assumptions || []).length || (a.blockers || []).length))
  if (env.length) {
    md.push(`## Assumptions and blockers\n\n${env.map(([k, a]) => `### ${LABELS[k]}\n\n${list([...(a.assumptions || []), ...(a.blockers || []).map(b => `Blocker (${b.responsible_agent}): ${b.issue}${b.resolution ? ` → ${b.resolution}` : ''}`)])}`).join('\n\n')}`)
  }
  if (out) md.push(`---\n\n_Run: ${out.command}, ${out.budget_ledger.agent_calls_used_this_run} agent calls${out.totalTokens ? `, ${(out.totalTokens / 1e6).toFixed(2)}M tokens` : ''}._`)
  return md.join('\n\n') + '\n'
}

// ---- Approval Desk documents ----

function deskDocs(slug, s, out) {
  const g = s.pending_gate
  const dev = C(s, 'development')
  const cs = C(s, 'concepts')
  const docs = []
  const base = {
    project_id: s.project_id,
    project_slug: slug,
    project_name: dev.working_title || s.brief.name || slug,
    project_sub: [dev.format && dev.format.replace(/_/g, ' '), s.brief.brand, (s.brief.deliverables || []).map(d => (d.type === 'video' ? `${d.duration_seconds}s ${d.aspect_ratio}` : d.type === 'still' ? `${d.count} still${d.count === 1 ? '' : 's'}` : 'outline')).join(', ')].filter(Boolean).join(' · '),
  }
  if (g && g.gate_id === 'production_plan') {
    const pr = s.package_review
    docs.push({
      collection: 'gates',
      id: `${slug}--production_plan`,
      data: {
        ...base,
        gate_id: 'production_plan', gate_label: 'Package', order: 2,
        status: g.blocked_by_stale ? 'blocked' : 'pending', decision_id: null,
        title: s.settings && s.settings.review_at_end ? 'Review the whole package' : 'Approve the full production package',
        ask: s.settings && s.settings.review_at_end
          ? 'The studio developed your idea, picked the recommended route and built every department to the A bar. Approve the package and the route together, pick a different route to rebuild on, or send notes and it comes back revised.'
          : 'Approve the exact script, cast, looks, world, storyboard, sound plan and generation plan. Paid media still needs a separate budget.',
        from_run: `${out ? out.command : 'run'} · ${new Date().toISOString().slice(0, 10)}`,
        review_mode: 'package',
        idea: s.idea || null,
        development: dev.logline ? { working_title: dev.working_title, logline: dev.logline, format: dev.format, premise: dev.premise, what_makes_it_specific: dev.what_makes_it_specific || [] } : null,
        strategy: C(s, 'strategy').single_minded_proposition ? { proposition: C(s, 'strategy').single_minded_proposition, tension: C(s, 'strategy').audience_tension } : null,
        routes: (cs.routes || []).map(r => ({ route_id: r.route_id, central_idea: r.central_idea, emotional_promise: r.emotional_promise, product_role: r.product_role, execution_example: r.execution_example })),
        recommended_route_id: cs.recommended_route_id || null,
        built_route_id: s.selected_concept_id || null,
        recommendation: cs.recommendation_rationale || '',
        package_grade: pr ? pr.grade : null,
        panel: pr ? {
          round: pr.round, approvals: pr.approvals, of: pr.of, averages: pr.averages, ended: pr.ended || null,
          revised_after_review: (pr.revised_after_review || []).map(k => LABELS[k] || k), grade_note: panelNote(pr),
          lenses: pr.lenses.map(l => ({ lens: l.lens, would_approve: l.would_approve, verdict: l.verdict, scores: l.scores, notes: pr.grade === 'A' ? [] : (l.notes || []).map(n => ({ dept: n.responsible, target: n.target, note: n.note })) })),
        } : null,
        departments: grades(s).map(x => ({ key: x.key, label: x.label, grade: x.grade, lowest: x.lowest, rounds: x.rounds, failed_checks: x.failed_checks, notes: x.notes, ...(x.target ? { target: x.target, met_target: x.met_target, kept_round: x.kept_round } : {}) })),
        direction: (s.direction || []).map(d => ({ id: d.id, departments: d.departments, note: d.note, lucas_words: d.lucas_words || null })),
        script: (C(s, 'script').deliverable_scripts || []).map(d => ({ deliverable_id: d.deliverable_id, duration_s: d.duration_s, idea_in_one_line: d.idea_in_one_line, cta: d.cta, beats: (d.beats || []).map(b => ({ t: `${b.start_s}–${b.end_s}s`, picture: b.picture, sound: b.sound, vo: b.vo, text: b.on_screen_text })) })),
        cast: (C(s, 'casting_bible').characters || []).map(c => ({ id: c.character_id, role: c.role_in_story, presence: c.screen_presence })),
        open_questions: questionsFor(s),
        blocked_reason: g.blocked_by_stale ? `Can't be approved yet: ${g.blocked_by_stale.length} pieces of work are stale. Claude re-runs the project to rebuild them.` : null,
        stale: g.blocked_by_stale || [],
        open_issues: g.blocked_by_stale ? questionsFor(s) : [],
        next: g.blocked_by_stale ? `Tell Claude "resume ${slug}" to rebuild the stale work.` : null,
        caveat: [
          g.changed_since_review ? `Your last approval wasn't applied: the package changed after you saw it${(g.changed || []).length ? ` (${g.changed.map(k => LABELS[k] || k).join(', ')} ${g.changed.length === 1 ? 'is' : 'are'} new since then)` : ''}. These are the current versions; approve again if they still work for you.` : '',
          blockedDepartments(s).length ? `${blockedDepartments(s).join(' and ')} ${blockedDepartments(s).length === 1 ? 'is' : 'are'} blocked (see the questions). Approving accepts the package with ${blockedDepartments(s).length === 1 ? 'it' : 'them'} unfinished; answer in notes instead to have ${blockedDepartments(s).length === 1 ? 'it' : 'them'} redone.` : '',
        ].filter(Boolean).join(' ') || null,
        earlier_questions: earlierQuestions(s),
        review_items: (g.artifacts_for_review || []).map(a => ({ artifact_id: a.artifact_id, revision: a.revision, kind: a.kind })),
        package_file: `projects/${slug}/package.md`,
      },
    })
  } else if (g && g.gate_id === 'concept') {
    docs.push({
      collection: 'gates',
      id: `${slug}--concept`,
      data: {
        ...base, gate_id: 'concept', gate_label: 'Concept', order: 1, status: 'pending', decision_id: null,
        title: g.blocked_by ? 'The studio needs an answer' : 'Pick the route',
        ask: g.blocked_by ? `The ${g.blocked_by.join(' and ')} couldn't be finished from your idea alone. Answer the questions below and the studio carries on from here.` : 'Approve the strategy and one route. Nothing downstream is built until you do.',
        needs_answer: !!g.blocked_by,
        open_questions: questionsFor(s),
        earlier_questions: earlierQuestions(s),
        from_run: `${out ? out.command : 'run'} · ${new Date().toISOString().slice(0, 10)}`,
        strategy: C(s, 'strategy').single_minded_proposition ? { proposition: C(s, 'strategy').single_minded_proposition, tension: C(s, 'strategy').audience_tension } : null,
        routes: (cs.routes || []).map(r => ({ route_id: r.route_id, central_idea: r.central_idea, emotional_promise: r.emotional_promise, product_role: r.product_role, execution_example: r.execution_example })),
        recommended_route_id: cs.recommended_route_id, recommendation: cs.recommendation_rationale || '',
        review_items: (g.artifacts_for_review || []).map(a => ({ artifact_id: a.artifact_id, revision: a.revision, kind: a.kind })),
      },
    })
  }
  const ideaFile = path.join(projectDir(slug), 'idea.json')
  const ideaDoc = fs.existsSync(ideaFile) ? readJSON(ideaFile).idea_doc_id : null
  if (ideaDoc) {
    docs.push({
      collection: 'ideas', id: ideaDoc, update: true,
      data: {
        project_slug: slug,
        status: g ? 'in_review' : s.production_plan_applied ? 'done' : 'building',
        status_note: g ? `Ready for your review: ${dev.working_title || slug}.`
          : s.production_plan_applied ? `Package approved: ${dev.working_title || slug}. Next is the enhancement phase.`
          : s.limit_reached ? 'Still building: the studio paused at its per-run call limit and continues next run.'
          : (s.decision_log || []).some(e => e.blocked && e.stage === '01_development') ? `Stopped: the idea couldn't be developed this run. Tell Claude "resume ${slug}" to retry.`
          : `At ${s.stage_reached}.`,
      },
    })
  }
  return docs
}

// ---- main ----

const [cmd, slug, ...rest] = process.argv.slice(2)
const f = flags(rest)
switch (cmd) {
  case 'new': cmdNew(slug, f._[0], f); break
  case 'resume': cmdResume(slug, f); break
  case 'approve': cmdApprove(slug, f._[0], f); break
  case 'notes': cmdNotes(slug, f._[0], f); break
  case 'direct': cmdDirect(slug, f._[0], f); break
  case 'save': cmdSave(slug, f._[0]); break
  case 'status': cmdStatus(slug); break
  default:
    console.log(read(fileURLToPath(import.meta.url)).split('\n').slice(1).filter((l, i, a) => a.slice(0, i + 1).every(x => x.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
}
