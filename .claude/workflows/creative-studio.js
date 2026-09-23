export const meta = {
  name: 'creative-studio',
  description: 'Run the Lucas Prevost Creative AI Studio pipeline from a brief to an approved pre-production package, stopping at every human approval gate',
  phases: [
    { title: 'Intake' },
    { title: 'Strategy' },
    { title: 'Concepts' },
    { title: 'Script, Cast & World' },
    { title: 'Direction, Style & Sound' },
    { title: 'Camera' },
    { title: 'Storyboard' },
    { title: 'Generation Plan' },
    { title: 'Pre-production Review' },
    { title: 'Production' },
  ],
}

// Usage: Workflow({ name: 'creative-studio', args: {
//   brief, command, approvals, priorState, mode, toolBindings, projectId, revision
// } })
// command: START (default) | APPROVE | REVISE | STATUS | EXPORT_STATE | EXPORT_PLAN
// APPROVE = START with priorState + new approvals merged in (same code path).
// REVISE  = START with priorState + a { target_kind, routing_key, note, reason, estimated_cost_impact } revision.
// mode: 'planning_only' (default) | 'connected_tools' — connected_tools also needs toolBindings
//   ({ image_generation, video_generation, audio_generation, editing }: true/false) and
//   brief.budget.media_and_render_cap set, or stage 10+ reports a blocked_capability_report.
// See ../../spec/creative_studio_agents.json for the full blueprint this implements.

const input = args || {}
const PROJECT_ID = input.projectId || (input.priorState && input.priorState.project_id) || 'PROJECT_001'
const command = input.command || 'START'

const LIMITS = { maxParallelTasks: 3, maxAgentCallsPerRun: 40, maxRevisionRoundsPerStage: 2 }

const GATES = {
  concept: 'Approve the normalized brief, strategy, and one selected concept ID.',
  production_plan: 'Approve exact script, cast, style, world, storyboard, sound, and generation-plan revisions. Separately authorize a media cap and the external sharing of identified assets before any paid production.',
  visual_lock: 'Approve the exact reference asset IDs and versions to anchor identity, product, styling, and locations.',
  final_cut: 'Approve the exact review-cut versions, edit timelines, and final campaign stills before final export.',
}

const DEPT_IDS = ['strategist', 'creative_director', 'copywriter', 'casting_director', 'production_designer', 'director', 'stylist', 'cinematographer', 'storyboard_artist', 'generation_supervisor', 'sound_designer', 'editor']

const ROLE_INSTRUCTIONS = {
  producer: 'Executive Producer / Orchestrator. Normalize the brief, keep every department on the same approved direction, merge outputs, and present one coherent campaign. Never approve on the human’s behalf and never claim an asset exists without evidence.',
  strategist: 'Brand and Audience Strategist. Identify the audience tension, desired behavior, product relevance, single-minded proposition, proof points, and success criteria. Separate supplied facts, sourced research, and hypotheses. Do not invent audience research or performance claims.',
  creative_director: 'AI Creative Director. Develop three distinct campaign routes (unless told otherwise), each with a central idea, emotional promise, product role, visual language, and execution example. Recommend one with a concise rationale.',
  copywriter: 'Campaign Copywriter. Write timed scripts, dialogue or voiceover, on-screen copy, hooks, and calls to action for the approved route, one per deliverable duration, without changing the central promise. Use only approved factual claims.',
  casting_director: 'Casting Director. Define character profiles, screen presence, performance style, wardrobe fit considerations, and visual identity anchors. Use fictional adult talent by default. Never invent a real person’s availability or permission to use their likeness or voice.',
  production_designer: 'Production Designer / Art Director. Define locations, spatial layout, props, materials, palette, product placement, and background behavior with persistent location and prop IDs and states that must match between shots.',
  director: 'Film Director. Turn the approved script and world into a directing treatment: performance beats, blocking, action progression, emotional shifts, and transitions, explaining how each scene demonstrates the campaign idea and flagging anything needing practical footage or compositing.',
  stylist: 'Wardrobe, Hair and Makeup Stylist. Build looks for the cast and world: garment silhouettes, materials, colors, fit, accessories, hair, makeup, and grooming, with look IDs and locked continuity. Avoid wardrobe that distracts from or obscures the product.',
  cinematographer: 'Director of Photography. Translate the directing treatment into a shot plan: framing, lens intent, camera height, movement, focus, lighting, exposure mood, and product visibility, resolving eyelines, screen direction, and spatial continuity.',
  storyboard_artist: 'Storyboard Artist / Previsualization. Combine the approved script, cast, wardrobe, world, direction, camera plan, and sound plan into ordered, timed panels with narrative purpose, action, composition, sound, and continuity states. Flag contradictions before production.',
  generation_supervisor: 'AI Generation Supervisor. Translate locked shots into reference-image requirements and model-ready image/video prompts, preserving product geometry, cast identity, styling, and location. Prepare a capability-checked generation plan and cost estimate; never substitute prose for a generated file.',
  sound_designer: 'Sound Designer / Music Supervisor. Plan music direction, sound effects, atmosphere, dialogue, and voiceover against the script, with cue timing and licensing/consent requirements.',
  editor: 'Editor / Finishing Artist. Assemble an executable edit timeline from approved asset IDs with source in/out points and destination frames, building the hook, story, product moment, and ending, without breaking continuity.',
  quality_control: 'Independent Creative QC / Script Supervisor. Audit the brief, product fidelity, identity, wardrobe, prop states, eyelines, timing, text, sound, rights evidence, and export specs. Give every issue a severity, location, evidence, and responsible department. Never treat a written description as evidence a rendered clip passed inspection, and never replace human sign-off.',
}

const DEFAULT_BRIEF = {
  name: null, brand: null, product_or_subject: null, one_line_brief: null, objective: null,
  audience: null, key_message: null, tone: [], verified_product_facts: [], references: [],
  deliverables: [], must_include: [], must_avoid: [], deadline: null,
  budget: { currency: 'USD', runner_llm_cap: null, media_and_render_cap: null, spent: 0, reserved: 0 },
}

const DEPENDENTS = {
  strategy: ['concepts', 'script', 'casting_bible', 'world_bible', 'directors_treatment', 'style_bible', 'sound_plan', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports'],
  concepts: ['script', 'casting_bible', 'world_bible', 'directors_treatment', 'style_bible', 'sound_plan', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports'],
  script: ['directors_treatment', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports'],
  casting_bible: ['style_bible', 'directors_treatment', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports'],
  world_bible: ['directors_treatment', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports'],
  directors_treatment: ['camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports'],
  style_bible: ['camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports'],
  sound_plan: ['storyboard', 'continuity_bible', 'generation_plan', 'quality_reports'],
  camera_plan: ['storyboard', 'continuity_bible', 'generation_plan', 'quality_reports'],
  storyboard: ['generation_plan', 'quality_reports'],
  continuity_bible: ['generation_plan', 'quality_reports'],
  generation_plan: ['quality_reports'],
}

const REVISION_ROUTING = {
  strategy_or_message: ['strategist', 'creative_director'],
  script_or_copy: ['copywriter', 'director'],
  casting_or_identity: ['casting_director'],
  wardrobe_hair_makeup: ['stylist'],
  location_props_palette: ['production_designer'],
  camera_lighting: ['cinematographer'],
  boards_or_sequence: ['storyboard_artist'],
  generated_asset_defect: ['generation_supervisor'],
  music_voice_sound: ['sound_designer'],
  pacing_graphics_export: ['editor'],
}

// ---- content schemas (kept lean; envelope fields below carry the artifact_contract) ----

const STRATEGY_CONTENT = {
  type: 'object',
  properties: {
    audience_tension: { type: 'string' },
    desired_behavior: { type: 'string' },
    product_relevance: { type: 'string' },
    single_minded_proposition: { type: 'string' },
    proof_points: { type: 'array', items: { type: 'string' } },
    success_criteria: { type: 'array', items: { type: 'string' } },
    supplied_facts: { type: 'array', items: { type: 'string' } },
    sourced_research: { type: 'array', items: { type: 'string' } },
    hypotheses: { type: 'array', items: { type: 'string' } },
  },
  required: ['audience_tension', 'desired_behavior', 'product_relevance', 'single_minded_proposition', 'proof_points', 'success_criteria', 'supplied_facts', 'sourced_research', 'hypotheses'],
}

const CONCEPTS_CONTENT = {
  type: 'object',
  properties: {
    routes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          route_id: { type: 'string' },
          central_idea: { type: 'string' },
          emotional_promise: { type: 'string' },
          product_role: { type: 'string' },
          visual_language: { type: 'string' },
          execution_example: { type: 'string' },
        },
        required: ['route_id', 'central_idea', 'emotional_promise', 'product_role', 'visual_language', 'execution_example'],
      },
    },
    recommended_route_id: { type: 'string' },
    recommendation_rationale: { type: 'string' },
  },
  required: ['routes', 'recommended_route_id', 'recommendation_rationale'],
}

const SCRIPT_CONTENT = {
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
}

const CASTING_CONTENT = {
  type: 'object',
  properties: {
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          character_id: { type: 'string' },
          role_in_story: { type: 'string' },
          screen_presence: { type: 'string' },
          performance_style: { type: 'string' },
          wardrobe_fit_notes: { type: 'string' },
          visual_identity_anchors: { type: 'array', items: { type: 'string' } },
          fictional_talent: { type: 'boolean' },
        },
        required: ['character_id', 'role_in_story', 'screen_presence', 'performance_style', 'wardrobe_fit_notes', 'visual_identity_anchors', 'fictional_talent'],
      },
    },
  },
  required: ['characters'],
}

const WORLD_CONTENT = {
  type: 'object',
  properties: {
    locations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          location_id: { type: 'string' },
          description: { type: 'string' },
          spatial_layout: { type: 'string' },
          palette: { type: 'array', items: { type: 'string' } },
          props: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                prop_id: { type: 'string' },
                description: { type: 'string' },
                persistent_state_notes: { type: 'string' },
              },
              required: ['prop_id', 'description', 'persistent_state_notes'],
            },
          },
          product_placement: { type: 'string' },
        },
        required: ['location_id', 'description', 'spatial_layout', 'palette', 'props', 'product_placement'],
      },
    },
  },
  required: ['locations'],
}

const TREATMENT_CONTENT = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          scene_id: { type: 'string' },
          performance_beats: { type: 'string' },
          blocking: { type: 'string' },
          action_progression: { type: 'string' },
          emotional_shift: { type: 'string' },
          transition_in: { type: 'string' },
          transition_out: { type: 'string' },
          campaign_idea_link: { type: 'string' },
          practical_or_compositing_flags: { type: 'array', items: { type: 'string' } },
        },
        required: ['scene_id', 'performance_beats', 'blocking', 'action_progression', 'emotional_shift', 'transition_in', 'transition_out', 'campaign_idea_link', 'practical_or_compositing_flags'],
      },
    },
  },
  required: ['scenes'],
}

const STYLE_CONTENT = {
  type: 'object',
  properties: {
    looks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          look_id: { type: 'string' },
          character_id: { type: 'string' },
          garment_silhouette: { type: 'string' },
          materials_colors: { type: 'string' },
          fit_notes: { type: 'string' },
          accessories: { type: 'array', items: { type: 'string' } },
          hair_makeup: { type: 'string' },
          continuity_locks: { type: 'array', items: { type: 'string' } },
        },
        required: ['look_id', 'character_id', 'garment_silhouette', 'materials_colors', 'fit_notes', 'accessories', 'hair_makeup', 'continuity_locks'],
      },
    },
  },
  required: ['looks'],
}

const SOUND_PLAN_CONTENT = {
  type: 'object',
  properties: {
    cues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cue_id: { type: 'string' },
          deliverable_ids: { type: 'array', items: { type: 'string' } },
          type: { type: 'string' },
          timing: { type: 'string' },
          description: { type: 'string' },
          licensing_or_consent_requirement: { type: 'string' },
        },
        required: ['cue_id', 'deliverable_ids', 'type', 'timing', 'description', 'licensing_or_consent_requirement'],
      },
    },
  },
  required: ['cues'],
}

const SHOT_FIELDS = ['shot_id', 'scene_id', 'deliverable_ids', 'purpose', 'duration_frames', 'fps', 'character_ids', 'look_ids', 'location_id', 'product_reference_ids', 'prop_ids', 'framing', 'lens_intent', 'camera_movement', 'lighting', 'action', 'performance', 'dialogue_or_voiceover', 'on_screen_text', 'sound_cues', 'entry_state', 'exit_state', 'image_prompt', 'video_prompt', 'avoid', 'reference_asset_ids', 'generation_method', 'acceptance_checks']

const SHOT_SCHEMA = {
  type: 'object',
  properties: {
    shot_id: { type: 'string' },
    scene_id: { type: 'string' },
    deliverable_ids: { type: 'array', items: { type: 'string' } },
    purpose: { type: 'string' },
    duration_frames: { type: 'integer' },
    fps: { type: 'integer' },
    character_ids: { type: 'array', items: { type: 'string' } },
    look_ids: { type: 'array', items: { type: 'string' } },
    location_id: { type: 'string' },
    product_reference_ids: { type: 'array', items: { type: 'string' } },
    prop_ids: { type: 'array', items: { type: 'string' } },
    framing: { type: 'string' },
    lens_intent: { type: 'string' },
    camera_movement: { type: 'string' },
    lighting: { type: 'string' },
    action: { type: 'string' },
    performance: { type: 'string' },
    dialogue_or_voiceover: { type: 'string' },
    on_screen_text: { type: 'string' },
    sound_cues: { type: 'array', items: { type: 'string' } },
    entry_state: { type: 'string' },
    exit_state: { type: 'string' },
    image_prompt: { type: 'string' },
    video_prompt: { type: 'string' },
    avoid: { type: 'array', items: { type: 'string' } },
    reference_asset_ids: { type: 'array', items: { type: 'string' } },
    generation_method: { type: 'string' },
    acceptance_checks: { type: 'array', items: { type: 'string' } },
  },
  required: SHOT_FIELDS,
}

const CAMERA_PLAN_CONTENT = { type: 'object', properties: { shots: { type: 'array', items: SHOT_SCHEMA } }, required: ['shots'] }

const STORYBOARD_AND_CONTINUITY_CONTENT = {
  type: 'object',
  properties: {
    panels: { type: 'array', items: SHOT_SCHEMA },
    contradictions_flagged: { type: 'array', items: { type: 'string' } },
    tracked_elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          element_id: { type: 'string' },
          element_type: { type: 'string' },
          states_by_shot: {
            type: 'array',
            items: {
              type: 'object',
              properties: { shot_id: { type: 'string' }, state: { type: 'string' } },
              required: ['shot_id', 'state'],
            },
          },
        },
        required: ['element_id', 'element_type', 'states_by_shot'],
      },
    },
  },
  required: ['panels', 'contradictions_flagged', 'tracked_elements'],
}

const GENERATION_PLAN_CONTENT = {
  type: 'object',
  properties: {
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          shot_id: { type: 'string' },
          job_type: { type: 'string', enum: ['image', 'video'] },
          prompt: { type: 'string' },
          reference_asset_ids: { type: 'array', items: { type: 'string' } },
          capability_supported: { type: 'boolean' },
          capability_notes: { type: 'string' },
          estimated_cost_unit: { type: 'string' },
        },
        required: ['job_id', 'shot_id', 'job_type', 'prompt', 'reference_asset_ids', 'capability_supported', 'capability_notes', 'estimated_cost_unit'],
      },
    },
    missing_capabilities: { type: 'array', items: { type: 'string' } },
  },
  required: ['jobs', 'missing_capabilities'],
}

const QUALITY_REPORT_CONTENT = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          check_id: { type: 'string' },
          category: { type: 'string' },
          result: { type: 'string', enum: ['pass', 'fail', 'not_inspected'] },
          evidence: { type: 'string' },
        },
        required: ['check_id', 'category', 'result', 'evidence'],
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issue_id: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          shot_or_timecode: { type: 'string' },
          evidence: { type: 'string' },
          responsible_agent: { type: 'string', enum: DEPT_IDS.concat(['producer']) },
        },
        required: ['issue_id', 'severity', 'shot_or_timecode', 'evidence', 'responsible_agent'],
      },
    },
    recommendation: { type: 'string', enum: ['approve', 'revise'] },
  },
  required: ['checks', 'issues', 'recommendation'],
}

const JOB_RESULT_CONTENT = {
  type: 'object',
  properties: {
    job_results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          shot_id: { type: 'string' },
          status: { type: 'string', enum: ['submitted', 'completed', 'failed', 'blocked'] },
          asset_uri: { type: 'string' },
          model_or_provider: { type: 'string' },
          idempotency_key: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['job_id', 'shot_id', 'status', 'asset_uri', 'model_or_provider', 'idempotency_key', 'notes'],
      },
    },
  },
  required: ['job_results'],
}

const EDIT_TIMELINE_CONTENT = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          deliverable_id: { type: 'string' },
          shot_id: { type: 'string' },
          asset_id: { type: 'string' },
          source_in_frame: { type: 'integer' },
          source_out_frame: { type: 'integer' },
          timeline_in_frame: { type: 'integer' },
          timeline_out_frame: { type: 'integer' },
          transition: { type: 'string' },
          audio_asset_ids: { type: 'array', items: { type: 'string' } },
          overlay_asset_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['deliverable_id', 'shot_id', 'asset_id', 'source_in_frame', 'source_out_frame', 'timeline_in_frame', 'timeline_out_frame', 'transition', 'audio_asset_ids', 'overlay_asset_ids'],
      },
    },
  },
  required: ['entries'],
}

const DELIVERY_CONTENT = {
  type: 'object',
  properties: {
    manifest: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          deliverable_id: { type: 'string' },
          file_or_asset_uri: { type: 'string' },
          spec_check: { type: 'string' },
        },
        required: ['deliverable_id', 'file_or_asset_uri', 'spec_check'],
      },
    },
  },
  required: ['manifest'],
}

const KIND_BY_DEPT = {
  strategist: 'strategy', creative_director: 'concepts', copywriter: 'script', casting_director: 'casting_bible',
  production_designer: 'world_bible', director: 'directors_treatment', stylist: 'style_bible',
  cinematographer: 'camera_plan', storyboard_artist: 'storyboard', generation_supervisor: 'generation_plan',
  sound_designer: 'sound_plan', editor: 'edit_timeline',
}
const DEPT_SCHEMA = {
  strategist: STRATEGY_CONTENT, creative_director: CONCEPTS_CONTENT, copywriter: SCRIPT_CONTENT, casting_director: CASTING_CONTENT,
  production_designer: WORLD_CONTENT, director: TREATMENT_CONTENT, stylist: STYLE_CONTENT, cinematographer: CAMERA_PLAN_CONTENT,
  storyboard_artist: STORYBOARD_AND_CONTINUITY_CONTENT, generation_supervisor: GENERATION_PLAN_CONTENT,
  sound_designer: SOUND_PLAN_CONTENT, editor: EDIT_TIMELINE_CONTENT,
}

function envelopeSchema(contentSchema) {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['draft', 'review_required', 'blocked'] },
      based_on: { type: 'array', items: { type: 'string' } },
      content: contentSchema,
      asset_uri: { type: 'string' },
      assumptions: { type: 'array', items: { type: 'string' } },
      sources: { type: 'array', items: { type: 'string' } },
      blockers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            issue: { type: 'string' },
            responsible_agent: { type: 'string' },
            resolution: { type: 'string' },
          },
          required: ['issue', 'responsible_agent', 'resolution'],
        },
      },
    },
    required: ['status', 'based_on', 'content', 'assumptions', 'sources', 'blockers'],
  }
}

// ---- helpers ----

function normalizeBrief(rawBrief) {
  const b = { ...DEFAULT_BRIEF, ...(rawBrief || {}) }
  b.budget = { ...DEFAULT_BRIEF.budget, ...((rawBrief && rawBrief.budget) || {}) }
  const needsInput = []
  const assumptions = []
  ;['brand', 'product_or_subject', 'audience', 'key_message', 'objective', 'deliverables'].forEach(field => {
    const empty = field === 'deliverables' ? !b.deliverables.length : !b[field]
    if (empty) needsInput.push(field)
  })
  const capped = needsInput.slice(0, 5)
  capped.forEach(field => assumptions.push(`ASSUMPTION: "${field}" was not supplied — treated as unconfirmed pending human input.`))
  if (capped.includes('deliverables')) {
    b.deliverables = [
      { id: 'D01', type: 'video', duration_seconds: 30, aspect_ratio: '9:16' },
      { id: 'D02', type: 'still', count: 3, aspect_ratio: '4:5' },
    ]
    assumptions.push('ASSUMPTION: no deliverables were specified — planning assumed one 30s 9:16 video and 3 square-ish stills, pending confirmation.')
  }
  return { brief: b, assumptions, needsInput: capped }
}

function nextId(state, kind) {
  state.artifact_seq += 1
  return `${kind}-${String(state.artifact_seq).padStart(3, '0')}`
}

function makeArtifact(state, kind, owner, taskId, basedOn, result) {
  const blockers = result.blockers || []
  const status = result.status === 'blocked' ? 'blocked' : (blockers.length ? 'review_required' : 'draft')
  return {
    artifact_id: nextId(state, kind),
    project_id: state.project_id,
    task_id: taskId,
    owner_agent: owner,
    kind,
    revision: 1,
    status,
    based_on: (basedOn || []).filter(Boolean),
    content: result.content,
    asset_uri: result.asset_uri || null,
    assumptions: result.assumptions || [],
    sources: result.sources || [],
    blockers,
  }
}

function isPresent(state, kind) {
  return !!state.artifacts[kind] && state.artifacts[kind].status !== 'stale'
}

function markStale(state, kind) {
  if (state.artifacts[kind]) state.artifacts[kind] = { ...state.artifacts[kind], status: 'stale' }
  ;(DEPENDENTS[kind] || []).forEach(dep => {
    if (state.artifacts[dep]) state.artifacts[dep] = { ...state.artifacts[dep], status: 'stale' }
  })
}

function groupBy(arr, keyFn) {
  const out = {}
  arr.forEach(item => {
    const k = keyFn(item)
    ;(out[k] = out[k] || []).push(item)
  })
  return out
}

function gateInfo(gateId, artifactList) {
  return {
    gate_id: gateId,
    rule: GATES[gateId],
    artifacts_for_review: artifactList.filter(Boolean).map(a => ({ artifact_id: a.artifact_id, kind: a.kind, revision: a.revision, status: a.status })),
  }
}

function recordPendingApproval(state, gateId) {
  state.approval_log.push({ gate_id: gateId, decision: 'pending' })
  state.decision_log.push({ stage: state.stage_reached, summary: `Stopped for required human approval: ${gateId}` })
}

function collectBlockers(state) {
  const out = []
  Object.values(state.artifacts).forEach(a => {
    (a.blockers || []).forEach(b => out.push({ artifact_id: a.artifact_id, kind: a.kind, ...b }))
  })
  return out
}

function planningArtifactIds(state) {
  return ['script', 'casting_bible', 'world_bible', 'directors_treatment', 'style_bible', 'sound_plan', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan']
    .map(k => state.artifacts[k] && state.artifacts[k].artifact_id)
    .filter(Boolean)
}

function preamble(state) {
  return `Project ${state.project_id} — "${state.brief.name || 'untitled campaign'}" for ${state.brief.brand || 'the client (brand unconfirmed)'}.
One-line brief: ${state.brief.one_line_brief || 'not supplied'}
Objective: ${state.brief.objective || 'not supplied'}
Audience: ${state.brief.audience || 'not supplied'}
Key message: ${state.brief.key_message || 'not supplied'}
Tone: ${(state.brief.tone || []).join(', ') || 'not specified'}
Deliverables: ${JSON.stringify(state.brief.deliverables)}
Must include: ${JSON.stringify(state.brief.must_include)}
Must avoid: ${JSON.stringify(state.brief.must_avoid)}
Verified product facts (the ONLY claims you may state as fact): ${JSON.stringify(state.brief.verified_product_facts)}
Rules: never invent product performance claims, statistics, or research beyond the verified facts above — label anything else as a hypothesis or assumption. Never assume a real person's likeness, availability, or rights; use fictional cast by default. No reference_reader tool is bound in this run, so do not claim to have visually inspected any reference — treat named references only as context and flag as an assumption if inspection was required. If you cannot complete this task from the given context, set status "blocked" and list exactly what is missing in blockers.`
}

function rolePrompt(state, role, task, upstream) {
  return `${preamble(state)}

Your role: ${ROLE_INSTRUCTIONS[role]}
This task: ${task}
Upstream context: ${JSON.stringify(upstream)}
Respond only via the required schema.`
}

function revisionPrompt(state, dept, issues, prior) {
  return `${preamble(state)}

Your role: ${ROLE_INSTRUCTIONS[dept]}
Quality control raised these CRITICAL issues against your last output: ${JSON.stringify(issues)}
Your previous content: ${JSON.stringify(prior && prior.content)}
Produce a corrected, full replacement 'content' that resolves every issue while preserving whatever still holds. Respond only via the required schema.`
}

function qcPrompt(state) {
  return `${preamble(state)}

Your role: ${ROLE_INSTRUCTIONS.quality_control}
Audit this production package against the brief, product fidelity, department consistency, storyboard completeness, timing, and reference/rights readiness (per quality_checks.planning). No media has been generated yet, so mark every "media" category check as "not_inspected", never "pass". Package: ${JSON.stringify({
    strategy: state.artifacts.strategy.content,
    concepts: state.artifacts.concepts.content,
    script: state.artifacts.script.content,
    casting_bible: state.artifacts.casting_bible.content,
    world_bible: state.artifacts.world_bible.content,
    directors_treatment: state.artifacts.directors_treatment.content,
    style_bible: state.artifacts.style_bible.content,
    sound_plan: state.artifacts.sound_plan.content,
    camera_plan: state.artifacts.camera_plan.content,
    storyboard: state.artifacts.storyboard.content,
    continuity_bible: state.artifacts.continuity_bible.content,
    generation_plan: state.artifacts.generation_plan.content,
  })}
Every issue must name a responsible_agent from the fixed role list and cite evidence. Recommend "approve" only if there are no unresolved critical or major defects and every required planning check was actually inspected.`
}

// ---- agent-call budget guard (per_run; must never throw across parallel() — it swallows errors to null) ----

let agentCalls = 0

async function runAgent(state, role, prompt, opts) {
  if (agentCalls >= LIMITS.maxAgentCallsPerRun) {
    state.limit_reached = true
    return {
      status: 'blocked',
      based_on: [],
      content: (opts && opts.emptyContent) || {},
      asset_uri: null,
      assumptions: [],
      sources: [],
      blockers: [{
        issue: `agent-call budget (${LIMITS.maxAgentCallsPerRun} per run) was reached before ${role} could run`,
        responsible_agent: 'producer',
        resolution: 'Resume this project (command APPROVE/STATUS with the returned project_state) in a new run to continue with a fresh budget.',
      }],
    }
  }
  agentCalls += 1
  return agent(prompt, { label: role, phase: opts && opts.phase, schema: opts && opts.schema })
}

// ---- stage 09 revision loop ----

async function preproductionReview(state) {
  let round = 0
  let clean = isPresent(state, 'quality_reports') && state.artifacts.quality_reports.content.recommendation === 'approve'
  while (!clean && round < LIMITS.maxRevisionRoundsPerStage && !state.limit_reached) {
    round += 1
    const res = await runAgent(state, 'quality_control', qcPrompt(state), { schema: envelopeSchema(QUALITY_REPORT_CONTENT), phase: 'Pre-production Review', emptyContent: { checks: [], issues: [], recommendation: 'revise' } })
    state.artifacts.quality_reports = makeArtifact(state, 'quality_reports', 'quality_control', '09_preproduction_review', planningArtifactIds(state), res)
    if (state.limit_reached) return
    const critical = (res.content.issues || []).filter(i => i.severity === 'critical')
    if (!critical.length) { clean = true; break }
    const byDept = groupBy(critical, i => i.responsible_agent)
    const entries = Object.entries(byDept).filter(([dept]) => KIND_BY_DEPT[dept] && DEPT_SCHEMA[dept])
    for (let i = 0; i < entries.length && !state.limit_reached; i += LIMITS.maxParallelTasks) {
      const batch = entries.slice(i, i + LIMITS.maxParallelTasks)
      await parallel(batch.map(([dept, issues]) => async () => {
        const kind = KIND_BY_DEPT[dept]
        const prior = state.artifacts[kind]
        // storyboard_artist is the one department whose single call produces two artifacts
        // (storyboard + continuity_bible); give it both as prior context and split its fix back out.
        const priorForPrompt = dept === 'storyboard_artist'
          ? { ...prior, content: { ...(prior && prior.content), tracked_elements: state.artifacts.continuity_bible && state.artifacts.continuity_bible.content.tracked_elements } }
          : prior
        const fixRes = await runAgent(state, dept, revisionPrompt(state, dept, issues, priorForPrompt), { schema: envelopeSchema(DEPT_SCHEMA[dept]), phase: 'Pre-production Review', emptyContent: prior ? prior.content : {} })
        if (state.limit_reached) return
        if (dept === 'storyboard_artist') {
          const updatedStoryboard = makeArtifact(state, 'storyboard', dept, '09_preproduction_review_revision', prior ? [prior.artifact_id] : [], { ...fixRes, content: { panels: fixRes.content.panels, contradictions_flagged: fixRes.content.contradictions_flagged } })
          updatedStoryboard.revision = (prior ? prior.revision : 0) + 1
          state.artifacts.storyboard = updatedStoryboard
          const priorContinuity = state.artifacts.continuity_bible
          const updatedContinuity = makeArtifact(state, 'continuity_bible', dept, '09_preproduction_review_revision', priorContinuity ? [priorContinuity.artifact_id] : [], { ...fixRes, content: { tracked_elements: fixRes.content.tracked_elements } })
          updatedContinuity.revision = (priorContinuity ? priorContinuity.revision : 0) + 1
          state.artifacts.continuity_bible = updatedContinuity
          return
        }
        const updated = makeArtifact(state, kind, dept, '09_preproduction_review_revision', prior ? [prior.artifact_id] : [], fixRes)
        updated.revision = (prior ? prior.revision : 0) + 1
        state.artifacts[kind] = updated
      }))
    }
    state.decision_log.push({ stage: '09_preproduction_review', summary: `Revision round ${round}: routed ${critical.length} critical issue(s) to ${Object.keys(byDept).join(', ')}`, round })
  }
  if (!clean && !state.limit_reached) {
    state.decision_log.push({ stage: '09_preproduction_review', summary: `Reached max_revision_rounds_per_stage (${LIMITS.maxRevisionRoundsPerStage}) with unresolved critical issues — escalating to the human for a decision.`, unresolved: true })
  }
}

// ---- stages 10-15 (connected_tools only; blocked-by-default per tool_policy.missing_tool) ----

async function runProductionStages(state) {
  phase('Production')
  const toolBindings = input.toolBindings || {}
  const mode = input.mode || 'planning_only'
  const missing = []
  if (mode !== 'connected_tools') missing.push('runtime mode is "planning_only" — no media, audio, or edit jobs may be submitted')
  ;['image_generation', 'video_generation', 'audio_generation', 'editing'].forEach(t => {
    if (!toolBindings[t]) missing.push(`capability "${t}" has no bound implementation`)
  })
  if (!state.brief.budget.media_and_render_cap) missing.push('media_and_render_cap is not authorized — unknown cost bounds require explicit approval before any paid production job')

  if (missing.length) {
    const jobs = (state.artifacts.generation_plan && state.artifacts.generation_plan.content.jobs) || []
    state.artifacts.production_readiness = {
      artifact_id: nextId(state, 'production_readiness'),
      project_id: state.project_id,
      task_id: '10_reference_stills',
      owner_agent: 'generation_supervisor',
      kind: 'blocked_capability_report',
      revision: 1,
      status: 'blocked',
      based_on: [state.artifacts.generation_plan && state.artifacts.generation_plan.artifact_id].filter(Boolean),
      content: {
        missing_capabilities: missing,
        handoff_package: jobs.map(j => ({ job_id: j.job_id, shot_id: j.shot_id, job_type: j.job_type, ready_to_use_prompt: j.prompt, reference_asset_ids: j.reference_asset_ids })),
      },
      asset_uri: null,
      assumptions: [],
      sources: [],
      blockers: missing.map(m => ({ issue: m, responsible_agent: 'producer', resolution: 'Bind the capability and record the required approval and budget authorization, then resume with command APPROVE.' })),
    }
    state.decision_log.push({ stage: '10_reference_stills', summary: 'Connected-tools production stages are blocked pending capability bindings, mode, and budget authorization.', missing })
    return
  }

  if (!isPresent(state, 'reference_stills')) {
    const res = await runAgent(state, 'generation_supervisor', rolePrompt(state, 'generation_supervisor', 'Create authorized character, product, location, and hero-frame reference stills for every shot that needs one; reuse supplied assets where possible.', { generation_plan: state.artifacts.generation_plan.content }), { schema: envelopeSchema(JOB_RESULT_CONTENT), phase: 'Production', emptyContent: { job_results: [] } })
    state.artifacts.reference_stills = makeArtifact(state, 'reference_stills', 'generation_supervisor', '10_reference_stills', [state.artifacts.generation_plan.artifact_id], res)
  }
  state.stage_reached = '10_reference_stills'
  if (state.limit_reached) return
  const visualLock = state.approvals.visual_lock
  if (!visualLock || !visualLock.approved) {
    state.pending_gate = gateInfo('visual_lock', [state.artifacts.reference_stills])
    recordPendingApproval(state, 'visual_lock')
    return
  }
  state.artifacts.reference_stills.status = 'approved'
  state.approval_log.push({ gate_id: 'visual_lock', decision: 'approved', scope: [state.artifacts.reference_stills.artifact_id] })

  if (!isPresent(state, 'motion_assets')) {
    const res = await runAgent(state, 'generation_supervisor', rolePrompt(state, 'generation_supervisor', 'Generate approved motion shots and requested campaign stills using the exact approved reference asset versions only.', { generation_plan: state.artifacts.generation_plan.content, reference_stills: state.artifacts.reference_stills.content }), { schema: envelopeSchema(JOB_RESULT_CONTENT), phase: 'Production', emptyContent: { job_results: [] } })
    state.artifacts.motion_assets = makeArtifact(state, 'motion_assets', 'generation_supervisor', '11_motion', [state.artifacts.reference_stills.artifact_id], res)
  }
  state.stage_reached = '11_motion'
  if (state.limit_reached) return

  if (!isPresent(state, 'audio_assets')) {
    const res = await runAgent(state, 'sound_designer', rolePrompt(state, 'sound_designer', 'Produce or ingest the approved music, dialogue, and sound assets for the locked sound plan.', { sound_plan: state.artifacts.sound_plan.content }), { schema: envelopeSchema(JOB_RESULT_CONTENT), phase: 'Production', emptyContent: { job_results: [] } })
    state.artifacts.audio_assets = makeArtifact(state, 'audio_assets', 'sound_designer', '12_audio', [state.artifacts.motion_assets.artifact_id], res)
  }
  state.stage_reached = '12_audio'
  if (state.limit_reached) return

  if (!isPresent(state, 'edit_timeline')) {
    const editTimelineFields = ['deliverable_id', 'shot_id', 'asset_id', 'source_in_frame', 'source_out_frame', 'timeline_in_frame', 'timeline_out_frame', 'transition', 'audio_asset_ids', 'overlay_asset_ids']
    const res = await runAgent(state, 'editor', rolePrompt(state, 'editor', 'Assemble an executable edit timeline and rough cut per deliverable from the approved motion and audio assets.', { edit_timeline_fields: editTimelineFields, motion_assets: state.artifacts.motion_assets.content, audio_assets: state.artifacts.audio_assets.content, deliverables: state.brief.deliverables }), { schema: envelopeSchema(EDIT_TIMELINE_CONTENT), phase: 'Production', emptyContent: { entries: [] } })
    state.artifacts.edit_timeline = makeArtifact(state, 'edit_timeline', 'editor', '13_edit', [state.artifacts.audio_assets.artifact_id], res)
  }
  state.stage_reached = '13_edit'
  if (state.limit_reached) return

  if (!isPresent(state, 'final_review')) {
    const res = await runAgent(state, 'quality_control', rolePrompt(state, 'quality_control', 'Inspect the actual review cuts and campaign stills (not just their plan) and resolve blocking issues before final export.', { edit_timeline: state.artifacts.edit_timeline.content }), { schema: envelopeSchema(QUALITY_REPORT_CONTENT), phase: 'Production', emptyContent: { checks: [], issues: [], recommendation: 'revise' } })
    state.artifacts.final_review = makeArtifact(state, 'final_review', 'quality_control', '14_review', [state.artifacts.edit_timeline.artifact_id], res)
  }
  state.stage_reached = '14_review'
  if (state.limit_reached) return
  const finalCut = state.approvals.final_cut
  if (!finalCut || !finalCut.approved) {
    state.pending_gate = gateInfo('final_cut', [state.artifacts.edit_timeline, state.artifacts.final_review])
    recordPendingApproval(state, 'final_cut')
    return
  }
  state.artifacts.final_review.status = 'approved'
  state.approval_log.push({ gate_id: 'final_cut', decision: 'approved', scope: [state.artifacts.edit_timeline.artifact_id] })

  if (!isPresent(state, 'final_delivery')) {
    const res = await runAgent(state, 'editor', rolePrompt(state, 'editor', 'Export only the approved timelines and stills, verify every final file against its deliverable spec, and assemble the delivery manifest.', { edit_timeline: state.artifacts.edit_timeline.content, final_review: state.artifacts.final_review.content }), { schema: envelopeSchema(DELIVERY_CONTENT), phase: 'Production', emptyContent: { manifest: [] } })
    state.artifacts.final_delivery = makeArtifact(state, 'final_delivery', 'editor', '15_delivery', [state.artifacts.edit_timeline.artifact_id, state.artifacts.final_review.artifact_id], res)
  }
  state.stage_reached = '15_delivery'
}

// ---- REVISE support ----

function applyRevision(state, revision) {
  const kind = revision && revision.target_kind
  if (!kind) return
  markStale(state, kind)
  if (state.approvals.production_plan) state.approvals.production_plan = { approved: false, note: 'invalidated by revision' }
  state.decision_log.push({
    stage: 'revision_request',
    note: revision.note,
    target_artifact_kind: kind,
    reason: revision.reason,
    affected_departments: REVISION_ROUTING[revision.routing_key] || [],
    estimated_cost_impact: revision.estimated_cost_impact || 'not estimated',
    required_reapprovals: ['production_plan'],
  })
}

// ---- main pipeline (single project moving through a DAG of stages; two 3-way parallel fan-outs) ----

async function runPipeline(state) {
  phase('Strategy')
  if (!isPresent(state, 'strategy')) {
    const res = await runAgent(state, 'strategist', rolePrompt(state, 'strategist', 'Develop the strategic foundation for this campaign.', { brief: state.artifacts.brief.content }), { schema: envelopeSchema(STRATEGY_CONTENT), phase: 'Strategy', emptyContent: { audience_tension: '', desired_behavior: '', product_relevance: '', single_minded_proposition: '', proof_points: [], success_criteria: [], supplied_facts: [], sourced_research: [], hypotheses: [] } })
    state.artifacts.strategy = makeArtifact(state, 'strategy', 'strategist', '02_strategy', [state.artifacts.brief.artifact_id], res)
    state.decision_log.push({ stage: '02_strategy', summary: 'Strategy drafted', artifact_id: state.artifacts.strategy.artifact_id })
  }
  state.stage_reached = '02_strategy'
  if (state.limit_reached) return

  phase('Concepts')
  if (!isPresent(state, 'concepts')) {
    const res = await runAgent(state, 'creative_director', rolePrompt(state, 'creative_director', 'Present three distinct campaign routes and one recommendation.', { strategy: state.artifacts.strategy.content }), { schema: envelopeSchema(CONCEPTS_CONTENT), phase: 'Concepts', emptyContent: { routes: [], recommended_route_id: '', recommendation_rationale: '' } })
    state.artifacts.concepts = makeArtifact(state, 'concept_options', 'creative_director', '03_concepts', [state.artifacts.strategy.artifact_id], res)
    state.decision_log.push({ stage: '03_concepts', summary: 'Three routes proposed', artifact_id: state.artifacts.concepts.artifact_id })
  }
  state.stage_reached = '03_concepts'
  if (state.limit_reached) return

  const conceptGate = state.approvals.concept
  if (!conceptGate || !conceptGate.approved) {
    state.pending_gate = gateInfo('concept', [state.artifacts.brief, state.artifacts.strategy, state.artifacts.concepts])
    recordPendingApproval(state, 'concept')
    return
  }
  if (state.artifacts.concepts.status !== 'approved') {
    state.selected_concept_id = conceptGate.selected_route_id || state.artifacts.concepts.content.recommended_route_id
    state.artifacts.concepts.status = 'approved'
    state.approval_log.push({ gate_id: 'concept', decision: 'approved', selected_route_id: state.selected_concept_id, scope: [state.artifacts.concepts.artifact_id] })
  }

  phase('Script, Cast & World')
  if (!isPresent(state, 'script') || !isPresent(state, 'casting_bible') || !isPresent(state, 'world_bible')) {
    const upstream = { selected_route_id: state.selected_concept_id, concepts: state.artifacts.concepts.content }
    const [scriptRes, castRes, worldRes] = await parallel([
      () => isPresent(state, 'script') ? Promise.resolve(null) : runAgent(state, 'copywriter', rolePrompt(state, 'copywriter', 'Write the timed script (hook, beats, on-screen copy, CTA) for every video deliverable on the approved route.', upstream), { schema: envelopeSchema(SCRIPT_CONTENT), phase: 'Script, Cast & World', emptyContent: { deliverable_scripts: [] } }),
      () => isPresent(state, 'casting_bible') ? Promise.resolve(null) : runAgent(state, 'casting_director', rolePrompt(state, 'casting_director', 'Define the character profiles for the approved route.', upstream), { schema: envelopeSchema(CASTING_CONTENT), phase: 'Script, Cast & World', emptyContent: { characters: [] } }),
      () => isPresent(state, 'world_bible') ? Promise.resolve(null) : runAgent(state, 'production_designer', rolePrompt(state, 'production_designer', 'Define the locations, props, and palette for the approved route.', upstream), { schema: envelopeSchema(WORLD_CONTENT), phase: 'Script, Cast & World', emptyContent: { locations: [] } }),
    ])
    if (scriptRes) state.artifacts.script = makeArtifact(state, 'script', 'copywriter', '04_script_cast_world', [state.artifacts.concepts.artifact_id], scriptRes)
    if (castRes) state.artifacts.casting_bible = makeArtifact(state, 'casting_bible', 'casting_director', '04_script_cast_world', [state.artifacts.concepts.artifact_id], castRes)
    if (worldRes) state.artifacts.world_bible = makeArtifact(state, 'world_bible', 'production_designer', '04_script_cast_world', [state.artifacts.concepts.artifact_id], worldRes)
    ;['script', 'casting_bible', 'world_bible'].forEach(k => {
      const a = state.artifacts[k]
      if (a && a.status === 'blocked') state.decision_log.push({ stage: '04_script_cast_world', summary: `${k} returned blocked — producer flags for resolution before downstream departments proceed.`, artifact_id: a.artifact_id })
    })
  }
  state.stage_reached = '04_script_cast_world'
  if (state.limit_reached) return

  phase('Direction, Style & Sound')
  const needsSound = (state.brief.deliverables || []).some(d => d.type === 'video')
  if (!isPresent(state, 'sound_plan') && !needsSound) {
    state.artifacts.sound_plan = makeArtifact(state, 'sound_plan', 'sound_designer', '05_direction_style_sound', [], { status: 'draft', based_on: [], content: { cues: [] }, asset_uri: null, assumptions: ['Sound design skipped — not applicable: the brief has no video/audio-bearing deliverables.'], sources: [], blockers: [] })
    state.decision_log.push({ stage: '05_direction_style_sound', summary: 'sound_designer skipped: not applicable (no video/audio deliverables)', not_applicable: true })
  }
  if (!isPresent(state, 'directors_treatment') || !isPresent(state, 'style_bible') || !isPresent(state, 'sound_plan')) {
    const upstream = { script: state.artifacts.script.content, casting_bible: state.artifacts.casting_bible.content, world_bible: state.artifacts.world_bible.content }
    const basedOn = [state.artifacts.script.artifact_id, state.artifacts.casting_bible.artifact_id, state.artifacts.world_bible.artifact_id]
    const [dirRes, styleRes, soundRes] = await parallel([
      () => isPresent(state, 'directors_treatment') ? Promise.resolve(null) : runAgent(state, 'director', rolePrompt(state, 'director', 'Turn the approved script and world into a directing treatment.', upstream), { schema: envelopeSchema(TREATMENT_CONTENT), phase: 'Direction, Style & Sound', emptyContent: { scenes: [] } }),
      () => isPresent(state, 'style_bible') ? Promise.resolve(null) : runAgent(state, 'stylist', rolePrompt(state, 'stylist', 'Build wardrobe, hair, and makeup looks for the defined cast and world.', upstream), { schema: envelopeSchema(STYLE_CONTENT), phase: 'Direction, Style & Sound', emptyContent: { looks: [] } }),
      () => (isPresent(state, 'sound_plan') || !needsSound) ? Promise.resolve(null) : runAgent(state, 'sound_designer', rolePrompt(state, 'sound_designer', 'Plan music, sound effects, dialogue, and voiceover against the script.', { script: state.artifacts.script.content }), { schema: envelopeSchema(SOUND_PLAN_CONTENT), phase: 'Direction, Style & Sound', emptyContent: { cues: [] } }),
    ])
    if (dirRes) state.artifacts.directors_treatment = makeArtifact(state, 'directors_treatment', 'director', '05_direction_style_sound', basedOn, dirRes)
    if (styleRes) state.artifacts.style_bible = makeArtifact(state, 'style_bible', 'stylist', '05_direction_style_sound', basedOn, styleRes)
    if (soundRes) state.artifacts.sound_plan = makeArtifact(state, 'sound_plan', 'sound_designer', '05_direction_style_sound', [state.artifacts.script.artifact_id], soundRes)
  }
  state.stage_reached = '05_direction_style_sound'
  if (state.limit_reached) return

  phase('Camera')
  if (!isPresent(state, 'camera_plan')) {
    const basedOn = [state.artifacts.directors_treatment.artifact_id, state.artifacts.style_bible.artifact_id, state.artifacts.world_bible.artifact_id]
    const res = await runAgent(state, 'cinematographer', rolePrompt(state, 'cinematographer', 'Build the shot plan (per shot_contract) from the directing treatment, styling, and world.', { directors_treatment: state.artifacts.directors_treatment.content, style_bible: state.artifacts.style_bible.content, world_bible: state.artifacts.world_bible.content, casting_bible: state.artifacts.casting_bible.content, script: state.artifacts.script.content, shot_fields: SHOT_FIELDS }), { schema: envelopeSchema(CAMERA_PLAN_CONTENT), phase: 'Camera', emptyContent: { shots: [] } })
    state.artifacts.camera_plan = makeArtifact(state, 'camera_plan', 'cinematographer', '06_camera', basedOn, res)
  }
  state.stage_reached = '06_camera'
  if (state.limit_reached) return

  phase('Storyboard')
  if (!isPresent(state, 'storyboard') || !isPresent(state, 'continuity_bible')) {
    const basedOn = [state.artifacts.camera_plan.artifact_id, state.artifacts.sound_plan.artifact_id]
    const res = await runAgent(state, 'storyboard_artist', rolePrompt(state, 'storyboard_artist', 'Combine the approved script, cast, wardrobe, world, direction, camera plan, and sound plan into ordered, timed text panels, and track continuity state per persistent element across shots. Flag contradictions.', { camera_plan: state.artifacts.camera_plan.content, sound_plan: state.artifacts.sound_plan.content }), { schema: envelopeSchema(STORYBOARD_AND_CONTINUITY_CONTENT), phase: 'Storyboard', emptyContent: { panels: [], contradictions_flagged: [], tracked_elements: [] } })
    state.artifacts.storyboard = makeArtifact(state, 'storyboard', 'storyboard_artist', '07_storyboard', basedOn, { ...res, content: { panels: res.content.panels, contradictions_flagged: res.content.contradictions_flagged } })
    state.artifacts.continuity_bible = makeArtifact(state, 'continuity_bible', 'storyboard_artist', '07_storyboard', basedOn, { ...res, content: { tracked_elements: res.content.tracked_elements } })
  }
  state.stage_reached = '07_storyboard'
  if (state.limit_reached) return

  phase('Generation Plan')
  if (!isPresent(state, 'generation_plan')) {
    const res = await runAgent(state, 'generation_supervisor', rolePrompt(state, 'generation_supervisor', 'Translate every locked shot into image/video prompts and reference-image requirements. Check capability against the parameter_rule (no assumed negative prompts, seeds, multi-reference, exact lenses, or arbitrary durations) and estimate cost per job. Do not generate media.', { storyboard: state.artifacts.storyboard.content }), { schema: envelopeSchema(GENERATION_PLAN_CONTENT), phase: 'Generation Plan', emptyContent: { jobs: [], missing_capabilities: [] } })
    state.artifacts.generation_plan = makeArtifact(state, 'generation_plan', 'generation_supervisor', '08_generation_plan', [state.artifacts.storyboard.artifact_id], res)
  }
  state.stage_reached = '08_generation_plan'
  if (state.limit_reached) return

  phase('Pre-production Review')
  await preproductionReview(state)
  state.stage_reached = '09_preproduction_review'
  if (state.limit_reached) return

  const prodGate = state.approvals.production_plan
  if (!prodGate || !prodGate.approved) {
    state.pending_gate = gateInfo('production_plan', Object.values(state.artifacts))
    recordPendingApproval(state, 'production_plan')
    return
  }
  Object.values(state.artifacts).forEach(a => { if (a.status !== 'blocked') a.status = 'approved' })
  state.approval_log.push({ gate_id: 'production_plan', decision: 'approved', scope: Object.values(state.artifacts).map(a => a.artifact_id) })

  await runProductionStages(state)
}

// ---- driver ----

if (['STATUS', 'EXPORT_STATE', 'EXPORT_PLAN'].includes(command)) {
  if (!input.priorState) {
    return { command, error: 'No priorState supplied — nothing to report. Run command START first and pass its project_state back in as priorState.' }
  }
  const priorState = input.priorState
  if (command === 'EXPORT_PLAN') {
    return {
      command,
      project_id: priorState.project_id,
      stage_reached: priorState.stage_reached,
      pending_gate: priorState.pending_gate,
      campaign_bible: Object.values(priorState.artifacts),
      handoff_manifest: Object.values(priorState.artifacts).filter(a => a.status === 'blocked'),
    }
  }
  return { command, project_state: priorState }
}

let state
if (!input.priorState) {
  const normalized = normalizeBrief(input.brief)
  state = {
    project_id: PROJECT_ID,
    artifact_seq: 0,
    brief: normalized.brief,
    artifacts: {},
    approvals: input.approvals || {},
    decision_log: [],
    approval_log: [],
    pending_gate: null,
    needs_human_input: normalized.needsInput,
    stage_reached: '01_intake',
    limit_reached: false,
  }
  state.artifacts.brief = makeArtifact(state, 'brief', 'producer', '01_intake', [], {
    status: normalized.needsInput.length ? 'review_required' : 'draft',
    based_on: [],
    content: { normalized_brief: normalized.brief },
    asset_uri: null,
    assumptions: normalized.assumptions,
    sources: [],
    blockers: [],
  })
  state.decision_log.push({ stage: '01_intake', summary: 'Brief normalized', missing_fields: normalized.needsInput })
} else {
  state = input.priorState
  state.limit_reached = false
  state.pending_gate = null
  state.approvals = { ...(state.approvals || {}), ...(input.approvals || {}) }
  if (command === 'REVISE' && input.revision) applyRevision(state, input.revision)
}

await runPipeline(state)

return {
  project_id: PROJECT_ID,
  command,
  stage_reached: state.stage_reached,
  pending_gate: state.pending_gate,
  needs_human_input: state.needs_human_input || [],
  artifacts: Object.values(state.artifacts),
  decision_log: state.decision_log,
  approval_log: state.approval_log,
  budget_ledger: {
    currency: state.brief.budget.currency,
    runner_llm_cap: state.brief.budget.runner_llm_cap,
    media_and_render_cap: state.brief.budget.media_and_render_cap,
    agent_calls_used_this_run: agentCalls,
    agent_calls_allowed_per_run: LIMITS.maxAgentCallsPerRun,
    limit_reached: state.limit_reached,
  },
  blockers: collectBlockers(state),
  project_state: state,
}
