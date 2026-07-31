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
