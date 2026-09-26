// Tests for tools/live-feed.mjs against synthetic workflow journals. Uses a scratch project it deletes.
// Run: node tests/live-feed.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SLUG = 'zz-feed-test'
const PDIR = path.join(ROOT, 'projects', SLUG)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'))
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

// A journal: [label, result | undefined] pairs, in call order.
let n = 0
function journal(name, calls) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  const lines = [{ type: 'launched' }]
  calls.forEach(([label, result]) => {
    const key = `k${++n}`
    lines.push({ type: 'started', key, agentId: `a${n}`, label, phase: 'Test' })
    if (result !== undefined) lines.push({ type: 'result', key, agentId: `a${n}`, result })
  })
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return { dir, lines: lines.length }
}
const review = (s, d, f, c, note) => ({ specificity: { score: s }, distinctiveness: { score: d }, fit: { score: f }, craft: { score: c }, notes: [{ note: note || `note ${s}${d}${f}${c}` }], keep: [`keep ${s}${d}${f}${c}`] })
const made = content => ({ status: 'draft', content: content || {} })
function snap(pointer) {
  fs.writeFileSync(path.join(PDIR, '.live-run'), JSON.stringify(pointer))
  const out = path.join(tmp, `snap${++n}.json`)
  execFileSync('node', [path.join(ROOT, 'tools/live-feed.mjs'), SLUG, '--out', out], { cwd: ROOT, encoding: 'utf8' })
  return JSON.parse(fs.readFileSync(out, 'utf8'))
}
const dept = (s, id) => s.departments.find(d => d.dept === id)

fs.rmSync(PDIR, { recursive: true, force: true })
fs.mkdirSync(PDIR, { recursive: true })
try {
  // Keep-best: a bar of 10 over 3 rounds, where round 1 scored best.
  const kb = journal('kb', [
    ['cinematographer', made()], ['cinematographer · review 1', review(9, 9, 9, 9, 'ROUND-1-NOTE')],
    ['cinematographer · revise 1', made()], ['cinematographer · review 2', review(7, 8, 8, 8)],
    ['cinematographer · revise 2', made()], ['cinematographer · review 3', review(8, 8, 8, 8, 'ROUND-3-NOTE')],
  ])
  const s1 = snap({ journals: [kb], targets: { cinematographer: { min: 10, rounds: 3 } } })
  const c1 = dept(s1, 'cinematographer')
  ok(c1.status === 'done' && c1.kept_round === 1 && c1.grade === 'A' && c1.met_target === false && c1.notes[0] === 'ROUND-1-NOTE', 'the feed reports the version the studio keeps, with its notes: ' + JSON.stringify({ st: c1.status, k: c1.kept_round, n: c1.notes[0] }))
  ok(s1.feed.some(f => /keeping round 1's version/.test(f.text)), 'the log says which round is kept')

  // A 9s round under a 10 bar is still revising, not done.
  const nine = journal('nine', [['cinematographer', made()], ['cinematographer · review 1', review(9, 9, 9, 9)]])
  const c2 = dept(snap({ journals: [nine], targets: { cinematographer: { min: 10, rounds: 5 } } }), 'cinematographer')
  ok(c2.status === 'revising' && c2.met_target === false && c2.grade === 'A', 'A but below the bar reads as revising')

  // The bar comes from the saved state when the pointer has none; so do the rounds already reviewed.
  fs.writeFileSync(path.join(PDIR, 'state.json'), JSON.stringify({ settings: { targets: { cinematographer: { min: 10, rounds: 2 } } }, direction: [{ id: 'LD-01', note: 'FILM', departments: ['cinematographer'] }], artifacts: { camera_plan: { status: 'draft', quality: { rounds: 2, min: 8, scores: {}, incomplete: true, pending: 'revise', target_from_round: 2 } } } }))
  const run1 = journal('run1', [['cinematographer', made()], ['cinematographer · review 1', review(7, 7, 7, 7)], ['cinematographer · revise 1', made()], ['cinematographer · review 2', review(8, 8, 8, 8)]])
  const run2 = journal('run2', [['cinematographer · resume revision', made()], ['cinematographer · review 3', review(9, 9, 9, 9)]])
  const s3 = snap({ journals: [run1, run2] })
  const c3 = dept(s3, 'cinematographer')
  ok(c3.target === 10 && s3.direction.length === 1 && c3.status === 'revising', 'bar, direction and earlier rounds come from the saved state: ' + JSON.stringify({ t: c3.target, st: c3.status }))
  fs.rmSync(path.join(PDIR, 'state.json'))

  // A tie keeps the last round, as the workflow does; a round revised despite meeting its goal failed its checks.
  const tie = journal('tie', [['director', made()], ['director · review 1', review(7, 8, 8, 8)], ['director · revise 1', made()], ['director · review 2', review(6, 8, 8, 8)], ['director · revise 2', made()], ['director · review 3', review(8, 7, 8, 8)]])
  const dt = dept(snap({ journals: [tie] }), 'director')
  ok(dt.kept_round === null && dt.grade === 'below_A', 'a tie on the lowest score and total keeps the last round')
  const chk = journal('chk', [['development_producer', made()], ['development_producer · review 1', review(7, 8, 8, 8)], ['development_producer · revise 1', made()], ['development_producer · review 2', review(9, 9, 9, 9)], ['development_producer · revise 2', made()], ['development_producer · review 3', review(8, 8, 8, 7)]])
  const dc = dept(snap({ journals: [chk] }), 'development_producer')
  ok(dc.kept_round === null && dc.grade === 'below_A', 'a round that failed its code checks is never the kept version')

  // A cycle whose run was already saved: the state is the one it ended in, so it reads as finished.
  const nines = { specificity: 9, distinctiveness: 9, fit: 9, craft: 9 }
  fs.writeFileSync(path.join(PDIR, 'state.json'), JSON.stringify({ settings: { targets: { cinematographer: { min: 10, rounds: 3 } } }, artifacts: { camera_plan: { status: 'draft', quality: { rounds: 5, min: 9, scores: nines, target: 10, met_target: false, target_from_round: 2 } } } }))
  const endedRun = journal('ended', [['cinematographer · resume revision', made()], ['cinematographer · review 3', review(9, 9, 9, 9)], ['cinematographer · revise 3', made()], ['cinematographer · review 4', review(9, 9, 9, 9)], ['cinematographer · revise 4', made()], ['cinematographer · review 5', review(9, 9, 9, 9)]])
  const nextRun = journal('next', [['storyboard_artist', undefined]])
  ok(dept(snap({ journals: [endedRun, nextRun] }), 'cinematographer').status === 'done', 'a finished cycle stays finished once its run is saved')

  // The reviewed version a bar sent back is kept when every revision scores lower.
  fs.writeFileSync(path.join(PDIR, 'state.json'), JSON.stringify({ settings: { targets: { cinematographer: { min: 10, rounds: 3 } } }, artifacts: { camera_plan: { status: 'draft', quality: { rounds: 2, min: 9, scores: nines, notes: [{ note: 'SAVED-NOTE' }], keep: [] } } } }))
  const lower = journal('lower', [['cinematographer · resume revision', made()], ['cinematographer · review 3', review(8, 8, 8, 8)], ['cinematographer · revise 3', made()], ['cinematographer · review 4', review(8, 8, 8, 8)], ['cinematographer · revise 4', made()], ['cinematographer · review 5', review(8, 8, 8, 8)]])
  const kept = dept(snap({ journals: [lower] }), 'cinematographer')
  ok(kept.status === 'done' && kept.kept_round === 2 && kept.notes[0] === 'SAVED-NOTE', 'the version a resumed cycle started from can be the one kept: ' + JSON.stringify({ st: kept.status, k: kept.kept_round }))

  // A resume in place of a notes cycle is not a new run: its rounds count from 1.
  fs.writeFileSync(path.join(PDIR, 'state.json'), JSON.stringify({ settings: { targets: { cinematographer: { min: 10, rounds: 3 } } }, artifacts: { camera_plan: { status: 'draft', quality: { rounds: 2, min: 8, scores: nines } } } }))
  const nc = journal('nc', [['cinematographer · revise from notes', made()], ['cinematographer · review 1', review(9, 9, 9, 9)], ['cinematographer · revise 1', made()], ['cinematographer · review 2', review(9, 9, 9, 9)], ['cinematographer · revise 2', undefined]])
  fs.appendFileSync(path.join(nc.dir, 'journal.jsonl'), [
    { type: 'started', key: 'nc-a', agentId: 'x1', label: 'cinematographer · revise 2', phase: 'T' }, { type: 'result', key: 'nc-a', agentId: 'x1', result: made() },
    { type: 'started', key: 'nc-b', agentId: 'x2', label: 'cinematographer · review 3', phase: 'T' }, { type: 'result', key: 'nc-b', agentId: 'x2', result: review(9, 9, 9, 9) },
  ].map(l => JSON.stringify(l)).join('\n') + '\n')
  ok(dept(snap({ journals: [{ dir: nc.dir, lines: nc.lines }, { dir: nc.dir, from: nc.lines }] }), 'cinematographer').status === 'done', 'a notes cycle resumed in place finishes after the bar\'s rounds')
  fs.rmSync(path.join(PDIR, 'state.json'))

  // 'resume revision' wording.
  const rr = journal('rr', [['cinematographer · resume revision', undefined]])
  ok(snap({ journals: [rr] }).active.some(a => a.text === 'Camera: resuming its revision'), "a resumed revision reads 'resuming its revision'")

  // Blocked work that is redone in a later run is no longer shown as blocked.
  const b1 = journal('b1', [['storyboard_artist', { status: 'blocked', blockers: ['NEED-AN-ANSWER'], content: {} }]])
  const b2 = journal('b2', [['storyboard_artist', made()], ['storyboard_artist · review 1', review(9, 9, 9, 9)]])
  const sb = dept(snap({ journals: [b1, b2] }), 'storyboard_artist')
  ok(sb.status === 'done' && sb.blocked === '', 'a department redone after being blocked drops the blocked reason')

  // An in-place resume: the stopped attempt's unfinished calls are dropped.
  const ip = journal('ip', [['director', made()], ['director · review 1', review(9, 9, 9, 9)], ['cinematographer', undefined]])
  fs.appendFileSync(path.join(ip.dir, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'k-new', agentId: 'a-new', label: 'cinematographer', phase: 'Test' }) + '\n')
  const s5 = snap({ journals: [{ dir: ip.dir, lines: ip.lines }, { dir: ip.dir, from: ip.lines }] })
  ok(s5.calls.running === 1 && s5.active.length === 1 && dept(s5, 'director').status === 'done', 'an in-place resume shows only the live attempt as running: ' + JSON.stringify(s5.calls))

  // Revise from notes starts a new review cycle.
  const rn = journal('rn', [['copywriter', made()], ['copywriter · review 1', review(9, 9, 9, 9)], ['copywriter · revise from notes', made()], ['copywriter · review 1', review(8, 9, 9, 9)]])
  const cw = dept(snap({ journals: [rn] }), 'copywriter')
  ok(cw.rounds.length === 1 && cw.rounds[0].min === 8, 'a revision from notes starts a fresh set of rounds')
} finally {
  fs.rmSync(PDIR, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
if (fails) process.exit(1)
