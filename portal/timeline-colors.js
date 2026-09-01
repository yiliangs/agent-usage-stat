/**
 * The portal's colour axes -- project, model family, and time territory -- in
 * one place.
 *
 * Both the dashboard and the status-area panel draw the same families, so the
 * mapping from a family to its series lives here rather than beside whichever
 * surface happened to need it first. The territory axis has one surface today
 * and still lives here: an axis is defined by the set it partitions, not by
 * how many views happen to draw it.
 */

const PROJECT_SERIES = [
  { variable: '--project-1', fallback: '#3f6d99' },
  { variable: '--project-2', fallback: '#b4832c' },
  { variable: '--project-3', fallback: '#a8577a' },
  { variable: '--project-4', fallback: '#4a7a52' },
]

export const OTHER_PROJECT_SERIES = {
  label: 'Other projects',
  variable: '--muted',
  fallback: '#66717f',
}

/**
 * Which projects hold the four fixed colour slots: the four largest by volume.
 *
 * Two rules used to compete here. Slots were claimed in iteration order, and
 * the timeline handed its currently visible week the first claim, so the four
 * coloured projects were an artefact of which week happened to be on screen.
 * A chart elsewhere could then draw its three largest projects in one neutral
 * while two projects nobody was reading held blue and green.
 *
 * One rule replaces both: colour follows volume, over the same period every
 * table on the dashboard sorts by. Ties keep first appearance, so a session
 * list carrying no volume at all still produces a stable index rather than an
 * arbitrary one.
 *
 * The cost is that the timeline, in its opt-in project colouring, can page to
 * a week whose projects are all outside the four and draw it entirely neutral.
 * That is the deliberate trade: one project keeping one colour everywhere is
 * worth more than every week being colourful.
 */
export function buildProjectColorIndex(sessions) {
  const totals = new Map()
  for (const session of sessions) {
    const project = session.project || 'Unassigned'
    const entry = totals.get(project) || { tokens: 0, seen: totals.size }
    entry.tokens += Number(session.totalTokens) || 0
    totals.set(project, entry)
  }
  const ranked = [...totals.entries()]
    .sort(([, left], [, right]) => right.tokens - left.tokens || left.seen - right.seen)
    .map(([project]) => project)
  return new Map(ranked.map((project, rank) => [project, rank < PROJECT_SERIES.length ? rank : -1]))
}

export function projectSeriesFor(project, index) {
  const label = project || 'Unassigned'
  const slot = index.get(label) ?? -1
  if (slot < 0) return OTHER_PROJECT_SERIES
  return { label, ...PROJECT_SERIES[slot] }
}

const MODEL_SERIES = {
  fable: { variable: '--model-fable', fallback: '#CE604A' },
  sol: { variable: '--model-sol', fallback: '#00897D' },
  opus: { variable: '--model-opus', fallback: '#76569A' },
  sonnet: { variable: '--model-sonnet', fallback: '#2D804F' },
  haiku: { variable: '--model-haiku', fallback: '#405FA0' },
  terra: { variable: '--model-terra', fallback: '#A27B18' },
  luna: { variable: '--model-luna', fallback: '#AA4778' },
  codex: { variable: '--model-codex', fallback: '#007F9A' },
  gpt: { variable: '--model-luna', fallback: '#AA4778' },
  other: { variable: '--muted', fallback: '#66717F' },
}

/** The series a model family draws in, falling back to the neutral one. */
export function modelSeriesFor(family) {
  return MODEL_SERIES[(family || 'other').toLowerCase()] || MODEL_SERIES.other
}

/**
 * The four territories of the folded week, in the Pattern view.
 *
 * They run work hours, evenings, early hours, weekend: an order, not a set of
 * categories, so they take the four-step tonal ramp the Tokens view already
 * draws its composition in rather than four competing hues. Reusing that ramp
 * also means the dark palette, which inverts it wholesale, is already handled.
 */
const TERRITORY_SERIES = {
  work: { variable: '--token-dark', fallback: '#5f5e59' },
  evening: { variable: '--token-mid', fallback: '#8f8d86' },
  early: { variable: '--token-light', fallback: '#bbb8b0' },
  weekend: { variable: '--token-pale', fallback: '#dedbd2' },
}

/** The series a time territory draws in. */
export function territorySeriesFor(territory) {
  return TERRITORY_SERIES[territory] || MODEL_SERIES.other
}
