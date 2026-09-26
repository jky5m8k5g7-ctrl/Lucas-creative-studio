#!/usr/bin/env node
// Recovers a project after its run was lost (a container restart, a stopped task) without redoing
// finished work. Replays the lost run's own script with every call answered by the result it
// actually returned (from the run's journal), stopped by the call budget at the latest point where
// every call asked for had finished. Then files that state like a normal run output, so
// `node tools/studio.mjs resume <slug>` continues from it in a fresh run.
//
//   node tools/recover.mjs <slug> <run transcript dir with journal.jsonl> [--script <path>]
//
// --script is the script the lost run executed (default projects/<slug>/.run.js; use it only if
// that file was rewritten since). A Workflow resumeFromRunId reuses cached calls only up to the
// first one that changed or ran in a different order, which parallel departments break; this
// matches calls by label and occurrence instead, so order doesn't matter.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadWorkflow } from '../tests/load-workflow.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const [slug, runDir] = args
const si = args.indexOf('--script')
const script = si >= 0 ? path.resolve(args[si + 1]) : path.join(ROOT, 'projects', slug || '', '.run.js')
if (!slug || !runDir || !fs.existsSync(path.join(runDir, 'journal.jsonl')) || !fs.existsSync(script)) {
  console.error('usage: node tools/recover.mjs <slug> <run transcript dir> [--script <path>]')
  process.exit(2)
}

const L = fs.readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8').split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const results = new Map(L.filter(e => e.type === 'result').map(e => [e.key, e.result]))
const byLabel = {}
for (const e of L) if (e.type === 'started') (byLabel[e.label] = byLabel[e.label] || []).push(results.get(e.key))
const finished = results.size

async function replay(budget) {
  const run = await loadWorkflow(script)
  const seen = {}
  let missing = null
  const agent = async (prompt, o = {}) => {
    const i = seen[o.label] = (seen[o.label] || 0) + 1
    const r = (byLabel[o.label] || [])[i - 1]
    if (!r) { missing = missing || o.label; return null }
    return r
  }
  const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const result = await run({ maxAgentCalls: budget }, agent, parallel, () => {}, () => {})
  return { result, missing, calls: Object.values(seen).reduce((a, b) => a + b, 0) }
}

// The largest budget at which the replay never asks for a call that didn't finish.
let lo = 0
let hi = finished
let best = null
while (lo <= hi) {
  const mid = Math.floor((lo + hi) / 2)
  const r = await replay(mid)
  if (r.missing) hi = mid - 1
  else { best = { budget: mid, ...r }; lo = mid + 1 }
}
if (!best || !best.result || !best.result.project_state) {
  console.error('recover: the replay produced no project state')
  process.exit(1)
}
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recover-')), 'output.json')
fs.writeFileSync(out, JSON.stringify({ result: best.result, totalTokens: null }))
console.log(`Recovered ${best.calls} of ${finished} finished calls from ${path.basename(runDir)}; the rest run again.`)
execFileSync('node', [path.join(ROOT, 'tools/studio.mjs'), 'save', slug, out], { stdio: 'inherit' })
console.log(`Next: node tools/studio.mjs resume ${slug}, then run the script it writes.`)
