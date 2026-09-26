#!/usr/bin/env node
// Live feed for a running build: turns the workflow's journal into a small progress snapshot
// (departments, review scores, the latest reviewer notes, recent events) for the live page.
//
//   node tools/live-feed.mjs <slug> --out <snapshot.json> [--wait <seconds>]
//
// The run to follow is named in projects/<slug>/.live-run (JSON: { journal, run, finished }).
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
const journalFile = p => (p.journal ? path.join(p.journal, 'journal.jsonl') : null)
const size = f => { try { return fs.statSync(f).size } catch { return -1 } }
const mtime = f => { try { return fs.statSync(f).mtime.toISOString() } catch { return null } }
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s }

function readJournal(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const lines = text.split('\n')
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
  const jf = journalFile(p)
  const events = jf ? readJournal(jf) : []
  const starts = new Map()
  const results = new Map()
  for (const e of events) {
    if (e.type === 'started') starts.set(e.key, e)
    else if (e.type === 'result') results.set(e.key, e)
  }
  const dir = p.journal
  const times = s => ({
    at: s.agentId ? mtime(path.join(dir, `agent-${s.agentId}.meta.json`)) : null,
    end: s.agentId ? mtime(path.join(dir, `agent-${s.agentId}.jsonl`)) : null,
  })

  const depts = Object.fromEntries(DEPTS.map(([d, n, what]) => [d, { dept: d, name: n, what, status: 'waiting', step: null, rounds: [], grade: null, headline: '', notes: [], keep: '', calls: 0, blocked: '' }]))
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
      if (!r) {
        d.status = { draft: 'drafting', review: 'reviewing', revise: 'revising', notes: 'revising', fix: 'fixing' }[info.step]
        d.step = info.step === 'review' ? `review ${info.round}` : info.step
        feed.push({ running: true, at: t.at, dept: info.dept, text: `${d.name}: ${{ draft: 'drafting', review: `reviewer scoring round ${info.round}`, revise: `revising (round ${info.round || ''})`.replace(' ()', ''), notes: 'revising from notes', fix: 'fixing failed checks' }[info.step]}` })
        continue
      }
      if (info.step === 'review') {
        if (res && res.specificity) {
          const sc = { s: res.specificity.score, d: res.distinctiveness.score, f: res.fit.score, c: res.craft.score }
          const min = Math.min(sc.s, sc.d, sc.f, sc.c)
          d.rounds.push({ round: info.round, ...sc, min })
          d.grade = min >= 8 ? 'A' : 'below_A'
          d.notes = (res.notes || []).slice(0, 3).map(n => clip(n.note, 280))
          d.keep = clip((res.keep || [])[0], 220)
          const last = info.round >= 3
          d.status = min >= 8 || last ? 'done' : 'revising'
          d.step = null
          feed.push({ at: doneAt, dept: info.dept, text: `${d.name} review ${info.round}: ${sc.s} · ${sc.d} · ${sc.f} · ${sc.c}${min >= 8 ? ' (A)' : last ? ' (below A after 3 rounds)' : ', sent back to revise'}` })
        } else {
          feed.push({ at: doneAt, dept: info.dept, text: `${d.name} review ${info.round}: no result` })
        }
      } else {
        if (res && res.status === 'blocked') {
          d.status = 'blocked'
          d.blocked = clip((res.blockers || [])[0], 220)
        } else {
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
    started_at: events.length && dir ? mtime(path.join(dir, `agent-${[...starts.values()][0]?.agentId}.meta.json`)) : null,
    last_event_at: lastAt,
    written_at: new Date().toISOString(),
    departments: DEPTS.map(([d]) => depts[d]),
    qc,
    panel,
    router,
    active,
    feed: feed.slice(-24).reverse(),
    finished: p.finished || null,
    journal_bytes: jf ? size(jf) : -1,
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
      const now = size(journalFile(p))
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
