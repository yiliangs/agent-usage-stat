/**
 * The figures the status-area panel shows, selected from the same ledger the
 * dashboard reads.
 *
 * The panel is a glance, not a report, so it carries two windows and one
 * session. Today is a calendar day in the reader's own time zone, because that
 * is the day they are living in. The week is a rolling seven days ending now,
 * paired with the seven before it, because a comparison is only fair between
 * windows of the same length. The two are adjacent and never overlap, so no
 * session is counted twice.
 *
 * Summing, family naming, and the end-or-start rule for when a session
 * happened all come from `usage-model.js`, which the dashboard uses for the
 * same purposes. This module owns only the selection.
 */

import { compact, periodDelta, usdHeadline } from './usage-format.js'
import {
  DAY,
  createCalendarProjection,
  familyOf,
  normalizeSession,
  summarizeUsage,
} from './usage-model.js'

const WEEK = 7 * DAY

/**
 * @param sessions Snapshot records, exactly as `data/sessions.json` holds them.
 * @param now The instant the panel is being read at.
 * @param timeZone IANA zone for the calendar day, or null for the machine's.
 * @param generatedAt When the snapshot behind these records was built.
 */
export function buildGlance(sessions, { now, timeZone = null, generatedAt = null } = {}) {
  const records = sessions.map(normalizeSession)
  const { dateKey } = createCalendarProjection(timeZone)
  const todayKey = dateKey(new Date(now))

  const today = records.filter((session) => dateKey(new Date(session.t)) === todayKey)
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
 * The exact strings the panel prints, each bounded by the slot it sits in.
 *
 * Formatting is done here rather than in the panel's markup so the widths hold
 * without a browser: `SLOT_BUDGET` records what each slot was sized for and
 * `usage-format.js` bounds every formatter that feeds one. The panel is 320px
 * wide and sized once, so an unbounded figure wraps onto the row below it.
 */
export function glanceFigures(glance, { now, timeZone = null } = {}) {
  const stamp = createStamp(now, timeZone)
  return {
    today: {
      tokens: compact(glance.today.tokens),
      cost: usdHeadline(glance.today.cost),
      note: sessionCount(glance.today.sessions),
    },
    week: {
      tokens: compact(glance.week.tokens),
      cost: usdHeadline(glance.week.cost),
      note: periodDelta(glance.week.cost, glance.priorWeek.cost),
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

function sessionCount(sessions) {
  if (sessions === 0) return 'No sessions'
  return `${sessions} session${sessions === 1 ? '' : 's'}`
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
