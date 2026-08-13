export const DAY = 86_400_000

const sum = (items, read) => items.reduce((total, item) => total + read(item), 0)
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

export function familyOf(model) {
  const value = (model || '').toLowerCase()
  if (value.includes('opus')) return 'Opus'
  if (value.includes('sonnet')) return 'Sonnet'
  if (value.includes('haiku')) return 'Haiku'
  if (value.includes('fable')) return 'Fable'
  if (value.endsWith('-sol')) return 'Sol'
  if (value.endsWith('-terra')) return 'Terra'
  if (value.endsWith('-luna')) return 'Luna'
  if (value.includes('codex')) return 'Codex'
  if (value.includes('gpt')) return 'GPT'
  return 'Other'
}

export function normalizeSession(session, index) {
  const time = Date.parse(session.end || session.start)
  return {
    ...session,
    _i: index,
    t: Number.isFinite(time) ? time : Date.parse(session.start),
    project: session.project || 'Unassigned',
    machine: session.machine || 'Unknown',
    provider: session.provider || 'claude',
    primaryModel: session.models?.[0] || 'unknown',
    turns: Array.isArray(session.turns) ? session.turns : [],
  }
}

export function summarizeUsage(sessions) {
  const tokens = sum(sessions, (session) => session.totalTokens || 0)
  const cacheRead = sum(sessions, (session) => session.cacheRead || 0)
  const cost = sum(sessions, (session) => session.cost || 0)
  return {
    cost,
    sessions: sessions.length,
    tokens,
    cacheRead,
    input: sum(sessions, (session) => session.input || 0),
    output: sum(sessions, (session) => session.output || 0),
    cacheCreate: sum(sessions, (session) => session.cacheCreate || 0),
    avgCost: sessions.length ? cost / sessions.length : 0,
    cacheRatio: tokens ? cacheRead / tokens : 0,
  }
}

export function summarizeProjects(sessions) {
  const projects = new Map()
  for (const session of sessions) {
    const project = projects.get(session.project) || {
      project: session.project,
      sessions: 0,
      cost: 0,
      tokens: 0,
      durSec: 0,
      machines: new Set(),
      families: {},
      last: 0,
    }
    const family = familyOf(session.primaryModel)
    project.sessions += 1
    project.cost += session.cost || 0
    project.tokens += session.totalTokens || 0
    project.durSec += session.durSec || 0
    project.machines.add(session.machine)
    project.families[family] = (project.families[family] || 0) + (session.cost || 0)
    project.last = Math.max(project.last, session.t)
    projects.set(session.project, project)
  }

  const all = [...projects.values()].map(({ machines, ...project }) => ({
    ...project,
    machineCount: machines.size,
    avgCost: project.cost / Math.max(1, project.sessions),
    family: Object.entries(project.families).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other',
  }))
  return {
    all,
    byCost: all.slice().sort((a, b) => b.cost - a.cost),
    totalCost: sum(all, (project) => project.cost),
  }
}

export function makeIntervalBuckets(sessions, start, end, preferredCount = 30) {
  const span = Math.max(DAY, end - start)
  const count = clamp(preferredCount, 1, 180)
  const width = span / count
  const buckets = Array.from({ length: count }, (_, index) => ({
    start: start + index * width,
    end: start + (index + 1) * width,
    cost: 0,
    sessions: 0,
    tokens: 0,
    families: {},
  }))
  for (const session of sessions) {
    const index = clamp(Math.floor((session.t - start) / width), 0, count - 1)
    const bucket = buckets[index]
    const family = familyOf(session.primaryModel)
    bucket.cost += session.cost || 0
    bucket.sessions += 1
    bucket.tokens += session.totalTokens || 0
    bucket.families[family] = (bucket.families[family] || 0) + (session.cost || 0)
  }
  return buckets
}

export function createCalendarProjection(timeZone) {
  const timeZoneOptions = timeZone ? { timeZone } : {}
  const partsFormatter = new Intl.DateTimeFormat('en-US', {
    ...timeZoneOptions,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })

  function parts(value) {
    return Object.fromEntries(partsFormatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  }

  function dateKey(value) {
    const valueParts = parts(value)
    return `${valueParts.year}-${valueParts.month}-${valueParts.day}`
  }

  function hour(value) {
    return Number(parts(value).hour)
  }

  function minute(value) {
    const valueParts = parts(value)
    return Number(valueParts.hour) * 60 + Number(valueParts.minute) + Number(valueParts.second) / 60
  }

  function buckets(sessions, end, preferredCount = 30) {
    const count = Math.max(1, Math.round(preferredCount))
    const endDate = new Date(`${dateKey(new Date(end))}T12:00:00Z`)
    const dateKeys = Array.from({ length: count }, (_, index) => {
      const date = new Date(endDate)
      date.setUTCDate(endDate.getUTCDate() - (count - index - 1))
      return date.toISOString().slice(0, 10)
    })
    const result = dateKeys.map((key) => ({
      key,
      start: Date.parse(`${key}T12:00:00Z`),
      cost: 0,
      sessions: 0,
      tokens: 0,
      families: {},
    }))
    const byDate = new Map(result.map((bucket) => [bucket.key, bucket]))
    for (const session of sessions) {
      const bucket = byDate.get(dateKey(new Date(session.t)))
      if (!bucket) continue
      const family = familyOf(session.primaryModel)
      bucket.cost += session.cost || 0
      bucket.sessions += 1
      bucket.tokens += session.totalTokens || 0
      bucket.families[family] = (bucket.families[family] || 0) + (session.cost || 0)
    }
    return result
  }

  function dailyUsage(sessions, period) {
    const count = clamp(Math.ceil((period.end - period.start) / DAY), 7, 30)
    const rows = buckets(sessions, period.end, count).map((bucket) => ({
      ...bucket,
      input: 0,
      output: 0,
      cacheCreate: 0,
      cacheRead: 0,
    }))
    const byDate = new Map(rows.map((row) => [row.key, row]))
    for (const session of sessions) {
      const row = byDate.get(dateKey(new Date(session.t)))
      if (!row) continue
      row.input += session.input || 0
      row.output += session.output || 0
      row.cacheCreate += session.cacheCreate || 0
      row.cacheRead += session.cacheRead || 0
    }
    return rows
  }

  return { parts, dateKey, hour, minute, buckets, dailyUsage }
}
