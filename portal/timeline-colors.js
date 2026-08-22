/**
 * The portal's two colour axes, project and model family, in one place.
 *
 * Both the dashboard and the status-area panel draw the same families, so the
 * mapping from a family to its series lives here rather than beside whichever
 * surface happened to need it first.
 */

const PROJECT_SERIES = [
  { variable: '--project-1', fallback: '#2a78d6' },
  { variable: '--project-2', fallback: '#eda100' },
  { variable: '--project-3', fallback: '#e87ba4' },
  { variable: '--project-4', fallback: '#008300' },
]

const OTHER_PROJECTS = {
  label: 'Other projects',
  variable: '--muted',
  fallback: '#66717f',
}

export function buildProjectColorIndex(sessions, preferredSessions = []) {
  const index = new Map()
  for (const session of [...preferredSessions, ...sessions]) {
    const project = session.project || 'Unassigned'
    if (index.has(project)) continue
    index.set(project, index.size < PROJECT_SERIES.length ? index.size : -1)
  }
  return index
}

export function projectSeriesFor(project, index) {
  const label = project || 'Unassigned'
  const slot = index.get(label) ?? -1
  if (slot < 0) return OTHER_PROJECTS
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
