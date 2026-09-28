// The studio's twelve departments, in build order, as the live pages name them:
// [workflow department id, short name, what it makes]. KEY is the project state artifact each
// department's work is saved under. Shared by tools/live-feed.mjs and tools/studio-feed.mjs.
export const DEPTS = [
  ['development_producer', 'Development', 'Develops the idea into a brief'],
  ['strategist', 'Strategy', 'The audience and the one thing to say'],
  ['creative_director', 'Routes', 'Three creative routes, one recommended'],
  ['copywriter', 'Script', 'The script, beat by beat'],
  ['casting_director', 'Casting', 'Who plays everyone, and how'],
  ['production_designer', 'World', 'Every location and prop'],
  ['director', "Director's treatment", 'How it plays and feels'],
  ['stylist', 'Style', 'Wardrobe, hair and makeup'],
  ['sound_designer', 'Sound', 'Music, silence and every sound cue'],
  ['cinematographer', 'Camera', 'Every shot: framing, lens, timing'],
  ['storyboard_artist', 'Storyboard', 'Panels, continuity and risk'],
  ['generation_supervisor', 'Generation plan', 'How each shot gets made'],
]

export const NAME = Object.fromEntries(DEPTS.map(([d, n]) => [d, n]))

export const KEY = {
  development_producer: 'development',
  strategist: 'strategy',
  creative_director: 'concepts',
  copywriter: 'script',
  casting_director: 'casting_bible',
  production_designer: 'world_bible',
  director: 'directors_treatment',
  stylist: 'style_bible',
  sound_designer: 'sound_plan',
  cinematographer: 'camera_plan',
  storyboard_artist: 'storyboard',
  generation_supervisor: 'generation_plan',
}
