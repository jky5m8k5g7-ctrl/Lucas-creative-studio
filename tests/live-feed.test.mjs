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
  fs.writeFileSync(path.join(PDIR, 'state.json'), JSON.stringify({ settings: { targets: { cinematographer: { min: 10, rounds: 2 } } }, direction: [{ id: 'LD-01', note: 'FILM', departments: ['cinematographer'] }], artifacts: { camera_plan: { quality: { target_from_round: 2 } } } }))
  const from = journal('from', [
    ['cinematographer', made()], ['cinematographer · review 1', review(7, 7, 7, 7)], ['cinematographer · revise 1', made()], ['cinematographer · review 2', review(8, 8, 8, 8)],
    ['cinematographer · resume revision', made()], ['cinematographer · review 3', review(9, 9, 9, 9)],
  ])
  const s3 = snap({ journals: [from] })
  const c3 = dept(s3, 'cinematographer')
  ok(c3.target === 10 && s3.direction.length === 1 && c3.status === 'revising', 'bar, direction and earlier rounds come from the saved state: ' + JSON.stringify({ t: c3.target, st: c3.status }))
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
