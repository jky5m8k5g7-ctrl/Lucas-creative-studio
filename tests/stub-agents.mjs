// Stub agents for tests: valid, check-passing content keyed by call label, with hooks to
// script reviewer scores, integrity-QC findings, panel verdicts and failures.
export function makeStub(opts = {}) {
  const calls = []
  const counts = {}
  const env = content => ({ status: 'draft', based_on: [], content, asset_uri: null, assumptions: [], sources: [], blockers: [] })
  const shots = (withLens) => [
    { shot_id: 'S1', scene_id: 'SC1', deliverable_ids: ['D01'], duration_frames: 360, fps: 24, character_ids: ['C1'], look_ids: ['LK1'], location_id: 'L1', prop_ids: ['P1'], lens_intent: withLens ? '35mm at T2.8' : '35mm' },
    { shot_id: 'S2', scene_id: 'SC1', deliverable_ids: ['D01'], duration_frames: 360, fps: 24, character_ids: ['C1'], look_ids: ['LK1'], location_id: 'L1', prop_ids: ['P2'], lens_intent: '50mm' },
    { shot_id: 'K1', scene_id: 'SC1', deliverable_ids: ['D02'], duration_frames: 0, fps: 24, character_ids: [], look_ids: [], location_id: 'L1', prop_ids: ['P1'], lens_intent: '85mm' },
  ]
  const long = n => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
  const makers = {
    development_producer: () => ({
      working_title: 'Emberline Mornings', logline: 'A father learns the pan remembers every breakfast.', format: opts.format || 'ad_spot', format_rationale: 'thirty seconds carries it',
      premise: long(90), what_makes_it_specific: ['a', 'b', 'c'], brand: 'Emberline', product_or_subject: 'cast-iron skillet', objective: 'consideration', audience: 'new parents',
      key_message: 'it gets better with use', tone: ['dry'], verified_product_facts: [{ fact: 'Pre-seasoned with flaxseed oil', quoted_from_idea: 'pre-seasoned with flaxseed oil' }],
      deliverables: [{ id: 'D01', type: 'video', label: 'hero', duration_seconds: 30, count: 1, aspect_ratio: '9:16' }, { id: 'D02', type: 'still', label: 'key art', duration_seconds: 0, count: 1, aspect_ratio: '4:5' }],
      must_include: [], must_avoid: [], story_seed: { protagonist: 'p', want: 'w', obstacle: 'o', turn: 't', ending: 'e' }, questions_for_lucas: ['Is Emberline the final brand name?'],
    }),
    strategist: () => ({ audience_tension: 't', desired_behavior: 'd', product_relevance: 'r', single_minded_proposition: 'The pan gets better the more you use it.', proof_points: ['a', 'b'], success_criteria: [], supplied_facts: [], sourced_research: [], hypotheses: [] }),
    creative_director: () => ({ routes: [1, 2, 3].map(i => ({ route_id: `R${i}`, central_idea: `idea ${i}`, emotional_promise: 'relief', product_role: 'tool', visual_language: 'v', execution_example: 'e' })), recommended_route_id: 'R2', recommendation_rationale: 'r' }),
    copywriter: () => ({
      story: { logline: 'l', beat_sheet: [{ scene_id: 'SC1', heading: 'INT. KITCHEN', characters: ['C1'], what_happens: 'w', turn: 't' }] },
      deliverable_scripts: [{ deliverable_id: 'D01', duration_s: 30, idea_in_one_line: 'i', beats: [
        { beat_id: 'B1', start_s: 0, end_s: 15, picture: 'A man cracks two eggs one handed into a black skillet on a gas ring', sound: 's', vo: 'C1: It was my father\'s pan.', on_screen_text: '' },
        { beat_id: 'B2', start_s: 15, end_s: 30, picture: 'His daughter reaches up and slides the skillet toward herself across the cooktop', sound: 's', vo: '', on_screen_text: 'Emberline. Better with use.' },
      ], cta: 'Find yours at emberline.example' }],
      stills_copy: [{ still_id: 'K1', picture: 'p', headline: 'Better with use', subline: 's' }], decisions: [],
    }),
    casting_director: () => ({ characters: [{ character_id: 'C1', visual_identity_anchors: ['a', 'b', 'c'], fictional_talent: true }] }),
    production_designer: () => ({ locations: [{ location_id: 'L1', palette: ['#111111 iron', '#AA7733 oak', '#EEEEEE tile'], props: [{ prop_id: 'P1' }, { prop_id: 'P2' }] }] }),
    director: () => ({ scenes: [{ scene_id: 'SC1', campaign_idea_link: 'the pan passes hands' }] }),
    stylist: () => ({ looks: [{ look_id: 'LK1', character_id: 'C1', materials_colors: 'waxed cotton #3B4A5C', continuity_locks: ['sleeves rolled', 'watch left wrist'] }] }),
    sound_designer: () => ({ cues: [{ cue_id: 'Q1', deliverable_ids: ['D01'], timing: '0-30s', licensing_or_consent_requirement: 'original score, work for hire' }] }),
    cinematographer: () => ({ shots: shots(true) }),
    storyboard_artist: () => ({ panels: ['S1', 'S2', 'K1'].map(id => ({ shot_id: id, board_note: 'reads at phone size', dialogue_or_voiceover: '', on_screen_text: '', sound_cues: ['Q1'], entry_state: 'pan cold', exit_state: 'pan hot', generation_risk: 'none' })), contradictions_flagged: [], tracked_elements: [{ element_id: 'PAN', element_type: 'product', states_by_shot: [{ shot_id: 'S1', state: 'cold' }, { shot_id: 'S2', state: 'hot' }] }] }),
    generation_supervisor: () => ({ jobs: ['S1', 'S2', 'K1'].map((s, i) => ({ job_id: `J${i}`, shot_id: s, job_type: 'image', method: 'text-to-image still', prompt: long(45), reference_asset_ids: [], acceptance_checks: ['the pan reads as cast iron'], capability_supported: true, capability_notes: '', estimated_cost_unit: '1 image' })), missing_capabilities: [] }),
  }
  const crit = s => ({ score: s, evidence: `line ${s}` })
  async function agent(prompt, o) {
    const label = o.label
    calls.push({ label, phase: o.phase, prompt })
    counts[label] = (counts[label] || 0) + 1
    if (opts.fail && opts.fail(label)) return null
    if (/ · review \d+$/.test(label)) {
      const dept = label.split(' · ')[0]
      const s = opts.score ? opts.score(dept, label, calls) : 8
      return { specificity: crit(s), distinctiveness: crit(Math.max(s, 8)), fit: crit(9), craft: crit(9), notes: s < 8 ? [{ target: 'B1', note: 'name the object', source: 'craft brief' }] : [], keep: ['the pan'] }
    }
    if (/^integrity QC/.test(label)) {
      const crits = opts.qc ? opts.qc(label, calls) : []
      return env({ checks: [], issues: crits.map((r, i) => ({ issue_id: `I${i}`, severity: 'critical', shot_or_timecode: 'S1', evidence: 'lens contradicts treatment', responsible_agent: r })), recommendation: crits.length ? 'revise' : 'approve' })
    }
    if (/^panel · /.test(label)) {
      const [, lens, round] = label.match(/^panel · (\S+) · round (\d+)$/)
      const v = opts.panel ? opts.panel(lens, +round, calls) : { ok: true }
      const s = v.ok ? 9 : 7
      return { specificity: crit(s), distinctiveness: crit(s), fit: crit(s), craft: crit(s), would_approve: v.ok, notes: v.notes || [], direction_questions: v.questions || [], verdict: v.ok ? 'ship it' : 'not yet' }
    }
    if (label === 'producer · route your notes') return opts.router ? opts.router(prompt) : { routes: [{ responsible: 'copywriter', note: 'lose the window line' }], switch_route_to: '', direction_change: '' }
    const dept = label.split(' · ')[0]
    if (makers[dept]) return env(makers[dept]())
    return env({})
  }
  async function parallel(fns) {
    return Promise.all(fns.map(f => Promise.resolve().then(f).catch(() => null)))
  }
  return { agent, parallel, calls, counts }
}
