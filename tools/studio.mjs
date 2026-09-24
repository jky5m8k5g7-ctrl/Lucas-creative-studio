#!/usr/bin/env node
// Studio runner: prepares each creative-studio workflow run and files what it returns.
//
// Workflow scripts can't read files, so every run gets a generated copy of the workflow with its
// inputs (craft briefs, taste notes, quality bar, the project's state) embedded. Claude runs that
// copy with Workflow({ scriptPath }), then files the output with `save`.
//
//   node tools/studio.mjs new <slug> "<idea>" [--format ad_spot] [--seconds 30] [--brand Name]
//   node tools/studio.mjs resume <slug>                  continue after a run hit its call budget
//   node tools/studio.mjs approve <slug> <decision.json> apply an Approval Desk decision
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
  const run = src.replace(marker, `// Inputs embedded by tools/studio.mjs for project "${slug}".\nconst EMBEDDED_ARGS = ${JSON.stringify(embedded)}\nconst input = { ...EMBEDDED_ARGS, ...(args || {}) }`)
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
  writeRun(slug, { command: 'IDEA', idea: idea.trim(), ideaHints: hints })
}

function cmdResume(slug) {
  writeRun(slug, { command: 'APPROVE', priorState: loadState(slug) })
}

// A decision as the Approval Desk stores it: { gate_id, decision, selected_route_id, comment,
// approver_id, decided_at, id | decision_id }.
function cmdApprove(slug, decisionFile) {
  const d = readJSON(decisionFile)
  // route_change: Lucas picked a different route at package review; the studio rebuilds on it
  // and brings the package back (the pipeline records no approval for work he hasn't seen).
  if (d.decision !== 'approved' && d.decision !== 'route_change') die(`that decision is "${d.decision}", not an approval; use notes for requested changes`)
  if (d.decision === 'route_change' && !d.selected_route_id) die('a route change needs selected_route_id')
  if (!d.approver_id) die('the decision has no approver_id, so it did not come from the Approval Desk')
  const approval = { approved: true, selected_route_id: d.selected_route_id || undefined, approver_id: d.approver_id, decided_at: d.decided_at, comment: d.comment || '', decision_id: d.decision_id || d.id }
  writeRun(slug, { command: 'APPROVE', priorState: loadState(slug), approvals: { [d.gate_id]: approval } })
}

function cmdNotes(slug, notes, f) {
  if (!notes || !notes.trim()) die('give the notes as the second argument')
  writeRun(slug, { command: 'NOTES', priorState: loadState(slug), notes: notes.trim(), decision_id: f['decision-id'] || null })
}

function cmdSave(slug, outFile) {
  const raw = readJSON(outFile)
  const out = raw.result || raw
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
    return { key: k, label: LABELS[k], artifact: `${art(s, k).artifact_id} r${art(s, k).revision}`, grade: q ? (q.incomplete ? 'unfinished' : q.grade) : 'not graded', lowest: q ? q.min : null, rounds: q ? q.rounds : 0, failed_checks: (art(s, k).checks && art(s, k).checks.failed) || [], scores: q ? q.scores : null }
  })
}

function summary(slug, s, out) {
  const g = s.pending_gate
  const lines = [`${slug}: ${C(s, 'development').working_title || s.brief.name || s.project_id} · stage ${s.stage_reached}`]
  if (out) lines.push(`agent calls this run: ${out.budget_ledger.agent_calls_used_this_run}/${out.budget_ledger.agent_calls_allowed_per_run}${out.budget_ledger.limit_reached ? ' (budget reached: run `resume`)' : ''}`)
  const approved = (s.approval_log || []).some(e => e.gate_id === 'production_plan' && e.decision === 'approved')
  lines.push(g ? `waiting on Lucas: ${g.gate_id}${g.blocked_by_stale ? ' (blocked: stale work)' : ''}` : s.limit_reached ? 'paused: call budget reached (run resume)' : approved ? 'package approved: next is the enhancement phase (full script, or paid media with a budget)' : 'no gate pending')
  if (s.package_review) lines.push(`package: ${s.package_review.grade} (round ${s.package_review.round}, ${s.package_review.approvals}/${s.package_review.of} reviewers would approve)`)
  grades(s).forEach(x => lines.push(`  ${x.label.padEnd(22)} ${String(x.grade).padEnd(11)} ${x.lowest != null ? `lowest ${x.lowest}` : ''}${x.failed_checks.length ? ` · ${x.failed_checks.length} failed check(s)` : ''}`))
  ;(s.open_questions || []).forEach(q => lines.push(`  ? ${q}`))
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
  const r = route(s)
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
    md.push(`Package: **${pr.grade === 'A' ? 'A' : 'below A'}** after ${pr.round} panel round${pr.round === 1 ? '' : 's'}; ${pr.approvals} of ${pr.of} reviewers would approve it today. Averages: ${Object.entries(pr.averages).map(([k, v]) => `${k} ${v}`).join(', ')}.${pr.revised_after_review ? ` Integrity fixes made after the panel's last look: ${pr.revised_after_review.join(', ')}.` : ''}`)
    md.push(table(pr.lenses, [['lens', 'Reviewer'], [l => (l.would_approve ? 'yes' : 'no'), 'Would approve'], [l => Object.values(l.scores).join(' / '), 'Spec / Dist / Fit / Craft'], ['verdict', 'Verdict']]))
  }
  md.push(table(grades(s), [['label', 'Department'], ['grade', 'Grade'], ['lowest', 'Lowest score'], ['rounds', 'Review rounds'], [x => x.failed_checks.join('; '), 'Failed checks'], ['artifact', 'Version']]))
  if ((s.open_questions || []).length || (s.needs_human_input || []).length) {
    md.push(`## Questions for you\n\n${list([...(s.needs_human_input || []), ...(s.open_questions || [])])}`)
  }
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
  const shots = C(s, 'camera_plan').shots || []
  if (shots.length) md.push(`## Shot plan\n\n${table(shots, [['shot_id', 'Shot'], ['deliverable_ids', 'For'], [x => `${x.duration_frames}f @${x.fps}`, 'Length'], ['framing', 'Framing'], ['lens_intent', 'Lens'], ['camera_movement', 'Move'], ['lighting', 'Light'], ['action', 'Action']])}`)
  const panels = C(s, 'storyboard').panels || []
  if (panels.length) md.push(`## Storyboard\n\n${table(panels, [['shot_id', 'Panel'], ['purpose', 'Purpose'], ['action', 'Action'], ['framing', 'Framing'], ['dialogue_or_voiceover', 'Dialogue / VO'], ['on_screen_text', 'On screen'], ['sound_cues', 'Sound']])}${(C(s, 'storyboard').contradictions_flagged || []).length ? `\nContradictions flagged:\n\n${list(C(s, 'storyboard').contradictions_flagged)}\n` : ''}`)
  const tracked = C(s, 'continuity_bible').tracked_elements || []
  if (tracked.length) md.push(`## Continuity\n\n${tracked.map(e => `- **${e.element_id}** (${e.element_type}): ${(e.states_by_shot || []).map(x => `${x.shot_id}: ${x.state}`).join('; ')}`).join('\n')}`)
  const jobs = C(s, 'generation_plan').jobs || []
  if (jobs.length) md.push(`## Generation plan (not run; no paid media without your approval and a budget)\n\n${table(jobs, [['job_id', 'Job'], ['shot_id', 'Shot'], ['job_type', 'Type'], ['prompt', 'Prompt'], ['estimated_cost_unit', 'Est. cost']])}`)
  const qc = C(s, 'quality_reports')
  if (qc.issues) md.push(`## Integrity check\n\nRecommendation: ${qc.recommendation}.\n\n${table(qc.issues, [['severity', 'Severity'], ['shot_or_timecode', 'Where'], ['evidence', 'Issue'], ['responsible_agent', 'Owner']])}`)
  if (out) md.push(`---\n\n_Run: ${out.command}, ${out.budget_ledger.agent_calls_used_this_run} agent calls._`)
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
        panel: pr ? { round: pr.round, approvals: pr.approvals, of: pr.of, averages: pr.averages, revised_after_review: pr.revised_after_review || [], lenses: pr.lenses.map(l => ({ lens: l.lens, would_approve: l.would_approve, verdict: l.verdict, scores: l.scores })) } : null,
        departments: grades(s).map(x => ({ key: x.key, label: x.label, grade: x.grade, lowest: x.lowest, rounds: x.rounds, failed_checks: x.failed_checks.length })),
        script: (C(s, 'script').deliverable_scripts || []).map(d => ({ deliverable_id: d.deliverable_id, duration_s: d.duration_s, idea_in_one_line: d.idea_in_one_line, cta: d.cta, beats: (d.beats || []).map(b => ({ t: `${b.start_s}–${b.end_s}s`, picture: b.picture, sound: b.sound, vo: b.vo, text: b.on_screen_text })) })),
        cast: (C(s, 'casting_bible').characters || []).map(c => ({ id: c.character_id, role: c.role_in_story, presence: c.screen_presence })),
        open_questions: [...(s.needs_human_input || []), ...(s.open_questions || [])],
        blocked_reason: g.blocked_by_stale ? `Can't be approved yet: ${g.blocked_by_stale.length} pieces of work are stale. Claude re-runs the project to rebuild them.` : null,
        stale: g.blocked_by_stale || [],
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
        title: 'Pick the route', ask: 'Approve the strategy and one route. Nothing downstream is built until you do.',
        from_run: `${out ? out.command : 'run'} · ${new Date().toISOString().slice(0, 10)}`,
        strategy: { proposition: C(s, 'strategy').single_minded_proposition, tension: C(s, 'strategy').audience_tension },
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
  case 'resume': cmdResume(slug); break
  case 'approve': cmdApprove(slug, f._[0]); break
  case 'notes': cmdNotes(slug, f._[0], f); break
  case 'save': cmdSave(slug, f._[0]); break
  case 'status': cmdStatus(slug); break
  default:
    console.log(read(fileURLToPath(import.meta.url)).split('\n').slice(1, 20).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
}
