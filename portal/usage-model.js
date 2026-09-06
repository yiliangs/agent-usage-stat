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

/** Monday-first weekday of a projected date key, so a week reads MON to SUN
 *  rather than the Sunday-first order `Date` reports. The key is already in the
 *  reader's zone, so parsing it at noon UTC cannot cross a date boundary. */
export function weekdayOfKey(key) {
  return (new Date(`${key}T12:00:00Z`).getUTCDay() + 6) % 7
}

/** The date key of the Monday that opens `key`'s calendar week. */
export function weekKeyOf(key) {
  return shiftDateKey(key, -weekdayOfKey(key))
}

/** The date key of the first day of `key`'s calendar month. */
export function monthKeyOf(key) {
  return `${key.slice(0, 7)}-01`
}

/**
 * The units a calendar series can fold a window into, finest first.
 *
 * A chart draws one mark per bucket and has a finite number of marks it can
 * hold, so a long window has to be folded rather than truncated. Truncating is
 * what it did: the bucket count was capped and every day older than the cap
 * matched no bucket and vanished, taking 70 percent of a long ledger out of a
 * figure labelled PERIOD TOTAL (#130) and two thirds of a 90-day selection out
 * of the trend charts (#131). Coarsening keeps every session in the series;
 * only the resolution drops.
 */
const SERIES_UNITS = ['day', 'week', 'month']

/** The bucket a date key belongs to, per unit, named by the bucket's first day. */
const SERIES_START = { day: (key) => key, week: weekKeyOf, month: monthKeyOf }

/** The next bucket after the one opening on `key`. A month is stepped through
 *  its own first day: no month is longer than 31 days and none is shorter than
 *  28, so 31 days on from the first lands inside the next month every time. */
const SERIES_STEP = {
  day: (key) => shiftDateKey(key, 1),
  week: (key) => shiftDateKey(key, 7),
  month: (key) => monthKeyOf(shiftDateKey(key, 31)),
}

/** Every bucket key from the one holding `firstKey` through the one holding
 *  `lastKey`, so the series opens at or before the window's first day and
 *  closes at or after its last. */
function seriesKeys(firstKey, lastKey, unit) {
  const keys = []
  for (let key = SERIES_START[unit](firstKey); key <= lastKey; key = SERIES_STEP[unit](key)) keys.push(key)
  return keys.length ? keys : [SERIES_START[unit](firstKey)]
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

  /** This zone's offset from UTC at `instant`, in milliseconds. Reading the
   *  wall clock back as though it were UTC is what turns a formatted local
   *  time into the shift that produced it. */
  function zoneOffset(instant) {
    const at = parts(instant)
    const wall = Date.UTC(Number(at.year), Number(at.month) - 1, Number(at.day), Number(at.hour), Number(at.minute), Number(at.second))
    return wall - Math.floor(instant / 1000) * 1000
  }

  /**
   * The instant a date key opens on in this zone.
   *
   * A key names a calendar day, and a window built from keys has to say where
   * that day begins before any session can be tested against it. The offset is
   * read twice because the first read is taken at the wrong instant: midnight
   * UTC on the key sits inside the previous or the following local day, and a
   * zone whose offset changes between the two would place the boundary an hour
   * off. Where the second read disagrees with the key -- a spring-forward that
   * skips midnight itself, so no instant carries that wall time -- the day
   * opens at the first instant that does exist.
   */
  function startOfDay(key) {
    const naive = Date.parse(`${key}T00:00:00Z`)
    const guess = naive - zoneOffset(naive)
    const settled = naive - zoneOffset(guess)
    return dateKey(settled) === key ? settled : guess
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

  /**
   * A fixed range as a window of instants, measured in whole calendar days.
   *
   * A range chip names a run of days, not a rolling span of milliseconds, and
   * a day is the coarsest thing the calendar surfaces can draw: the heatmap
   * has one cell per date and no way to hold half of one. So the window opens
   * at local midnight on the first of its `days` date keys rather than at the
   * closing instant's own clock time, and every panel that counts calendar
   * days counts the same ones the window admits (#92).
   *
   * `end` is an instant; the window closes on it rather than at the end of the
   * day holding it, because that instant is the last moment anything could
   * have been recorded.
   */
  function calendarWindow(end, days) {
    const count = Math.max(1, Math.round(days))
    const lastKey = dateKey(end)
    const firstKey = shiftDateKey(lastKey, -(count - 1))
    return { start: startOfDay(firstKey), end, firstKey, lastKey }
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

  /**
   * The whole window as a series of at most `maxBuckets` buckets.
   *
   * A chart says how many marks it can draw, not how long a bucket is. This
   * picks the finest unit that fits inside that ceiling and covers the window
   * end to end, so every session the caller was handed lands in a bucket and
   * the series adds back up to the period's own total. A caller that capped
   * the count instead kept the newest `count` days and silently dropped the
   * rest (#130, #131).
   *
   * `unit` comes back with the buckets because a chart drawn in weeks has to
   * say so: the same marks under a "Daily" label are a second wrong reading of
   * the same window.
   */
  function series(sessions, period, maxBuckets = 30) {
    const ceiling = Math.max(1, Math.round(maxBuckets))
    const firstKey = dateKey(period.start)
    const lastKey = dateKey(period.end)
    const unit = SERIES_UNITS.find((candidate) => seriesKeys(firstKey, lastKey, candidate).length <= ceiling)
      || SERIES_UNITS[SERIES_UNITS.length - 1]
    const keys = seriesKeys(firstKey, lastKey, unit)
    const dayAfterLast = shiftDateKey(lastKey, 1)
    const rows = keys.map((key, index) => {
      // How many of the window's own days this bucket holds, not how long the
      // unit is. A window opening mid-week and closing mid-month leaves a
      // short bucket at each end, and a reader comparing one bucket against
      // another has to be able to tell which ones are short.
      const from = index === 0 && key < firstKey ? firstKey : key
      const to = keys[index + 1] || dayAfterLast
      return {
        key,
        unit,
        days: Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY),
        // As in `buckets`: `start` orders and positions the bucket, `key`
        // names it, and only `key` may be formatted (#91).
        start: Date.parse(`${key}T12:00:00Z`),
        cost: 0,
        sessions: 0,
        tokens: 0,
        families: {},
        input: 0,
        output: 0,
        cacheCreate: 0,
        cacheRead: 0,
      }
    })
    const byKey = new Map(rows.map((row) => [row.key, row]))
    for (const session of sessions) {
      const row = byKey.get(SERIES_START[unit](dateKey(session.t)))
      if (!row) continue
      const family = familyOf(session.primaryModel)
      row.cost += session.cost || 0
      row.sessions += 1
      row.tokens += session.totalTokens || 0
      row.input += session.input || 0
      row.output += session.output || 0
      row.cacheCreate += session.cacheCreate || 0
      row.cacheRead += session.cacheRead || 0
      row.families[family] = (row.families[family] || 0) + (session.cost || 0)
    }
    return { unit, buckets: rows }
  }

  /**
   * Tokens landing on each local calendar date, keyed by date.
   *
   * A session records one window and its turns record where inside that window
   * the volume actually landed, so the date a token belongs to is the date its
   * own event completed on -- the rule `usageEvents` owns and every view
   * plotting completion time reads. A view that instead reads whole-session
   * totals off each date a session touched counts an overnight session's whole
   * volume twice, and a table doing that visibly exceeded the ledger for any
   * week holding one (#93).
   */
  function tokensByDate(sessions) {
    const totals = new Map()
    for (const session of sessions) {
      for (const event of usageEvents(session)) {
        const time = Date.parse(event.end || event.start || session.end || session.start)
        const tokens = Number(event.totalTokens) || 0
        if (!Number.isFinite(time) || tokens <= 0) continue
        const key = dateKey(time)
        totals.set(key, (totals.get(key) || 0) + tokens)
      }
    }
    return totals
  }

  return { parts, dateKey, hour, minute, startOfDay, calendarWindow, buckets, series, tokensByDate }
}
