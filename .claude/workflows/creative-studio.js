export const meta = {
  name: 'creative-studio',
  description: 'Run the Lucas Prevost Creative AI Studio: develop an idea (or take a brief), build the full pre-production package department by department to an A-quality bar, and stop for Lucas at the approval gates',
  phases: [
    { title: 'Development' },
    { title: 'Strategy' },
    { title: 'Concepts' },
    { title: 'Script, Cast & World' },
    { title: 'Direction, Style & Sound' },
    { title: 'Camera' },
    { title: 'Storyboard' },
    { title: 'Generation Plan' },
    { title: 'Pre-production Review' },
    { title: 'Package Review' },
    { title: 'Production' },
  ],
}

// Usage: Workflow({ scriptPath: '.claude/workflows/creative-studio.js', args: {
//   command, idea, ideaHints, brief, priorState, approvals, notes, revision, craft, tasteNotes,
//   qualityBar, quality, review, maxAgentCalls, mode, toolBindings, projectId } })
// command:
//   IDEA     develop a raw `idea` (+ optional ideaHints {format, duration_seconds, brand, ...}) into a
//            brief, then build the whole package; quality bar on, review at the end (one gate).
//   START    begin from a written `brief` (per-gate stops unless review: 'end').
//   APPROVE  resume `priorState` with new `approvals` merged in.
//   NOTES    resume `priorState` with Lucas's free-text `notes` on the package; they are routed to
//            departments, the work is revised to the quality bar and comes back for review.
//   REVISE   resume with a { target_kind, routing_key, note, reason } revision.
//   STATUS | EXPORT_STATE | EXPORT_PLAN  report on `priorState` without running agents.
// craft: { <role id>: <craft brief markdown> }, tasteNotes, qualityBar: text from spec/ (workflow
//   scripts can't read files, so the caller passes them in).
// quality: true turns on the A-quality loop (default for IDEA); review: 'end' | 'gates'.
// mode: 'planning_only' (default) | 'connected_tools' (also needs toolBindings and
//   brief.budget.media_and_render_cap, or stage 10+ reports a blocked_capability_report).
// See ../../spec/creative_studio_agents.json for the blueprint and ../../spec/quality-bar.md for "A".

const input = args || {}
const PROJECT_ID = input.projectId || (input.priorState && input.priorState.project_id) || 'PROJECT_001'
const command = input.command || 'START'
const CRAFT = input.craft || {}
const TASTE_NOTES = input.tasteNotes || ''
const QUALITY_BAR = input.qualityBar || ''
const A_MIN = 8

// Adjusted after the project's settings are known (quality runs need a larger call budget).
const LIMITS = { maxParallelTasks: 3, maxAgentCallsPerRun: 40, maxRevisionRoundsPerStage: 2, maxQualityRounds: 3, maxPackageRounds: 2 }

const FORMATS = ['ad_spot', 'social_series', 'brand_film', 'short_film', 'music_video', 'series_pilot']
const AD_FORMATS = ['ad_spot', 'social_series', 'brand_film']
const MAX_BUILD_VIDEO_SECONDS = 120

const GATES = {
  concept: 'Approve the normalized brief, strategy, and one selected concept ID.',
  production_plan: 'Approve exact script, cast, style, world, storyboard, sound, and generation-plan revisions. Separately authorize a media cap and the external sharing of identified assets before any paid production.',
  visual_lock: 'Approve the exact reference asset IDs and versions to anchor identity, product, styling, and locations.',
  final_cut: 'Approve the exact review-cut versions, edit timelines, and final campaign stills before final export.',
}

const DEPT_IDS = ['strategist', 'creative_director', 'copywriter', 'casting_director', 'production_designer', 'director', 'stylist', 'cinematographer', 'storyboard_artist', 'generation_supervisor', 'sound_designer', 'editor']

const ROLE_INSTRUCTIONS = {
  producer: 'Executive Producer / Orchestrator. Normalize the brief, keep every department on the same approved direction, merge outputs, and present one coherent campaign. Never approve on the human’s behalf and never claim an asset exists without evidence.',
  development_producer: 'Development Producer. Take a raw idea from the creative director and develop it into a complete, buildable brief: the right format, a logline, a premise that makes the idea more specific and more surprising without replacing it, audience, objective, tone, deliverables sized to the format, and every assumption labeled. Never invent product facts, statistics, real people or real brands.',
  strategist: 'Brand and Audience Strategist. Identify the audience tension, desired behavior, product relevance, single-minded proposition, proof points, and success criteria. Separate supplied facts, sourced research, and hypotheses. Do not invent audience research or performance claims.',
  creative_director: 'AI Creative Director. Develop exactly three distinct routes, each with a central idea, emotional promise, product role, visual language, and execution example. Recommend one with a concise rationale.',
  copywriter: 'Campaign Copywriter. Write timed scripts, dialogue or voiceover, on-screen copy, hooks, and calls to action for the approved route, one per deliverable duration, without changing the central promise. Use only approved factual claims.',
  screenwriter: 'Screenwriter. Write the beat sheet for the whole piece and the timed script for the build sequence: every scene has a heading, who is present, what each character wants, what changes, and the exact action and dialogue. Structure, character and visual storytelling come before dialogue.',
  casting_director: 'Casting Director. Define character profiles, screen presence, performance style, wardrobe fit considerations, and visual identity anchors. Use fictional adult talent by default; cast a child only when the script needs one, and flag it for human review. Never invent a real person’s availability or permission to use their likeness or voice.',
  production_designer: 'Production Designer / Art Director. Define locations, spatial layout, props, materials, palette, product placement, and background behavior with persistent location and prop IDs and states that must match between shots.',
  director: 'Film Director. Turn the approved script and world into a directing treatment: performance beats, blocking, action progression, emotional shifts, and transitions, explaining how each scene demonstrates the idea and flagging anything needing practical footage or compositing.',
  stylist: 'Wardrobe, Hair and Makeup Stylist. Build looks for the cast and world: garment silhouettes, materials, colors, fit, accessories, hair, makeup, and grooming, with look IDs and locked continuity. Avoid wardrobe that distracts from or obscures the product.',
  cinematographer: 'Director of Photography. Translate the directing treatment into a shot plan: framing, lens intent, camera height, movement, focus, lighting, exposure mood, and product visibility, resolving eyelines, screen direction, and spatial continuity.',
  storyboard_artist: 'Storyboard Artist / Previsualization. Board the camera plan shot by shot: the script\'s exact lines and cards, the sound plan\'s cues, entry and exit states, generation risk, and the continuity of every tracked element. Never re-time or re-frame a shot; flag contradictions with their owner before production.',
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

const DOWNSTREAM_OF_BRIEF = ['strategy', 'concepts', 'script', 'casting_bible', 'world_bible', 'directors_treatment', 'style_bible', 'sound_plan', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports', 'package_review']
const DEPENDENTS = {
  development: DOWNSTREAM_OF_BRIEF,
  strategy: DOWNSTREAM_OF_BRIEF.slice(1),
  concepts: DOWNSTREAM_OF_BRIEF.slice(2),
  // Cast and world are broken down from the script, so a script change reaches everything.
  script: ['casting_bible', 'world_bible', 'directors_treatment', 'style_bible', 'sound_plan', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports', 'package_review'],
  casting_bible: ['style_bible', 'directors_treatment', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports', 'package_review'],
  world_bible: ['directors_treatment', 'style_bible', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports', 'package_review'],
  directors_treatment: ['camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports', 'package_review'],
  style_bible: ['camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports', 'package_review'],
  sound_plan: ['storyboard', 'continuity_bible', 'generation_plan', 'quality_reports', 'package_review'],
  camera_plan: ['storyboard', 'continuity_bible', 'generation_plan', 'quality_reports', 'package_review'],
  storyboard: ['generation_plan', 'quality_reports', 'package_review'],
  continuity_bible: ['generation_plan', 'quality_reports', 'package_review'],
  generation_plan: ['quality_reports', 'package_review'],
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

const BANNED = ['elevat\\w*', 'seamless\\w*', 'journey\\w*', 'curated', 'crafted', 'stunning', 'vibrant',
  'cinematic', 'immersive', 'indulg\\w*', 'unlock\\w*', 'effortless\\w*', 'game[- ]changer\\w*',
  'reimagin\\w*', 'discover\\w*', 'introducing', 'more than just', 'because you deserve']
const BANNED_RE = new RegExp('\\b(' + BANNED.join('|') + ')\\b', 'gi')
const BANNED_READABLE = 'elevate, seamless, journey, curated, crafted, stunning, vibrant, cinematic, immersive, indulge, unlock, effortless, game-changer, reimagine, discover, introducing, "more than just", "because you deserve"'

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

const DEVELOPMENT_CONTENT = {
  type: 'object',
  properties: {
    working_title: { type: 'string' },
    logline: { type: 'string' },
    format: { type: 'string', enum: FORMATS },
    format_rationale: { type: 'string' },
    premise: { type: 'string' },
    what_makes_it_specific: { type: 'array', items: { type: 'string' } },
    brand: { type: 'string' },
    product_or_subject: { type: 'string' },
    objective: { type: 'string' },
    audience: { type: 'string' },
    key_message: { type: 'string' },
    tone: { type: 'array', items: { type: 'string' } },
    verified_product_facts: {
      type: 'array',
      items: { type: 'object', properties: { fact: { type: 'string' }, quoted_from_idea: { type: 'string' } }, required: ['fact', 'quoted_from_idea'] },
    },
    deliverables: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string', enum: ['video', 'still', 'outline'] },
          label: { type: 'string' },
          duration_seconds: { type: 'number' },
          count: { type: 'integer' },
          aspect_ratio: { type: 'string' },
        },
        required: ['id', 'type', 'label', 'duration_seconds', 'count', 'aspect_ratio'],
      },
    },
    must_include: { type: 'array', items: { type: 'string' } },
    must_avoid: { type: 'array', items: { type: 'string' } },
    story_seed: {
      type: 'object',
      properties: { protagonist: { type: 'string' }, want: { type: 'string' }, obstacle: { type: 'string' }, turn: { type: 'string' }, ending: { type: 'string' } },
      required: ['protagonist', 'want', 'obstacle', 'turn', 'ending'],
    },
    questions_for_lucas: { type: 'array', items: { type: 'string' } },
  },
  required: ['working_title', 'logline', 'format', 'format_rationale', 'premise', 'what_makes_it_specific', 'brand', 'product_or_subject', 'objective', 'audience', 'key_message', 'tone', 'verified_product_facts', 'deliverables', 'must_include', 'must_avoid', 'story_seed', 'questions_for_lucas'],
}

const WRITING_BEAT = {
  type: 'object',
  properties: {
    beat_id: { type: 'string' },
    start_s: { type: 'number' },
    end_s: { type: 'number' },
    picture: { type: 'string' },
    sound: { type: 'string' },
    vo: { type: 'string' },
    on_screen_text: { type: 'string' },
  },
  required: ['beat_id', 'start_s', 'end_s', 'picture', 'sound', 'vo', 'on_screen_text'],
}

const WRITING_CONTENT = {
  type: 'object',
  properties: {
    story: {
      type: 'object',
      properties: {
        logline: { type: 'string' },
        beat_sheet: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              scene_id: { type: 'string' },
              heading: { type: 'string' },
              characters: { type: 'array', items: { type: 'string' } },
              what_happens: { type: 'string' },
              turn: { type: 'string' },
            },
            required: ['scene_id', 'heading', 'characters', 'what_happens', 'turn'],
          },
        },
      },
      required: ['logline', 'beat_sheet'],
    },
    deliverable_scripts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          deliverable_id: { type: 'string' },
          duration_s: { type: 'number' },
          idea_in_one_line: { type: 'string' },
          beats: { type: 'array', items: WRITING_BEAT },
          cta: { type: 'string' },
        },
        required: ['deliverable_id', 'duration_s', 'idea_in_one_line', 'beats', 'cta'],
      },
    },
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
      items: { type: 'object', properties: { choice: { type: 'string' }, reason: { type: 'string' }, source: { type: 'string' } }, required: ['choice', 'reason', 'source'] },
    },
  },
  required: ['story', 'deliverable_scripts', 'stills_copy', 'decisions'],
}

const SCORE = {
  type: 'object',
  properties: { score: { type: 'integer', minimum: 1, maximum: 10 }, evidence: { type: 'string' } },
  required: ['score', 'evidence'],
}

const NOTE = {
  type: 'object',
  properties: { target: { type: 'string' }, note: { type: 'string' }, source: { type: 'string' } },
  required: ['target', 'note', 'source'],
}

const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    specificity: SCORE,
    distinctiveness: SCORE,
    fit: SCORE,
    craft: SCORE,
    notes: { type: 'array', items: NOTE },
    keep: { type: 'array', items: { type: 'string' } },
  },
  required: ['specificity', 'distinctiveness', 'fit', 'craft', 'notes', 'keep'],
}

// Execution departments the package panel may send work back to. Direction (development,
// strategy, route) is Lucas's call, so panel concerns about it come to him as questions.
const PANEL_DEPTS = ['copywriter', 'casting_director', 'production_designer', 'director', 'stylist', 'sound_designer', 'cinematographer', 'storyboard_artist', 'generation_supervisor']

const PANEL_SCHEMA = {
  type: 'object',
  properties: {
    specificity: SCORE,
    distinctiveness: SCORE,
    fit: SCORE,
    craft: SCORE,
    would_approve: { type: 'boolean' },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { responsible: { type: 'string', enum: PANEL_DEPTS }, target: { type: 'string' }, note: { type: 'string' }, source: { type: 'string' } },
        required: ['responsible', 'target', 'note', 'source'],
      },
    },
    direction_questions: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
  required: ['specificity', 'distinctiveness', 'fit', 'craft', 'would_approve', 'notes', 'direction_questions', 'verdict'],
}

const ROUTER_SCHEMA = {
  type: 'object',
  properties: {
    routes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { responsible: { type: 'string', enum: PANEL_DEPTS }, note: { type: 'string' } },
        required: ['responsible', 'note'],
      },
    },
    switch_route_to: { type: 'string' },
    direction_change: { type: 'string' },
  },
  required: ['routes', 'switch_route_to', 'direction_change'],
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

// The camera plan owns what the camera does; the storyboard adds only what a board adds (sound,
// text, states, what a generator may get wrong) and is merged onto the camera plan's shots in
// code; the generation plan owns prompts, references and acceptance checks. Nothing is written
// twice.
const CAMERA_SHOT_FIELDS = ['shot_id', 'scene_id', 'deliverable_ids', 'purpose', 'duration_frames', 'fps', 'character_ids', 'look_ids', 'location_id', 'product_reference_ids', 'prop_ids', 'framing', 'lens_intent', 'camera_movement', 'lighting', 'action', 'performance']

const CAMERA_SHOT_SCHEMA = {
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
  },
  required: CAMERA_SHOT_FIELDS,
}

const CAMERA_PLAN_CONTENT = { type: 'object', properties: { shots: { type: 'array', items: CAMERA_SHOT_SCHEMA } }, required: ['shots'] }

const BOARD_FIELDS = ['shot_id', 'board_note', 'dialogue_or_voiceover', 'on_screen_text', 'sound_cues', 'entry_state', 'exit_state', 'generation_risk']

const BOARD_PANEL_SCHEMA = {
  type: 'object',
  properties: {
    shot_id: { type: 'string' },
    board_note: { type: 'string' },
    dialogue_or_voiceover: { type: 'string' },
    on_screen_text: { type: 'string' },
    sound_cues: { type: 'array', items: { type: 'string' } },
    entry_state: { type: 'string' },
    exit_state: { type: 'string' },
    generation_risk: { type: 'string' },
  },
  required: BOARD_FIELDS,
}

const STORYBOARD_AND_CONTINUITY_CONTENT = {
  type: 'object',
  properties: {
    panels: { type: 'array', items: BOARD_PANEL_SCHEMA },
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
          method: { type: 'string' },
          prompt: { type: 'string' },
          reference_asset_ids: { type: 'array', items: { type: 'string' } },
          acceptance_checks: { type: 'array', items: { type: 'string' } },
          capability_supported: { type: 'boolean' },
          capability_notes: { type: 'string' },
          estimated_cost_unit: { type: 'string' },
        },
        required: ['job_id', 'shot_id', 'job_type', 'method', 'prompt', 'reference_asset_ids', 'acceptance_checks', 'capability_supported', 'capability_notes', 'estimated_cost_unit'],
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
          responsible_agent: { type: 'string', enum: PANEL_DEPTS.concat(['strategist', 'creative_director', 'producer']) },
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
    ...(result.not_run ? { not_run: true } : {}),
  }
}

function isPresent(state, kind) {
  return !!state.artifacts[kind] && state.artifacts[kind].status !== 'stale' && !state.artifacts[kind].not_run
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

// approval_policy.record_fields: who decided, when, on which exact versions, with what comment.
// An approval without an approver_id did not come from the Approval Desk and is logged as unverified.
function approvedEntry(state, gateId, approval, scope, extra) {
  if (approval.comment && !(state.human_notes || []).some(n => (approval.decision_id ? n.decision_id === approval.decision_id : n.gate_id === gateId && n.note === approval.comment))) {
    state.human_notes = (state.human_notes || []).concat([{ gate_id: gateId, note: approval.comment, decision_id: approval.decision_id || null }])
  }
  return {
    gate_id: gateId,
    decision: 'approved',
    approver_id: approval.approver_id || null,
    decided_at: approval.decided_at || null,
    comment: approval.comment || '',
    decision_id: approval.decision_id || null,
    verified: !!approval.approver_id,
    artifact_ids_and_revisions: scope,
    ...(extra || {}),
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

// ---- prompts ----

function roleTitle(role) {
  return (ROLE_INSTRUCTIONS[role] || role).split('.')[0]
}

function selectedRoute(state) {
  const routes = (state.artifacts.concepts && state.artifacts.concepts.content && state.artifacts.concepts.content.routes) || []
  return routes.find(r => r.route_id === state.selected_concept_id) || null
}

function preamble(state) {
  const b = state.brief
  const route = selectedRoute(state)
  const lines = [
    'Work only from this prompt. Do not use tools: do not read files, run commands, search, or create tasks. Everything you need is below; answer with the structured output directly.',
    `Project ${state.project_id} — "${b.name || 'untitled'}"${b.brand ? ` for ${b.brand}` : ''}.`,
    state.idea ? `Lucas's original idea (stay true to it): ${state.idea}` : null,
    b.format ? `Format: ${b.format}` : null,
    b.logline ? `Logline: ${b.logline}` : null,
    b.premise ? `Premise: ${b.premise}` : null,
    b.story_seed ? `Story seed: ${JSON.stringify(b.story_seed)}` : null,
    `One-line brief: ${b.one_line_brief || 'not supplied'}`,
    `Objective: ${b.objective || 'not supplied'}`,
    `Audience: ${b.audience || 'not supplied'}`,
    `Key message: ${b.key_message || 'not supplied'}`,
    `Tone: ${(b.tone || []).join(', ') || 'not specified'}`,
    `Deliverables: ${JSON.stringify(b.deliverables)}`,
    `Must include: ${JSON.stringify(b.must_include)}`,
    `Must avoid: ${JSON.stringify(b.must_avoid)}`,
    `Verified product facts (the ONLY claims you may state as fact): ${JSON.stringify(b.verified_product_facts)}`,
    route ? `Route in production: ${route.route_id}: ${route.central_idea}` : null,
    (state.human_notes || []).length ? `Notes from Lucas, the human creative director (binding direction; follow them unless one conflicts with the verified facts, and say so if it does): ${JSON.stringify(state.human_notes.map(n => `[${n.gate_id}] ${n.note}`))}` : null,
    `Rules: never invent product performance claims, statistics, or research beyond the verified facts above; label anything else as a hypothesis or assumption. Never use a real person's likeness, name, availability or rights; the cast is fictional. No reference_reader tool is bound in this run, so do not claim to have inspected any reference. If you cannot complete this task from the given context, set status "blocked" and list exactly what is missing in blockers.`,
  ]
  return lines.filter(Boolean).join('\n')
}

function craftBlock(role) {
  const parts = []
  if (CRAFT[role]) parts.push(`CRAFT BRIEF FOR THIS ROLE (requirements, not suggestions):\n<<<\n${CRAFT[role]}\n>>>`)
  if (TASTE_NOTES) parts.push(`THE STUDIO'S TASTE NOTES (its point of view; follow them, and say when you break one on purpose):\n<<<\n${TASTE_NOTES}\n>>>`)
  return parts.join('\n\n')
}

// Kept for the connected-tools production stages, which run without the quality loop.
function rolePrompt(state, role, task, upstream) {
  return `${preamble(state)}

Your role: ${ROLE_INSTRUCTIONS[role]}
This task: ${task}
Upstream context: ${JSON.stringify(upstream)}
Respond only via the required schema.`
}

// previous: this department's last version, when it is being rebuilt because work upstream changed.
function makerPrompt(state, spec, role, previous) {
  const rules = spec.rules ? spec.rules(state) : []
  const pending = (state.pending_notes && state.pending_notes[spec.key]) || []
  return `${preamble(state)}

Your role: ${ROLE_INSTRUCTIONS[role]}
${craftBlock(role)}

This task: ${spec.task(state)}
${spec.lane ? `Your lane: you decide ${spec.lane.decides}. Leave to later departments: ${spec.lane.leaves}. Detail that belongs to a later department is padding, not credit. Keep every field as short as its job allows; ${spec.lane.next} must be able to act on it without a follow-up question.` : ''}
${rules.length ? `Your work is checked in code and sent back if any of these fail:\n${rules.map(r => `- ${r}`).join('\n')}` : ''}
${pending.length ? `Notes from an earlier review that this version must address:\n${JSON.stringify(pending)}` : ''}
${previous ? `Work upstream of you has changed since your last version. Update it to the new upstream context: keep every choice that still holds, change what no longer fits. Your last version:\n${JSON.stringify(previous)}` : ''}
Upstream context: ${JSON.stringify(spec.upstream(state))}
Respond only via the required schema.`
}

const DEFAULT_BAR = `Anchors, used for every criterion: 10 best-in-class, approve unchanged; 9 approve unchanged; 8 a senior practitioner would send it to the client with only small notes (the minimum for A); 6–7 competent but generic, or has real gaps; 5 or below not usable.`

function criticPrompt(state, spec, role, content, previous) {
  return `${preamble(state)}

You are reviewing the ${spec.label} before anything reaches Lucas. Hold it to the standard of the most demanding senior ${roleTitle(role)} working today and of the studio's creative director.
${craftBlock(role)}
${QUALITY_BAR ? `THE STUDIO'S QUALITY BAR:\n<<<\n${QUALITY_BAR}\n>>>` : DEFAULT_BAR}

What this work had to build on: ${JSON.stringify(spec.upstream(state))}

THE WORK UNDER REVIEW (its assumptions and blockers are part of it):
${JSON.stringify(content)}
${previous && (previous.notes || []).length ? `\nThis is a revision. The previous review scored it ${Object.entries(previous.scores || {}).map(([k, v]) => `${k} ${v}`).join(', ')} and gave these notes:\n${JSON.stringify(previous.notes)}\nFirst check each note: was it addressed? Score the work as it stands now. Don't move the goalposts: raise a new note only for a problem at least as serious as the ones above, and credit what was fixed.\n` : ''}
${spec.lane ? `Judge it as a ${spec.label}, at its own stage. This department decides ${spec.lane.decides}; ${spec.lane.leaves} belong to later departments. Never mark it down for leaving those out, and never ask for them in notes. Detail that does a later department's job is scope creep: it costs craft, not specificity.\n` : ''}
Score each criterion 1–10 and quote the exact line that justifies the score:
- specificity: could ${spec.lane ? spec.lane.next : 'the next department'} act on it without a follow-up question? Concrete names, numbers, actions, objects and sounds score high; moods and adjectives score low.
- distinctiveness: could it be dropped into someone else's project unchanged? Work that could only belong to this idea scores high.
- fit: does it deliver Lucas's idea, the brief, the route in production, the verified facts and the must-haves, and avoid the must-avoids?
- craft: would a senior ${roleTitle(role)} sign it? Correct technique, timing, continuity, nothing physically implausible.
Default to below 8 unless the page proves otherwise; 8 is the minimum for A. Then give at most six notes, the changes that would move a score most first, each aimed at a specific part, saying exactly what to do within this department's lane, and citing the craft rule, taste note or brief line it comes from. List what must be kept.`
}

function revisePrompt(state, spec, role, prior, feedback, violations) {
  const scores = feedback.scores ? Object.entries(feedback.scores).map(([k, v]) => `${k} ${v}`).join(', ') : ''
  return `${makerPrompt(state, spec, role)}

${prior ? `YOUR PREVIOUS VERSION:\n${JSON.stringify(prior)}\n\n` : ''}${scores ? `The reviewer scored it: ${scores}. A needs 8 or more on every criterion.` : ''}
NOTES TO ADDRESS (apply each one; if one would break the brief, the facts or another note, keep your version and say why in assumptions):
${JSON.stringify(feedback.notes || [])}
${(feedback.keep || []).length ? `KEEP, don't lose these: ${JSON.stringify(feedback.keep)}` : ''}
${(violations || []).length ? `Also fix these failed checks: ${JSON.stringify(violations)}` : ''}
Return the full revised work.`
}

// Who fixes what: shared by integrity QC, the notes router and the package panel, so they route alike.
const OWNERS = "Owners: the script's words, a line's timing within its beat and the CTA → copywriter; the cast → casting_director; places and props → production_designer; a scene's performance and blocking → director; looks → stylist; sound cues and VO windows → sound_designer; each shot's framing, lens, height, movement, focus, light, action and length in frames → cinematographer; board notes, sound-cue placement, entry and exit states, continuity and generation risk → storyboard_artist; methods, prompts, references, acceptance checks and cost → generation_supervisor."

// ---- code checks: objective, cheap, and run before any reviewer sees the work ----

function words(s) {
  return String(s || '').split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length
}
function bannedHits(text) {
  return [...new Set((String(text || '').match(BANNED_RE) || []).map(w => w.toLowerCase()))]
}
const HEX_RE = /#[0-9a-f]{6}\b/i
const MM_RE = /\b\d+(\.\d+)?\s*mm\b/i
const FPS_OK = [24, 25, 30, 48, 50, 60]
const isNarrative = s => ['short_film', 'music_video', 'series_pilot'].includes(s.brief.format)
const isAdFormat = s => !s.brief.format || AD_FORMATS.includes(s.brief.format)
const videoDeliverables = s => (s.brief.deliverables || []).filter(d => d.type === 'video')
const stillCount = s => (s.brief.deliverables || []).filter(d => d.type === 'still').reduce((n, d) => n + (d.count || 1), 0)
const idSet = (arr, f) => new Set((arr || []).map(x => x && x[f]).filter(Boolean))
function dupes(arr, f) {
  const seen = new Set()
  const d = []
  ;(arr || []).forEach(x => { const v = x && x[f]; if (seen.has(v)) d.push(v); seen.add(v) })
  return d
}
const content = (state, key) => (state.artifacts[key] && state.artifacts[key].content) || {}
// What another agent needs to read a department's work: its content plus the assumptions and
// blockers it cites by ID (they live in the envelope, not the content).
function work(state, key) {
  const a = state.artifacts[key]
  if (!a) return {}
  return { ...(a.content || {}), assumptions: a.assumptions || [], blockers: a.blockers || [] }
}
// Compact ID tables for departments that only need to reference upstream work, not re-read it.
const castTable = state => (content(state, 'casting_bible').characters || []).map(c => ({ character_id: c.character_id, role_in_story: c.role_in_story, visual_identity_anchors: c.visual_identity_anchors }))
const lookTable = state => (content(state, 'style_bible').looks || []).map(l => ({ look_id: l.look_id, character_id: l.character_id, continuity_locks: l.continuity_locks }))
const worldTable = state => (content(state, 'world_bible').locations || []).map(l => ({ location_id: l.location_id, description: l.description, props: (l.props || []).map(p => ({ prop_id: p.prop_id, description: p.description, persistent_state_notes: p.persistent_state_notes })) }))
// Each board panel joined onto its camera-plan shot, in the camera plan's order; a panel for a
// shot the camera plan doesn't have is kept at the end (its check has already failed).
// Only the board's own fields join: the camera plan's values always win, so a board can never
// re-time or re-frame a shot behind QC's back.
const boardOnly = p => Object.fromEntries(BOARD_FIELDS.map(f => [f, p[f]]))
function mergePanels(state, panels) {
  const shots = content(state, 'camera_plan').shots || []
  const byId = {}
  panels.forEach(p => { if (p && p.shot_id && !byId[p.shot_id]) byId[p.shot_id] = p })
  const known = new Set(shots.map(sh => sh.shot_id))
  return shots.filter(sh => byId[sh.shot_id]).map(sh => ({ ...sh, ...boardOnly(byId[sh.shot_id]) }))
    .concat(panels.filter(p => p && !known.has(p.shot_id)).map(boardOnly))
}
// The storyboard as its own work: the board's fields per shot plus continuity, without the
// camera-plan fields its stored panels are joined with (those are the camera plan's).
function boardWork(state) {
  const a = state.artifacts.storyboard
  if (!a) return {}
  return {
    panels: (a.content.panels || []).map(p => Object.fromEntries(BOARD_FIELDS.map(f => [f, p[f]]))),
    contradictions_flagged: a.content.contradictions_flagged || [],
    tracked_elements: content(state, 'continuity_bible').tracked_elements || [],
    assumptions: a.assumptions || [],
    blockers: a.blockers || [],
  }
}
const asWork = r => ({ ...((r && r.content) || {}), assumptions: (r && r.assumptions) || [], blockers: (r && r.blockers) || [] })

function checkDevelopment(state, c) {
  const v = []
  const norm = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim()
  const idea = norm(state.idea)
  if (!FORMATS.includes(c.format)) v.push(`format must be one of ${FORMATS.join(', ')}`)
  if (words(c.logline) > 40) v.push(`the logline is ${words(c.logline)} words; keep it to 40 or fewer`)
  if (words(c.premise) < 80) v.push('the premise is too thin; develop it to at least 80 words')
  if ((c.what_makes_it_specific || []).length < 3) v.push('list at least three specific choices that make this idea not generic')
  ;(c.verified_product_facts || []).forEach(f => {
    const q = norm(f.quoted_from_idea)
    if (!q || !idea.includes(q)) v.push(`"${f.fact}" is listed as a verified fact but isn't quoted word for word from the idea; move it to assumptions`)
  })
  const del = c.deliverables || []
  if (dupes(del, 'id').length) v.push(`duplicate deliverable ids: ${dupes(del, 'id').join(', ')}`)
  const vids = del.filter(d => d.type === 'video')
  if (!vids.length) v.push('add at least one video deliverable: the build needs a timed sequence')
  vids.forEach(d => { if (!(d.duration_seconds >= 5 && d.duration_seconds <= MAX_BUILD_VIDEO_SECONDS)) v.push(`${d.id}: video length must be 5–${MAX_BUILD_VIDEO_SECONDS}s in this build`) })
  const total = vids.reduce((n, d) => n + (d.duration_seconds || 0), 0)
  if (total > MAX_BUILD_VIDEO_SECONDS) v.push(`total video across deliverables is ${total}s; this build holds at most ${MAX_BUILD_VIDEO_SECONDS}s (longer pieces go in an outline deliverable)`)
  if (['short_film', 'music_video', 'series_pilot'].includes(c.format) && !del.some(d => d.type === 'outline')) v.push('long-form formats need an outline deliverable covering the whole piece')
  del.filter(d => d.type === 'still').forEach(d => { if (!(d.count >= 1)) v.push(`${d.id}: stills need a count of at least 1`) })
  if ((c.questions_for_lucas || []).length > 5) v.push('ask Lucas at most five questions')
  return v
}

function checkStrategy(state, c) {
  const v = []
  if (words(c.single_minded_proposition) > 35) v.push(`the single-minded proposition is ${words(c.single_minded_proposition)} words; 35 at most`)
  if ((c.proof_points || []).length < 2) v.push('give at least two proof points')
  return v
}

function checkConcepts(state, c) {
  const v = []
  const routes = c.routes || []
  if (routes.length !== 3) v.push(`present exactly three routes (you have ${routes.length})`)
  if (dupes(routes, 'route_id').length) v.push('route ids must be unique')
  if (!routes.some(r => r.route_id === c.recommended_route_id)) v.push('recommended_route_id must be one of the routes')
  const hits = bannedHits(routes.map(r => `${r.central_idea} ${r.emotional_promise}`).join(' '))
  if (hits.length) v.push(`banned language in the routes: ${hits.join(', ')}`)
  return v
}

function checkWriting(state, c) {
  const v = []
  const sheet = (c.story && c.story.beat_sheet) || []
  if (!sheet.length) v.push('story.beat_sheet is empty')
  if (state.brief.format === 'series_pilot' && sheet.length < 12) v.push(`a pilot outline needs at least 12 scenes; the beat sheet has ${sheet.length}`)
  if (dupes(sheet, 'scene_id').length) v.push('scene ids in the beat sheet must be unique')
  const wpsTotal = isNarrative(state) ? 3 : 2.5
  videoDeliverables(state).forEach(d => {
    const sc = (c.deliverable_scripts || []).find(x => x.deliverable_id === d.id)
    if (!sc) { v.push(`no timed script for ${d.id}`); return }
    const beats = sc.beats || []
    const dur = d.duration_seconds
    if (!beats.length) { v.push(`${d.id}: no beats`); return }
    if (Math.abs(beats[0].start_s) > 0.01) v.push(`${d.id}: the first beat starts at ${beats[0].start_s}s, not 0s`)
    if (Math.abs(beats[beats.length - 1].end_s - dur) > 0.01) v.push(`${d.id}: the last beat ends at ${beats[beats.length - 1].end_s}s; ${d.id} is exactly ${dur}s`)
    beats.forEach((b, i) => {
      const len = b.end_s - b.start_s
      if (!(len > 0)) v.push(`${d.id} ${b.beat_id}: end_s must be after start_s`)
      if (i > 0 && Math.abs(b.start_s - beats[i - 1].end_s) > 0.01) v.push(`${d.id} ${b.beat_id}: starts at ${b.start_s}s but the previous beat ends at ${beats[i - 1].end_s}s`)
      if (len > 0 && words(b.vo) / len > 3.2) v.push(`${d.id} ${b.beat_id}: ${words(b.vo)} spoken words in ${len}s is too fast to perform`)
      if (words(b.on_screen_text) > 7) v.push(`${d.id} ${b.beat_id}: on-screen text is ${words(b.on_screen_text)} words (7 at most)`)
      if (words(b.picture) < 12) v.push(`${d.id} ${b.beat_id}: the picture needs to say what the camera sees, in at least 12 words`)
    })
    const spoken = beats.reduce((n, b) => n + words(b.vo), 0)
    if (spoken > Math.floor(wpsTotal * dur)) v.push(`${d.id}: ${spoken} spoken words won't fit in ${dur}s (at most ${Math.floor(wpsTotal * dur)})`)
    if (isAdFormat(state) && !String(sc.cta || '').trim()) v.push(`${d.id}: missing CTA`)
  })
  const need = stillCount(state)
  if ((c.stills_copy || []).length !== need) v.push(`stills_copy needs exactly ${need} entries, one per still`)
  const text = (c.deliverable_scripts || []).flatMap(sc => [sc.cta, ...(sc.beats || []).flatMap(b => [b.picture, b.vo, b.on_screen_text])])
    .concat((c.stills_copy || []).flatMap(x => [x.headline, x.subline])).join(' ')
  const hits = bannedHits(text)
  if (hits.length) v.push(`banned language: ${hits.join(', ')}`)
  return v
}

// Speaker prefixes that are not on-screen characters (an unseen announcer, text, effects).
const NOT_CAST = new Set(['VO', 'V', 'VOICEOVER', 'NARRATOR', 'ANNOUNCER', 'ANNCR', 'SUPER', 'SFX', 'MUSIC', 'CAPTION', 'TEXT', 'CARD'])

function checkCasting(state, c) {
  const v = []
  const chars = c.characters || []
  if (!chars.length) v.push('no characters defined')
  if (dupes(chars, 'character_id').length) v.push('character ids must be unique')
  chars.forEach(ch => {
    if ((ch.visual_identity_anchors || []).length < 3) v.push(`${ch.character_id}: give at least three visual identity anchors`)
    if (ch.fictional_talent !== true) v.push(`${ch.character_id}: the cast is fictional; set fictional_talent to true`)
  })
  // Everyone the script names by ID (beat sheet, dialogue prefixes) is cast under that ID.
  const ID = /^[A-Z][A-Z0-9_]{0,23}$/
  const sc = content(state, 'script')
  const named = new Set(((sc.story && sc.story.beat_sheet) || []).flatMap(x => x.characters || []).filter(x => ID.test(x)))
  ;(sc.deliverable_scripts || []).forEach(d => (d.beats || []).forEach(b => String(b.vo || '').split('\n').forEach(line => {
    const m = line.trim().match(/^([A-Z][A-Z0-9_]{0,23})(?: \([^)]*\))?:/)
    if (m) named.add(m[1])
  })))
  const castIds = idSet(chars, 'character_id')
  named.forEach(id => { if (!NOT_CAST.has(id) && !castIds.has(id)) v.push(`the script's character ${id} isn't cast; use the script's IDs exactly`) })
  return v
}

function checkWorld(state, c) {
  const v = []
  const locs = c.locations || []
  if (!locs.length) v.push('no locations defined')
  if (dupes(locs, 'location_id').length) v.push('location ids must be unique')
  const props = locs.flatMap(l => l.props || [])
  if (dupes(props, 'prop_id').length) v.push(`prop ids must be unique across locations: ${[...new Set(dupes(props, 'prop_id'))].join(', ')}`)
  locs.forEach(l => {
    const pal = l.palette || []
    if (pal.length < 3 || pal.some(p => !HEX_RE.test(p))) v.push(`${l.location_id}: palette needs at least three entries, each with a hex color like #7A5230`)
    if ((l.props || []).length < 2) v.push(`${l.location_id}: list at least two props with persistent states`)
  })
  return v
}

function checkTreatment(state, c) {
  const v = []
  const scenes = c.scenes || []
  if (!scenes.length) v.push('no scenes in the treatment')
  if (dupes(scenes, 'scene_id').length) v.push('scene ids must be unique')
  scenes.forEach(s => { if (!String(s.campaign_idea_link || '').trim()) v.push(`${s.scene_id}: say how the scene carries the idea`) })
  return v
}

function checkStyle(state, c) {
  const v = []
  const castIds = idSet(content(state, 'casting_bible').characters, 'character_id')
  const looks = c.looks || []
  if (dupes(looks, 'look_id').length) v.push('look ids must be unique')
  looks.forEach(l => {
    if (!castIds.has(l.character_id)) v.push(`${l.look_id}: character ${l.character_id} isn't in the casting bible`)
    if (!HEX_RE.test(l.materials_colors || '')) v.push(`${l.look_id}: give garment colors as hex values like #3B4A5C`)
    if ((l.continuity_locks || []).length < 2) v.push(`${l.look_id}: lock at least two continuity details`)
  })
  castIds.forEach(id => { if (!looks.some(l => l.character_id === id)) v.push(`character ${id} has no look`) })
  return v
}

function checkSound(state, c) {
  const v = []
  const cues = c.cues || []
  const delIds = new Set((state.brief.deliverables || []).map(d => d.id))
  videoDeliverables(state).forEach(d => { if (!cues.some(q => (q.deliverable_ids || []).includes(d.id))) v.push(`${d.id} has no sound cues`) })
  cues.forEach(q => {
    ;(q.deliverable_ids || []).forEach(id => { if (!delIds.has(id)) v.push(`${q.cue_id}: deliverable ${id} doesn't exist`) })
    if (!String(q.licensing_or_consent_requirement || '').trim()) v.push(`${q.cue_id}: state the licensing or consent requirement`)
    if (!/\d/.test(q.timing || '')) v.push(`${q.cue_id}: give the cue timing in seconds`)
  })
  return v
}

function checkShots(state, shots, label, needLens) {
  const v = []
  const castIds = idSet(content(state, 'casting_bible').characters, 'character_id')
  const lookIds = idSet(content(state, 'style_bible').looks, 'look_id')
  const locs = content(state, 'world_bible').locations || []
  const locIds = idSet(locs, 'location_id')
  const propIds = idSet(locs.flatMap(l => l.props || []), 'prop_id')
  if (!shots.length) v.push(`the ${label} has no shots`)
  if (dupes(shots, 'shot_id').length) v.push(`${label}: shot ids must be unique`)
  shots.forEach(sh => {
    const id = sh.shot_id
    ;(sh.character_ids || []).forEach(x => { if (!castIds.has(x)) v.push(`${id}: character ${x} isn't in the casting bible`) })
    ;(sh.look_ids || []).forEach(x => { if (!lookIds.has(x)) v.push(`${id}: look ${x} isn't in the style bible`) })
    if (!locIds.has(sh.location_id)) v.push(`${id}: location ${sh.location_id || '(none)'} isn't in the world bible`)
    ;(sh.prop_ids || []).forEach(x => { if (!propIds.has(x)) v.push(`${id}: prop ${x} isn't in the world bible`) })
    if (needLens && !MM_RE.test(sh.lens_intent || '')) v.push(`${id}: lens_intent needs a focal length in mm`)
  })
  videoDeliverables(state).forEach(d => {
    const mine = shots.filter(sh => (sh.deliverable_ids || []).includes(d.id))
    if (!mine.length) { v.push(`${label}: no shots for ${d.id}`); return }
    const fps = mine[0].fps
    if (!FPS_OK.includes(fps)) v.push(`${d.id}: fps must be one of ${FPS_OK.join(', ')}`)
    if (mine.some(sh => sh.fps !== fps)) v.push(`${d.id}: every shot in a deliverable uses the same fps`)
    const frames = mine.reduce((n, sh) => n + (sh.duration_frames || 0), 0)
    const want = Math.round(d.duration_seconds * fps)
    if (Math.abs(frames - want) > fps / 2) v.push(`${d.id}: shots add up to ${frames} frames; ${d.duration_seconds}s at ${fps}fps is ${want} (a shot used in two cut-downs at different lengths needs two entries)`)
  })
  return v.slice(0, 30)
}

function checkCamera(state, c) {
  return checkShots(state, c.shots || [], 'shot plan', true)
}

function checkStoryboard(state, c) {
  const v = []
  const shotIds = idSet(content(state, 'camera_plan').shots, 'shot_id')
  const panels = c.panels || []
  const twice = [...new Set(dupes(panels, 'shot_id'))]
  if (twice.length) v.push(`one panel per shot; these appear more than once: ${twice.join(', ')}`)
  panels.forEach(p => { if (!shotIds.has(p.shot_id)) v.push(`panel ${p.shot_id} isn't a shot in the camera plan; board the shot plan as it is and flag a missing shot in contradictions_flagged`) })
  const panelIds = idSet(panels, 'shot_id')
  const missing = [...shotIds].filter(id => !panelIds.has(id))
  if (missing.length) v.push(`every camera-plan shot needs a panel; missing: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}`)
  ;(c.tracked_elements || []).forEach(e => (e.states_by_shot || []).forEach(x => {
    if (!panelIds.has(x.shot_id)) v.push(`continuity ${e.element_id}: shot ${x.shot_id} isn't a panel`)
  }))
  if (!(c.tracked_elements || []).length) v.push('track at least the product and each character across shots')
  return v.slice(0, 30)
}

function checkGeneration(state, c) {
  const v = []
  const panels = content(state, 'storyboard').panels || []
  const panelIds = idSet(panels, 'shot_id')
  const jobs = c.jobs || []
  jobs.forEach(j => {
    if (!panelIds.has(j.shot_id)) v.push(`${j.job_id}: shot ${j.shot_id} isn't in the storyboard`)
    if (words(j.prompt) < 40) v.push(`${j.job_id}: the prompt is ${words(j.prompt)} words; a usable generation prompt needs at least 40`)
    if (!String(j.method || '').trim()) v.push(`${j.job_id}: name the method`)
    if (!(j.acceptance_checks || []).length) v.push(`${j.job_id}: give at least one acceptance check a reviewer can pass or fail`)
  })
  panels.forEach(p => { if (!jobs.some(j => j.shot_id === p.shot_id)) v.push(`storyboard shot ${p.shot_id} has no generation job`) })
  const hits = bannedHits(jobs.map(j => j.prompt).join(' '))
  if (hits.length) v.push(`banned language in prompts: ${hits.join(', ')}`)
  return v.slice(0, 30)
}

function qcPrompt(state) {
  return `${preamble(state)}

Your role: ${ROLE_INSTRUCTIONS.quality_control}
Audit this production package against the brief, product fidelity, department consistency, storyboard completeness, timing, and reference/rights readiness (per quality_checks.planning). No media has been generated yet, so mark every "media" category check as "not_inspected", never "pass". Package: ${JSON.stringify({
    strategy: work(state, 'strategy'),
    route_in_production: selectedRoute(state),
    script: work(state, 'script'),
    casting_bible: work(state, 'casting_bible'),
    world_bible: work(state, 'world_bible'),
    directors_treatment: work(state, 'directors_treatment'),
    style_bible: work(state, 'style_bible'),
    sound_plan: work(state, 'sound_plan'),
    camera_plan: work(state, 'camera_plan'),
    // The board's own fields and continuity; its camera fields are the camera plan's, above.
    storyboard: boardWork(state),
    generation_plan: work(state, 'generation_plan'),
  })}
Every issue must name the one responsible_agent who can fix it and cite evidence. ${OWNERS} The strategy or the route itself → strategist or creative_director, and rights, consent, budget and anything only a person can decide → producer; those go to Lucas as questions. Recommend "approve" only if there are no unresolved critical or major defects and every required planning check was actually inspected.`
}

// ---- agent calls: per-run budget guard (must never throw across parallel(), which swallows errors to null) ----

let agentCalls = 0
const budgetLeft = () => LIMITS.maxAgentCallsPerRun - agentCalls

function blockedResult(opts, issue, resolution) {
  return {
    status: 'blocked',
    based_on: [],
    content: (opts && opts.emptyContent) || {},
    asset_uri: null,
    assumptions: [],
    sources: [],
    blockers: [{ issue, responsible_agent: 'producer', resolution }],
  }
}

// Artifact-producing calls (those that pass emptyContent) always get an envelope back, even when
// the budget is spent or the agent fails; review calls get null when the agent fails. A call
// refused for budget is marked not_run, so it is never mistaken for finished work.
async function runAgent(state, role, prompt, opts) {
  const label = (opts && opts.label) || role
  if (agentCalls >= LIMITS.maxAgentCallsPerRun) {
    state.limit_reached = true
    return opts && opts.emptyContent
      ? { ...blockedResult(opts, `agent-call budget (${LIMITS.maxAgentCallsPerRun} per run) was reached before ${label} could run`, 'Resume this project (pass the returned project_state back as priorState) to continue with a fresh budget.'), not_run: true }
      : { not_run: true }
  }
  agentCalls += 1
  let r = null
  try {
    r = await agent(prompt, { label, phase: opts && opts.phase, schema: opts && opts.schema })
  } catch (e) {
    r = null
  }
  if (r) return r
  return opts && opts.emptyContent
    ? { ...blockedResult(opts, `${label} returned no result`, 'Resume this project to retry this department.'), failed: true }
    : null
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
  state.approval_log.push(approvedEntry(state, 'visual_lock', visualLock, [`${state.artifacts.reference_stills.artifact_id}@r${state.artifacts.reference_stills.revision}`]))

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
  state.approval_log.push(approvedEntry(state, 'final_cut', finalCut, [`${state.artifacts.edit_timeline.artifact_id}@r${state.artifacts.edit_timeline.revision}`]))

  if (!isPresent(state, 'final_delivery')) {
    const res = await runAgent(state, 'editor', rolePrompt(state, 'editor', 'Export only the approved timelines and stills, verify every final file against its deliverable spec, and assemble the delivery manifest.', { edit_timeline: state.artifacts.edit_timeline.content, final_review: state.artifacts.final_review.content }), { schema: envelopeSchema(DELIVERY_CONTENT), phase: 'Production', emptyContent: { manifest: [] } })
    state.artifacts.final_delivery = makeArtifact(state, 'final_delivery', 'editor', '15_delivery', [state.artifacts.edit_timeline.artifact_id, state.artifacts.final_review.artifact_id], res)
  }
  state.stage_reached = '15_delivery'
}

// ---- REVISE support ----

const GATE_COVERAGE = {
  concept: ['idea', 'development', 'brief', 'strategy', 'concepts'],
  production_plan: ['script', 'casting_bible', 'world_bible', 'directors_treatment', 'style_bible', 'sound_plan', 'camera_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports'],
  visual_lock: ['reference_stills'],
  final_cut: ['edit_timeline', 'final_review'],
}

function applyRevision(state, revision) {
  const kind = revision && revision.target_kind
  if (!kind) return
  markStale(state, kind)
  if (state.package_review) state.package_review.stale = true
  // The requested change goes to the department that rebuilds the target (continuity is the storyboard's).
  const noteKey = kind === 'continuity_bible' ? 'storyboard' : kind
  if (revision.note) state.pending_notes = { ...(state.pending_notes || {}), [noteKey]: [...((state.pending_notes || {})[noteKey] || []), { target: 'Lucas', note: revision.note, source: 'revision request' }] }
  const affected = new Set([kind, ...(DEPENDENTS[kind] || [])])
  const invalidatedGates = []
  Object.entries(GATE_COVERAGE).forEach(([gateId, kinds]) => {
    if (state.approvals[gateId] && kinds.some(k => affected.has(k))) {
      state.approvals[gateId] = { approved: false, note: 'invalidated by revision' }
      if (gateId === 'production_plan') state.production_plan_applied = false
      invalidatedGates.push(gateId)
    }
  })
  state.decision_log.push({
    stage: 'revision_request',
    note: revision.note,
    target_artifact_kind: kind,
    reason: revision.reason,
    affected_departments: REVISION_ROUTING[revision.routing_key] || [],
    estimated_cost_impact: revision.estimated_cost_impact || 'not estimated',
    required_reapprovals: invalidatedGates,
  })
}

// ---- department specs: what each department makes, from what, and how it's checked ----

const ids = (state, keys) => keys.map(k => state.artifacts[k] && state.artifacts[k].artifact_id).filter(Boolean)
const routeUpstream = state => ({
  route: selectedRoute(state),
  strategy: {
    single_minded_proposition: content(state, 'strategy').single_minded_proposition,
    audience_tension: content(state, 'strategy').audience_tension,
  },
  assumptions_cited_upstream: [
    ...((state.artifacts.development && state.artifacts.development.assumptions) || []),
    ...((state.artifacts.concepts && state.artifacts.concepts.assumptions) || []),
  ],
})

const SPECS = {
  development: {
    lane: { decides: 'the format, logline, premise and its ending, story seed, audience, objective, tone, deliverables and assumptions', leaves: 'strategy, the routes, and anything shot-level: lenses, camera positions, frame timings, casting looks, wardrobe, sound design', next: 'the strategist and the creative director' },
    dept: 'development_producer', role: () => 'development_producer', kind: 'development', stage: '01_development', phase: 'Development', label: 'developed brief',
    schema: DEVELOPMENT_CONTENT,
    empty: { working_title: '', logline: '', format: 'ad_spot', format_rationale: '', premise: '', what_makes_it_specific: [], brand: '', product_or_subject: '', objective: '', audience: '', key_message: '', tone: [], verified_product_facts: [], deliverables: [], must_include: [], must_avoid: [], story_seed: { protagonist: '', want: '', obstacle: '', turn: '', ending: '' }, questions_for_lucas: [] },
    task: () => `Develop Lucas's raw idea into a complete, buildable brief. Keep his idea recognizable; make it more specific and more surprising, never replace it. Choose the format that serves it best (${FORMATS.join(', ')}) unless the idea or its hints name one, and say why. Size the deliverables to the format. This build fully plans at most ${MAX_BUILD_VIDEO_SECONDS} seconds of video in total: an ad or social piece is planned whole; a longer piece (a short film, a full music video, a series pilot) gets an "outline" deliverable covering the whole piece plus its single strongest sequence as the video deliverable, and the complete piece is written later in an enhancement phase. Add stills where they'd help the work travel (key art, social frames). Only facts literally stated in the idea may be verified_product_facts, each with the exact words from the idea in quoted_from_idea; everything else is an assumption. Ask Lucas at most five questions, and don't wait on the answers: make a labeled assumption for each.`,
    rules: () => [
      `format is one of ${FORMATS.join(', ')}`,
      'logline of 40 words or fewer; premise of at least 80 words; at least three specific choices in what_makes_it_specific',
      'every verified fact is quoted word for word from the idea',
      `at least one video deliverable; each 5–${MAX_BUILD_VIDEO_SECONDS}s; ${MAX_BUILD_VIDEO_SECONDS}s of video in total at most`,
      'long-form formats include an outline deliverable; at most five questions for Lucas',
    ],
    upstream: state => ({ idea: state.idea, hints: state.idea_hints || {} }),
    basedOn: state => ids(state, ['idea']),
    check: checkDevelopment,
  },
  strategy: {
    lane: { decides: 'the audience tension, the single-minded proposition, proof points, success criteria, and what is fact versus hypothesis', leaves: 'the creative routes and any execution: scenes, shots, lines, casting', next: 'the creative director' },
    dept: 'strategist', role: () => 'strategist', kind: 'strategy', stage: '02_strategy', phase: 'Strategy', label: 'strategy',
    schema: STRATEGY_CONTENT,
    empty: { audience_tension: '', desired_behavior: '', product_relevance: '', single_minded_proposition: '', proof_points: [], success_criteria: [], supplied_facts: [], sourced_research: [], hypotheses: [] },
    task: state => isNarrative(state)
      ? 'Develop the strategic foundation. For a narrative piece the "product" is the piece itself: who it is for, the tension in their lives it speaks to, what it must make them feel or do, and the single-minded proposition every department serves.'
      : 'Develop the strategic foundation for this piece.',
    rules: () => ['single-minded proposition of 35 words or fewer', 'at least two proof points'],
    upstream: state => ({ brief: content(state, 'brief'), development: work(state, 'development') }),
    basedOn: state => ids(state, ['brief', 'development']),
    check: checkStrategy,
  },
  concepts: {
    lane: { decides: 'three routes: the central idea, emotional promise, product role, visual language, and an execution example told in beats with rough seconds', leaves: 'final copy, frame-accurate timing, lenses and camera maths, blocking, casting and wardrobe detail', next: 'the writer, casting and production design' },
    dept: 'creative_director', role: () => 'creative_director', kind: 'concept_options', stage: '03_concepts', phase: 'Concepts', label: 'three routes',
    schema: CONCEPTS_CONTENT,
    empty: { routes: [], recommended_route_id: '', recommendation_rationale: '' },
    task: () => 'Present three distinct routes and recommend one. The routes must differ on at least two of: tone, structure, point of view, and the role the product (or protagonist) plays. Size each execution example to the deliverables.',
    rules: () => ['exactly three routes with unique ids', 'recommended_route_id is one of them', `no banned language in central ideas or emotional promises (${BANNED_READABLE})`],
    upstream: state => ({ strategy: work(state, 'strategy'), development: work(state, 'development') }),
    basedOn: state => ids(state, ['strategy']),
    check: checkConcepts,
  },
  script: {
    lane: { decides: 'the beats of the story and the timed script: what the camera sees, what we hear, the spoken lines, on-screen text and CTA', leaves: 'lenses, camera moves and lighting, casting looks, wardrobe, set dressing', next: 'the director, casting, production design and sound' },
    dept: 'copywriter', role: state => (isNarrative(state) ? 'screenwriter' : 'copywriter'), kind: 'script', stage: '04_script_cast_world', phase: 'Script, Cast & World', label: 'script',
    schema: WRITING_CONTENT,
    empty: { story: { logline: '', beat_sheet: [] }, deliverable_scripts: [], stills_copy: [], decisions: [] },
    task: state => isNarrative(state)
      ? 'Write the beat sheet for the whole piece (every scene: heading, who is in it, what happens, what turns), then a timed script for each video deliverable, which is the sequence this build plans in full. Every beat says what the camera sees and what we hear. Put dialogue and VO in vo, each line prefixed with the speaking character ID. Write copy for every still (key art or frames).'
      : 'Write the story of the spot as a short beat sheet, then a timed script for every video deliverable: hook, beats (picture, sound, VO, on-screen text) and CTA. Every beat says what the camera sees and what we hear. Write on-image copy for every still.',
    rules: state => [
      'for every video deliverable: beats run back to back from exactly 0s to its exact length',
      `spoken words fit the time: at most ${isNarrative(state) ? 3 : 2.5} per second overall, never faster than 3.2 in a beat`,
      'on-screen text 7 words or fewer per beat; approved end-frame text that is longer keeps its words and splits at a phrase break across consecutive end beats (each at least 1.5 s, same picture); every picture at least 12 words of what the camera sees',
      "on-screen characters are named by an ID in capitals (the character's name, e.g. ROSA) in the beat sheet and as the prefix of every line they speak; casting and every later department use these IDs. An unseen announcer or narrator is written 'VO:' and is not a character",
      isAdFormat(state) ? 'every video deliverable has a CTA' : 'no CTA is needed for this format; leave cta empty unless the piece has one',
      `stills_copy has exactly ${stillCount(state)} entries`,
      state.brief.format === 'series_pilot' ? 'the pilot beat sheet has at least 12 scenes' : 'the beat sheet is not empty',
      `no banned language (${BANNED_READABLE})`,
    ],
    upstream: routeUpstream,
    basedOn: state => ids(state, ['concepts']),
    check: checkWriting,
  },
  casting_bible: {
    lane: { decides: 'who each character is on screen: presence, performance, identity anchors', leaves: 'wardrobe and grooming detail (the stylist) and framing (the cinematographer)', next: 'the stylist, the director and the cinematographer' },
    dept: 'casting_director', role: () => 'casting_director', kind: 'casting_bible', stage: '04_script_cast_world', phase: 'Script, Cast & World', label: 'casting bible',
    schema: CASTING_CONTENT,
    empty: { characters: [] },
    task: () => "Cast every character in the script. Use the script's character IDs exactly as written (in the beat sheet and the dialogue prefixes) so every department means the same person; add no one the script doesn't have.",
    rules: () => ['unique character ids, matching the ids the script uses', 'at least three visual identity anchors per character', 'fictional_talent is true for everyone'],
    upstream: state => ({ ...routeUpstream(state), script: content(state, 'script') }),
    basedOn: state => ids(state, ['concepts', 'script']),
    check: checkCasting,
  },
  world_bible: {
    lane: { decides: 'locations, layout, props and their persistent states, palettes and product placement', leaves: 'camera positions, lenses and lighting setups', next: 'the director, stylist, cinematographer and storyboard' },
    dept: 'production_designer', role: () => 'production_designer', kind: 'world_bible', stage: '04_script_cast_world', phase: 'Script, Cast & World', label: 'world bible',
    schema: WORLD_CONTENT,
    empty: { locations: [] },
    task: () => "Break the script down into every location and prop it needs, with persistent IDs, spatial layout, palettes as hex colors, and the prop states that must match between shots. Every scene heading in the script has a location; every object a beat names has a prop.",
    rules: () => ['unique location ids and prop ids (across all locations)', 'each palette has at least three entries, each with a hex color', 'at least two props per location'],
    upstream: state => ({ ...routeUpstream(state), script: content(state, 'script') }),
    basedOn: state => ids(state, ['concepts', 'script']),
    check: checkWorld,
  },
  directors_treatment: {
    lane: { decides: 'performance, blocking, action progression, emotional shifts and transitions, scene by scene', leaves: 'lens choices and lighting setups (the cinematographer), wardrobe (the stylist)', next: 'the cinematographer and storyboard' },
    dept: 'director', role: () => 'director', kind: 'directors_treatment', stage: '05_direction_style_sound', phase: 'Direction, Style & Sound', label: "director's treatment",
    schema: TREATMENT_CONTENT,
    empty: { scenes: [] },
    task: () => 'Turn the script, cast and world into a directing treatment, scene by scene.',
    rules: () => ['unique scene ids', 'every scene says how it carries the idea'],
    upstream: state => ({ route: selectedRoute(state), script: content(state, 'script'), casting_bible: content(state, 'casting_bible'), world_bible: content(state, 'world_bible') }),
    basedOn: state => ids(state, ['script', 'casting_bible', 'world_bible']),
    check: checkTreatment,
  },
  style_bible: {
    lane: { decides: 'the look for each character: silhouette, materials and colors, fit, accessories, hair and makeup, continuity locks', leaves: 'camera and lighting', next: 'the cinematographer, storyboard and generation' },
    dept: 'stylist', role: () => 'stylist', kind: 'style_bible', stage: '05_direction_style_sound', phase: 'Direction, Style & Sound', label: 'style bible',
    schema: STYLE_CONTENT,
    empty: { looks: [] },
    task: () => 'Build a look for every character in the casting bible, using their IDs.',
    rules: () => ['every look uses a character id from the casting bible, and every character has a look', 'garment colors given as hex values', 'at least two continuity locks per look'],
    upstream: state => ({ route: selectedRoute(state), script: content(state, 'script'), casting_bible: content(state, 'casting_bible'), world_bible: content(state, 'world_bible') }),
    basedOn: state => ids(state, ['script', 'casting_bible', 'world_bible']),
    check: checkStyle,
  },
  sound_plan: {
    lane: { decides: 'music, effects, atmosphere, dialogue and VO cues with timing and rights needs', leaves: 'the final mix and delivery specs', next: 'the storyboard and the editor' },
    dept: 'sound_designer', role: () => 'sound_designer', kind: 'sound_plan', stage: '05_direction_style_sound', phase: 'Direction, Style & Sound', label: 'sound plan',
    schema: SOUND_PLAN_CONTENT,
    empty: { cues: [] },
    task: () => 'Plan music, sound effects, atmosphere, dialogue and VO against the script, with cue timing in seconds for each deliverable.',
    rules: () => ['every video deliverable has cues', 'cue deliverable ids exist', 'timing in seconds and a licensing or consent requirement on every cue', "the script's lines are quoted exactly and placed inside their beats (they already fit the script's speaking-rate check); flag the copywriter only if one can't fit"],
    upstream: state => ({ route: selectedRoute(state), script: content(state, 'script') }),
    basedOn: state => ids(state, ['script']),
    check: checkSound,
  },
  camera_plan: {
    lane: { decides: 'every shot: framing, lens, height, movement, focus, light, action, performance, and its length in frames', leaves: 'sound, on-screen text and continuity states (the storyboard) and generation prompts, references and model settings (the generation supervisor)', next: 'the storyboard and generation' },
    dept: 'cinematographer', role: () => 'cinematographer', kind: 'camera_plan', stage: '06_camera', phase: 'Camera', label: 'shot plan',
    schema: CAMERA_PLAN_CONTENT,
    empty: { shots: [] },
    task: () => "Build the shot plan for every video deliverable, plus one shot entry per still frame (duration_frames 0). You own what the camera does in each shot: framing, lens, height, movement, focus, light, action and performance, in order within each deliverable. Use only the character, look, location and prop IDs that exist upstream. Prompts for a generator are the generation supervisor's job; if a shot's action or lens behavior is one a generator may not manage (fine hand work, legible text, a rack focus), say so in its purpose.",
    rules: () => [
      'unique shot ids; every character, look, location and prop id exists upstream',
      'lens_intent gives a focal length in mm',
      `one fps per deliverable, from ${FPS_OK.join(', ')}; each deliverable's shots add up to its exact length in frames (a shot used in two cut-downs at different lengths needs two entries)`,
    ],
    upstream: state => ({ route: selectedRoute(state), script: content(state, 'script'), directors_treatment: content(state, 'directors_treatment'), casting_bible: content(state, 'casting_bible'), style_bible: content(state, 'style_bible'), world_bible: content(state, 'world_bible'), shot_fields: CAMERA_SHOT_FIELDS }),
    basedOn: state => ids(state, ['directors_treatment', 'style_bible', 'world_bible', 'casting_bible', 'script']),
    check: checkCamera,
  },
  storyboard: {
    lane: { decides: "what each shot's panel adds: the exact dialogue or VO, on-screen text, sound cues, entry and exit states, generation risk, and the continuity of every tracked element", leaves: 'framing, lens, timing, action and performance (the camera plan): flag disagreements instead of changing them', next: 'the generation supervisor' },
    dept: 'storyboard_artist', role: () => 'storyboard_artist', kind: 'storyboard', stage: '07_storyboard', phase: 'Storyboard', label: 'storyboard and continuity bible',
    schema: STORYBOARD_AND_CONTINUITY_CONTENT,
    empty: { panels: [], contradictions_flagged: [], tracked_elements: [] },
    task: () => "Board the camera plan: one panel per shot, keyed by its shot_id, in the camera plan's order. The camera plan already fixes each shot's framing, lens, timing, action and performance, and the board is joined to it by shot_id, so don't repeat those. Each panel adds: board_note (what the frame reads as at phone size, and how it cuts into the next panel), dialogue_or_voiceover (the script's exact line with its speaker ID, or empty), on_screen_text (the script's exact card, or empty), sound_cues (cue IDs from the sound plan), entry_state and exit_state (each character, the product and each state-changing prop, written out in full), and generation_risk (low, medium or high, with what a generator could get wrong in this shot). Then track the state of every persistent element across panels. Never re-time or re-frame a shot: put any disagreement with the camera plan, script or sound plan in contradictions_flagged.",
    rules: () => ['exactly one panel per camera-plan shot, keyed by its shot_id', 'continuity states only reference existing panels; track at least the product and each character'],
    upstream: state => ({ route: selectedRoute(state), script: content(state, 'script'), camera_plan: content(state, 'camera_plan'), sound_plan: content(state, 'sound_plan'), cast: castTable(state), looks: lookTable(state), world: worldTable(state) }),
    basedOn: state => ids(state, ['script', 'casting_bible', 'style_bible', 'world_bible', 'camera_plan', 'sound_plan']),
    check: checkStoryboard,
    // The storyboard artifact holds each panel joined onto its camera-plan shot, so everything
    // downstream reads one complete panel; the agent only ever sees and writes the board's fields.
    split: (c, state) => ({
      storyboard: { panels: mergePanels(state, c.panels || []), contradictions_flagged: c.contradictions_flagged || [] },
      continuity_bible: { tracked_elements: c.tracked_elements || [] },
    }),
    unsplit: state => ({
      panels: (content(state, 'storyboard').panels || []).map(p => Object.fromEntries(BOARD_FIELDS.map(f => [f, p[f]]))),
      contradictions_flagged: content(state, 'storyboard').contradictions_flagged || [],
      tracked_elements: content(state, 'continuity_bible').tracked_elements || [],
    }),
  },
  generation_plan: {
    lane: { decides: 'a job per shot: prompts, references, capability checks and cost', leaves: 'any change to the approved shots: flag it instead', next: 'Lucas, who approves any paid generation' },
    dept: 'generation_supervisor', role: () => 'generation_supervisor', kind: 'generation_plan', stage: '08_generation_plan', phase: 'Generation Plan', label: 'generation plan',
    schema: GENERATION_PLAN_CONTENT,
    empty: { jobs: [], missing_capabilities: [] },
    task: () => "For every storyboard panel, write the jobs that would make it: the method (for example a text-to-image still, image-to-video from an approved still, a practical insert or a composite), a model-ready prompt that describes the visible result, the reference images it needs (cast, look, location, product and state references), acceptance checks a reviewer can pass or fail on the generated file, capability notes against a cautious profile (no assumed negative prompts, seeds, multi-reference, exact lenses or arbitrary durations), and a cost estimate. Reference kit jobs (character, product, location) attach to the first shot that uses them. Generated picture carries no speech: every video prompt ends on the scene's ambient sound only, with lips closed wherever a face is in frame; lines are added later by an approved lip-sync pass or staged off-mouth. Do not generate media.",
    rules: () => ['every storyboard shot has at least one job, and every job points at a storyboard shot', 'every job has a method and at least one acceptance check', 'every prompt at least 40 words', `no banned language in prompts (${BANNED_READABLE})`],
    upstream: state => ({ route: selectedRoute(state), storyboard: content(state, 'storyboard'), casting_bible: content(state, 'casting_bible'), style_bible: content(state, 'style_bible'), world_bible: content(state, 'world_bible') }),
    basedOn: state => ids(state, ['storyboard']),
    check: checkGeneration,
  },
}

const BUILD_ORDER = ['script', 'casting_bible', 'world_bible', 'directors_treatment', 'style_bible', 'sound_plan', 'camera_plan', 'storyboard', 'generation_plan']
const KEY_BY_DEPT = {
  copywriter: 'script', casting_director: 'casting_bible', production_designer: 'world_bible', director: 'directors_treatment',
  stylist: 'style_bible', sound_designer: 'sound_plan', cinematographer: 'camera_plan', storyboard_artist: 'storyboard',
  generation_supervisor: 'generation_plan', strategist: 'strategy', creative_director: 'concepts',
}

// A script revision that changes only words (lines, cards, sound notes, CTA, still copy) leaves
// the story's structure, cast, places and pictures as they were: only the departments that
// carry the words are rebuilt. Anything structural rebuilds everything built on the script.
const SCRIPT_WORD_DEPENDENTS = ['sound_plan', 'storyboard', 'continuity_bible', 'generation_plan', 'quality_reports', 'package_review']
function scriptStructure(c) {
  const speakers = new Set()
  ;(c.deliverable_scripts || []).forEach(d => (d.beats || []).forEach(b => String(b.vo || '').split('\n').forEach(line => {
    const m = line.trim().match(/^([A-Z][A-Z0-9_]{0,23})(?: \([^)]*\))?:/)
    if (m) speakers.add(m[1])
  })))
  return JSON.stringify({
    sheet: ((c.story && c.story.beat_sheet) || []).map(x => [x.scene_id, x.heading, x.characters, x.what_happens, x.turn]),
    beats: (c.deliverable_scripts || []).map(d => [d.deliverable_id, d.duration_s, (d.beats || []).map(b => [b.beat_id, b.start_s, b.end_s, b.picture])]),
    stills: (c.stills_copy || []).map(x => [x.still_id, x.picture]),
    speakers: [...speakers].sort(),
  })
}
function scriptDependents(before, after) {
  return scriptStructure(before || {}) === scriptStructure(after || {}) ? SCRIPT_WORD_DEPENDENTS : (DEPENDENTS.script || [])
}

// ---- the quality loop: make → code checks → review → revise, until A or out of rounds ----

// The prior version's content, rejoined for departments whose output is split into two artifacts.
function priorContent(state, key, spec) {
  const prior = state.artifacts[key]
  if (!prior) return null
  if (!spec.unsplit) return work(state, key)
  return { ...spec.unsplit(state), assumptions: prior.assumptions || [], blockers: prior.blockers || [] }
}

async function produce(state, key, opts) {
  const spec = { key, ...SPECS[key] }
  const role = spec.role(state)
  const ph = (opts && opts.phase) || spec.phase
  const prior = state.artifacts[key]
  const previous = priorContent(state, key, spec)
  const schema = envelopeSchema(spec.schema)
  const attempts = []
  let violations = (prior && prior.checks && prior.checks.failed) || []
  let refused = false
  let madeNew = false

  // One make: the agent's work, re-run up to twice while code checks fail. Out of budget, it
  // returns the last real attempt (or null if there was none).
  // retryBase: the prompt a check-fix retry builds on. It leaves out the previous version,
  // which the failed attempt already supersedes, so a retry never carries two copies of the work.
  async function make(firstPrompt, label, retryBase) {
    let prompt = firstPrompt
    let last = null
    for (let i = 0; i <= 2; i++) {
      const r = await runAgent(state, spec.dept, prompt, { schema, phase: ph, label: i ? `${label} · fix checks ${i}` : label, emptyContent: spec.empty })
      if (r.not_run) { refused = true; return last }
      if (r.failed && last && !last.failed) return last
      last = r
      madeNew = true
      // An agent that says it can't do the work without an answer isn't retried against the
      // checks; the blocker goes to Lucas. A call that failed outright is retried as it was.
      if (r.status === 'blocked' && !r.failed) { violations = []; return r }
      if (r.failed) { if (i === 2) return r; prompt = firstPrompt; continue }
      const v = spec.check ? spec.check(state, r.content || {}) : []
      attempts.push(v.length)
      violations = v
      if (!v.length || i === 2) return r
      prompt = `${retryBase || firstPrompt}\n\nYour last attempt failed these checks:\n${v.map(x => `- ${x}`).join('\n')}\n\nLast attempt: ${JSON.stringify(r.content)}\n\nFix every failed check and keep everything that already works.`
    }
    return last
  }

  // Ways in: notes on current work; a review a previous run ran out of budget in the middle of
  // (pick up exactly where it stopped); or a fresh build, given the last version if upstream
  // changed under it.
  const pq = prior && prior.status !== 'stale' && prior.quality && prior.quality.incomplete ? prior.quality : null
  // Notes waiting from an earlier run reach the agent through makerPrompt (pending_notes).
  const hasPending = !!(state.pending_notes && (state.pending_notes[key] || []).length)
  const byNotes = prior && prior.status !== 'stale' && ((opts && opts.notes) || hasPending)
  let res
  if (byNotes) {
    const fb = { notes: (opts && opts.notes) || [] }
    res = await make(revisePrompt(state, spec, role, previous, fb, []), `${spec.dept} · revise from notes`, revisePrompt(state, spec, role, null, fb, []))
  } else if (pq && pq.pending === 'review') {
    const joined = spec.unsplit ? spec.unsplit(state) : prior.content
    res = { status: prior.status === 'review_required' ? 'draft' : prior.status, based_on: prior.based_on, content: joined, asset_uri: prior.asset_uri, assumptions: prior.assumptions, sources: prior.sources, blockers: prior.blockers }
  } else if (pq) {
    const fb = { scores: pq.scores, notes: pq.notes, keep: pq.keep }
    res = await make(revisePrompt(state, spec, role, previous, fb, violations), `${spec.dept} · resume revision`, revisePrompt(state, spec, role, null, fb, violations))
  } else {
    const rebuildFrom = prior && prior.status === 'stale' && !prior.superseded_route ? previous : null
    res = await make(makerPrompt(state, spec, role, rebuildFrom), spec.dept, rebuildFrom ? makerPrompt(state, spec, role, null) : null)
  }
  // Nothing was made (out of budget), or the call failed outright while current work exists:
  // leave the department as it was. Its notes stay pending and are applied on the next build.
  if (!res || (res.failed && prior && prior.status !== 'stale')) return prior || null

  let quality = pq && !byNotes ? { ...pq } : null
  // Blocked work (the agent couldn't do it, or failed) goes to Lucas as blocked, not to a reviewer.
  if (state.settings.quality && res.status !== 'blocked') {
    const history = quality ? quality.history.slice() : []
    let pending = 'review'
    for (let round = (quality ? quality.rounds : 0) + 1; round <= LIMITS.maxQualityRounds; round++) {
      const last = history.length ? { scores: history[history.length - 1].scores, notes: quality && quality.notes } : null
      const crit = await runAgent(state, 'quality_control', criticPrompt(state, spec, role, asWork(res), last), { schema: CRITIQUE_SCHEMA, phase: ph, label: `${spec.dept} · review ${round}` })
      if (crit && crit.not_run) { refused = true; break }
      if (!crit || !crit.specificity) { pending = null; break }
      const scores = { specificity: crit.specificity.score, distinctiveness: crit.distinctiveness.score, fit: crit.fit.score, craft: crit.craft.score }
      const min = Math.min(...Object.values(scores))
      history.push({ round, scores, min, failed_checks: violations.length })
      quality = {
        grade: min >= A_MIN && !violations.length ? 'A' : 'below_A',
        scores, min, rounds: round, history,
        evidence: { specificity: crit.specificity.evidence, distinctiveness: crit.distinctiveness.evidence, fit: crit.fit.evidence, craft: crit.craft.evidence },
        notes: crit.notes, keep: crit.keep,
      }
      pending = null
      if (quality.grade === 'A' || round === LIMITS.maxQualityRounds) break
      pending = 'revise'
      const fb = { scores, notes: crit.notes, keep: crit.keep }
      const next = await make(revisePrompt(state, spec, role, asWork(res), fb, violations), `${spec.dept} · revise ${round}`, revisePrompt(state, spec, role, null, fb, violations))
      // A revision that failed outright keeps the last good version and its review.
      if (!next || next.failed) break
      res = next
      pending = 'review'
      if (refused) break
    }
    // Out of budget mid-review: record exactly what's left so the next run picks it up.
    if (refused && pending) quality = { ...(quality || { grade: 'not_reviewed', scores: null, min: null, rounds: 0, history: [], notes: [], keep: [] }), history, incomplete: true, pending }
    else if (quality) delete quality.incomplete
  }

  const parts = spec.split ? spec.split(res.content || {}, state) : { [key]: res.content }
  Object.entries(parts).forEach(([k, c]) => {
    const was = state.artifacts[k]
    // A resumed review that changed nothing only updates the grade on the same version.
    if (!madeNew && was) {
      state.artifacts[k] = { ...was, checks: { failed: violations, attempts: (was.checks && was.checks.attempts) || [] }, ...(quality ? { quality } : {}) }
      return
    }
    const art = makeArtifact(state, (was && was.kind) || (k === key ? spec.kind : k), spec.dept, spec.stage, spec.basedOn(state), { ...res, content: c })
    art.revision = was ? was.revision + 1 : 1
    art.checks = { failed: violations, attempts }
    if (quality) art.quality = quality
    state.artifacts[k] = art
    // A fresh revision of current work invalidates what was built on it; regenerating stale
    // work doesn't need to, because its dependents were already marked stale.
    if (was && was.status !== 'stale') {
      const deps = k === 'script' ? scriptDependents(was.content, c) : (DEPENDENTS[k] || [])
      deps.forEach(dep => {
        if (state.artifacts[dep] && !parts[dep]) state.artifacts[dep] = { ...state.artifacts[dep], status: 'stale' }
      })
      if (state.package_review) state.package_review.stale = true
    }
  })
  if (state.pending_notes && state.pending_notes[key]) delete state.pending_notes[key]
  state.decision_log.push({
    stage: spec.stage,
    summary: `${spec.label}: ${quality ? (quality.incomplete ? `review paused for budget (next: ${quality.pending})` : `graded ${quality.grade} (lowest ${quality.min}/10) after ${quality.rounds} review round${quality.rounds === 1 ? '' : 's'}`) : 'drafted'}${violations.length ? `; ${violations.length} check(s) still failing` : ''}`,
    artifact_id: state.artifacts[key].artifact_id,
  })
  return state.artifacts[key]
}

const anyStale = (state, keys) => (keys || Object.keys(state.artifacts)).some(k => state.artifacts[k] && state.artifacts[k].status === 'stale')
const BUILT = BUILD_ORDER.concat(['continuity_bible'])
const packageNeedsWork = state => anyStale(state, BUILT) || BUILD_ORDER.some(k => hasPendingNotes(state, k))
const unfinishedReview = (state, k) => !!(state.artifacts[k] && state.artifacts[k].quality && state.artifacts[k].quality.incomplete)
const hasPendingNotes = (state, k) => !!(state.pending_notes && (state.pending_notes[k] || []).length)
// Blocked work is retried on the next run: it was missing something (an answer from Lucas, or
// an agent that failed), and the next run may have it.
const needsWork = (state, k) => !isPresent(state, k) || state.artifacts[k].status === 'blocked' || hasPendingNotes(state, k) || (state.settings.quality && unfinishedReview(state, k))

async function runGroup(state, keys, phaseName) {
  const todo = keys.filter(k => needsWork(state, k) || (k === 'storyboard' && !isPresent(state, 'continuity_bible')))
  if (!todo.length) return
  phase(phaseName)
  for (let i = 0; i < todo.length && !state.limit_reached; i += LIMITS.maxParallelTasks) {
    await parallel(todo.slice(i, i + LIMITS.maxParallelTasks).map(k => () => produce(state, k)))
  }
}

// Idempotent: builds whatever in 04–08 is missing or stale, and nothing else.
async function buildDepartments(state) {
  await runGroup(state, ['script'], 'Script, Cast & World')
  if (state.limit_reached) return
  await runGroup(state, ['casting_bible', 'world_bible'], 'Script, Cast & World')
  state.stage_reached = '04_script_cast_world'
  if (state.limit_reached) return
  const needsSound = videoDeliverables(state).length > 0
  if (!needsSound && !isPresent(state, 'sound_plan')) {
    state.artifacts.sound_plan = makeArtifact(state, 'sound_plan', 'sound_designer', '05_direction_style_sound', [], { status: 'draft', based_on: [], content: { cues: [] }, asset_uri: null, assumptions: ['Sound design skipped: not applicable, the brief has no video or audio deliverables.'], sources: [], blockers: [] })
    state.decision_log.push({ stage: '05_direction_style_sound', summary: 'sound_designer skipped: not applicable (no video/audio deliverables)', not_applicable: true })
  }
  await runGroup(state, ['directors_treatment', 'style_bible', 'sound_plan'], 'Direction, Style & Sound')
  state.stage_reached = '05_direction_style_sound'
  if (state.limit_reached) return
  await runGroup(state, ['camera_plan'], 'Camera')
  state.stage_reached = '06_camera'
  if (state.limit_reached) return
  await runGroup(state, ['storyboard'], 'Storyboard')
  state.stage_reached = '07_storyboard'
  if (state.limit_reached) return
  await runGroup(state, ['generation_plan'], 'Generation Plan')
  state.stage_reached = '08_generation_plan'
}

// Revises departments in build order. A department whose upstream was revised in the same pass
// is not revised against stale input: its notes wait in pending_notes and are applied when it
// is regenerated.
// Revises departments in build order. Notes that can't be applied now (an upstream department
// was just revised, the department is stale, or the budget ran out) wait in pending_notes and
// are applied when the department is next built; none are dropped.
async function reviseInOrder(state, notesByKey, phaseName) {
  const revised = []
  const keep = (key, notes) => { state.pending_notes = { ...(state.pending_notes || {}), [key]: [...((state.pending_notes || {})[key] || []), ...notes] } }
  let stopped = false
  for (const key of BUILD_ORDER) {
    const notes = notesByKey[key]
    if (!notes || !notes.length) continue
    const upstreamRevised = revised.some(up => (DEPENDENTS[up] || []).includes(key))
    if (stopped || upstreamRevised || !isPresent(state, key)) { keep(key, notes); continue }
    const before = state.artifacts[key].artifact_id
    await produce(state, key, { notes, phase: phaseName })
    if (state.artifacts[key].artifact_id === before) {
      // Out of budget before the revision was made.
      keep(key, notes)
      stopped = true
      continue
    }
    revised.push(key)
    if (state.limit_reached) stopped = true
  }
  return revised
}

// Lucas's open questions, kept by source; state.open_questions is the union he sees. QC and
// panel questions accumulate until Lucas answers (NOTES) or the route changes, since revising
// departments never answers a direction question; the others are replaced when re-evaluated.
const addQuestions = (state, source, list) => setQuestions(state, source, [...((state.questions || {})[source] || []), ...list])
function setQuestions(state, source, list) {
  state.questions = { ...(state.questions || {}), [source]: [...new Set(list)] }
  const all = []
  Object.values(state.questions).forEach(l => l.forEach(q => { if (!all.includes(q)) all.push(q) }))
  state.open_questions = all
}

// ---- stage 09: integrity QC (facts, continuity, rights), routed back through the quality loop ----

// Always ends on a QC report of the current package (never on an unchecked revision), so the
// report Lucas sees describes the versions he is approving. Returns the departments it revised.
async function preproductionReview(state) {
  const revisedAll = []
  if (isPresent(state, 'quality_reports') && state.artifacts.quality_reports.content.recommendation === 'approve') return revisedAll
  for (let round = 1; !state.limit_reached; round++) {
    if (packageNeedsWork(state)) {
      await buildDepartments(state)
      if (state.limit_reached) break
    }
    phase('Pre-production Review')
    const res = await runAgent(state, 'quality_control', qcPrompt(state), { schema: envelopeSchema(QUALITY_REPORT_CONTENT), phase: 'Pre-production Review', label: `integrity QC ${round}`, emptyContent: { checks: [], issues: [], recommendation: 'revise' } })
    if (res.not_run) break
    state.artifacts.quality_reports = makeArtifact(state, 'quality_reports', 'quality_control', '09_preproduction_review', planningArtifactIds(state), res)
    const critical = (res.content.issues || []).filter(i => i.severity === 'critical')
    // Direction and production decisions QC raises are Lucas's; this report replaces the last one's.
    addQuestions(state, 'qc', critical.filter(i => !KEY_BY_DEPT[i.responsible_agent] || ['strategy', 'concepts'].includes(KEY_BY_DEPT[i.responsible_agent]))
      .map(i => i.responsible_agent === 'producer' ? `Rights or production decision needed: ${i.evidence}` : `QC flagged a direction issue (${i.responsible_agent}): ${i.evidence}`))
    if (!critical.length) break
    if (round > LIMITS.maxRevisionRoundsPerStage) {
      state.decision_log.push({ stage: '09_preproduction_review', summary: `${critical.length} critical issue(s) still open after ${LIMITS.maxRevisionRoundsPerStage} integrity revision rounds; they are listed for Lucas in the QC report.`, unresolved: true })
      break
    }
    const notesByKey = {}
    critical.forEach(i => {
      const key = KEY_BY_DEPT[i.responsible_agent]
      // Direction was approved (or is Lucas's to approve) and production decisions are his: those
      // went to him as questions above; QC doesn't overrule them.
      if (key === 'strategy' || key === 'concepts' || !key) return
      ;(notesByKey[key] = notesByKey[key] || []).push({ target: i.shot_or_timecode, note: i.evidence, source: `integrity QC, ${i.severity}` })
    })
    if (!Object.keys(notesByKey).length) break
    const revised = await reviseInOrder(state, notesByKey, 'Pre-production Review')
    revised.forEach(k => { if (!revisedAll.includes(k)) revisedAll.push(k) })
    state.decision_log.push({ stage: '09_preproduction_review', summary: `Integrity round ${round}: ${critical.length} critical issue(s) routed to ${Object.keys(notesByKey).join(', ')}`, round })
  }
  return revisedAll
}

// ---- stage 10: the package panel, three blind lenses on the whole package ----

function panelLenses(state) {
  const narrative = isNarrative(state)
  return [
    { id: 'creative_director', brief: `You are a senior creative director at a top independent studio, known for refusing anything generic. The studio's taste notes and quality bar are your standard. Ask: would I put this in front of ${narrative ? 'the commissioner' : 'the client'} today?`, taste: true },
    { id: 'film_director', brief: 'You are the director who has to shoot this next week with a small crew. Ask: can I shoot it from these pages without a follow-up call? What is ambiguous, contradictory between departments, or physically implausible?' },
    narrative
      ? { id: 'commissioner', brief: 'You are the commissioning executive deciding whether to fund this. Ask: is there a story here an audience will stay for, is it clearly this idea and nobody else\'s, and is the build sequence strong enough to sell the whole piece?' }
      : { id: 'client', brief: 'You are the brand\'s marketing lead who approves and pays for production. Ask: does it sell this product to this audience, does it stay strictly inside the facts we verified, and is it clearly ours?' },
  ]
}

function packageContent(state) {
  const out = { route: selectedRoute(state), strategy: work(state, 'strategy') }
  ;['development', 'script', 'casting_bible', 'world_bible', 'directors_treatment', 'style_bible', 'sound_plan', 'camera_plan']
    .forEach(k => { if (state.artifacts[k]) out[k] = work(state, k) })
  if (state.artifacts.storyboard) out.storyboard = boardWork(state)
  if (state.artifacts.generation_plan) out.generation_plan = work(state, 'generation_plan')
  return out
}

function panelPrompt(state, lens) {
  return `${preamble(state)}

${lens.brief}
${lens.taste ? `${TASTE_NOTES ? `THE STUDIO'S TASTE NOTES:\n<<<\n${TASTE_NOTES}\n>>>\n` : ''}${QUALITY_BAR ? `THE STUDIO'S QUALITY BAR:\n<<<\n${QUALITY_BAR}\n>>>` : DEFAULT_BAR}` : DEFAULT_BAR}

THE FULL PACKAGE:
${JSON.stringify(packageContent(state))}

Score the package as a whole, 1–10 on specificity, distinctiveness, fit (to Lucas's idea, the brief and the route) and craft, quoting the line that justifies each score. Set would_approve true only if you would approve it for production today.
Notes: every change needed to reach 9, each assigned to the one department that must make it (responsible), aimed at a specific part, saying exactly what to do, and citing where the rule comes from. ${OWNERS} Anything about the direction itself (how the idea was developed, the strategy, or which route was chosen) is Lucas's call: put it in direction_questions, not in notes. Rights, consent, prices and budget are the producer's and Lucas's to decide; a department's job is to name them, not clear them, so put anything only a person can decide in direction_questions.`
}

// Returns the departments it revised. Skipped when the current package already has a finished
// review; a review a previous run ran out of budget in continues from the round it reached.
async function packagePanel(state) {
  const revisedAll = []
  const pr = state.package_review
  if (pr && pr.complete && !pr.stale) return revisedAll
  const lastRound = LIMITS.maxPackageRounds + 1
  const first = pr && !pr.complete ? Math.min(pr.round + 1, lastRound) : 1
  const lenses = panelLenses(state)
  const finish = (why) => {
    state.package_review.complete = true
    state.package_review.ended = why
  }
  for (let round = first; round <= lastRound && !state.limit_reached; round++) {
    if (packageNeedsWork(state)) {
      await buildDepartments(state)
      if (state.limit_reached) break
    }
    phase('Package Review')
    // Start a round only if all its lenses can run; half a round would be thrown away.
    if (budgetLeft() < lenses.length) { state.limit_reached = true; break }
    const res = await parallel(lenses.map(l => () => runAgent(state, 'quality_control', panelPrompt(state, l), { schema: PANEL_SCHEMA, phase: 'Package Review', label: `panel · ${l.id} · round ${round}` })))
    // A round with a lens missing for budget didn't happen; the next run repeats it.
    if (res.some(r => r && r.not_run)) break
    const got = lenses.map((l, i) => ({ lens: l.id, r: res[i] })).filter(x => x.r && x.r.specificity)
    if (!got.length) {
      state.decision_log.push({ stage: '10_package_review', summary: `Package review round ${round}: no reviewer returned a result.` })
      break
    }
    const crits = ['specificity', 'distinctiveness', 'fit', 'craft']
    const averages = {}
    crits.forEach(c => { averages[c] = Math.round((got.reduce((n, x) => n + x.r[c].score, 0) / got.length) * 10) / 10 })
    const approvals = got.filter(x => x.r.would_approve).length
    // A needs every lens, all approving, and every criterion averaging A_MIN or better.
    const grade = got.length === lenses.length && approvals === got.length && Math.min(...Object.values(averages)) >= A_MIN ? 'A' : 'below_A'
    addQuestions(state, 'panel', got.flatMap(x => (x.r.direction_questions || []).map(q => `${x.lens}: ${q}`)))
    state.package_review = {
      round, grade, averages, approvals, of: lenses.length, complete: false,
      // The exact versions this round looked at, so later changes can be named.
      scope: Object.fromEntries(BUILT.filter(k => state.artifacts[k]).map(k => [k, state.artifacts[k].artifact_id])),
      lenses: got.map(x => ({ lens: x.lens, would_approve: x.r.would_approve, verdict: x.r.verdict, scores: Object.fromEntries(crits.map(c => [c, x.r[c].score])), evidence: Object.fromEntries(crits.map(c => [c, x.r[c].evidence])), notes: x.r.notes })),
    }
    state.decision_log.push({ stage: '10_package_review', summary: `Package review round ${round}: ${grade}, ${approvals}/${lenses.length} would approve, lowest average ${Math.min(...Object.values(averages))}` })
    if (grade === 'A') { finish('graded A'); break }
    if (round >= lastRound) { finish(`below A after ${round} rounds; the open notes are listed for Lucas`); break }
    const notesByKey = {}
    got.forEach(x => (x.r.notes || []).forEach(n => {
      const key = KEY_BY_DEPT[n.responsible]
      if (key) (notesByKey[key] = notesByKey[key] || []).push({ target: n.target, note: n.note, source: `${x.lens} (package review): ${n.source}` })
    }))
    if (!Object.keys(notesByKey).length) { finish('below A with no department notes; what remains is a direction question for Lucas'); break }
    const revised = await reviseInOrder(state, notesByKey, 'Package Review')
    revised.forEach(k => { if (!revisedAll.includes(k)) revisedAll.push(k) })
  }
  return revisedAll
}

// After the panel's last look, fixes and rebuilds can change departments it saw. Name every
// changed department, so the grade is never presented as covering versions it didn't see.
function notePanelScope(state, fixed) {
  const pr = state.package_review
  if (!pr || !pr.scope) return
  const changed = BUILT.filter(k => state.artifacts[k] && pr.scope[k] && pr.scope[k] !== state.artifacts[k].artifact_id)
  pr.fixed_after_review = [...new Set([...(pr.fixed_after_review || []), ...(fixed || [])])]
  pr.revised_after_review = changed
  pr.grade_on_earlier_versions = changed.length > 0
  pr.stale = false
}

// ---- Lucas's notes (command NOTES) ----

async function routeLucasNotes(state, notes) {
  const routes = (content(state, 'concepts').routes || []).map(r => ({ route_id: r.route_id, central_idea: r.central_idea }))
  const lastPending = [...(state.approval_log || [])].reverse().find(e => e.decision === 'pending')
  const atConceptGate = !!lastPending && lastPending.gate_id === 'concept'
  const r = await runAgent(state, 'producer', `${preamble(state)}

You are the studio's producer. Lucas, the creative director, has reviewed the package and written these notes:
"""${notes}"""

Route each note to the one execution department that must act on it (responsible), rewritten as a specific instruction that keeps Lucas's intent and wording. ${OWNERS} A note about a shot's or panel's framing, timing or action goes to the cinematographer, not the storyboard artist. If he asks for a different route, set switch_route_to to its id (routes: ${JSON.stringify(routes)}); otherwise leave it empty. If he asks to change the strategy, the routes themselves or the idea, describe that in direction_change and don't route it; otherwise leave it empty.`, { schema: ROUTER_SCHEMA, phase: 'Package Review', label: 'producer · route your notes' })
  state.human_notes = (state.human_notes || []).concat([{ gate_id: 'package', note: notes, decision_id: (input.decision_id || null) }])
  const addPending = (k, note) => { state.pending_notes = { ...(state.pending_notes || {}), [k]: [...((state.pending_notes || {})[k] || []), { target: 'Lucas', note, source: "Lucas's notes" }] } }
  if (atConceptGate) {
    // At the route choice the notes are about the strategy or the routes: those are what get
    // revised (a strategy change rebuilds the routes too).
    if (r && r.direction_change) addPending('strategy', r.direction_change)
    addPending('concepts', notes)
    setQuestions(state, 'notes', [])
    state.decision_log.push({ stage: 'lucas_notes', summary: `Lucas's notes at the route choice go to ${r && r.direction_change ? 'the strategist and ' : ''}the creative director` })
    return ['concepts']
  }
  if (r && r.direction_change) {
    // A change of direction is redeveloped, not queued as a question: the strategist and the
    // creative director revise, and everything built on them is rebuilt and reviewed again.
    addPending('strategy', r.direction_change)
    addPending('concepts', notes)
    const cg = state.approvals.concept
    if (cg && cg.approved) {
      delete state.approvals.concept
      state.approval_log.push({ gate_id: 'concept', decision: 'reopened', decision_id: input.decision_id || null, note: `Lucas's notes change the direction: ${r.direction_change}` })
    }
    state.selected_concept_id = null
    setQuestions(state, 'notes', [])
    state.decision_log.push({ stage: 'lucas_notes', summary: `Lucas's notes change the direction (${r.direction_change}); strategy and routes are redeveloped and everything downstream rebuilt` })
    return ['strategy', 'concepts']
  }
  if (!r || !r.routes) {
    setQuestions(state, 'notes', ['Your notes were saved and every department now sees them, but they could not be routed to specific departments in this run. Send them again to have the work revised.'])
    return []
  }
  setQuestions(state, 'notes', [])
  if (r.switch_route_to && routes.some(x => x.route_id === r.switch_route_to) && r.switch_route_to !== state.selected_concept_id) {
    const cg = state.approvals.concept
    if (cg && cg.approved) {
      // Gates mode: the route decision moves with Lucas's notes.
      state.approvals.concept = { ...cg, selected_route_id: r.switch_route_to, decision_id: input.decision_id || cg.decision_id }
      state.approval_log.push({ gate_id: 'concept', decision: 'approved', selected_route_id: r.switch_route_to, decision_id: input.decision_id || null, verified: false, confirmed_at: 'notes', comment: notes })
    }
    switchRoute(state, r.switch_route_to, 'Lucas asked for a different route in his notes')
    return ['route']
  }
  const notesByKey = {}
  r.routes.forEach(x => {
    const key = KEY_BY_DEPT[x.responsible]
    if (key) (notesByKey[key] = notesByKey[key] || []).push({ target: 'Lucas', note: x.note, source: "Lucas's notes" })
  })
  const revised = await reviseInOrder(state, notesByKey)
  state.decision_log.push({ stage: 'lucas_notes', summary: `Lucas's notes routed to ${Object.keys(notesByKey).join(', ') || 'no department'}` })
  return revised.concat(Object.keys(state.pending_notes || {}).filter(k => (state.pending_notes[k] || []).length))
}

function switchRoute(state, routeId, why) {
  state.selected_concept_id = routeId
  // superseded_route: rebuilt from scratch, never "update your last version", which was the old route.
  ;(DEPENDENTS.concepts || []).forEach(k => { if (state.artifacts[k]) state.artifacts[k] = { ...state.artifacts[k], status: 'stale', superseded_route: true } })
  delete state.approvals.production_plan
  state.production_plan_applied = false
  state.presented_scope = null
  state.pending_notes = {}
  setQuestions(state, 'panel', [])
  setQuestions(state, 'qc', [])
  state.package_review = null
  state.decision_log.push({ stage: 'route_switch', summary: `Switched to route ${routeId} (${why}); everything built on the old route will be redone.` })
}

// ---- development → brief ----

function applyDevelopment(state) {
  const c = content(state, 'development')
  const b = {
    ...DEFAULT_BRIEF,
    budget: { ...DEFAULT_BRIEF.budget },
    name: c.working_title || null,
    brand: c.brand || null,
    product_or_subject: c.product_or_subject || null,
    one_line_brief: c.logline || null,
    objective: c.objective || null,
    audience: c.audience || null,
    key_message: c.key_message || null,
    tone: c.tone || [],
    verified_product_facts: (c.verified_product_facts || []).map(f => f.fact),
    deliverables: (c.deliverables || []).map(d => ({
      id: d.id, type: d.type, label: d.label, aspect_ratio: d.aspect_ratio,
      ...(d.type === 'video' ? { duration_seconds: d.duration_seconds, fps: 24 } : {}),
      ...(d.type === 'still' ? { count: d.count || 1 } : {}),
    })),
    must_include: c.must_include || [],
    must_avoid: c.must_avoid || [],
    format: c.format,
    logline: c.logline,
    premise: c.premise,
    story_seed: c.story_seed,
  }
  state.brief = b
  state.needs_human_input = c.questions_for_lucas || []
  state.artifacts.brief = makeArtifact(state, 'brief', 'producer', '01_intake', ids(state, ['development']), {
    status: 'draft', based_on: [], content: { normalized_brief: b }, asset_uri: null,
    assumptions: state.artifacts.development.assumptions || [], sources: [], blockers: [],
  })
}

function gradeSummary(state) {
  return BUILD_ORDER.concat(['development', 'strategy', 'concepts'])
    .filter(k => state.artifacts[k] && state.artifacts[k].quality)
    .map(k => ({ key: k, artifact_id: state.artifacts[k].artifact_id, grade: state.artifacts[k].quality.grade, lowest: state.artifacts[k].quality.min, rounds: state.artifacts[k].quality.rounds }))
}

// ---- main pipeline ----

// The versions a production_plan decision covers: the package and the direction it confirms.
// Artifacts made after approval (production stages) are not part of it.
const PACKAGE_KINDS = [...GATE_COVERAGE.concept, ...GATE_COVERAGE.production_plan]
// Every covered artifact version, as "id@rN". An approval applies only to the exact versions
// Lucas was shown.
const packageScope = state => PACKAGE_KINDS.filter(k => state.artifacts[k] && state.artifacts[k].status !== 'stale')
  .map(k => `${state.artifacts[k].artifact_id}@r${state.artifacts[k].revision}`).sort()

async function runPipeline(state) {
  // An applied package approval freezes the package: nothing before production runs again.
  if (state.production_plan_applied && state.approvals.production_plan && state.approvals.production_plan.approved) {
    await runProductionStages(state)
    return
  }

  if (state.settings.idea_mode) {
    const dev = state.artifacts.development
    if (!isPresent(state, 'development') || (dev && dev.status === 'blocked') || (state.settings.quality && unfinishedReview(state, 'development'))) {
      phase('Development')
      await produce(state, 'development')
    }
    const developed = state.artifacts.development
    if (state.limit_reached && !developed) return
    if (!developed || developed.status === 'blocked' || !content(state, 'development').format) {
      state.decision_log.push({ stage: '01_development', summary: 'The idea could not be developed into a brief in this run; resume the project to retry.', blocked: true })
      return
    }
    // The brief is always derived from the current development, including after a resume.
    if (!state.artifacts.brief || !(state.artifacts.brief.based_on || []).includes(developed.artifact_id)) applyDevelopment(state)
    state.stage_reached = '01_development'
    if (state.limit_reached) return
  }

  if (needsWork(state, 'strategy')) {
    phase('Strategy')
    await produce(state, 'strategy')
  }
  state.stage_reached = '02_strategy'
  if (state.limit_reached) return

  if (needsWork(state, 'concepts')) {
    phase('Concepts')
    await produce(state, 'concepts')
  }
  state.stage_reached = '03_concepts'
  if (state.limit_reached) return

  // Direction that came back blocked goes to Lucas before anything is built on it.
  const blockedDirection = ['strategy', 'concepts'].filter(k => state.artifacts[k] && state.artifacts[k].status === 'blocked')
  const blockers = blockedDirection.flatMap(k => state.artifacts[k].blockers || [])
  setQuestions(state, 'blockers', blockers.map(b => `${b.issue}${b.resolution ? ` (${b.resolution})` : ''}`))
  if (blockedDirection.length) {
    state.pending_gate = { ...gateInfo('concept', [state.artifacts.brief, state.artifacts.strategy, state.artifacts.concepts]), blocked_by: blockedDirection, blockers, open_questions: state.open_questions || [] }
    recordPendingApproval(state, 'concept')
    state.decision_log.push({ stage: '03_concepts', summary: `Stopped before building: ${blockedDirection.join(' and ')} came back blocked and needs Lucas's answer (send it as notes).`, blocked: true })
    return
  }

  const conceptGate = state.approvals.concept
  const routes = content(state, 'concepts').routes || []
  if (conceptGate && conceptGate.approved) {
    if (state.artifacts.concepts.status !== 'approved') {
      state.selected_concept_id = conceptGate.selected_route_id || content(state, 'concepts').recommended_route_id
      state.artifacts.concepts.status = 'approved'
      state.approval_log.push(approvedEntry(state, 'concept', conceptGate,
        [state.artifacts.brief, state.artifacts.strategy, state.artifacts.concepts].filter(Boolean).map(a => `${a.artifact_id}@r${a.revision}`),
        { selected_route_id: state.selected_concept_id }))
    }
  } else if (state.settings.review_at_end) {
    if (!routes.some(r => r.route_id === state.selected_concept_id)) {
      state.selected_concept_id = content(state, 'concepts').recommended_route_id
      state.approval_log.push({ gate_id: 'concept', decision: 'provisional', selected_route_id: state.selected_concept_id, verified: false, note: "The creative director's recommended route, built on so Lucas can review the route and the whole package together at the production_plan gate." })
      state.decision_log.push({ stage: '03_concepts', summary: `Building on the recommended route ${state.selected_concept_id}; Lucas approves the route with the package` })
    }
  } else {
    state.pending_gate = gateInfo('concept', [state.artifacts.brief, state.artifacts.strategy, state.artifacts.concepts])
    recordPendingApproval(state, 'concept')
    return
  }

  // A decision naming a different route is a rebuild, never an approval (in either mode): Lucas
  // hasn't seen that route built. His comment still steers the rebuild.
  let prodGate = state.approvals.production_plan
  if (prodGate && prodGate.approved && prodGate.selected_route_id && prodGate.selected_route_id !== state.selected_concept_id && routes.some(r => r.route_id === prodGate.selected_route_id)) {
    if (prodGate.comment) state.human_notes = (state.human_notes || []).concat([{ gate_id: 'package', note: prodGate.comment, decision_id: prodGate.decision_id || null }])
    state.approval_log.push({ gate_id: 'production_plan', decision: 'route_change', selected_route_id: prodGate.selected_route_id, approver_id: prodGate.approver_id || null, decided_at: prodGate.decided_at || null, decision_id: prodGate.decision_id || null, verified: !!prodGate.approver_id, note: 'Rebuild on another route; not an approval.' })
    if (conceptGate && conceptGate.approved) {
      // Gates mode: the route decision moves to the new route, recorded as Lucas's decision.
      state.approvals.concept = { ...conceptGate, selected_route_id: prodGate.selected_route_id, decision_id: prodGate.decision_id || conceptGate.decision_id }
      state.approval_log.push({ gate_id: 'concept', decision: 'approved', selected_route_id: prodGate.selected_route_id, approver_id: prodGate.approver_id || null, decided_at: prodGate.decided_at || null, decision_id: prodGate.decision_id || null, verified: !!prodGate.approver_id, confirmed_at: 'production_plan', comment: prodGate.comment || '' })
    }
    switchRoute(state, prodGate.selected_route_id, 'Lucas picked a different route at review')
    return runPipeline(state)
  }

  // A route change that names the route already built is a replayed decision, never an approval.
  if (prodGate && prodGate.approved && prodGate.route_change) {
    delete state.approvals.production_plan
    state.approval_log.push({ gate_id: 'production_plan', decision: 'not_applied', approver_id: prodGate.approver_id || null, decision_id: prodGate.decision_id || null, reason: `A rebuild on route ${prodGate.selected_route_id}, which is already built; it is not an approval.` })
    prodGate = null
  }
  // An approval of exactly the versions Lucas saw is applied as they are: nothing is rebuilt first
  // (a department he approved while blocked stays blocked, listed).
  const approvalMatches = !!(prodGate && prodGate.approved && state.presented_scope &&
    !anyStale(state, PACKAGE_KINDS) && packageScope(state).join() === state.presented_scope.join())
  if (!approvalMatches) await buildDepartments(state)
  if (state.limit_reached) return

  // An approval that no longer matches the package (work was rebuilt after Lucas saw it) is not
  // applied; this run reviews the current package and presents it again. His comment still counts.
  let seenScope = null
  if (prodGate && prodGate.approved && !approvalMatches) {
    seenScope = state.presented_scope || []
    delete state.approvals.production_plan
    if (prodGate.comment && !(state.human_notes || []).some(n => prodGate.decision_id && n.decision_id === prodGate.decision_id)) {
      state.human_notes = (state.human_notes || []).concat([{ gate_id: 'package', note: prodGate.comment, decision_id: prodGate.decision_id || null }])
    }
    state.approval_log.push({ gate_id: 'production_plan', decision: 'not_applied', approver_id: prodGate.approver_id || null, decision_id: prodGate.decision_id || null, comment: prodGate.comment || '', reason: 'The package changed after Lucas reviewed it; the current versions are reviewed and presented again.' })
    state.decision_log.push({ stage: '09_preproduction_review', summary: 'Approval not applied: the package changed after Lucas reviewed it. Reviewing and presenting the current versions.' })
    prodGate = null
  }
  // Departments whose current version differs from what Lucas last saw, named when presenting.
  const changedSince = () => (seenScope ? PACKAGE_KINDS.filter(k => { const a = state.artifacts[k]; return a && a.status !== 'stale' && !seenScope.includes(`${a.artifact_id}@r${a.revision}`) }) : null)

  // Once Lucas has approved, nothing is reviewed or revised again before the approval is
  // applied to the versions he saw.
  if (!(prodGate && prodGate.approved)) {
    phase('Pre-production Review')
    await preproductionReview(state)
    state.stage_reached = '09_preproduction_review'
    if (state.limit_reached) return

    if (state.settings.quality) {
      const panelRevised = await packagePanel(state)
      state.stage_reached = '10_package_review'
      if (state.limit_reached) return
      // The panel changed departments after integrity QC saw them: check the final package once more.
      if (panelRevised.length || !isPresent(state, 'quality_reports')) {
        const fixed = await preproductionReview(state)
        if (state.limit_reached) return
        notePanelScope(state, fixed)
      }
    }
  }

  // Revisions can leave downstream work stale. A package with stale parts never goes to Lucas
  // as if it were coherent: regenerate it (quality runs) or block the gate (legacy runs).
  if (!approvalMatches && packageNeedsWork(state)) {
    if (state.settings.quality) await buildDepartments(state)
    if (state.limit_reached) return
    notePanelScope(state, [])
  }
  const staleKinds = Object.entries(state.artifacts).filter(([, a]) => a.status === 'stale').map(([k]) => k)
  const pendingProduction = extra => {
    state.presented_scope = packageScope(state)
    state.pending_gate = {
      ...gateInfo('production_plan', PACKAGE_KINDS.map(k => state.artifacts[k]).filter(Boolean)),
      ...(state.settings.review_at_end ? { also_confirms: `concept (route ${state.selected_concept_id})` } : {}),
      selected_route_id: state.selected_concept_id,
      route_options: routes.map(r => ({ route_id: r.route_id, central_idea: r.central_idea })),
      package_grade: state.package_review ? state.package_review.grade : null,
      department_grades: gradeSummary(state),
      below_a: gradeSummary(state).filter(g => g.grade !== 'A').map(g => g.key),
      open_questions: state.open_questions || [],
      ...(seenScope ? { changed_since_review: true, changed: changedSince() } : {}),
      ...(extra || {}),
    }
    recordPendingApproval(state, 'production_plan')
  }
  if (staleKinds.length) {
    state.decision_log.push({ stage: '09_preproduction_review', summary: `Cannot request production_plan approval yet: ${staleKinds.join(', ')} are stale. Re-run this project (same priorState) to regenerate them.`, stale: staleKinds })
    pendingProduction({ blocked_by_stale: staleKinds })
    return
  }
  if (!prodGate || !prodGate.approved) {
    pendingProduction()
    return
  }
  if (state.settings.review_at_end && !(conceptGate && conceptGate.approved)) {
    state.approvals.concept = { ...prodGate, selected_route_id: state.selected_concept_id }
    state.artifacts.concepts.status = 'approved'
    state.approval_log.push(approvedEntry(state, 'concept', prodGate,
      [state.artifacts.brief, state.artifacts.strategy, state.artifacts.concepts].filter(Boolean).map(a => `${a.artifact_id}@r${a.revision}`),
      { selected_route_id: state.selected_concept_id, confirmed_at: 'production_plan' }))
  }
  PACKAGE_KINDS.forEach(k => { const a = state.artifacts[k]; if (a && a.status !== 'blocked' && a.status !== 'stale') a.status = 'approved' })
  state.approval_log.push(approvedEntry(state, 'production_plan', prodGate, packageScope(state), { selected_route_id: state.selected_concept_id }))
  state.production_plan_applied = true
  state.stage_reached = '09_production_plan_approved'

  await runProductionStages(state)
}

// ---- driver ----

if (['STATUS', 'EXPORT_STATE', 'EXPORT_PLAN'].includes(command)) {
  if (!input.priorState) {
    return { command, error: 'No priorState supplied: nothing to report. Run IDEA or START first and pass its project_state back in as priorState.' }
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
if (command === 'IDEA') {
  const idea = String(input.idea || '').trim()
  if (!idea) return { command, error: 'No idea supplied. Pass it as args.idea.' }
  state = {
    project_id: PROJECT_ID,
    artifact_seq: 0,
    idea,
    idea_hints: input.ideaHints || {},
    brief: { ...DEFAULT_BRIEF, budget: { ...DEFAULT_BRIEF.budget } },
    artifacts: {},
    approvals: {},
    decision_log: [],
    approval_log: [],
    pending_gate: null,
    needs_human_input: [],
    stage_reached: '00_idea',
    limit_reached: false,
    settings: { idea_mode: true, quality: input.quality !== false, review_at_end: input.review !== 'gates' },
  }
  state.artifacts.idea = makeArtifact(state, 'idea', 'producer', '00_idea', [], { status: 'draft', based_on: [], content: { idea, hints: state.idea_hints }, asset_uri: null, assumptions: [], sources: [], blockers: [] })
  state.decision_log.push({ stage: '00_idea', summary: 'Idea received from Lucas' })
} else if (!input.priorState) {
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
    settings: { idea_mode: false, quality: !!input.quality, review_at_end: input.review === 'end' },
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
  state.settings = { idea_mode: false, quality: false, review_at_end: false, ...(state.settings || {}) }
  if (typeof input.quality === 'boolean') state.settings.quality = input.quality
  if (input.review) state.settings.review_at_end = input.review === 'end'
  state.approvals = { ...(state.approvals || {}), ...(input.approvals || {}) }
  if (command === 'REVISE' && input.revision) applyRevision(state, input.revision)
}

if (state.settings.quality) LIMITS.maxAgentCallsPerRun = input.maxAgentCalls || 220
else if (input.maxAgentCalls) LIMITS.maxAgentCallsPerRun = input.maxAgentCalls
if (state.settings.quality && !(CRAFT && Object.keys(CRAFT).length)) {
  state.decision_log.push({ stage: 'setup', summary: 'Quality loop is on but no craft briefs were passed in; reviewers are using the quality bar anchors only.' })
}

if (command === 'NOTES' && String(input.notes || '').trim()) {
  delete state.approvals.production_plan
  state.production_plan_applied = false
  // Questions asked before these notes may be answered by them: they move to earlier_questions,
  // shown apart from anything raised after.
  state.earlier_questions = [...new Set([...(state.earlier_questions || []), ...(state.needs_human_input || []), ...(state.open_questions || [])])]
  state.needs_human_input = []
  state.notes_at_seq = state.artifact_seq
  const changed = await routeLucasNotes(state, String(input.notes).trim())
  // Work that changes is reviewed again, and QC and the panel raise anything still open.
  if (changed && changed.length) { setQuestions(state, 'qc', []); setQuestions(state, 'panel', []) }
}

await runPipeline(state)

return {
  project_id: PROJECT_ID,
  command,
  stage_reached: state.stage_reached,
  pending_gate: state.pending_gate,
  needs_human_input: state.needs_human_input || [],
  open_questions: state.open_questions || [],
  package_review: state.package_review || null,
  department_grades: gradeSummary(state),
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
