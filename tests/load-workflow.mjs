// Loads a Workflow script as an async function (args, agent, parallel, phase, log) for tests.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function loadWorkflow(file) {
  const src = fs.readFileSync(file, 'utf8').replace('export const meta', 'const meta')
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'run.mjs')
  fs.writeFileSync(tmp, `export const run = async (args, agent, parallel, phase, log) => {\n${src}\n}\n`)
  return (await import(pathToFileURL(tmp).href)).run
}
