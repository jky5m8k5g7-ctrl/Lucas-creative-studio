#!/usr/bin/env node
// Live feed for a running build: turns the workflow's journal into a small progress snapshot
// (departments, review scores, the latest reviewer notes, recent events) for the live page.
//
//   node tools/live-feed.mjs <slug> --out <snapshot.json> [--wait <seconds>]
//
// The run to follow is named in projects/<slug>/.live-run (JSON: { journal, run, finished }, or
// { journals: [{ dir, from?, lines? }, ...] } for a build that continued in a new run, or resumed
// in place (the same dir twice: [{ dir, lines: N }, { dir, from: N }]): earlier entries are read
// from `from` up to `lines`, and their calls that never finished are left out. Lucas's bars and
// direction come from `targets` and `direction` here, or else from the project's saved state).
// With --wait, it waits (polling, up to the given seconds) for the journal to change since the
// snapshot already in --out, then writes a fresh one either way. It prints one word: "changed",
// "heartbeat" (nothing new; the snapshot only has a fresh written_at, so the page knows the
// feed is alive) or "finished" (the run is over).
import fs from 'node:fs'
import path from 'node:path'

const DEPTS = [
  ['development_producer', 'Development', 'Develops the idea into a brief'],
  ['strategist', 'Strategy', 'The audience and the one thing to say'],
  ['creative_director', 'Routes', 'Three creative routes, one recommended'],
  ['copywriter', 'Script', 'The pilot outline and the build sequence'],
  ['casting_director', 'Casting', 'Who plays everyone, and how'],
  ['production_designer', 'World', 'Every location and prop'],
  ['director', "Director's treatment", 'How it plays and feels'],
  ['stylist', 'Style', 'Wardrobe, hair and makeup'],
  ['sound_designer', 'Sound', 'Music, silence and every sound cue'],
  ['cinematographer', 'Camera', 'Every shot: framing, lens, timing'],
  ['storyboard_artist', 'Storyboard', 'Panels, continuity and risk'],
  ['generation_supervisor', 'Generation plan', 'How each shot gets made'],
]
const NAME = Object.fromEntries(DEPTS.map(([d, n]) => [d, n]))
const LENS = { creative_director: 'Creative director', film_director: 'Film director', commissioner: 'Commissioner', client: 'Client' }

const args = process.argv.slice(2)
const slug = args[0]
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const out = opt('--out')
const wait = Number(opt('--wait') || 0)
if (!slug || !out) {
  console.error('usage: node tools/live-feed.mjs <slug> --out <snapshot.json> [--wait <seconds>]')
  process.exit(2)
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const pointerFile = path.join(root, 'projects', slug, '.live-run')
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const pointer = () => readJson(pointerFile) || {}
const journalsOf = p => (Array.isArray(p.journals) ? p.journals : p.journal ? [{ dir: p.journal }] : [])
const size = f => { try { return fs.statSync(f).size } catch { return -1 } }
const journalBytes = p => journalsOf(p).reduce((n, j) => n + size(path.join(j.dir, 'journal.jsonl')), 0)
const mtime = f => { try { return fs.statSync(f).mtime.toISOString() } catch { return null } }
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s }

function readJournal(file, limit, from) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const lines = text.split('\n').slice(from || 0, limit || undefined)
  // The last line may still be being written.
  return lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

// "copywriter · review 2" → { dept, step: 'review', round: 2 }
function parseLabel(label = '') {
  let m
  if ((m = label.match(/^integrity QC (\d+)$/))) return { group: 'qc', step: 'qc', round: +m[1] }
  if ((m = label.match(/^panel · (\w+) · round (\d+)$/))) return { group: 'panel', lens: m[1], step: 'panel', round: +m[2] }
  if (label === 'producer · route your notes') return { group: 'router', step: 'route' }
  const [dept, ...rest] = label.split(' · ')
  if (!NAME[dept]) return { group: 'other', step: 'other' }
  const tail = rest.join(' · ')
  const fix = tail.match(/fix checks (\d+)$/)
  if ((m = tail.match(/^review (\d+)$/))) return { group: 'dept', dept, step: 'review', round: +m[1] }
  if ((m = tail.match(/^revise (\d+)/))) return { group: 'dept', dept, step: fix ? 'fix' : 'revise', round: +m[1] }
  if (/^revise from notes/.test(tail)) return { group: 'dept', dept, step: fix ? 'fix' : 'notes' }
  if (/^resume revision/.test(tail)) return { group: 'dept', dept, step: fix ? 'fix' : 'revise' }
  return { group: 'dept', dept, step: fix ? 'fix' : 'draft' }
}

function headline(dept, c) {
  if (!c || typeof c !== 'object') return ''
  if (dept === 'creative_director' && Array.isArray(c.routes)) {
    const rec = c.routes.find(r => r.route_id === c.recommended_route_id)
    return rec ? `Recommended: ${clip(rec.central_idea, 220)}` : ''
  }
  for (const k of ['logline', 'single_minded_proposition', 'central_idea', 'title', 'summary', 'approach', 'overview', 'concept']) {
    if (typeof c[k] === 'string' && c[k].trim()) return clip(c[k], 240)
  }
  return ''
}

function snapshot() {
  const p = pointer()
  const js = journalsOf(p)
  const starts = new Map()
  const results = new Map()
  let events = 0
  js.forEach((j, i) => {
    const rows = readJournal(path.join(j.dir, 'journal.jsonl'), j.lines, j.from)
    events += rows.length
    // An earlier run's calls that never finished were stopped with it: leave them out.
    const done = new Set(rows.filter(e => e.type === 'result').map(e => e.key))
    for (const e of rows) {
      if (e.type === 'started' && (i === js.length - 1 || done.has(e.key))) starts.set(e.key, { ...e, dir: j.dir })
      else if (e.type === 'result') results.set(e.key, e)
    }
  })
  const saved = readJson(path.join(root, 'projects', slug, 'state.json')) || {}
  const targets = p.targets || (saved.settings && saved.settings.targets) || {}
  const directionList = p.direction || saved.direction || []
  // Rounds a department had already been reviewed when a bar was set on it count toward its limit.
  const fromRound = dept => {
    const t = targets[dept] || {}
    if (t.from_round != null) return t.from_round
    const key = { cinematographer: 'camera_plan', storyboard_artist: 'storyboard', generation_supervisor: 'generation_plan' }[dept]
    const q = key && saved.artifacts && saved.artifacts[key] && saved.artifacts[key].quality
    return (q && q.target_from_round) || 0
  }
  const times = s => ({
    at: s.agentId ? mtime(path.join(s.dir, `agent-${s.agentId}.meta.json`)) : null,
    end: s.agentId ? mtime(path.join(s.dir, `agent-${s.agentId}.jsonl`)) : null,
  })

  const depts = Object.fromEntries(DEPTS.map(([d, n, what]) => [d, { dept: d, name: n, what, status: 'waiting', step: null, rounds: [], grade: null, headline: '', notes: [], keep: '', calls: 0, blocked: '', target: (targets[d] && targets[d].min) || null, met_target: null, kept_round: null }]))
  const qc = []
  const panel = []
  let router = null
  const feed = []
  const active = []
  let running = 0
  let title = ''
  let logline = ''
  let format = ''
  let phase = ''
  let lastAt = null

  for (const s of starts.values()) {
    const r = results.get(s.key)
    const res = r && r.result
    const info = parseLabel(s.label)
    const t = times(s)
    phase = s.phase || phase
    if (!r) running++
    const doneAt = r ? t.end : null
    lastAt = [lastAt, t.at, doneAt].filter(Boolean).sort().pop() || lastAt

    if (info.group === 'dept') {
      const d = depts[info.dept]
      d.calls++
      // A fresh draft, or a revision from notes, starts the department's review cycle over.
      if (info.step === 'draft' || info.step === 'notes') { d.rounds = []; d.grade = null; d.met_target = null; d.notes = []; d.keep = ''; d.blocked = ''; d.kept_round = null }
      if (!r) {
        d.status = { draft: 'drafting', review: 'reviewing', revise: 'revising', notes: 'revising', fix: 'fixing' }[info.step]
        d.step = info.step === 'review' ? `review ${info.round}` : info.step
        feed.push({ running: true, at: t.at, dept: info.dept, text: `${d.name}: ${{ draft: 'drafting', review: `reviewer scoring round ${info.round}`, revise: info.round ? `revising (round ${info.round})` : 'resuming its revision', notes: 'revising from notes', fix: 'fixing failed checks' }[info.step]}` })
        continue
      }
      if (info.step === 'review') {
        if (res && res.specificity) {
          const sc = { s: res.specificity.score, d: res.distinctiveness.score, f: res.fit.score, c: res.craft.score }
          const min = Math.min(sc.s, sc.d, sc.f, sc.c)
          const notes = (res.notes || []).slice(0, 3).map(n => clip(n.note, 280))
          const keep = clip((res.keep || [])[0], 220)
          d.rounds.push({ round: info.round, ...sc, min, notes, keep })
          d.grade = min >= 8 ? 'A' : 'below_A'
          d.notes = notes
          d.keep = keep
          d.kept_round = null
          const goal = d.target || 8
          const maxRounds = d.target ? Math.max(3, fromRound(info.dept) + (targets[info.dept].rounds || 3)) : 3
          const last = info.round >= maxRounds
          if (d.target) d.met_target = min >= goal
          d.status = min >= goal || last ? 'done' : 'revising'
          d.step = null
          let verdict = min >= goal ? (d.target ? ` (${goal}s: your bar met)` : ' (A)') : last ? (d.target ? ` (below your bar of ${goal} after ${maxRounds} rounds)` : ' (below A after 3 rounds)') : d.target && min >= 8 ? `, A but below your bar of ${goal}: revising` : ', sent back to revise'
          // Finished: the studio keeps the best-scoring version of this cycle, as the workflow does.
          if (d.status === 'done') {
            const score = r => [r.min, r.s + r.d + r.f + r.c]
            const best = d.rounds.reduce((b, r) => { const x = score(r), y = score(b); return x[0] > y[0] || (x[0] === y[0] && x[1] > y[1]) ? r : b })
            if (best !== d.rounds[d.rounds.length - 1]) {
              d.kept_round = best.round
              d.grade = best.min >= 8 ? 'A' : 'below_A'
              if (d.target) d.met_target = best.min >= goal
              d.notes = best.notes
              d.keep = best.keep
              verdict += `; keeping round ${best.round}'s version (${best.s} · ${best.d} · ${best.f} · ${best.c})`
            }
          }
          feed.push({ at: doneAt, dept: info.dept, text: `${d.name} review ${info.round}: ${sc.s} · ${sc.d} · ${sc.f} · ${sc.c}${verdict}` })
        } else {
          feed.push({ at: doneAt, dept: info.dept, text: `${d.name} review ${info.round}: no result` })
        }
      } else {
        if (res && res.status === 'blocked') {
          d.status = 'blocked'
          d.blocked = clip((res.blockers || [])[0], 220)
        } else {
          d.blocked = ''
          d.status = 'reviewing'
          const h = headline(info.dept, res && res.content)
          if (h) d.headline = h
        }
        if (info.dept === 'development_producer' && res && res.content) {
          title = res.content.working_title || title
          logline = res.content.logline || logline
          format = res.content.format || format
        }
        feed.push({ at: doneAt, dept: info.dept, text: `${d.name}: ${{ draft: 'first draft in', revise: 'revision in', notes: 'revision from notes in', fix: 'checks fixed' }[info.step]}${res && res.status === 'blocked' ? ' (blocked)' : ''}` })
      }
    } else if (info.group === 'qc') {
      if (!r) { feed.push({ running: true, at: t.at, text: `Integrity QC round ${info.round}: checking every department against each other` }); continue }
      const c = (res && res.content) || {}
      qc.push({ round: info.round, recommendation: c.recommendation || '', issues: (c.issues || []).length, top: (c.issues || []).slice(0, 3).map(i => clip(`${i.severity ? i.severity + ": " : ""}${i.evidence || i.issue || JSON.stringify(i)}`, 220)) })
      feed.push({ at: doneAt, text: `Integrity QC round ${info.round}: ${(c.issues || []).length} issue(s), ${c.recommendation || 'no recommendation'}` })
    } else if (info.group === 'panel') {
      const who = LENS[info.lens] || info.lens
      if (!r) { feed.push({ running: true, at: t.at, text: `Package panel: ${who} reading the whole package (round ${info.round})` }); continue }
      const sc = res && res.specificity ? { s: res.specificity.score, d: res.distinctiveness.score, f: res.fit.score, c: res.craft.score } : null
      const min = sc ? Math.min(sc.s, sc.d, sc.f, sc.c) : null
      panel.push({ lens: info.lens, who, round: info.round, would_approve: !!(res && res.would_approve), ...(sc || {}), min, note: clip(((res && res.notes) || [])[0] && res.notes[0].note, 260) })
      feed.push({ at: doneAt, text: `${who} (panel round ${info.round}): ${sc ? `${sc.s} · ${sc.d} · ${sc.f} · ${sc.c}` : 'no scores'}, ${res && res.would_approve ? 'would approve' : 'would not approve yet'}` })
    } else if (info.group === 'router') {
      router = r ? 'done' : 'running'
      feed.push({ running: !r, at: r ? doneAt : t.at, text: r ? 'Producer routed the notes to departments' : 'Producer routing notes to departments' })
    }
  }

  for (const e of feed) if (e.running) { active.push({ text: e.text, at: e.at, dept: e.dept }); delete e.running }
  feed.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  const started = starts.size
  const done = [...starts.keys()].filter(k => results.has(k)).length
  return {
    project: slug,
    run: p.run || '',
    title,
    logline,
    format,
    phase,
    calls: { started, done, running },
    budget: p.budget || null,
    started_at: starts.size ? times([...starts.values()][0]).at : null,
    direction: directionList.map(d => ({ id: d.id, note: d.note, lucas_words: d.lucas_words || '', departments: (d.departments || []).map(x => NAME[x] || x) })),
    last_event_at: lastAt,
    written_at: new Date().toISOString(),
    departments: DEPTS.map(([d]) => depts[d]),
    qc,
    panel,
    router,
    active,
    feed: feed.slice(-24).reverse(),
    finished: p.finished || null,
    journal_bytes: journalBytes(p),
  }
}

async function main() {
  const prev = readJson(out)
  if (wait > 0) {
    const deadline = Date.now() + wait * 1000
    const pause = ms => new Promise(r => setTimeout(r, ms))
    for (;;) {
      const p = pointer()
      if (p.finished && !(prev && prev.finished)) break
      const now = journalBytes(p)
      if (!prev || now !== prev.journal_bytes) {
        // Let parallel starts land together.
        await pause(8000)
        break
      }
      if (Date.now() > deadline) break
      await pause(3000)
    }
  }
  const snap = snapshot()
  const changed = !prev || snap.journal_bytes !== prev.journal_bytes || !!snap.finished !== !!prev.finished
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(snap))
  console.log(snap.finished ? 'finished' : changed ? 'changed' : 'heartbeat')
}

main()
