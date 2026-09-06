export const DAY = 86_400_000

/** The token fields a shard records, and therefore the fields a turn has to
 *  account for before it can stand in for its session. */
export const TOKEN_FIELDS = ['input', 'output', 'cacheCreate', 'cacheRead', 'totalTokens']

const sum = (items, read) => items.reduce((total, item) => total + read(item), 0)
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

/**
 * The token-bearing events of one session, placed at the times they completed.
 *
 * A session records one window; its turns record where inside that window the
 * volume actually landed, which is what any view plotting completion time
 * needs. Turns are only trusted when every field they carry adds back up to
 * the session, because a partial list would silently drop the difference. The
 * check is all-or-nothing rather than per-field for the same reason: a mix of
 * turn-level input and session-level output would count neither window
 * correctly.
 *
 * The returned array is `session.turns` itself when the turns win, so a caller
 * can tell the two cases apart by identity.
 */
export function usageEvents(session) {
  if (!Array.isArray(session.turns) || !session.turns.length) return [session]
  const complete = TOKEN_FIELDS.every((field) => {
    const sessionValue = Number(session[field]) || 0
    const turnValue = session.turns.reduce((total, turn) => total + (Number(turn[field]) || 0), 0)
    return Math.abs(sessionValue - turnValue) < .5
  })
  return complete ? session.turns : [session]
}

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

/**
 * The first `limit` projects, with everything past them folded into one row.
 *
 * A table that prints a bounded number of project rows under a footer totalling
 * every project asks the reader to add up a column that cannot reach the total
 * printed beneath it, with nothing on screen explaining the gap, and the gap
 * grows with the number of projects (#134). Folding the tail into a single row
 * closes it: the column sums to the footer again, and the row says how many
 * projects stand behind it.
 *
 * Only what can be added survives the fold. `machineCount` cannot: a count of
 * distinct machines is not a sum across projects, and by this point the sets of
 * names it was derived from are gone. The row is marked `synthetic` because
 * there is no project behind it to filter a view on or open a detail for, so a
 * surface offering those has to leave it alone.
 */
export function foldProjects(projects, limit) {
  if (projects.length <= limit) return projects
  const kept = projects.slice(0, limit - 1)
  const folded = projects.slice(limit - 1)
  const families = {}
  for (const project of folded) {
    for (const [family, value] of Object.entries(project.families)) {
      families[family] = (families[family] || 0) + value
    }
  }
  const sessions = sum(folded, (project) => project.sessions)
  const cost = sum(folded, (project) => project.cost)
  return [...kept, {
    project: 'Other',
    synthetic: true,
    projects: folded.length,
    sessions,
    cost,
    tokens: sum(folded, (project) => project.tokens),
    durSec: sum(folded, (project) => project.durSec),
    families,
    last: Math.max(...folded.map((project) => project.last)),
    avgCost: sessions ? cost / sessions : 0,
    family: Object.entries(families).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other',
  }]
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

/**
 * A date key moved by whole days, answered as a date key.
 *
 * Key arithmetic stays in key space. A key is a calendar day, not an instant,
 * and the only reason it is stamped at noon UTC is that noon has twelve hours
 * of slack on either side. Shifting the instant and reading the result back
 * through a time zone spends that slack: at UTC+13 noon UTC on the day before
 * a key is one in the morning on the key itself, so the shift returns the day
 * it started from and the heatmap's prior window overlaps its current one by a
 * day, counting that day's cost in both totals (#91).
 *
 * The offset is applied in UTC, where every day is the same length, so the
 * result is a whole-day step across month ends and daylight-saving edges
 * alike.
 */
export function shiftDateKey(key, days) {
  const date = new Date(`${key}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
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

  /**
   * The date key an end marker names.
   *
   * A caller that already holds a key has already consulted this zone, and
   * passing that key back through an instant consults it a second time. The
   * zone is read exactly once per window, here or in `dateKey`, never twice.
   */
  function endDateKey(end) {
    return typeof end === 'string' ? end : dateKey(new Date(end))
  }

  /** The `count` calendar days ending on `end`, which is either an instant to
   *  read in this zone or the date key the window closes on. */
  function buckets(sessions, end, preferredCount = 30) {
    const count = Math.max(1, Math.round(preferredCount))
    const last = endDateKey(end)
    const dateKeys = Array.from({ length: count }, (_, index) => shiftDateKey(last, index - (count - 1)))
    const result = dateKeys.map((key) => ({
      key,
      // A bucket is a calendar day, and `key` is what says which one. `start`
      // orders and positions it; it is not the day itself and must not be
      // formatted, because reading noon UTC back in the viewer's zone names
      // the following day past UTC+12 (#91). Labels come from `key`.
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
