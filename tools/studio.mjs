#!/usr/bin/env node
// Studio runner: prepares each creative-studio workflow run and files what it returns.
//
// Workflow scripts can't read files, so every run gets a generated copy of the workflow with its
// inputs (craft briefs, taste notes, quality bar, the project's state) embedded. Claude runs that
// copy with Workflow({ scriptPath }), then files the output with `save`.
//
//   node tools/studio.mjs new <slug> "<idea>" [--format ad_spot] [--seconds 30] [--brand Name]
//        [--review end|gates] [--budget N]   gates: stop at the route choice before building
//   node tools/studio.mjs resume <slug>                  continue after a run hit its call budget
//   node tools/studio.mjs approve <slug> <decision.json> apply an Approval Desk decision
//        (checked against the versions the desk showed; --no-version-check for one given in chat)
//   node tools/studio.mjs notes <slug> "<notes>" [--decision-id id]
//   node tools/studio.mjs save <slug> <workflow-output-file>
//   node tools/studio.mjs status <slug>
//
// Files per project (projects/<slug>/):
//   idea.json    the idea as Lucas dropped it
//   state.json   the project state the next run resumes from
//   package.md   the full package, readable
//   desk.json    the documents to publish to the Approval Desk (gate + idea status)
//   .run.js      the generated workflow for the next run (not committed)

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

function writeRun(slug, args) {
  const src = read(WORKFLOW)
  const marker = 'const input = args || {}'
  if (!src.includes(marker)) die('the workflow no longer has the args line this runner patches')
  const embedded = { ...studioInputs(), projectId: slug.toUpperCase().replace(/-/g, '_'), ...args }
  // A replacer function, so "$&" or "$$" in Lucas's text or the state is inserted literally.
  const run = src.replace(marker, () => `// Inputs embedded by tools/studio.mjs for project "${slug}".\nconst EMBEDDED_ARGS = ${JSON.stringify(embedded)}\nconst input = { ...EMBEDDED_ARGS, ...(args || {}) }`)
  const out = path.join(projectDir(slug), '.run.js')
  fs.writeFileSync(out, run)
  const roles = Object.keys(embedded.craft)
  console.log(`Wrote ${path.relative(ROOT, out)} (${args.command}; ${roles.length} craft brief${roles.length === 1 ? '' : 's'}: ${roles.join(', ') || 'none'})`)
  console.log(`Run it: Workflow({ scriptPath: '${path.relative(ROOT, out)}' })`)
}

function loadState(slug) {
  const p = path.join(projectDir(slug), 'state.json')
  if (!fs.existsSync(p)) die(`no state for ${slug} yet: run it once and save the output first`)
  return readJSON(p)
}

// ---- commands ----

function cmdNew(slug, idea, f) {
  if (!idea || !idea.trim()) die('give the idea as the second argument')
  const dir = projectDir(slug)
  if (fs.existsSync(path.join(dir, 'state.json'))) die(`${slug} already has a state; pick another name or use resume`)
  fs.mkdirSync(dir, { recursive: true })
  const hints = {}
  if (f.format) hints.format = f.format
  if (f.seconds) hints.duration_seconds = Number(f.seconds)
  if (f.brand) hints.brand = f.brand
  writeJSON(path.join(dir, 'idea.json'), { idea: idea.trim(), hints, idea_doc_id: f['idea-id'] || null })
  writeRun(slug, { command: 'IDEA', idea: idea.trim(), ideaHints: hints, ...runOptions(f) })
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
  // An approval applies only to the versions Lucas saw: the desk records them with the decision.
  if (d.decision === 'approved') {
    const shown = (d.artifact_ids_and_revisions || []).slice().sort()
    const current = (g.artifacts_for_review || []).filter(a => a.status !== 'stale').map(a => `${a.artifact_id}@r${a.revision}`).sort()
    if (!shown.length && !f['no-version-check']) die('the decision lists no versions, so it can\'t be checked against what Lucas saw. Pass --no-version-check only for an approval Lucas gave in chat about the current package.')
    if (shown.length && shown.join() !== current.join()) die(`the desk card showed ${shown.join(', ')}, but the project is now at ${current.join(', ')}. Republish projects/${slug}/desk.json and ask Lucas to decide again.`)
  }
  const approval = { approved: true, selected_route_id: d.selected_route_id || undefined, approver_id: d.approver_id, decided_at: d.decided_at, comment: d.comment || '', decision_id: d.decision_id || d.id }
  writeRun(slug, { command: 'APPROVE', priorState: state, approvals: { [d.gate_id]: approval } })
}

function cmdNotes(slug, notes, f) {
  if (!notes || !notes.trim()) die('give the notes as the second argument')
  writeRun(slug, { command: 'NOTES', priorState: loadState(slug), notes: notes.trim(), decision_id: f['decision-id'] || null })
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
}
const GRADED = ['development', 'strategy', 'concepts', 'script', 'casting_bible', 'world_bible', 'directors_treatment', 'style_bible', 'sound_plan', 'camera_plan', 'storyboard', 'generation_plan']

function grades(s) {
  return GRADED.filter(k => art(s, k)).map(k => {
    const q = art(s, k).quality
    const grade = q ? (q.incomplete ? 'unfinished' : q.grade) : 'not graded'
    return {
      key: k, label: LABELS[k], artifact: `${art(s, k).artifact_id} r${art(s, k).revision}`, status: art(s, k).status,
      grade, lowest: q ? q.min : null, rounds: q ? q.rounds : 0, failed_checks: (art(s, k).checks && art(s, k).checks.failed) || [], scores: q ? q.scores : null,
      // What a reviewer still wants, shown wherever the grade isn't A.
      notes: grade === 'A' ? [] : ((q && q.notes) || []).map(n => (typeof n === 'string' ? n : `${n.target ? `${n.target}: ` : ''}${n.note}`)),
    }
  })
}

// Envelope items from current work only (stale work is being replaced).
const live = s => Object.entries(s.artifacts || {}).filter(([, a]) => a && a.status !== 'stale' && !a.not_run)
const lucasBlockers = s => live(s).flatMap(([k, a]) => (a.blockers || [])
  .filter(b => /lucas/i.test(b.responsible_agent || '') || a.status === 'blocked')
  .map(b => `${LABELS[k] || k}: ${b.issue}${b.resolution ? ` (${b.resolution})` : ''}`))
const otherBlockers = s => live(s).flatMap(([k, a]) => (a.blockers || [])
  .filter(b => !/lucas/i.test(b.responsible_agent || '') && a.status !== 'blocked')
  .map(b => ({ department: LABELS[k] || k, ...b })))
const questionsFor = s => [...new Set([...(s.needs_human_input || []), ...(s.open_questions || []), ...lucasBlockers(s)])]
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
  md.push(table(gr, [['label', 'Department'], ['grade', 'Grade'], ['lowest', 'Lowest score'], ['rounds', 'Review rounds'], [x => x.failed_checks.length, 'Failed checks'], ['artifact', 'Version']]))
  const below = gr.filter(x => x.grade !== 'A' && (x.notes.length || x.failed_checks.length))
  if (below.length) md.push(`### What keeps these below A\n\n${below.map(x => `**${x.label}**\n\n${list([...x.failed_checks.map(c => `Failed check: ${c}`), ...x.notes])}`).join('\n\n')}`)
  const qs = questionsFor(s)
  if (qs.length) md.push(`## Questions for you\n\n${list(qs)}`)

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
  const deliverables = (s.brief.deliverables || []).filter(d => d.type !== 'outline')
  if (shots.length) {
    const blocks = []
    deliverables.forEach(d => {
      const mine = byDeliverable(shots, d)
      if (!mine.length) return
      let t = 0
      const rows = mine.map(sh => { const start = t; t += (sh.duration_frames || 0) / (sh.fps || 24); return { ...sh, ...(panelById[sh.shot_id] || {}), start: `${start.toFixed(1)}s` } })
      blocks.push(`### ${d.id} · ${d.type === 'video' ? `${d.duration_seconds}s` : `${d.count || 1} still(s)`} ${d.aspect_ratio || ''}\n\n${table(rows, [['shot_id', 'Shot'], ['start', 'At'], [x => `${x.duration_frames}f @${x.fps}`, 'Length'], ['framing', 'Framing'], ['lens_intent', 'Lens'], ['action', 'Action'], ['dialogue_or_voiceover', 'Dialogue / VO'], ['on_screen_text', 'On screen'], ['sound_cues', 'Sound'], ['generation_risk', 'Generation risk']])}`)
    })
    const unassigned = shots.filter(sh => !deliverables.some(d => (sh.deliverable_ids || []).includes(d.id)))
    if (unassigned.length) blocks.push(`### Other shots\n\n${table(unassigned, [['shot_id', 'Shot'], ['deliverable_ids', 'For'], ['framing', 'Framing'], ['action', 'Action']])}`)
    md.push(`## Shot plan and storyboard\n\n${blocks.join('\n\n')}`)
    md.push(`### Every shot in full\n\n${shots.map(sh => `#### ${sh.shot_id}\n\n${fields({ ...sh, ...(panelById[sh.shot_id] || {}) }, ['shot_id'])}`).join('\n\n')}`)
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
        departments: grades(s).map(x => ({ key: x.key, label: x.label, grade: x.grade, lowest: x.lowest, rounds: x.rounds, failed_checks: x.failed_checks, notes: x.notes })),
        script: (C(s, 'script').deliverable_scripts || []).map(d => ({ deliverable_id: d.deliverable_id, duration_s: d.duration_s, idea_in_one_line: d.idea_in_one_line, cta: d.cta, beats: (d.beats || []).map(b => ({ t: `${b.start_s}–${b.end_s}s`, picture: b.picture, sound: b.sound, vo: b.vo, text: b.on_screen_text })) })),
        cast: (C(s, 'casting_bible').characters || []).map(c => ({ id: c.character_id, role: c.role_in_story, presence: c.screen_presence })),
        open_questions: questionsFor(s),
        blocked_reason: g.blocked_by_stale ? `Can't be approved yet: ${g.blocked_by_stale.length} pieces of work are stale. Claude re-runs the project to rebuild them.` : null,
        stale: g.blocked_by_stale || [],
        open_issues: g.blocked_by_stale ? questionsFor(s) : [],
        next: g.blocked_by_stale ? `Tell Claude "resume ${slug}" to rebuild the stale work.` : null,
        caveat: g.changed_since_review ? `Your last approval wasn't applied: the package changed after you saw it${(g.changed || []).length ? ` (${g.changed.join(', ')} were rebuilt)` : ''}. These are the current versions; approve again if they still work for you.` : null,
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
        status: g ? 'in_review' : s.limit_reached ? 'building' : 'building',
        status_note: g ? `Ready for your review: ${dev.working_title || slug}.` : s.limit_reached ? 'Still building: the studio paused at its per-run call limit and continues next run.' : `At ${s.stage_reached}.`,
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
  case 'save': cmdSave(slug, f._[0]); break
  case 'status': cmdStatus(slug); break
  default:
    console.log(read(fileURLToPath(import.meta.url)).split('\n').slice(1).filter((l, i, a) => a.slice(0, i + 1).every(x => x.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
}
