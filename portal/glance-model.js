/**
 * The figures and the small charts the status-area panel shows, selected from
 * the same ledger the dashboard reads.
 *
 * The panel answers where today stands, when the work happened, and what it
 * was spent on. Today is a calendar day in the reader's own time zone, because
 * that is the day they are living in. Everything summarised beside it is a
 * rolling seven days ending now, paired with the seven before it so the
 * comparison is between windows of the same length.
 *
 * Traffic, day bucketing, summing, and family naming all come from
 * `token-traffic.js` and `usage-model.js`, which the dashboard uses for the
 * same purposes. This module owns the selection, the intensity levels the
 * heatmap draws, and the printed strings.
 */

import { modelSeriesFor } from './timeline-colors.js'
import { buildTokenTraffic } from './token-traffic.js'
import { compact, pct, periodDelta, usdHeadline } from './usage-format.js'
import {
  DAY,
  createCalendarProjection,
  familyOf,
  modelShares,
  normalizeSession,
  summarizeUsage,
} from './usage-model.js'

const HOUR = 3_600_000
const WEEK = 7 * DAY
/**
 * One day per cell, twenty-six weeks across.
 *
 * Half a year is what a 10px cell fills a 360px panel with. Twelve weeks left
 * the strip stranded at half the panel's width, and widening the cells to
 * cover it made the heatmap taller than the band it sits in.
 */
export const ACTIVITY_DAYS = 182
/** Hours of traffic the panel draws, one bar each. */
export const TRAFFIC_HOURS = 24
/** Families named individually before the rest are folded into one slice. */
const MODEL_SLICES = 3
/** The family `usage-model.js` gives a model it does not recognise. */
const OTHER_FAMILY = 'Other'

/**
 * @param sessions Snapshot records, exactly as `data/sessions.json` holds them.
 * @param now The instant the panel is being read at.
 * @param timeZone IANA zone for the calendar day, or null for the machine's.
 * @param generatedAt When the snapshot behind these records was built.
 */
export function buildGlance(sessions, { now, timeZone = null, generatedAt = null } = {}) {
  const records = sessions.map(normalizeSession)
  const projection = createCalendarProjection(timeZone)
  const todayKey = projection.dateKey(new Date(now))

  const today = records.filter((session) => projection.dateKey(new Date(session.t)) === todayKey)
  const week = records.filter((session) => session.t >= now - WEEK && session.t <= now)
  const priorWeek = records.filter((session) => session.t >= now - 2 * WEEK && session.t < now - WEEK)
  const latest = records.reduce(
    (newest, session) => (newest === null || session.t > newest.t ? session : newest),
    null,
  )

  return {
    today: totals(today),
    week: totals(week),
    priorWeek: totals(priorWeek),
    traffic: hourlyTraffic(records, now),
    activity: dailyActivity(records, projection, now),
    models: modelSplit(week),
    project: topProject(week),
    latest: latest === null ? null : {
      project: latest.project,
      provider: latest.provider,
      family: familyOf(latest.primaryModel),
      model: latest.primaryModel,
      tokens: latest.totalTokens || 0,
      cost: latest.cost || 0,
      at: new Date(latest.t).toISOString(),
    },
    ledger: {
      sessions: records.length,
      updatedAt: generatedAt,
    },
  }
}

/** The three figures a panel band shows, from the dashboard's own summary. */
function totals(sessions) {
  const usage = summarizeUsage(sessions)
  return {
    sessions: usage.sessions,
    tokens: usage.tokens,
    cost: usage.cost,
  }
}

/**
 * One bar per hour for the last day, ending with the hour in progress.
 *
 * The window is aligned to the hour so the bars are whole hours rather than a
 * rolling smear, and the buckets come from `token-traffic.js`, which places a
 * session's tokens by the turn that produced them when the transcript recorded
 * turns at all. `height` is each hour against the busiest one, which is what
 * makes a quiet day legible rather than flat.
 */
function hourlyTraffic(records, now) {
  const end = Math.floor(now / HOUR) * HOUR + HOUR
  const start = end - TRAFFIC_HOURS * HOUR
  // Traffic buckets clamp whatever they are given into the window, so a ledger
  // handed over whole would stack every session it ever recorded onto the
  // first hour. Only what happened in the window is passed in.
  const inWindow = records.filter((session) => session.t >= start && session.t <= end)
  const { buckets } = buildTokenTraffic(inWindow, start, end, 60)
  const hours = buckets.slice(-TRAFFIC_HOURS)
  const peak = Math.max(0, ...hours.map((hour) => hour.totalTokens))
  return {
    peak,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    hours: hours.map((hour) => ({
      at: new Date(hour.start).toISOString(),
      tokens: hour.totalTokens,
      height: peak ? hour.totalTokens / peak : 0,
    })),
  }
}

/**
 * One cell per calendar day for the last twenty-six weeks.
 *
 * `level` is 0 for a day with nothing on it and 1 through 4 otherwise, taken
 * against the busiest day in the window on a square-root scale: token counts
 * across a quarter span orders of magnitude, and a linear scale leaves every
 * ordinary day in the lowest step.
 */
function dailyActivity(records, projection, now) {
  const buckets = projection.buckets(records, now, ACTIVITY_DAYS)
  const peak = Math.max(0, ...buckets.map((bucket) => bucket.tokens))
  const days = buckets.map((bucket) => ({
    key: bucket.key,
    tokens: bucket.tokens,
    sessions: bucket.sessions,
    level: intensity(bucket.tokens, peak),
  }))
  return {
    days,
    peak,
    activeDays: days.filter((day) => day.tokens > 0).length,
    // Cells the strip's first column is short of a full week. Without it every
    // row would be a rolling offset rather than one weekday.
    leadingDays: weekdayOffset(days[0]),
  }
}

function weekdayOffset(day) {
  if (!day) return 0
  return (new Date(Date.parse(day.key + 'T12:00:00Z')).getUTCDay() + 6) % 7
}

function intensity(tokens, peak) {
  if (tokens <= 0 || peak <= 0) return 0
  return Math.max(1, Math.ceil(Math.sqrt(tokens / peak) * 4))
}

/**
 * The week's tokens by model family, largest first.
 *
 * A session is fanned out over the models it used, through the same
 * `modelShares` the dashboard's own model charts read, so the panel and the
 * dashboard cannot disagree about what a mixed session went on.
 *
 * Past three named families the rest become one slice: a ring with nine
 * slivers in it names nothing. `usage-model.js` already calls an unrecognised
 * model's family Other, so a fold joins that slice rather than drawing a
 * second one under the same name. Ties break on the family name, so the order
 * never depends on the order sessions happened to be read in.
 */
function modelSplit(sessions) {
  const total = sessions.reduce((sum, session) => sum + (session.totalTokens || 0), 0)
  const byFamily = new Map()
  for (const session of sessions) {
    for (const share of modelShares(session)) {
      byFamily.set(share.family, (byFamily.get(share.family) || 0) + share.tokens)
    }
  }

  const ranked = [...byFamily.entries()]
    .map(([family, tokens]) => ({ family, tokens }))
    .filter((slice) => slice.tokens > 0)
    .sort(bySize)
  const slices = ranked.slice(0, MODEL_SLICES)
  const folded = ranked.slice(MODEL_SLICES).reduce((sum, slice) => sum + slice.tokens, 0)
  if (folded > 0) {
    const other = slices.find((slice) => slice.family === OTHER_FAMILY)
    if (other) other.tokens += folded
    else slices.push({ family: OTHER_FAMILY, tokens: folded })
  }

  return slices.sort(bySize).map((slice) => ({
    ...slice,
    share: total ? slice.tokens / total : 0,
    series: modelSeriesFor(slice.family),
  }))
}

function bySize(left, right) {
  return right.tokens - left.tokens || left.family.localeCompare(right.family)
}

/** The project the week's tokens mostly went to, or null for a quiet week. */
function topProject(sessions) {
  const byProject = new Map()
  for (const session of sessions) {
    byProject.set(session.project, (byProject.get(session.project) || 0) + (session.totalTokens || 0))
  }
  const ranked = [...byProject.entries()]
    .filter(([, tokens]) => tokens > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  if (!ranked.length) return null
  const [project, tokens] = ranked[0]
  return { project, tokens, projects: ranked.length }
}

/**
 * The exact strings the panel prints, each bounded by the slot it sits in.
 *
 * Formatting is done here rather than in the panel's markup so the widths hold
 * without a browser: `SLOT_BUDGET` records what each slot was sized for and
 * `usage-format.js` bounds every formatter that feeds one. Bar heights, cell
 * levels, and ring shares stay numbers, because they are geometry rather than
 * anything a reader parses.
 */
export function glanceFigures(glance, { now, timeZone = null } = {}) {
  const stamp = createStamp(now, timeZone)
  return {
    today: {
      tokens: compact(glance.today.tokens),
      cost: usdHeadline(glance.today.cost),
      note: sessionCount(glance.today.sessions),
      delta: periodDelta(glance.week.cost, glance.priorWeek.cost),
    },
    week: {
      meta: [compact(glance.week.tokens), usdHeadline(glance.week.cost)].join(' · '),
    },
    traffic: {
      peak: glance.traffic.peak ? `peak ${compact(glance.traffic.peak)}` : 'no traffic',
      // A day of bars never spans more than two dates, and the last bar is
      // always the hour in progress, so the axis is four clock faces and a
      // word rather than dates the reader has to place against each other.
      axis: [0, 6, 12, 18]
        .map((index) => clockAt(glance.traffic.hours[index].at, timeZone))
        .concat('now'),
      hours: glance.traffic.hours.map((hour) => hour.height),
    },
    activity: {
      note: `${glance.activity.activeDays} of ${glance.activity.days.length} days`,
      levels: glance.activity.days.map((day) => day.level),
      leadingDays: glance.activity.leadingDays,
    },
    models: glance.models.map((slice) => ({
      family: slice.family,
      share: slice.share,
      percent: sharePercent(slice.share),
      variable: slice.series.variable,
      fallback: slice.series.fallback,
    })),
    project: glance.project === null
      ? { name: 'No projects', note: 'nothing recorded' }
      : {
        name: glance.project.project,
        note: glance.project.projects === 1
          ? 'the only one'
          : `of ${glance.project.projects}`,
      },
    latest: glance.latest === null ? null : {
      project: glance.latest.project,
      detail: [
        glance.latest.family,
        compact(glance.latest.tokens),
        usdHeadline(glance.latest.cost),
      ].join(' · '),
      when: stamp(glance.latest.at),
    },
    updated: glance.ledger.updatedAt === null ? 'never' : stamp(glance.ledger.updatedAt),
  }
}

/**
 * A share as a whole percent, except one too small to round to one.
 *
 * A named family printed at "0%" reads as a rendering fault beside its own
 * coloured mark. The family is in the ring because it ran, so it says so.
 */
function sharePercent(share) {
  const rounded = pct(share)
  return share > 0 && rounded === '0%' ? '<1%' : rounded
}

/** The clock face at an instant, for an axis end that is only ever a time. */
function clockAt(value, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(Date.parse(value))
}

/** A session count, compacted so a long-running machine cannot outgrow the
 *  line it shares with the figure above it. */
function sessionCount(sessions) {
  if (sessions === 0) return 'No sessions'
  return `${compact(sessions)} session${sessions === 1 ? '' : 's'}`
}

/**
 * When something happened, at the resolution that distinguishes it from now.
 *
 * Today is the panel's subject, so a stamp from today is a clock; anything
 * older is a date, because a bare clock on an older record reads as today. The
 * year appears only when it is not this one.
 */
function createStamp(now, timeZone) {
  const zone = timeZone ? { timeZone } : {}
  const { dateKey } = createCalendarProjection(timeZone)
  const clock = new Intl.DateTimeFormat('en-US', { ...zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const date = new Intl.DateTimeFormat('en-US', { ...zone, month: 'short', day: '2-digit' })
  const dateWithYear = new Intl.DateTimeFormat('en-US', { ...zone, month: 'short', day: '2-digit', year: 'numeric' })
  const todayKey = dateKey(new Date(now))

  return (value) => {
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) return 'unknown'
    const key = dateKey(new Date(parsed))
    if (key === todayKey) return clock.format(parsed)
    if (key.slice(0, 4) === todayKey.slice(0, 4)) return date.format(parsed)
    return dateWithYear.format(parsed)
  }
}
