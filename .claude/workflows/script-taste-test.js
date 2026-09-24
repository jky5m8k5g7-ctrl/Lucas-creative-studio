export const meta = {
  name: 'script-taste-test',
  description: 'A/B test the copywriter: current prompt vs craft brief + taste notes + code checks + a notes round, judged blind from three angles',
  phases: [
    { title: 'Draft', detail: 'baseline copywriter vs enhanced copywriter with code checks' },
    { title: 'Notes', detail: 'creative director notes from the taste file, then a revision' },
    { title: 'Judge', detail: 'three blind judges: creative director, film director, client' },
  ],
}

// Usage: Workflow({ scriptPath: '.claude/workflows/script-taste-test.js',
//                   args: <contents of tests/fixtures/quiet-mornings.json> })
// Enhanced agents read spec/roles/copywriter.md and spec/taste/notes.md at run time,
// so editing those files changes the test without touching this script.

const input = args || {}
const brief = input.brief
const strategy = input.strategy
const concepts = input.concepts
const routeId = input.selected_route_id || 'R1'
const route = concepts.routes.find(r => r.route_id === routeId)
const video = brief.deliverables.find(d => d.type === 'video')
const stills = brief.deliverables.find(d => d.type === 'still')
const DURATION = video.duration_seconds

const CRAFT_BRIEF = 'spec/roles/copywriter.md'
const TASTE_NOTES = 'spec/taste/notes.md'
const MAX_RETRIES = 2
const VO_WORDS_MAX = Math.floor(2.5 * DURATION)
const BEAT_WPS_MAX = 3
const CARD_WORDS_MAX = 7
const BANNED = ['elevat\\w*', 'seamless\\w*', 'journey\\w*', 'curated', 'crafted', 'stunning', 'vibrant',
  'cinematic', 'immersive', 'indulg\\w*', 'unlock\\w*', 'effortless\\w*', 'game[- ]changer\\w*',
  'reimagin\\w*', 'discover\\w*', 'introducing', 'more than just', 'because you deserve']
const BANNED_RE = new RegExp('\\b(' + BANNED.join('|') + ')\\b', 'gi')
const BANNED_READABLE = ['elevate', 'seamless', 'journey', 'curated', 'crafted', 'stunning', 'vibrant',
  'cinematic', 'immersive', 'indulge', 'unlock', 'effortless', 'game-changer', 'reimagine', 'discover',
  'introducing', 'more than just', 'because you deserve']

// ---- helpers ----

function words(s) {
  return String(s || '').split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length
}

function bannedHits(text) {
  return (String(text).match(BANNED_RE) || []).map(w => w.toLowerCase())
}

function enhancedText(s) {
  return [s.idea_in_one_line, s.cta]
    .concat((s.beats || []).flatMap(b => [b.picture, b.sound, b.vo, b.on_screen_text]))
    .concat((s.stills_copy || []).flatMap(c => [c.picture, c.headline, c.subline]))
    .join(' \n ')
}

function checkEnhanced(s) {
  const v = []
  const read = (s.files_read || []).join(' ')
  ;[CRAFT_BRIEF, TASTE_NOTES].forEach(p => {
    if (!read.includes(p) || /UNREAD/i.test(read)) v.push(`did not confirm reading ${p} — read it with the Read tool and list it in files_read`)
  })
  const beats = s.beats || []
  if (!beats.length) v.push('no beats')
  if (beats.length) {
    if (Math.abs(beats[0].start_s) > 0.01) v.push(`first beat starts at ${beats[0].start_s}s, not 0s`)
    const last = beats[beats.length - 1]
    if (Math.abs(last.end_s - DURATION) > 0.01) v.push(`last beat ends at ${last.end_s}s; the deliverable is exactly ${DURATION}s`)
    beats.forEach((b, i) => {
      const len = b.end_s - b.start_s
      if (!(len > 0)) v.push(`${b.beat_id}: end_s must be after start_s`)
      if (i > 0 && Math.abs(b.start_s - beats[i - 1].end_s) > 0.01) v.push(`${b.beat_id}: starts at ${b.start_s}s but the previous beat ends at ${beats[i - 1].end_s}s — beats must run back to back`)
      const vw = words(b.vo)
      if (len > 0 && vw / len > BEAT_WPS_MAX) v.push(`${b.beat_id}: ${vw} VO words in ${len}s is ${(vw / len).toFixed(1)} words/sec (max ${BEAT_WPS_MAX})`)
      const tw = words(b.on_screen_text)
      if (tw > CARD_WORDS_MAX) v.push(`${b.beat_id}: on-screen text is ${tw} words (max ${CARD_WORDS_MAX})`)
    })
    const totalVo = beats.reduce((n, b) => n + words(b.vo), 0)
    if (totalVo > VO_WORDS_MAX) v.push(`total VO is ${totalVo} words; ${DURATION}s holds at most ${VO_WORDS_MAX} at 2.5 words/sec`)
  }
  if (!String(s.cta || '').trim()) v.push('missing CTA')
  const hits = [...new Set(bannedHits(enhancedText(s)))]
  if (hits.length) v.push(`banned language: ${hits.join(', ')}`)
  if ((s.stills_copy || []).length !== stills.count) v.push(`stills_copy must have exactly ${stills.count} entries (one per ${stills.aspect_ratio} still)`)
  return v
}

function enhancedMetrics(s) {
  const beats = s.beats || []
  return {
    beats: beats.length,
    vo_words: beats.reduce((n, b) => n + words(b.vo), 0),
    max_card_words: Math.max(0, ...beats.map(b => words(b.on_screen_text))),
    banned_hits: bannedHits(enhancedText(s)),
    picture_described: beats.every(b => words(b.picture) >= 6),
    first_vo_at_s: (beats.find(b => words(b.vo) > 0) || {}).start_s ?? null,
    timing_exact: beats.length > 0 && Math.abs(beats[0].start_s) < 0.01 && Math.abs(beats[beats.length - 1].end_s - DURATION) < 0.01,
  }
}

function parseRange(tc) {
  const toks = String(tc || '').match(/\d+:\d+(?:\.\d+)?|\d+(?:\.\d+)?/g) || []
  const nums = toks.map(t => (t.includes(':') ? Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]) : Number(t)))
  return nums.length >= 2 ? [nums[0], nums[1]] : null
}

function baselineScript(a) {
  const scripts = (a && a.content && a.content.deliverable_scripts) || []
  return scripts.find(s => s.deliverable_id === video.id) || scripts[0] || { beats: [] }
}

function baselineMetrics(s) {
  const beats = s.beats || []
  const ranges = beats.map(b => parseRange(b.timecode))
  const text = [s.hook, s.cta].concat(beats.flatMap(b => [b.dialogue_or_vo, b.on_screen_copy])).join(' \n ')
  const parsed = ranges.every(Boolean)
  return {
    beats: beats.length,
    vo_words: beats.reduce((n, b) => n + words(b.dialogue_or_vo), 0),
    max_card_words: Math.max(0, ...beats.map(b => words(b.on_screen_copy))),
    banned_hits: bannedHits(text),
    picture_described: false,
    timing_exact: parsed && ranges.length > 0 && Math.abs(ranges[0][0]) < 0.01 && Math.abs(ranges[ranges.length - 1][1] - DURATION) < 0.01,
  }
}

// Both formats are rendered into the same plain-text layout so judges compare
// the writing, not the JSON shape.
function renderBaseline(s) {
  const lines = [`HOOK: ${s.hook || '(none)'}`]
  ;(s.beats || []).forEach(b => {
    lines.push(`${b.timecode} | PICTURE: (not specified) | VO: ${b.dialogue_or_vo || '—'} | ON-SCREEN: ${b.on_screen_copy || '—'} | SOUND: (not specified)`)
  })
  lines.push(`CTA: ${s.cta || '(none)'}`)
  return lines.join('\n')
}

function renderEnhanced(s) {
  const lines = [`HOOK: ${((s.beats || [])[0] || {}).picture || '(none)'}`]
  ;(s.beats || []).forEach(b => {
    lines.push(`${b.start_s.toFixed(1)}–${b.end_s.toFixed(1)}s | PICTURE: ${b.picture} | VO: ${b.vo || '—'} | ON-SCREEN: ${b.on_screen_text || '—'} | SOUND: ${b.sound || '—'}`)
  })
  lines.push(`CTA: ${s.cta || '(none)'}`)
  return lines.join('\n')
}

// ---- schemas ----

const BASELINE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['draft', 'review_required', 'blocked'] },
    based_on: { type: 'array', items: { type: 'string' } },
    content: {
      type: 'object',
      properties: {
        deliverable_scripts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              deliverable_id: { type: 'string' },
              duration_seconds: { type: 'integer' },
              hook: { type: 'string' },
              beats: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    timecode: { type: 'string' },
                    dialogue_or_vo: { type: 'string' },
                    on_screen_copy: { type: 'string' },
                  },
                  required: ['timecode', 'dialogue_or_vo', 'on_screen_copy'],
                },
              },
              cta: { type: 'string' },
            },
            required: ['deliverable_id', 'duration_seconds', 'hook', 'beats', 'cta'],
          },
        },
      },
      required: ['deliverable_scripts'],
    },
    asset_uri: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { issue: { type: 'string' }, responsible_agent: { type: 'string' }, resolution: { type: 'string' } },
        required: ['issue', 'responsible_agent', 'resolution'],
      },
    },
  },
  required: ['status', 'based_on', 'content', 'assumptions', 'sources', 'blockers'],
}

const BEAT = {
  type: 'object',
  properties: {
    beat_id: { type: 'string' },
    start_s: { type: 'number' },
    end_s: { type: 'number' },
    picture: { type: 'string' },
    sound: { type: 'string' },
    vo: { type: 'string' },
    on_screen_text: { type: 'string' },
    taste_note_applied: { type: 'string' },
  },
  required: ['beat_id', 'start_s', 'end_s', 'picture', 'sound', 'vo', 'on_screen_text', 'taste_note_applied'],
}

const ENHANCED_PROPS = {
  files_read: { type: 'array', items: { type: 'string' } },
  deliverable_id: { type: 'string' },
  duration_s: { type: 'number' },
  idea_in_one_line: { type: 'string' },
  beats: { type: 'array', items: BEAT },
  cta: { type: 'string' },
  stills_copy: {
    type: 'array',
    items: {
      type: 'object',
      properties: { still_id: { type: 'string' }, picture: { type: 'string' }, headline: { type: 'string' }, subline: { type: 'string' } },
      required: ['still_id', 'picture', 'headline', 'subline'],
    },
  },
  decisions: {
    type: 'array',
    items: {
      type: 'object',
      properties: { choice: { type: 'string' }, reason: { type: 'string' }, source: { type: 'string' } },
      required: ['choice', 'reason', 'source'],
    },
  },
  route_deviations: {
    type: 'array',
    items: { type: 'object', properties: { what: { type: 'string' }, why: { type: 'string' } }, required: ['what', 'why'] },
  },
}
const ENHANCED_REQUIRED = Object.keys(ENHANCED_PROPS)
const ENHANCED_SCHEMA = { type: 'object', properties: ENHANCED_PROPS, required: ENHANCED_REQUIRED }

const REVISION_SCHEMA = {
  type: 'object',
  properties: {
    ...ENHANCED_PROPS,
    notes_response: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          note_id: { type: 'string' },
          action: { type: 'string', enum: ['applied', 'pushed_back'] },
          what_changed: { type: 'string' },
        },
        required: ['note_id', 'action', 'what_changed'],
      },
    },
  },
  required: ENHANCED_REQUIRED.concat(['notes_response']),
}

const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    overall_read: { type: 'string' },
    keep: { type: 'array', items: { type: 'string' } },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          note_id: { type: 'string' },
          target: { type: 'string' },
          note: { type: 'string' },
          reason: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['note_id', 'target', 'note', 'reason', 'source'],
      },
    },
  },
  required: ['overall_read', 'keep', 'notes'],
}

const SCORE = {
  type: 'object',
  properties: { score: { type: 'integer', minimum: 1, maximum: 10 }, evidence: { type: 'string' } },
  required: ['score', 'evidence'],
}
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scripts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', enum: ['X', 'Y', 'Z'] },
          specificity: SCORE,
          distinctiveness: SCORE,
          brief_fit: SCORE,
          craft: SCORE,
          unsupported_claims: { type: 'array', items: { type: 'string' } },
          biggest_weakness: { type: 'string' },
        },
        required: ['label', 'specificity', 'distinctiveness', 'brief_fit', 'craft', 'unsupported_claims', 'biggest_weakness'],
      },
    },
    winner: { type: 'string', enum: ['X', 'Y', 'Z'] },
    would_approve_today: { type: 'array', items: { type: 'string', enum: ['X', 'Y', 'Z'] } },
    verdict: { type: 'string' },
  },
  required: ['scripts', 'winner', 'would_approve_today', 'verdict'],
}

// ---- prompts ----

// Mirrors creative-studio.js's preamble + rolePrompt for the copywriter exactly,
// so A is what the pipeline produces today.
function baselinePrompt() {
  const preamble = `Project PROJECT_001 — "${brief.name || 'untitled campaign'}" for ${brief.brand || 'the client (brand unconfirmed)'}.
One-line brief: ${brief.one_line_brief || 'not supplied'}
Objective: ${brief.objective || 'not supplied'}
Audience: ${brief.audience || 'not supplied'}
Key message: ${brief.key_message || 'not supplied'}
Tone: ${(brief.tone || []).join(', ') || 'not specified'}
Deliverables: ${JSON.stringify(brief.deliverables)}
Must include: ${JSON.stringify(brief.must_include)}
Must avoid: ${JSON.stringify(brief.must_avoid)}
Verified product facts (the ONLY claims you may state as fact): ${JSON.stringify(brief.verified_product_facts)}
Rules: never invent product performance claims, statistics, or research beyond the verified facts above — label anything else as a hypothesis or assumption. Never assume a real person's likeness, availability, or rights; use fictional cast by default. No reference_reader tool is bound in this run, so do not claim to have visually inspected any reference — treat named references only as context and flag as an assumption if inspection was required. If you cannot complete this task from the given context, set status "blocked" and list exactly what is missing in blockers.`
  return `${preamble}

Your role: Campaign Copywriter. Write timed scripts, dialogue or voiceover, on-screen copy, hooks, and calls to action for the approved route, one per deliverable duration, without changing the central promise. Use only approved factual claims.
This task: Write the timed script (hook, beats, on-screen copy, CTA) for every video deliverable on the approved route.
Upstream context: ${JSON.stringify({ selected_route_id: routeId, concepts })}
Respond only via the required schema.`
}

function context() {
  return `PROJECT: "${brief.name}" for ${brief.brand} — ${brief.product_or_subject}.
Objective: ${brief.objective}
Audience: ${brief.audience}
Key message: ${brief.key_message}
Tone: ${(brief.tone || []).join(', ')}
Must include: ${JSON.stringify(brief.must_include)}
Must avoid: ${JSON.stringify(brief.must_avoid)}
Verified product facts — the ONLY claims you may state or imply: ${JSON.stringify(brief.verified_product_facts)}

STRATEGY (approved)
Single-minded proposition: ${strategy.single_minded_proposition}
Audience tension: ${strategy.audience_tension}

APPROVED ROUTE ${route.route_id}
Central idea (approved by the human creative director — you cannot change it): ${route.central_idea}
Emotional promise: ${route.emotional_promise}
Product role: ${route.product_role}
Visual language: ${route.visual_language}
Execution example (ILLUSTRATIVE ONLY — you may depart from it wherever the craft brief or taste notes call for it, and must list every departure in route_deviations): ${route.execution_example}`
}

function readFirst() {
  return `Before writing anything, use the Read tool to read these two files, relative to the repository root, in full:
- ${CRAFT_BRIEF} — the copywriter craft brief. Its rules are requirements.
- ${TASTE_NOTES} — the studio's taste notes. They are the studio's point of view: follow them, cite them in taste_note_applied and decisions, and say explicitly when you break one on purpose.
List both paths in files_read. If you cannot read one, put "UNREAD: <path>" in files_read instead.`
}

function checksClause() {
  return `Your script is checked in code, and fails if any of these is false:
- beats run back to back with no gaps, from exactly 0.0s to exactly ${DURATION}.0s (start_s and end_s in seconds)
- total VO across all beats is at most ${VO_WORDS_MAX} words, and no beat exceeds ${BEAT_WPS_MAX} VO words per second (use "" for a beat with no VO)
- on_screen_text is at most ${CARD_WORDS_MAX} words per beat (use "" for none)
- none of these words or phrases, in any form (elevated, journeys, discovering…), appears anywhere in picture, sound, vo, on_screen_text, cta, idea_in_one_line or stills_copy: ${BANNED_READABLE.join(', ')}
- a CTA is present
- stills_copy has exactly ${stills.count} entries: on-image copy for the ${stills.count} ${stills.aspect_ratio} stills that pull from this spot`
}

function enhancedPrompt() {
  return `You are the Campaign Copywriter at a small, senior creative studio.

${readFirst()}

${context()}

TASK: write ${video.id}, the ${DURATION}-second ${video.aspect_ratio} video script, plus the on-image copy for ${stills.id} (${stills.count} × ${stills.aspect_ratio} stills pulled from the same shoot). Write the picture as carefully as the words: every beat says what the camera sees and what we hear. In decisions, record the non-obvious choices you made and the note or rule each came from.

${checksClause()}`
}

function retryPrompt(prev, violations, basePrompt) {
  return `${basePrompt}

Your previous attempt failed these code checks:
${violations.map(v => `- ${v}`).join('\n')}

Previous attempt: ${JSON.stringify(prev)}

Fix every failed check. Keep everything that already works; don't rewrite what isn't broken.`
}

function notesPrompt(script) {
  return `You are the studio's creative director. A copywriter has handed you a script for review before it goes to the film director. Give notes the way a good creative director does in a real review: specific, actionable, and only about things that matter.

Before reviewing, use the Read tool to read ${TASTE_NOTES} and ${CRAFT_BRIEF} (relative to the repository root). Your notes should come from them — they are the studio's taste — and from the approved route and brief below.

${context()}

SCRIPT UNDER REVIEW
${renderEnhanced(script)}

Stills copy: ${JSON.stringify(script.stills_copy)}
Copywriter's stated deviations from the route: ${JSON.stringify(script.route_deviations)}

Give between 1 and 6 notes. Each note targets a beat_id, "stills", or "overall"; says exactly what's wrong and what to do instead, in terms a copywriter can act on; and cites the taste note or craft rule it comes from in source. Don't invent notes to fill a count, and don't rewrite the script yourself. In keep, list what's working that must survive the revision.`
}

function revisionPrompt(script, notes) {
  return `You are the Campaign Copywriter. The creative director has given notes on your script. Revise it.

${readFirst()}

${context()}

YOUR SCRIPT: ${JSON.stringify(script)}

CREATIVE DIRECTOR'S NOTES: ${JSON.stringify(notes)}

Apply each note, or push back on it if applying it would break the approved route, a verified-facts rule or another note — explain which in notes_response. Don't lose anything listed under "keep". Return the full revised script.

${checksClause()}`
}

const LENSES = [
  {
    id: 'creative_director',
    brief: `You are a senior creative director at a top independent agency, known for rejecting anything generic. Before judging, use the Read tool to read ${TASTE_NOTES} and ${CRAFT_BRIEF} (relative to the repository root): they define this studio's standard. Ask of each script: would I put this in front of the client today?`,
  },
  {
    id: 'film_director',
    brief: 'You are the commercial film director who has to shoot this tomorrow with a small crew. Ask of each script: can I shoot it from the page without a follow-up call? What is ambiguous, unfilmable or physically implausible in 15 seconds?',
  },
  {
    id: 'client',
    brief: 'You are the brand marketing lead at the client. You approve and pay for production. Ask of each script: does it sell this product to this audience, does it stay strictly inside the facts we verified, and is it clearly ours rather than something any coffee brand could run?',
  },
]

const PERMS = [[0, 1, 2], [2, 0, 1], [1, 2, 0]]
const LABELS = ['X', 'Y', 'Z']

function judgePrompt(lens, rendered) {
  return `${lens.brief}

You are judging three scripts for the same approved route, blind. You don't know who wrote them or how. Judge only what is on the page.

${context()}

${rendered.map((r, i) => `=== SCRIPT ${LABELS[i]} ===\n${r}`).join('\n\n')}

Score each script 1–10 on:
- specificity: could a crew shoot it from the page? Concrete actions, objects and sounds score high; moods and adjectives score low.
- distinctiveness: could it run for a competitor unchanged? Only-this-brand work scores high.
- brief_fit: does it deliver the approved central idea, the must-includes and the verified facts, and avoid the must-avoids?
- craft: hook in the first 1.5s, timing a real VO could read, readable with the sound off, a legible product moment before the end.

For every score, quote or point to the exact line that justifies it. Use the full range: a 9–10 must be something you would approve for production unchanged. List any claim that goes beyond the verified facts in unsupported_claims. Then pick a winner, list which scripts you would approve for production today (possibly none), and give a short, direct verdict.`
}

// ---- run ----

async function enhancedWithChecks(label, phaseName, makePrompt, schema) {
  const attempts = []
  const base = makePrompt()
  let prompt = base
  for (let i = 0; i <= MAX_RETRIES; i++) {
    const out = await agent(prompt, { label: `${label}${i ? ` retry ${i}` : ''}`, phase: phaseName, schema })
    if (!out) break
    const violations = checkEnhanced(out)
    attempts.push({ attempt: i + 1, violations })
    if (!violations.length || i === MAX_RETRIES) return { script: out, attempts, passed: !violations.length }
    log(`${label}: attempt ${i + 1} failed ${violations.length} check(s), retrying`)
    prompt = retryPrompt(out, violations, base)
  }
  return { script: null, attempts, passed: false }
}

phase('Draft')
const [baselineRaw, chain] = await parallel([
  () => agent(baselinePrompt(), { label: 'copywriter (baseline)', phase: 'Draft', schema: BASELINE_SCHEMA }),
  async () => {
    const B = await enhancedWithChecks('copywriter (enhanced)', 'Draft', enhancedPrompt, ENHANCED_SCHEMA)
    if (!B.script) return { B, notes: null, C: null }
    const notes = await agent(notesPrompt(B.script), { label: 'creative director notes', phase: 'Notes', schema: NOTES_SCHEMA })
    if (!notes) return { B, notes: null, C: null }
    const C = await enhancedWithChecks('copywriter (revision)', 'Notes', () => revisionPrompt(B.script, notes), REVISION_SCHEMA)
    return { B, notes, C }
  },
])

const A = baselineScript(baselineRaw)
const B = chain && chain.B
const C = chain && chain.C
const notes = chain && chain.notes

if (!baselineRaw || !B || !B.script || !C || !C.script) {
  return { error: 'a draft stage failed; see attempts', baseline: baselineRaw, B, notes, C }
}

const renders = [renderBaseline(A), renderEnhanced(B.script), renderEnhanced(C.script)]
const NAMES = ['A_baseline', 'B_enhanced', 'C_after_notes']

phase('Judge')
const judged = await parallel(LENSES.map((lens, j) => () => {
  const order = PERMS[j]
  return agent(judgePrompt(lens, order.map(k => renders[k])), { label: `judge: ${lens.id}`, phase: 'Judge', schema: JUDGE_SCHEMA })
    .then(res => ({ lens: lens.id, order, res }))
}))

const CRITERIA = ['specificity', 'distinctiveness', 'brief_fit', 'craft']
const judges = judged.filter(j => j && j.res).map(({ lens, order, res }) => {
  const byName = {}
  res.scripts.forEach(s => {
    const idx = order[LABELS.indexOf(s.label)]
    byName[NAMES[idx]] = s
  })
  const toName = l => NAMES[order[LABELS.indexOf(l)]]
  return {
    lens,
    scripts: byName,
    winner: toName(res.winner),
    would_approve_today: res.would_approve_today.map(toName),
    verdict: res.verdict,
  }
})

const aggregate = {}
NAMES.forEach(n => {
  const row = {}
  CRITERIA.forEach(c => {
    const vals = judges.map(j => j.scripts[n] && j.scripts[n][c] && j.scripts[n][c].score).filter(x => typeof x === 'number')
    row[c] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null
  })
  const all = CRITERIA.map(c => row[c]).filter(x => x !== null)
  row.overall = all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null
  row.wins = judges.filter(j => j.winner === n).length
  row.approvals = judges.filter(j => j.would_approve_today.includes(n)).length
  aggregate[n] = row
})

const tasteLogEntry = {
  artifact: `${video.id} script`,
  route: route.route_id,
  notes: notes.notes.map(nt => {
    const resp = (C.script.notes_response || []).find(r => r.note_id === nt.note_id) || {}
    return { ...nt, action: resp.action || 'unanswered', what_changed: resp.what_changed || '' }
  }),
  keep: notes.keep,
}

return {
  duration_s: DURATION,
  metrics: {
    A_baseline: baselineMetrics(A),
    B_enhanced: enhancedMetrics(B.script),
    C_after_notes: enhancedMetrics(C.script),
  },
  scripts: { A_baseline: A, B_enhanced: B.script, C_after_notes: C.script },
  rendered: { A_baseline: renders[0], B_enhanced: renders[1], C_after_notes: renders[2] },
  check_attempts: { B_enhanced: B.attempts, C_after_notes: C.attempts },
  notes,
  taste_log_entry: tasteLogEntry,
  judges,
  aggregate,
}
