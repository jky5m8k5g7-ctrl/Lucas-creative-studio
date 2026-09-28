// Loads a Workflow script as an async function (args, agent, parallel, phase, log, workflow) for
// tests. workflow defaults to running a child script's body with no agents, which is what the
// runner's saved-state part scripts need.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function wrap(file) {
  const src = fs.readFileSync(file, 'utf8').replace('export const meta', 'const meta')
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'run.mjs')
  fs.writeFileSync(tmp, `export const run = async (args, agent, parallel, phase, log, workflow) => {\n${src}\n}\n`)
  return (await import(pathToFileURL(tmp).href)).run
}

export async function loadWorkflow(file) {
  const run = await wrap(file)
  const child = async ref => (await wrap(ref.scriptPath))(undefined, null, null, () => {}, () => {})
  return (args, agent, parallel, phase, log, workflow) => run(args, agent, parallel, phase, log, workflow || child)
}
