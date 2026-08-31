/**
 * The selected period folded onto the 24-hour clock and the 7-day week.
 *
 * Every other view plots absolute time, so thirty evenings of work read as
 * thirty separate events. This module collapses that axis: a timestamp keeps
 * only its weekday and its hour, and what survives the fold is the habit
 * rather than the occasion.
 *
 * It owns the folding rules and nothing about how they are drawn. Calendar
 * projection is injected rather than resolved here, for the reason
 * `createCalendarProjection` takes a time zone at all: the fold is only
 * meaningful in the zone the work was done in, and the caller is what knows
 * that zone. Colours belong to `timeline-colors.js` and formatting to
 * `usage-format.js`; neither is reached from here.
 */

import { usageEvents } from './usage-model.js'

export const HOURS_IN_DAY = 24
export const DAYS_IN_WEEK = 7
export const SLOTS_IN_WEEK = HOURS_IN_DAY * DAYS_IN_WEEK

export const WEEKDAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** An hour counts as quiet below this share of the busiest hour. */
export const QUIET_SHARE = .12

/** An hour joins a project's peak window above this share of its busiest hour. */
export const PEAK_WINDOW_SHARE = .55

/** A peak window stops widening here, so a flat project reports a window
 *  rather than the whole clock. */
export const PEAK_WINDOW_MAX_HOURS = 8

/**
 * The four territories of the folded week, with the hour budget each one holds.
 *
 * The budgets are fixed facts about a week rather than measurements: five
 * weekdays of nine, six and nine hours, then two whole weekend days. They are
 * what makes the comparison on the view a comparison, since a territory that
 * holds more of the week is expected to hold more of the volume.
 */
export const TERRITORIES = [
  { key: 'work', label: 'Weekday work hours', range: 'MON–FRI 09–18H', hours: 45 },
  { key: 'evening', label: 'Weekday evenings', range: 'MON–FRI 18–24H', hours: 30 },
  { key: 'early', label: 'Weekday early hours', range: 'MON–FRI 00–09H', hours: 45 },
  { key: 'weekend', label: 'Weekend', range: 'SAT–SUN', hours: 48 },
]

const OTHER_PROJECTS = 'Other projects'

const zeroes = (length) => Array.from({ length }, () => 0)
const total = (values) => values.reduce((carried, value) => carried + value, 0)

/** Monday-first weekday of a projected date key, so the fold reads MON to SUN
 *  rather than the Sunday-first order `Date` reports. The key is already in the
 *  reader's zone, so parsing it at noon UTC cannot cross a date boundary. */
export function weekdayOfKey(dateKey) {
  return (new Date(`${dateKey}T12:00:00Z`).getUTCDay() + 6) % 7
}

/** The date key of the Monday that opens `dateKey`'s calendar week. */
export function weekKeyOf(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - weekdayOfKey(dateKey))
  return date.toISOString().slice(0, 10)
}

export function territoryOf(weekday, hour) {
  if (weekday >= 5) return 'weekend'
  if (hour >= 9 && hour < 18) return 'work'
  if (hour >= 18) return 'evening'
  return 'early'
}

/**
 * The folded shape of `sessions`, ready to draw.
 *
 * Tokens are placed at the completion time of each token-bearing event, which
 * is a turn wherever the turn breakdown accounts for its session and the
 * session itself otherwise -- the same rule the token traffic bins use, so the
 * two views cannot disagree about when volume landed.
 *
 * A day appears in `days` only once something has been recorded on it. The
 * charts read recency off that list, and a run of empty days would otherwise
 * push every real day toward the faded end of the scale while drawing a solid
 * row of zeroes along the baseline.
 */
export function buildUsagePattern(sessions, calendar, { projectLimit = 4 } = {}) {
  const matrix = Array.from({ length: DAYS_IN_WEEK }, () => zeroes(HOURS_IN_DAY))
  const dayRows = new Map()
  const projectTotals = new Map()
  const projectHours = new Map()

  for (const session of sessions) {
    const project = session.project || 'Unassigned'
    for (const event of usageEvents(session)) {
      const time = Date.parse(event.end || event.start || session.end || session.start)
      const tokens = Number(event.totalTokens) || 0
      if (!Number.isFinite(time) || tokens <= 0) continue
      const at = new Date(time)
      const key = calendar.dateKey(at)
      const hour = calendar.hour(at)
      const weekday = weekdayOfKey(key)
      matrix[weekday][hour] += tokens

      const row = dayRows.get(key) || { key, weekday, weekKey: weekKeyOf(key), tokens: 0, hours: zeroes(HOURS_IN_DAY) }
      row.tokens += tokens
      row.hours[hour] += tokens
      dayRows.set(key, row)

      projectTotals.set(project, (projectTotals.get(project) || 0) + tokens)
      const hours = projectHours.get(project) || zeroes(HOURS_IN_DAY)
      hours[hour] += tokens
      projectHours.set(project, hours)
    }
  }

  const hourTotals = Array.from({ length: HOURS_IN_DAY }, (_, hour) => total(matrix.map((row) => row[hour])))
  const dayTotals = matrix.map(total)
  const tokens = total(dayTotals)
  const days = [...dayRows.values()].sort((left, right) => left.key.localeCompare(right.key))
  days.forEach((day, index) => {
    day.index = index
    day.recency = days.length > 1 ? index / (days.length - 1) : 1
  })

  return {
    matrix,
    hourTotals,
    dayTotals,
    tokens,
    days,
    weeks: groupWeeks(days),
    hourMeans: hourTotals.map((value) => value / Math.max(1, days.length)),
    weekdayMeans: weekdayMeans(days),
    dayHourMax: Math.max(0, ...days.flatMap((day) => day.hours)),
    dayMax: Math.max(0, ...days.map((day) => day.tokens)),
    peakSlot: peakSlotOf(matrix),
    peakHour: extremeIndex(hourTotals, 1),
    peakDay: extremeIndex(dayTotals, 1),
    leastDay: extremeIndex(dayTotals, -1),
    quietStretch: quietStretchOf(hourTotals),
    dayparts: daypartsOf(hourTotals, tokens),
    halfVolumeSlots: halfVolumeSlotsOf(matrix, tokens),
    territories: territoriesOf(matrix, tokens),
    projects: projectSeries(projectTotals, projectHours, tokens, projectLimit),
  }
}

function groupWeeks(days) {
  const weeks = new Map()
  for (const day of days) {
    const week = weeks.get(day.weekKey) || { key: day.weekKey, days: [] }
    week.days.push(day)
    weeks.set(day.weekKey, week)
  }
  return [...weeks.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function weekdayMeans(days) {
  return Array.from({ length: DAYS_IN_WEEK }, (_, weekday) => {
    const matching = days.filter((day) => day.weekday === weekday)
    return matching.length ? total(matching.map((day) => day.tokens)) / matching.length : 0
  })
}

/** The index of the largest value, or of the smallest when `direction` is -1.
 *  Ties keep the earliest index, so a flat week reports Monday rather than
 *  whichever weekday the scan happened to reach last. */
function extremeIndex(values, direction) {
  let best = 0
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] - values[best]) * direction > 0) best = index
  }
  return { index: best, tokens: values[best] }
}

function peakSlotOf(matrix) {
  let weekday = 0
  let hour = 0
  for (let day = 0; day < DAYS_IN_WEEK; day += 1) {
    for (let slot = 0; slot < HOURS_IN_DAY; slot += 1) {
      if (matrix[day][slot] > matrix[weekday][hour]) {
        weekday = day
        hour = slot
      }
    }
  }
  return { weekday, hour, tokens: matrix[weekday][hour] }
}

/**
 * The longest circular run of hours below `QUIET_SHARE` of the busiest hour.
 *
 * The run is circular because the quiet part of a day usually straddles
 * midnight, and a linear scan would report it as two shorter stretches at
 * opposite ends of the axis.
 */
function quietStretchOf(hourTotals) {
  const busiest = Math.max(...hourTotals)
  if (!(busiest > 0)) return null
  const quiet = hourTotals.map((value) => value < QUIET_SHARE * busiest)
  let start = 0
  let length = 0
  for (let from = 0; from < HOURS_IN_DAY; from += 1) {
    let run = 0
    while (run < HOURS_IN_DAY && quiet[(from + run) % HOURS_IN_DAY]) run += 1
    if (run > length) {
      length = run
      start = from
    }
  }
  if (!length) return null
  const hours = Array.from({ length }, (_, offset) => (start + offset) % HOURS_IN_DAY)
  return { start, length, end: (start + length) % HOURS_IN_DAY, hours, tokens: total(hours.map((hour) => hourTotals[hour])) }
}

function daypartsOf(hourTotals, tokens) {
  const parts = [
    { key: 'night', range: '00–06H', from: 0 },
    { key: 'morning', range: '06–12H', from: 6 },
    { key: 'afternoon', range: '12–18H', from: 12 },
    { key: 'evening', range: '18–24H', from: 18 },
  ].map((part) => {
    const value = total(hourTotals.slice(part.from, part.from + 6))
    return { ...part, tokens: value, share: tokens ? value / tokens : 0 }
  })
  return { all: parts, lead: parts.slice().sort((left, right) => right.tokens - left.tokens)[0] }
}

/** How many of the 168 slots it takes to reach half the period's volume, read
 *  from the heaviest down. A small count is a ritual, a large one is a habit
 *  spread thin; the view prints the count and lets the reader decide. */
function halfVolumeSlotsOf(matrix, tokens) {
  if (!(tokens > 0)) return 0
  const slots = matrix.flat().sort((left, right) => right - left)
  let carried = 0
  let count = 0
  while (carried < tokens / 2 && count < slots.length) {
    carried += slots[count]
    count += 1
  }
  return count
}

function territoriesOf(matrix, tokens) {
  const totals = new Map(TERRITORIES.map((territory) => [territory.key, 0]))
  for (let weekday = 0; weekday < DAYS_IN_WEEK; weekday += 1) {
    for (let hour = 0; hour < HOURS_IN_DAY; hour += 1) {
      const key = territoryOf(weekday, hour)
      totals.set(key, totals.get(key) + matrix[weekday][hour])
    }
  }
  return TERRITORIES.map((territory) => ({
    ...territory,
    tokens: totals.get(territory.key),
    share: tokens ? totals.get(territory.key) / tokens : 0,
    timeShare: territory.hours / SLOTS_IN_WEEK,
  }))
}

/**
 * Hour-of-day volume per project, largest first, with the tail folded into one
 * row.
 *
 * The tail is folded rather than dropped because the stacked bars have to add
 * up to the hour totals the rest of the view prints. Its hours are summed too,
 * so the fold changes how the volume is labelled and not where it sits.
 */
function projectSeries(projectTotals, projectHours, tokens, projectLimit) {
  const ranked = [...projectTotals.entries()].sort((left, right) => right[1] - left[1])
  const named = ranked.slice(0, projectLimit).map(([project, value]) => ({
    project,
    other: false,
    tokens: value,
    share: tokens ? value / tokens : 0,
    hours: projectHours.get(project),
  }))
  const tail = ranked.slice(projectLimit)
  if (tail.length) {
    const hours = zeroes(HOURS_IN_DAY)
    for (const [project] of tail) {
      projectHours.get(project).forEach((value, hour) => { hours[hour] += value })
    }
    const value = total(tail.map(([, amount]) => amount))
    named.push({ project: OTHER_PROJECTS, other: true, tokens: value, share: tokens ? value / tokens : 0, hours })
  }
  return named.map((row) => ({ ...row, ...peakWindowOf(row.hours) }))
}

/**
 * The contiguous hours a project keeps, grown outward from its busiest one
 * while its neighbours stay above `PEAK_WINDOW_SHARE` of that peak.
 *
 * The walk is circular so a project that runs from 22:00 to 02:00 reports one
 * window rather than two, and it stops at `PEAK_WINDOW_MAX_HOURS` so a project
 * with no preference reports a window instead of the entire clock.
 */
function peakWindowOf(hours) {
  const busiest = Math.max(...hours)
  if (!(busiest > 0)) return { peakHour: null, windowStart: null, windowEnd: null }
  const peak = hours.indexOf(busiest)
  let from = peak
  let to = peak
  const floor = PEAK_WINDOW_SHARE * busiest
  // `to` is the last hour inside the window and `from` the first, so a span of
  // n hours is reached at `to - from === n - 1`. The bound is written against
  // the span the label prints rather than against the index distance.
  const widening = () => to - from < PEAK_WINDOW_MAX_HOURS - 1
  while (widening() && hours[(from - 1 + HOURS_IN_DAY) % HOURS_IN_DAY] > floor) from -= 1
  while (widening() && hours[(to + 1) % HOURS_IN_DAY] > floor) to += 1
  return {
    peakHour: peak,
    windowStart: ((from % HOURS_IN_DAY) + HOURS_IN_DAY) % HOURS_IN_DAY,
    windowEnd: (((to + 1) % HOURS_IN_DAY) + HOURS_IN_DAY) % HOURS_IN_DAY,
  }
}
