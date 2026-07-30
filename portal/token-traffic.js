const MINUTE = 60_000
const DAY = 86_400_000
const TOKEN_FIELDS = ['input', 'output', 'cacheCreate', 'cacheRead', 'totalTokens']

export function tokenTrafficIntervalMinutes(start, end) {
  return end - start <= 14 * DAY ? 15 : 60
}

export function robustTokenTrafficScale(values) {
  const rawMax = Math.max(1, ...values)
  const positive = values.filter((value) => value > 0).sort((left, right) => left - right)
  if (positive.length < 4) return { max: niceMax(rawMax), rawMax, broken: false, outlierCount: 0 }

  const q1 = quantile(positive, .25)
  const q3 = quantile(positive, .75)
  const upperFence = q3 + 1.5 * (q3 - q1)
  const majority = positive.filter((value) => value <= upperFence)
  const majorityMax = Math.max(1, ...(majority.length ? majority : positive))
  const majorityCeiling = niceMax(majorityMax)
  const broken = rawMax > upperFence && rawMax > majorityCeiling * 1.5
  return {
    max: broken ? majorityCeiling : niceMax(rawMax),
    rawMax,
    broken,
    outlierCount: broken ? values.filter((value) => value > majorityCeiling).length : 0,
  }
}

export function buildTokenTraffic(sessions, start, end, intervalMinutes = tokenTrafficIntervalMinutes(start, end)) {
  const interval = Math.max(1, intervalMinutes) * MINUTE
  const bucketStart = Math.floor(start / interval) * interval
  const bucketEnd = Math.max(bucketStart + interval, Math.ceil(end / interval) * interval)
  const buckets = Array.from({ length: Math.ceil((bucketEnd - bucketStart) / interval) }, (_, index) => ({
    start: bucketStart + index * interval,
    end: bucketStart + (index + 1) * interval,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    totalTokens: 0,
    turns: 0,
    sessions: 0,
  }))

  for (const session of sessions) {
    const events = completeTurnBreakdown(session) ? session.turns : [session]
    for (const event of events) {
      const rawTime = Date.parse(event.end || event.start || session.end || session.start)
      const time = Math.max(start, Math.min(end - 1, Number.isFinite(rawTime) ? rawTime : end - 1))
      const index = Math.max(0, Math.min(buckets.length - 1, Math.floor((time - bucketStart) / interval)))
      const bucket = buckets[index]
      for (const field of TOKEN_FIELDS) bucket[field] += Number(event[field]) || 0
      if (events === session.turns) bucket.turns += 1
      else bucket.sessions += 1
    }
  }

  return { buckets, intervalMinutes }
}

function niceMax(value) {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const normalized = value / power
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : normalized <= 7.5 ? 7.5 : 10
  return step * power
}

function quantile(sorted, percentile) {
  const position = (sorted.length - 1) * percentile
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function completeTurnBreakdown(session) {
  if (!Array.isArray(session.turns) || !session.turns.length) return false
  return TOKEN_FIELDS.every((field) => {
    const sessionValue = Number(session[field]) || 0
    const turnValue = session.turns.reduce((total, turn) => total + (Number(turn[field]) || 0), 0)
    return Math.abs(sessionValue - turnValue) < .5
  })
}
