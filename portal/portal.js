import { createIcons, Settings } from 'lucide'
import { buildTokenTraffic, robustTokenTrafficScale } from './token-traffic.js'
import { OTHER_PROJECT_SERIES, buildProjectColorIndex, modelSeriesFor, projectSeriesFor, territorySeriesFor } from './timeline-colors.js'
import {
  SLOTS_IN_WEEK,
  WEEKDAY_LABELS,
  WEEKDAY_NAMES,
  buildUsagePattern,
  weekdayOfKey,
} from './pattern-model.js'
import { selectPortalView } from './portal-navigation.js'
import { providerMark } from './provider-marks.js'
import { escapeAttribute, escapeText } from './markup-escape.js'
import {
  compact,
  folioIndex,
  machineField,
  machineFieldLabel,
  pct,
  periodDelta,
  sessionsUpdated,
  syncLabel,
  tally,
  usd,
  usdHeadline,
} from './usage-format.js'
import {
  DAY,
  createCalendarProjection,
  familyOf,
  foldProjects,
  makeIntervalBuckets,
  normalizeSession,
  shiftDateKey,
  summarizeProjects,
  summarizeUsage,
} from './usage-model.js'

createIcons({ icons: { Settings } })

const RANGE_DAYS = { '07D': 7, '14D': 14, '30D': 30, '90D': 90 }
/** How far back ALL reaches when the ledger records nothing to reach back to.
 *  ALL still has to name a window, since the header prints both of its ends
 *  and every chart buckets between them. Thirty days is the length the portal
 *  opens on, so an empty ledger reads the same on whichever chip is chosen. */
const EMPTY_LEDGER_DAYS = 30
/** How many rows the project topology table draws. Everything past them is
 *  folded into the last one, so the Value column still sums to its footer. */
const TOPOLOGY_ROWS = 7
const state = {
  sessions: [],
  meta: null,
  current: [],
  range: '30D',
  view: 'overview',
  settingsReturnView: null,
  spendView: 'heatmap',
  projectView: 'overview',
  tokenTrafficView: 'chart',
  tokenTraffic: null,
  rhythmView: 'week',
  rhythmColor: 'model',
  projectColors: null,
  rhythmAnchor: null,
  pattern: null,
  patternWeek: null,
  patternProjectColors: null,
  focusFamily: null,
  projectSort: { key: 'cost', direction: -1 },
  sessionSort: { key: 'start', direction: -1 },
  sessionQuery: '',
  settings: null,
}

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const sum = (items, read) => items.reduce((total, item) => total + read(item), 0)
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
/**
 * One part's share of a whole, as a fraction.
 *
 * The only thing a share has to be guarded against is a total of zero, and an
 * empty period has no share to print anyway. Flooring the denominator instead
 * silently rescales every share whenever the total is below the floor, which
 * for a dollar total is any quiet week: sixty cents split three ways read 30,
 * 20, and 10 percent (#132). Every share on the page goes through here so the
 * page cannot hold two answers to the same question.
 */
const share = (value, total) => (total ? value / total : 0)

// Numeric formats live in usage-format.js, where each one is bounded to the
// width of the slot it feeds. Dates stay here; they have a fixed width.
//
// An instant and a calendar day are formatted by different pairs. `date` and
// `dateYear` render a moment in the reader's zone, which is what a session
// start or a period edge is. `day` and `dayYear` name the day a calendar
// bucket holds: that day is already the reader's own, decided once by
// `dateKey`, and the noon-UTC instant it is stamped at is a carrier rather
// than a moment. Reading that carrier back in the reader's zone spends the
// twelve hours of slack noon buys, so past UTC+12 every bucket label named the
// day after the one it held (#91). These two read it back in UTC.
const dayCarrier = (key) => new Date(`${key}T12:00:00Z`)
const fmt = {
  usd,
  usdHeadline,
  compact,
  tally,
  folioIndex,
  machineField,
  machineFieldLabel,
  sessionsUpdated,
  syncLabel,
  pct,
  date: (value) => new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short' }).format(value).toUpperCase(),
  dateYear: (value) => new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).format(value).toUpperCase(),
  day: (key) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', day: '2-digit', month: 'short' }).format(dayCarrier(key)).toUpperCase(),
  dayYear: (key) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }).format(dayCarrier(key)).toUpperCase(),
  time: (value) => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value),
}

const LOCAL_TIME_ZONE = resolveLocalTimeZone()
const LOCAL_LOCATION = locationLabelForTimeZone(LOCAL_TIME_ZONE)
const localTimeZoneOptions = LOCAL_TIME_ZONE ? { timeZone: LOCAL_TIME_ZONE } : {}
const {
  parts: localParts,
  dateKey: localDateKey,
  hour: localHour,
  minute: localMinute,
  startOfDay: startOfLocalDay,
  calendarWindow: localCalendarWindow,
  buckets: makeCalendarBuckets,
  dailyUsage: dailyUsageRows,
} = createCalendarProjection(LOCAL_TIME_ZONE)
const trafficTimeFormatter = new Intl.DateTimeFormat('en-US', {
  ...localTimeZoneOptions,
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function resolveLocalTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

function locationLabelForTimeZone(timeZone) {
  if (!timeZone || !timeZone.includes('/') || timeZone.startsWith('Etc/')) return 'N/A'
  const parts = timeZone.split('/')
  return parts[parts.length - 1].replaceAll('_', ' ').toUpperCase() || 'N/A'
}

function cssColor(variable, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback
}

function colorChannels(hex) {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16))
}

function styleForFamily(family) {
  const style = modelSeriesFor(family)
  const base = cssColor(style.variable, style.fallback)
  return { base, color: tintColor(base, .78) }
}

function rhythmSeriesFor(session, projectColors) {
  if (state.rhythmColor === 'project') {
    const series = projectSeriesFor(session.project, projectColors)
    return { label: series.label, base: cssColor(series.variable, series.fallback) }
  }
  const label = familyOf(session.primaryModel)
  return { label, base: styleForFamily(label).base }
}

function tintColor(hex, strength) {
  const series = colorChannels(hex)
  const paper = colorChannels(cssColor('--paper-hi', '#FAF8F2'))
  const mixed = series.map((channel, index) => Math.round(channel * strength + paper[index] * (1 - strength)))
  return `rgb(${mixed.join(', ')})`
}

function shortModel(model) {
  const value = (model || 'unknown').replace(/\[.*\]$/, '')
  const tier = /^gpt-([\d.]+)-(sol|terra|luna|codex)$/i.exec(value)
  if (tier) return `${tier[1]} ${tier[2].toUpperCase()}`
  if (/^gpt-/i.test(value)) return value.replace(/^gpt-/i, 'GPT ').toUpperCase()
  if (value === 'codex-auto-review') return 'AUTO REVIEW'
  const claude = value.replace(/^claude-/i, '').split('-')
  const name = claude.shift() || value
  const version = claude.join('.')
  return `${name.toUpperCase()}${version ? ` ${version}` : ''}`
}

/**
 * The oldest instant the ledger records, or null when it records none.
 *
 * ALL is the one range whose window is read off the data rather than counted
 * back from now, so a ledger with nothing in it leaves it with no instant to
 * start at: `Math.min` of nothing is `Infinity`, and every date derived from
 * it is invalid. Saying that once, here, is what keeps the renderers from each
 * having to ask whether the window they were handed is a real interval.
 */
function oldestRecorded() {
  const oldest = Math.min(...state.sessions.map((session) => session.t))
  return Number.isFinite(oldest) ? oldest : null
}

function currentWindow() {
  const generated = Date.parse(state.meta?.generatedAt || '')
  const latest = Math.max(...state.sessions.map((session) => session.t), Date.now())
  const end = Number.isFinite(generated) ? Math.max(generated, latest) : latest
  const days = RANGE_DAYS[state.range]
  // A range chip names calendar days, so the window opens at local midnight on
  // the first of them rather than at this moment's clock time that many days
  // ago. The heatmap can only draw whole days, and its "Current 30D" panel
  // counts exactly the thirty date keys this window now admits; the rolling
  // start let a further evening of work into the hero figure with no cell on
  // the heatmap to hold it, and the two disagreed by whatever fell in it (#92).
  if (days) return localCalendarWindow(end, days)
  // ALL is the whole ledger, which starts on its oldest session. With nothing
  // recorded there is no such session, so the window falls back to a length.
  const oldest = oldestRecorded()
  return { start: oldest === null ? end - EMPTY_LEDGER_DAYS * DAY : oldest, end }
}

function sessionsIn(start, end) {
  return state.sessions.filter((session) => session.t >= start && session.t <= end)
}

/**
 * The sessions in the period before the selected one, which only a fixed range
 * has.
 *
 * A fixed range is a run of calendar days, so the period before it is that
 * same run of days ending the day before it opens. Stepping in days rather
 * than in milliseconds is what keeps the two windows the same length across a
 * daylight-saving edge, where one calendar day is not 24 hours. The upper
 * bound is exclusive: a session recorded exactly on the boundary belongs to
 * the selected period, and counting it in both is counting it twice.
 *
 * ALL is not a length but the whole ledger, and its window starts on the
 * oldest session recorded, so nothing precedes it. It has no prior period at
 * all, and every comparison drawn from this reads as no baseline, which is
 * what a fixed range with nothing behind it already reads.
 */
function priorSessions(period) {
  const days = RANGE_DAYS[state.range]
  if (!days) return []
  const start = startOfLocalDay(shiftDateKey(period.firstKey, -days))
  return state.sessions.filter((session) => session.t >= start && session.t < period.start)
}

function render() {
  const period = currentWindow()
  const current = sessionsIn(period.start, period.end)
  const previous = priorSessions(period)
  const currentTotals = summarizeUsage(current)
  const previousTotals = summarizeUsage(previous)
  const projectSummary = summarizeProjects(current)
  state.current = current
  // One project, one colour, everywhere on the page. The index is built here
  // rather than inside whichever view draws first, because a view that builds
  // its own gives the same project a different colour on the next card down.
  state.projectColors = buildProjectColorIndex(current)

  renderHeader(period, current)
  renderSummary(currentTotals, previousTotals)
  renderCadence(current, period)
  renderSpendField(current, period)
  renderCumulativeSpend(current, period)
  renderModels(current)
  renderProjects(projectSummary)
  renderConcentration(projectSummary)
  renderTopology(current, projectSummary)
  renderTokens(currentTotals)
  renderWorkRhythm(state.sessions, period)
  renderAnalysisViews(current, previous, period, projectSummary)
  applyProjectView()
  applyPortalView()
  bindPageInteractions()
}

function renderHeader(window, current) {
  const generated = new Date(state.meta?.generatedAt || Date.now())
  // A period with nothing in it still has a ledger behind it, and the ledger's
  // machines are what the field then reports.
  const machines = (current.length ? current : state.sessions).map((session) => session.machine)
  const metaValues = $$('.top-meta b')
  const metaLabel = $('.top-meta div:first-child .micro')
  if (metaValues[0]) metaValues[0].textContent = fmt.machineField(machines)
  if (metaLabel) metaLabel.textContent = fmt.machineFieldLabel(machines)
  if (metaValues[1]) metaValues[1].textContent = fmt.dateYear(generated)
  if (metaValues[2]) metaValues[2].textContent = `LIVE / ${fmt.time(generated)}`

  $('.period-range span').innerHTML = `${fmt.dateYear(new Date(window.start))}<br>${fmt.dateYear(new Date(window.end))}`
  $('.folio .index').textContent = fmt.folioIndex(current.length, state.sessions.length)
}

function renderSummary(current, previous) {
  $('.period-range strong').textContent = fmt.compact(current.tokens)
  $('.hero-number .value').textContent = fmt.usdHeadline(current.cost)
  const delta = $('.hero-number .delta')
  delta.innerHTML = `<i class="delta-mark"></i>${periodDelta(current.cost, previous.cost)}`
  $('.hero-number').style.setProperty('--meter', `${100 * share(current.cost, current.cost + previous.cost)}%`)

  const metrics = $$('.metric')
  const values = [
    [fmt.tally(current.sessions), periodDelta(current.sessions, previous.sessions)],
    [fmt.compact(current.tokens), periodDelta(current.tokens, previous.tokens)],
    [fmt.usdHeadline(current.avgCost), periodDelta(current.avgCost, previous.avgCost)],
    [fmt.pct(current.cacheRatio), `${fmt.compact(current.cacheRead)} tokens`],
  ]
  const meterValues = [
    100 * share(current.sessions, current.sessions + previous.sessions),
    100 * share(current.tokens, current.tokens + previous.tokens),
    100 * share(current.avgCost, current.avgCost + previous.avgCost),
    100 * current.cacheRatio,
  ]
  metrics.forEach((metric, index) => {
    $('b', metric).textContent = values[index][0]
    $('small', metric).textContent = values[index][1]
    metric.style.setProperty('--meter', `${clamp(meterValues[index], 4, 100)}%`)
  })
}

function renderCadence(sessions, window) {
  const bucketCount = clamp(Math.ceil((window.end - window.start) / DAY), 7, 30)
  const buckets = makeIntervalBuckets(sessions, window.start, window.end, bucketCount)
  const maxSessions = Math.max(1, ...buckets.map((bucket) => bucket.sessions))
  const grid = $('.cadence-grid')
  grid.style.gridTemplateColumns = `repeat(${Math.min(15, buckets.length)}, 1fr)`
  grid.innerHTML = buckets.map((bucket) => {
    const height = 12 + 80 * bucket.sessions / maxSessions
    const hot = bucket.sessions === maxSessions && maxSessions > 0 ? ' hot' : ''
    return `<i class="${hot}" style="--activity:${height.toFixed(0)}%" data-tip="${fmt.date(new Date(bucket.start))} | ${bucket.sessions} sessions | ${fmt.usd(bucket.cost)}"></i>`
  }).join('')
  $('#cadenceStart').textContent = `${fmt.date(new Date(buckets[0].start))} / START`
  $('#cadenceEnd').textContent = `${fmt.date(new Date(buckets[buckets.length - 1].start))} / END`
}

function renderSpendField(sessions, window) {
  renderSpendChart(sessions, window)
  renderSpendHeatmap(state.sessions, window)
  $('.spend-bars-view').hidden = state.spendView !== 'bars'
  $('.spend-heatmap-view').hidden = state.spendView !== 'heatmap'
  $$('.spend-toggle button').forEach((button) => button.classList.toggle('active', button.dataset.spendView === state.spendView))
}

function renderSpendHeatmap(sessions, window) {
  const firstUsage = Math.min(...sessions.map((session) => session.t), window.end)
  const firstKey = localDateKey(new Date(firstUsage))
  const endKey = localDateKey(new Date(window.end))
  const ledgerDays = Math.floor((Date.parse(`${endKey}T12:00:00Z`) - Date.parse(`${firstKey}T12:00:00Z`)) / DAY) + 1
  const buckets = makeCalendarBuckets(sessions, window.end, Math.max(365, ledgerDays))
  const selectedDays = RANGE_DAYS[state.range]
  // The days the window itself admits, read off the window rather than
  // projected a second time from its closing instant. Deriving them twice is
  // what let the two definitions drift apart in the first place (#92).
  const currentKeys = new Set(selectedDays
    ? makeCalendarBuckets([], window.lastKey, selectedDays).map((bucket) => bucket.key)
    : buckets.map((bucket) => bucket.key))
  const firstCurrent = [...currentKeys][0]
  // The prior window closes on the day before the current one opens, and that
  // is a step in days rather than in milliseconds. Turning the key back into
  // an instant to subtract from returns the current window's own first day
  // past UTC+12, overlapping the two windows and double-counting that day in
  // both totals and the period change (#91).
  const priorKeys = new Set(selectedDays
    ? makeCalendarBuckets([], shiftDateKey(firstCurrent, -1), selectedDays).map((bucket) => bucket.key)
    : [])
  const rawMaxCost = Math.max(0, ...buckets.map((bucket) => bucket.cost))
  const maxCost = Math.max(1, rawMaxCost)
  const leading = weekdayOfKey(buckets[0].key)
  const peakIndex = buckets.reduce((best, bucket, index) => bucket.cost > buckets[best].cost ? index : best, 0)
  const level = (value) => {
    if (!value) return 0
    const ratio = value / maxCost
    if (ratio < .18) return 1
    if (ratio < .4) return 2
    if (ratio < .7) return 3
    return 4
  }
  const blanks = Array.from({ length: leading }, () => '<span class="calendar-blank"></span>').join('')
  $('#spendHeatmap').innerHTML = blanks + buckets.map((bucket, index) => {
    const windowClass = currentKeys.has(bucket.key) ? ' current-window' : priorKeys.has(bucket.key) ? ' prior-window' : ' outside-window'
    const period = currentKeys.has(bucket.key) ? 'current window' : priorKeys.has(bucket.key) ? 'prior window' : 'outside selection'
    // A day with nothing recorded on it has no detail to open, so it carries
    // no key. `data-day` is what makes the cell clickable, and the stylesheet
    // draws the pointer cursor from the same attribute.
    const day = bucket.sessions ? ` data-day="${bucket.key}"` : ''
    return `<button class="calendar-cell level-${level(bucket.cost)}${windowClass}${rawMaxCost > 0 && index === peakIndex ? ' peak' : ''}"${day}
      data-tip="${fmt.day(bucket.key)} | ${fmt.usd(bucket.cost)} | ${bucket.sessions} sessions | ${period}"
      aria-label="${fmt.dayYear(bucket.key)}: ${fmt.usd(bucket.cost)}, ${bucket.sessions} sessions, ${period}${bucket.sessions ? '. Opens day detail' : ''}"></button>`
  }).join('')
  const currentCost = sum(buckets.filter((bucket) => currentKeys.has(bucket.key)), (bucket) => bucket.cost)
  const priorCost = sum(buckets.filter((bucket) => priorKeys.has(bucket.key)), (bucket) => bucket.cost)
  const change = priorCost ? (currentCost - priorCost) / priorCost : null
  $('#heatmapSummary').innerHTML = `
    <div><span>${selectedDays ? `Current ${selectedDays}D` : 'Ledger total'}</span><b>${fmt.usd(currentCost)}</b></div>
    <div><span>${selectedDays ? `Prior ${selectedDays}D` : 'Prior window'}</span><b>${selectedDays ? fmt.usd(priorCost) : 'N/A'}</b></div>
    <div><span>Period change</span><b>${change === null ? 'N/A' : `${change >= 0 ? '+' : ''}${Math.round(change * 100)}%`}</b></div>`
  const monthLabels = $$('.calendar-months span')
  monthLabels[0].textContent = fmt.dayYear(buckets[0].key)
  monthLabels[1].textContent = fmt.dayYear(buckets[buckets.length - 1].key)
  const calendarMain = $('.calendar-main')
  requestAnimationFrame(() => { calendarMain.scrollLeft = calendarMain.scrollWidth })
}

function renderSpendChart(sessions, window) {
  const plot = $('.plot')
  const renderedWidth = plot.getBoundingClientRect().width || Math.max(760, $('.hero-chart').clientWidth - 50)
  const viewWidth = Math.max(760, Math.round(renderedWidth))
  plot.setAttribute('viewBox', `0 0 ${viewWidth} 516`)
  const selectedDays = RANGE_DAYS[state.range]
  const count = selectedDays || clamp(Math.ceil((window.end - window.start) / DAY), 30, 180)
  const buckets = makeCalendarBuckets(sessions, window.end, count)
  const familyTotals = new Map()
  for (const bucket of buckets) {
    for (const [family, value] of Object.entries(bucket.families)) {
      familyTotals.set(family, (familyTotals.get(family) || 0) + value)
    }
  }
  const rankedFamilies = [...familyTotals].sort((a, b) => b[1] - a[1]).map(([family]) => family)
  const families = rankedFamilies.length > 7 ? [...rankedFamilies.slice(0, 7), 'Other'] : rankedFamilies
  const visible = new Set(families.filter((family) => family !== 'Other'))
  const maxCost = Math.max(1, ...buckets.map((bucket) => bucket.cost))
  const rawStep = maxCost / 4
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const step = Math.ceil(rawStep / magnitude) * magnitude
  const top = step * 4
  const left = 58, right = viewWidth - 22, chartTop = 54, baseline = 471
  const chartWidth = right - left, chartHeight = baseline - chartTop
  const slot = chartWidth / Math.max(1, buckets.length)
  const barWidth = Math.min(28, Math.max(2, slot * .68))
  const peakIndex = buckets.reduce((best, bucket, index) => bucket.cost > buckets[best].cost ? index : best, 0)
  const peak = buckets[peakIndex]
  const peakX = left + slot * peakIndex + slot / 2

  const grid = [1, .75, .5, .25, 0].map((ratio) => {
    const y = baseline - chartHeight * ratio
    return `<line class="${ratio ? 'gridline' : 'axis'}" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/><text x="7" y="${y + 4}">${fmt.usd(top * ratio).replace('.00', '')}</text>`
  }).join('')

  const bars = buckets.map((bucket, index) => {
    const x = left + slot * index + (slot - barWidth) / 2
    let cursor = baseline
    const segments = families.map((family) => {
      const value = family === 'Other'
        ? Object.entries(bucket.families).filter(([key]) => !visible.has(key)).reduce((total, [, amount]) => total + amount, 0)
        : bucket.families[family] || 0
      return { family, value, rawHeight: chartHeight * value / top }
    }).filter((segment) => segment.value && segment.rawHeight > 1)

    return segments.map((segment, segmentIndex) => {
      cursor -= segment.rawHeight
      const gap = segmentIndex === 0 ? 0 : 1
      const height = segment.rawHeight - gap
      const style = styleForFamily(segment.family)
      return `<rect class="chart-mark stack-segment" data-family="${escapeAttribute(segment.family)}" data-tip="${fmt.day(bucket.key)} | ${escapeAttribute(segment.family)} | ${fmt.usd(segment.value)}" x="${x.toFixed(1)}" y="${cursor}" width="${barWidth.toFixed(1)}" height="${height}" rx=".8" fill="${style.color}"/>`
    }).join('')
  }).join('')

  const labelIndexes = [...new Set([0, Math.round((buckets.length - 1) * .2), Math.round((buckets.length - 1) * .4), Math.round((buckets.length - 1) * .6), Math.round((buckets.length - 1) * .8), buckets.length - 1])]
  const labels = labelIndexes.map((index) => {
    const x = left + slot * index + slot / 2
    const anchor = index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'
    return `<text x="${x}" y="500" text-anchor="${anchor}">${fmt.day(buckets[index].key)}</text>`
  }).join('')

  $('.legend').innerHTML = families.map((family) => {
    const style = styleForFamily(family)
    return `<span class="model-legend" data-family="${escapeAttribute(family)}"><i style="background:${style.color}"></i>${escapeText(family)}</span>`
  }).join('')

  $('.plot').innerHTML = `
    <title>Daily API-equivalent spend stacked by model family</title>
    <desc>${sessions.length} sessions in the selected period. Each daily bar is divided by model family.</desc>
    ${grid}${bars}
    <line x1="${peakX}" y1="${Math.max(28, baseline - chartHeight * peak.cost / top - 5)}" x2="${peakX}" y2="25" stroke="var(--ink)"/>
    <text class="annotation" x="${Math.min(right - 130, peakX + 10)}" y="31">PERIOD PEAK</text>
    <text class="annotation" x="${Math.min(right - 130, peakX + 10)}" y="46">${fmt.usd(peak.cost)} / ${peak.sessions} SESSIONS</text>
    ${labels}`
  bindTooltips()
}

function renderCumulativeSpend(sessions, window) {
  const selectedDays = RANGE_DAYS[state.range]
  const count = selectedDays || clamp(Math.ceil((window.end - window.start) / DAY), 30, 120)
  const buckets = makeCalendarBuckets(sessions, window.end, count)
  let running = 0
  const values = buckets.map((bucket) => (running += bucket.cost))
  const total = Math.max(1, values[values.length - 1] || 0)
  const left = 60, right = 738, top = 42, baseline = 376
  const width = right - left, height = baseline - top
  const xFor = (index) => left + width * index / Math.max(1, values.length - 1)
  const yFor = (value) => baseline - height * value / total
  const line = values.map((value, index) => `${index ? 'L' : 'M'}${xFor(index).toFixed(1)} ${yFor(value).toFixed(1)}`).join(' ')
  const area = `${line} L${right} ${baseline} L${left} ${baseline} Z`
  const grid = [1, .75, .5, .25, 0].map((ratio) => {
    const y = baseline - height * ratio
    return `<line class="${ratio ? 'cumulative-gridline' : 'cumulative-axis'}" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/><text x="4" y="${y + 4}">${fmt.usd(total * ratio).replace('.00', '')}</text>`
  }).join('')
  const points = values.map((value, index) => {
    const key = buckets[index].key
    const weeklyCheckpoint = weekdayOfKey(key) === 0
    if (index !== 0 && !weeklyCheckpoint && index !== values.length - 1) return ''
    const isEnd = index === values.length - 1
    const role = isEnd ? 'period total' : index === 0 ? 'period start' : 'weekly checkpoint'
    return `<circle class="${isEnd ? 'cumulative-end' : 'cumulative-point'}" cx="${xFor(index)}" cy="${yFor(value)}" r="${isEnd ? 5 : 3.5}" data-tip="${fmt.day(key)} | ${role} | cumulative ${fmt.usd(value)} | day ${fmt.usd(buckets[index].cost)}"/>`
  }).join('')
  const labels = [0, Math.round((buckets.length - 1) / 2), buckets.length - 1].map((index) => `<text x="${xFor(index)}" y="406" text-anchor="${index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'}">${fmt.day(buckets[index].key)}</text>`).join('')
  $('.cumulative-plot').innerHTML = `<defs><linearGradient id="cumulativeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--token-mid)" stop-opacity=".28"/><stop offset="1" stop-color="var(--token-mid)" stop-opacity=".03"/></linearGradient></defs>${grid}<path class="cumulative-area" d="${area}"/><path class="cumulative-line" d="${line}"/>${points}${labels}<text x="${right}" y="25" text-anchor="end" class="annotation">PERIOD TOTAL / ${fmt.usd(values[values.length - 1] || 0)}</text>`
}

function renderModels(sessions) {
  const rows = group(sessions, (session) => familyOf(session.primaryModel), (session) => session.cost || 0)
  const total = sum(rows, (row) => row.value)
  const visible = foldRows(rows, 4)
  let cursor = 0
  const stops = visible.map((row) => {
    const start = cursor
    cursor += 100 * share(row.value, total)
    return `${styleForFamily(row.key).color} ${start}% ${cursor}%`
  })
  $('.model-ring').style.background = `conic-gradient(${stops.join(', ')})`
  const largest = visible[0]
  $('.model-pie-caption b').textContent = largest ? fmt.pct(share(largest.value, total)) : '0%'
  $('.model-pie-caption span').textContent = largest ? `${largest.key} / largest share` : 'No activity'
  $('.model-pie-key').innerHTML = visible.map((row) => {
    const style = styleForFamily(row.key)
    return `<div class="model-pie-row model-filter" data-family="${escapeAttribute(row.key)}" style="--series:${style.color}"><i></i><span>${escapeText(row.key.toUpperCase())}</span><b>${fmt.pct(share(row.value, total))}</b></div>`
  }).join('')
}

function renderAnalysisViews(current, previous, period, projects) {
  renderSpendAnalysis(current, previous, period, projects)
  renderTokenAnalysis(current, previous, period, projects)
  renderPatternAnalysis(current, state.projectColors)
  renderProjectAnalysis(projects)
  renderSessionAnalysis(current)
}

function renderKpis(selector, items) {
  $(selector).innerHTML = items.map((item) => `
    <div class="analysis-kpi">
      <span class="micro">${escapeText(item.label)}</span>
      <b>${escapeText(item.value)}</b>
      <small>${escapeText(item.note || '')}</small>
    </div>`).join('')
}

function renderLineChart(selector, rows, read, formatValue) {
  const svg = $(selector)
  const width = 760
  const height = 245
  const left = 52
  const right = 746
  const top = 18
  const bottom = 208
  const values = rows.map(read)
  const max = Math.max(1, ...values)
  const xFor = (index) => left + (right - left) * index / Math.max(1, rows.length - 1)
  const yFor = (value) => bottom - (bottom - top) * value / max
  const line = values.map((value, index) => `${index ? 'L' : 'M'}${xFor(index).toFixed(1)} ${yFor(value).toFixed(1)}`).join(' ')
  const area = `${line} L${right} ${bottom} L${left} ${bottom} Z`
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = max * (4 - index) / 4
    const y = top + (bottom - top) * index / 4
    return `<line class="gridline" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/><text x="${left - 8}" y="${y + 3}" text-anchor="end">${escapeText(formatValue(value))}</text>`
  }).join('')
  const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])]
  const labels = labelIndexes.map((index) => `<text x="${xFor(index)}" y="232" text-anchor="${index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'}">${fmt.day(rows[index].key)}</text>`).join('')
  svg.innerHTML = `${grid}<line class="axis" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/><path class="area" d="${area}"/><path class="line" d="${line}"/>${values.map((value, index) => `<circle cx="${xFor(index)}" cy="${yFor(value)}" r="3" fill="${styleForFamily(Object.entries(rows[index].families || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other').base}" data-tip="${escapeAttribute(rows[index].key)} | ${escapeAttribute(formatValue(value))}"></circle>`).join('')}${labels}`
}

function brokenBarLayout(values, top, bottom) {
  const scale = robustTokenTrafficScale(values)
  const plotHeight = bottom - top
  const breakBand = scale.broken ? 18 : 0
  const usableHeight = plotHeight - breakBand
  const breakY = top + breakBand
  return {
    scale,
    plotHeight,
    usableHeight,
    breakY,
    yFor: (value) => bottom - usableHeight * value / scale.max,
  }
}

function brokenBarMarker(x, breakY, width = 6) {
  const half = width / 2
  const unit = width / 3
  return `<g class="traffic-bar-break"><rect x="${x - half}" y="${breakY - 4}" width="${width}" height="8"/><path d="M${x - half} ${breakY + 2}l${unit} -4l${unit} 4l${unit} -4l${unit} 4"/></g>`
}

function renderTokenTraffic(sessions, period) {
  const traffic = buildTokenTraffic(sessions, period.start, period.end)
  const buckets = traffic.buckets
  const peak = buckets.reduce((best, bucket) => bucket.totalTokens > best.totalTokens ? bucket : best, buckets[0])
  const active = buckets.filter((bucket) => bucket.totalTokens > 0)
  const slot = 4
  const width = Math.max(760, buckets.length * slot)
  const top = 18
  const bottom = 232
  const { scale, plotHeight, usableHeight, breakY, yFor } = brokenBarLayout(buckets.map((bucket) => bucket.totalTokens), top, bottom)
  const outliers = scale.broken ? buckets.map((bucket, index) => ({ bucket, index })).filter(({ bucket }) => bucket.totalTokens > scale.max) : []
  const intervalLabel = traffic.intervalMinutes === 15 ? '15-minute bins' : 'Hourly bins'
  const grid = Array.from({ length: 5 }, (_, index) => {
    const y = breakY + usableHeight * index / 4
    return `<line class="traffic-gridline" x1="0" y1="${y}" x2="${width}" y2="${y}"/>`
  }).join('')
  const bars = buckets.map((bucket, index) => {
    if (!bucket.totalTokens) return ''
    const y = bucket.totalTokens > scale.max ? top : yFor(bucket.totalTokens)
    return `<rect class="traffic-bar" x="${index * slot + 1}" y="${y}" width="2" height="${Math.max(1, bottom - y)}" rx="1"/>`
  }).join('')
  const breakMarkers = outliers.map(({ index }) => brokenBarMarker(index * slot + 2, breakY)).join('')
  const labelEvery = Math.max(1, Math.ceil(176 / slot))
  const labels = buckets.map((bucket, index) => index % labelEvery === 0 || index === buckets.length - 1
    ? `<text class="traffic-axis-label" x="${index * slot + 1}" y="270" text-anchor="${index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'}">${escapeText(trafficTimeFormatter.format(new Date(bucket.start)).toUpperCase())}</text>`
    : '').join('')
  const yLabels = Array.from({ length: 5 }, (_, index) => {
    const value = scale.max * (4 - index) / 4
    const y = breakY + usableHeight * index / 4
    return `<text x="48" y="${y + 3}" text-anchor="end">${escapeText(fmt.compact(value))}</text>`
  }).join('')
  const yBreak = scale.broken
    ? `<text class="traffic-break-label" x="48" y="10" text-anchor="end">BREAK</text><path class="traffic-y-break" d="M42 ${breakY - 4}l3 3l3 -3l3 3 M42 ${breakY + 1}l3 3l3 -3l3 3"/>`
    : ''
  const turnCount = sum(buckets, (bucket) => bucket.turns)
  const sessionCount = sum(buckets, (bucket) => bucket.sessions)
  const breakNote = scale.broken ? ` ${scale.outlierCount} outlier interval${scale.outlierCount === 1 ? '' : 's'} cut above ${fmt.compact(scale.max)}.` : ''

  state.tokenTraffic = { ...traffic, slot, width, top, bottom, scale }
  $('#tokenTrafficMeta').textContent = scale.broken
    ? `${intervalLabel} / axis break at ${fmt.compact(scale.max)}`
    : `${intervalLabel} / completion time`
  $('#tokenTrafficSummary').textContent = active.length
    ? `${fmt.compact(sum(buckets, (bucket) => bucket.totalTokens))} tokens across ${active.length.toLocaleString('en-US')} active intervals. Peak: ${fmt.compact(peak.totalTokens)} at ${trafficTimeFormatter.format(new Date(peak.start)).toUpperCase()}.${breakNote}`
    : 'No recorded token traffic in this period.'
  $('#tokenTrafficYAxis').innerHTML = `${yLabels}${yBreak}`
  const svg = $('#tokenTrafficChart')
  svg.setAttribute('viewBox', `0 0 ${width} 286`)
  svg.style.width = `${width}px`
  const description = scale.broken
    ? `Dense bars show recorded token volume with ${scale.outlierCount} outlier interval${scale.outlierCount === 1 ? '' : 's'} cut above ${fmt.compact(scale.max)} tokens. Hover and the table retain actual values.`
    : 'Dense bars show recorded token volume at turn completion times, with session completion as a fallback when turn detail is unavailable.'
  const clip = scale.broken ? `<defs><clipPath id="tokenTrafficClip"><rect x="0" y="${breakY}" width="${width}" height="${usableHeight + 1}"/></clipPath></defs>` : ''
  const barGroup = scale.broken ? `<g clip-path="url(#tokenTrafficClip)">${bars}</g>` : bars
  svg.innerHTML = `<title id="tokenTrafficTitle">Token traffic through the selected period</title><desc id="tokenTrafficDescription">${escapeText(description)}</desc>${clip}${grid}${barGroup}${breakMarkers}<line class="traffic-axis" x1="0" y1="${bottom}" x2="${width}" y2="${bottom}"/>${labels}<rect class="traffic-hover-band" id="tokenTrafficHoverBand" x="0" y="${top}" width="${slot}" height="${plotHeight}" hidden/><line class="traffic-crosshair" id="tokenTrafficCrosshair" x1="0" y1="${top}" x2="0" y2="${bottom}" hidden/><rect class="traffic-hit-field" x="0" y="${top}" width="${width}" height="${plotHeight}"/>`
  $('#tokenTrafficTableBody').innerHTML = active.length ? active.map((bucket) => `
    <tr>
      <td>${escapeText(trafficTimeFormatter.format(new Date(bucket.start)).toUpperCase())}</td>
      <td class="numeric">${escapeText(fmt.compact(bucket.totalTokens))}</td>
      <td class="numeric">${escapeText(fmt.compact(bucket.input))}</td>
      <td class="numeric">${escapeText(fmt.compact(bucket.output))}</td>
      <td class="numeric">${escapeText(fmt.compact(bucket.cacheCreate))}</td>
      <td class="numeric">${escapeText(fmt.compact(bucket.cacheRead))}</td>
      <td class="numeric">${bucket.turns || bucket.sessions}</td>
    </tr>`).join('') : '<tr><td colspan="7">No recorded activity in this period.</td></tr>'
  $('#tokenTrafficAttribution').textContent = `${turnCount.toLocaleString('en-US')} turn completions; ${sessionCount.toLocaleString('en-US')} session-level fallbacks. Completion-time attribution preserves the selected sessions’ recorded totals.`
  applyTokenTrafficView()
  bindTokenTrafficHover()
  const scroller = $('.token-traffic-scroll')
  requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth })
}

function renderDailyTokenBars(rows) {
  const values = rows.map((row) => row.tokens)
  const count = Math.max(1, rows.length)
  const slot = Math.max(4, Math.floor(760 / count))
  const width = Math.max(760, count * slot)
  const barWidth = Math.max(2, Math.min(12, slot * .55))
  const top = 18
  const bottom = 190
  const { scale, plotHeight, usableHeight, breakY, yFor } = brokenBarLayout(values, top, bottom)
  const outliers = scale.broken ? rows.map((row, index) => ({ row, index })).filter(({ row }) => row.tokens > scale.max) : []
  const grid = Array.from({ length: 5 }, (_, index) => {
    const y = breakY + usableHeight * index / 4
    return `<line class="traffic-gridline" x1="0" y1="${y}" x2="${width}" y2="${y}"/>`
  }).join('')
  const bars = rows.map((row, index) => {
    if (!row.tokens) return ''
    const y = row.tokens > scale.max ? top : yFor(row.tokens)
    const x = index * slot + (slot - barWidth) / 2
    return `<rect class="traffic-bar" x="${x}" y="${y}" width="${barWidth}" height="${Math.max(1, bottom - y)}" rx="1"/>`
  }).join('')
  const breakMarkers = outliers.map(({ index }) => brokenBarMarker(index * slot + slot / 2, breakY, Math.max(6, barWidth))).join('')
  const labelEvery = Math.max(1, Math.ceil(104 / slot))
  const labels = rows.map((row, index) => index % labelEvery === 0 || index === rows.length - 1
    ? `<text class="traffic-axis-label" x="${index * slot + slot / 2}" y="226">${escapeText(fmt.day(row.key))}</text>`
    : '').join('')
  const yLabels = Array.from({ length: 5 }, (_, index) => {
    const value = scale.max * (4 - index) / 4
    const y = breakY + usableHeight * index / 4
    return `<text x="48" y="${y + 3}" text-anchor="end">${escapeText(fmt.compact(value))}</text>`
  }).join('')
  const yBreak = scale.broken
    ? `<text class="traffic-break-label" x="48" y="10" text-anchor="end">BREAK</text><path class="traffic-y-break" d="M42 ${breakY - 4}l3 3l3 -3l3 3 M42 ${breakY + 1}l3 3l3 -3l3 3"/>`
    : ''
  const hitBuckets = rows.map((row, index) => {
    const date = fmt.day(row.key)
    const tip = `${date}\nTOTAL ${fmt.compact(row.tokens)}\nINPUT ${fmt.compact(row.input)} · OUTPUT ${fmt.compact(row.output)}\nCACHE WRITE ${fmt.compact(row.cacheCreate)} · CACHE READ ${fmt.compact(row.cacheRead)}`
    return `<rect class="traffic-hit-bucket multiline-tip" x="${index * slot}" y="${top}" width="${slot}" height="${plotHeight}" data-tip="${escapeAttribute(tip)}"/>`
  }).join('')
  const description = scale.broken
    ? `Daily token volume shown as bars with ${scale.outlierCount} outlier day${scale.outlierCount === 1 ? '' : 's'} cut above ${fmt.compact(scale.max)} tokens. Hover retains actual values.`
    : 'Daily token volume shown as monochrome bars on a linear scale.'
  const clip = scale.broken ? `<defs><clipPath id="dailyTokenClip"><rect x="0" y="${breakY}" width="${width}" height="${usableHeight + 1}"/></clipPath></defs>` : ''
  const barGroup = scale.broken ? `<g clip-path="url(#dailyTokenClip)">${bars}</g>` : bars
  const svg = $('#tokenTrend')
  svg.setAttribute('viewBox', `0 0 ${width} 245`)
  svg.style.width = `${width}px`
  svg.innerHTML = `<title id="dailyTokenTitle">Daily token volume</title><desc id="dailyTokenDescription">${escapeText(description)}</desc>${clip}${grid}${barGroup}${breakMarkers}<line class="traffic-axis" x1="0" y1="${bottom}" x2="${width}" y2="${bottom}"/>${labels}${hitBuckets}`
  $('#dailyTokenYAxis').innerHTML = `${yLabels}${yBreak}`
  $('#dailyTokenMeta').textContent = scale.broken
    ? `Daily bars / axis break at ${fmt.compact(scale.max)}`
    : 'Daily bars / all token types'
  const scroller = $('.daily-token-scroll')
  requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth })
}

function applyTokenTrafficView() {
  const chart = $('#tokenTrafficChartView')
  const table = $('#tokenTrafficTableView')
  chart.hidden = state.tokenTrafficView !== 'chart'
  table.hidden = state.tokenTrafficView !== 'table'
  $$('[data-token-traffic-view]').forEach((button) => {
    const active = button.dataset.tokenTrafficView === state.tokenTrafficView
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
  })
}

function bindTokenTrafficHover() {
  const svg = $('#tokenTrafficChart')
  const hitField = $('.traffic-hit-field', svg)
  const band = $('#tokenTrafficHoverBand')
  const crosshair = $('#tokenTrafficCrosshair')
  const tooltip = $('#tooltip')
  const traffic = state.tokenTraffic
  if (!hitField || !traffic) return

  hitField.onmousemove = (event) => {
    const bounds = svg.getBoundingClientRect()
    const x = (event.clientX - bounds.left) / bounds.width * traffic.width
    const index = clamp(Math.floor(x / traffic.slot), 0, traffic.buckets.length - 1)
    const bucket = traffic.buckets[index]
    const barX = index * traffic.slot
    band.hidden = false
    crosshair.hidden = false
    band.setAttribute('x', String(barX))
    crosshair.setAttribute('x1', String(barX + traffic.slot / 2))
    crosshair.setAttribute('x2', String(barX + traffic.slot / 2))
    tooltip.textContent = `${trafficTimeFormatter.format(new Date(bucket.start)).toUpperCase()} – ${trafficTimeFormatter.format(new Date(bucket.end)).toUpperCase()}\nTOTAL ${fmt.compact(bucket.totalTokens)} · ${bucket.turns || bucket.sessions} COMPLETIONS\nINPUT ${fmt.compact(bucket.input)} · OUTPUT ${fmt.compact(bucket.output)}\nCACHE WRITE ${fmt.compact(bucket.cacheCreate)} · CACHE READ ${fmt.compact(bucket.cacheRead)}`
    tooltip.classList.add('multiline')
    tooltip.style.display = 'block'
    positionTooltip(tooltip, event)
  }
  hitField.onmouseleave = () => {
    band.hidden = true
    crosshair.hidden = true
    tooltip.style.display = 'none'
    tooltip.classList.remove('multiline')
  }
}

function renderAnalysisBars(selector, rows, options = {}) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  $(selector).innerHTML = rows.length ? rows.map((row) => {
    const tag = row.sessionId != null || row.project ? 'button' : 'div'
    const attributes = row.sessionId != null
      ? ` data-analysis-session="${row.sessionId}"`
      : row.project ? ` data-analysis-project="${escapeAttribute(row.project)}"` : ''
    return `<${tag} class="analysis-bar-row"${attributes}><span class="analysis-bar-label">${escapeText(row.label)}${row.note ? `<small>${escapeText(row.note)}</small>` : ''}</span><span class="analysis-bar-track"><i style="width:${100 * row.value / max}%;${row.color ? `background:${row.color}` : ''}"></i></span><span class="analysis-bar-value">${escapeText(options.format ? options.format(row.value) : fmt.compact(row.value))}</span></${tag}>`
  }).join('') : '<p class="note">No recorded activity in this period.</p>'
}

function renderComposition(selector, rows, total, formatValue = fmt.usd) {
  $(selector).innerHTML = rows.length ? rows.map((row) => `
    <div class="composition-row" style="--series:${row.color || styleForFamily(row.key).base}">
      <i></i><span>${escapeText(row.key)}</span><b>${fmt.pct(share(row.value, total))} / ${escapeText(formatValue(row.value))}</b>
      <span class="composition-meter"><i style="width:${100 * share(row.value, total)}%"></i></span>
    </div>`).join('') : '<p class="note">No recorded activity in this period.</p>'
}

function renderSpendAnalysis(current, previous, period, projects) {
  const value = summarizeUsage(current)
  const prior = summarizeUsage(previous)
  const activeDays = new Set(current.map((session) => localDateKey(new Date(session.t)))).size
  const maximum = current.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0))[0]
  renderKpis('#spendKpis', [
    { label: 'Total spend', value: fmt.usd(value.cost), note: periodDelta(value.cost, prior.cost) },
    { label: 'Average / session', value: fmt.usd(value.avgCost), note: `${value.sessions} recorded sessions` },
    { label: 'Spend / active day', value: fmt.usd(value.cost / Math.max(1, activeDays)), note: `${activeDays} active day${activeDays === 1 ? '' : 's'}` },
    { label: 'Most expensive', value: fmt.usd(maximum?.cost || 0), note: maximum?.project || 'No sessions' },
  ])
  const days = dailyUsageRows(current, period)
  renderLineChart('#spendTrend', days, (row) => row.cost, fmt.usd)
  const machines = group(current, (session) => session.machine, (session) => session.cost || 0)
  renderComposition('#spendMachines', machines, value.cost)
  renderAnalysisBars('#spendProjects', projects.byCost.slice(0, 10).map((project) => ({ label: project.project, note: project.family, value: project.cost, project: project.project, color: styleForFamily(project.family).base })), { format: fmt.usd })
  renderAnalysisBars('#spendSessions', current.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, 10).map((session) => ({ label: session.project, note: `${session.slug || session.sid || 'Session'} / ${shortModel(session.primaryModel)}`, value: session.cost || 0, sessionId: session._i, color: styleForFamily(familyOf(session.primaryModel)).base })), { format: fmt.usd })
}

function renderTokenAnalysis(current, previous, period, projects) {
  const value = summarizeUsage(current)
  const prior = summarizeUsage(previous)
  const tokensPerDollar = value.cost ? value.tokens / value.cost : 0
  renderKpis('#tokenKpis', [
    { label: 'Total tokens', value: fmt.compact(value.tokens), note: periodDelta(value.tokens, prior.tokens) },
    { label: 'Output', value: fmt.compact(value.output), note: fmt.pct(share(value.output, value.tokens)) + ' of volume' },
    { label: 'Cache read', value: fmt.compact(value.cacheRead), note: fmt.pct(value.cacheRatio) + ' cache hit' },
    { label: 'Tokens / dollar', value: fmt.compact(tokensPerDollar), note: 'Recorded volume per API-equivalent dollar' },
  ])
  renderTokenTraffic(current, period)
  const days = dailyUsageRows(current, period)
  renderDailyTokenBars(days)
  const composition = [
    { key: 'Input', value: value.input, color: 'var(--token-mid)' },
    { key: 'Output', value: value.output, color: 'var(--token-dark)' },
    { key: 'Cache write', value: value.cacheCreate, color: 'var(--token-light)' },
    { key: 'Cache read', value: value.cacheRead, color: 'var(--token-pale)' },
  ]
  renderComposition('#tokenComposition', composition, value.tokens, fmt.compact)
  const byTokens = projects.all.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 10)
  renderAnalysisBars('#tokenProjects', byTokens.map((project) => ({ label: project.project, note: project.family, value: project.tokens, project: project.project, color: styleForFamily(project.family).base })))
  const cacheRows = days.filter((row) => row.tokens > 0).slice(-10).map((row) => ({ label: row.key.slice(5), note: `${fmt.compact(row.cacheRead)} cache-read tokens`, value: row.cacheRead / row.tokens }))
  renderAnalysisBars('#cacheDays', cacheRows, { format: fmt.pct })
}

/**
 * The Pattern view's charts, drawn at their rendered size.
 *
 * Each chart sets its viewBox width to the width it actually occupies, so one
 * viewBox unit is one CSS pixel and a font size declared in the stylesheet is
 * the size it draws at. A fixed viewBox scaled by the column span instead, so
 * the same 9px label came out at 12px in the eight-column card and at 9px in
 * the six-column one, and the three charts on this view disagreed about how
 * large type was. The heights stay fixed for the same reason: at a scale of
 * one they are pixel heights.
 *
 * The view ships hidden, where a measurement is zero, so `layoutPatternCharts`
 * redraws it when the tab is opened. The fallback widths are what the first,
 * unmeasured pass draws with.
 */
const PATTERN_CHART = { height: 230, top: 18, baseline: 190, span: 172, tickY: 207, fallbackWidth: 880 }
const PATTERN_WEEK_CHART = { height: 226, top: 24, baseline: 196, span: 172, tickY: 212, margin: 10, fallbackWidth: 420 }
const PATTERN_GRID_STEPS = [0, .25, .5, .75]
const PATTERN_HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21]

/**
 * How many recorded days the two dot charts scatter.
 *
 * Every figure printed on this view covers the whole selected period; the cap
 * thins only the scatter, which shows spread rather than any total. Without it
 * an ALL range over a year-old ledger puts nine thousand circles on the page,
 * each one carrying a tooltip binding, and the card says so whenever the cap
 * actually bites.
 */
const PATTERN_SCATTER_DAYS = 60

const clockHour = (hour) => String(((Math.round(hour) % 24) + 24) % 24).padStart(2, '0')
const clockLabel = (hour) => `${clockHour(hour)}:00`
const clockRange = (from, to) => `${clockHour(from)}–${clockHour(to)}H`

/** Older days fade rather than vanish. The exponent holds the last week or two
 *  at full strength without erasing the month behind them. */
const recencyFade = (day, floor, range) => (floor + range * day.recency ** 1.4).toFixed(2)

/** The heat ramp, mixed in CSS rather than resolved here, so a system theme
 *  change repaints the map without waiting for a re-render. */
const heatMix = (shade) => `color-mix(in srgb, var(--heat-chill) ${(clamp(shade, 0, 1) * 100).toFixed(1)}%, var(--paper-hi))`

/** A series as a live `var()` reference rather than a resolved colour, for the
 *  same reason. */
const seriesColor = (series) => `var(${series.variable}, ${series.fallback})`

/** The width a chart occupies, which is the width its viewBox takes. Zero
 *  while the view is hidden, which is what the fallback is for. */
function patternWidth(element, fallback) {
  const measured = Math.round(element?.getBoundingClientRect().width || 0)
  return measured > 0 ? measured : fallback
}

/** The hour axis, laid out across `width` so all 24 columns fill the card. */
function hourAxis(width) {
  const step = width / 24
  return {
    width,
    step,
    column: (hour) => hour * step,
    dot: (hour) => (hour + .5) * step,
    barX: (hour) => hour * step + step * .14,
    barWidth: step * .72,
  }
}

/** The weekday axis, laid out the same way across seven columns. */
function weekdayAxis(width) {
  const { margin } = PATTERN_WEEK_CHART
  const step = (width - margin * 2) / 7
  return { width, step, left: margin, right: width - margin, at: (weekday) => margin + (weekday + .5) * step }
}

/**
 * The scale ceiling for a set of readings, with outliers clamped off the top.
 *
 * One slot several times the size of the next flattens every other reading
 * into the palest step of a ramp or the bottom pixel of a chart, which is what
 * this exists to stop. The fence comes from `robustTokenTrafficScale`, already
 * the portal's one owner of what counts as an outlier, so the heatmap, the dot
 * charts and the token traffic bins all call the same readings extreme.
 *
 * A mark above the ceiling is drawn at the ceiling and marked, never dropped;
 * `clamped` is how many, so the card can say so.
 */
function patternCeiling(values) {
  const recorded = values.filter((value) => value > 0)
  if (!recorded.length) return { ceiling: 1, clamped: 0 }
  const scale = robustTokenTrafficScale(recorded)
  const ceiling = Math.max(1, Math.min(scale.max, scale.rawMax))
  return { ceiling, clamped: recorded.filter((value) => value > ceiling).length }
}

/** "3 slots above the scale", or nothing when the scale holds everything. */
function clampNote(clamped, noun) {
  if (!clamped) return ''
  return `${clamped} ${noun}${clamped === 1 ? '' : 's'} above the scale`
}

function renderPatternAnalysis(sessions, projectColors) {
  const pattern = buildUsagePattern(sessions, { dateKey: localDateKey, hour: localHour })
  state.pattern = pattern
  state.patternProjectColors = projectColors
  // A period change can retire the week the heatmap was paged to, and a key
  // that is no longer in the window would page it to an empty grid.
  if (state.patternWeek && !pattern.weeks.some((week) => week.key === state.patternWeek)) state.patternWeek = null
  renderPatternKpis(pattern)
  if (!pattern.tokens) {
    renderPatternEmpty()
    return
  }
  renderPatternHeat(pattern)
  renderPatternDay(pattern)
  renderPatternWeek(pattern)
  renderPatternTerritories(pattern)
  renderPatternProjects(pattern, projectColors)
  const quiet = pattern.quietStretch
  $('#patternNote').textContent = quiet
    ? `The ${clockRange(quiet.start, quiet.end)} stretch carries ${fmt.pct(quiet.tokens / pattern.tokens)} of period volume, against ${fmt.pct(pattern.peakHour.tokens / pattern.tokens)} in the single hour beginning ${clockLabel(pattern.peakHour.index)}.`
    : 'Volume is spread evenly enough across the clock that no run of hours stays under 12% of the busiest one.'
}

/** Redraw everything whose geometry depends on a measurement, which is
 *  everything that can only be measured once the view is on screen. */
function layoutPatternCharts() {
  const pattern = state.pattern
  if (!pattern || !pattern.tokens) return
  renderPatternHeat(pattern)
  renderPatternDay(pattern)
  renderPatternWeek(pattern)
  renderPatternTerritories(pattern)
  renderPatternProjects(pattern, state.patternProjectColors)
  bindPageInteractions()
}

function renderPatternKpis(pattern) {
  const quiet = pattern.quietStretch
  renderKpis('#patternKpis', [
    {
      label: 'Peak slot',
      value: pattern.tokens ? `${WEEKDAY_LABELS[pattern.peakSlot.weekday]} ${clockLabel(pattern.peakSlot.hour)}` : '—',
      note: pattern.tokens ? `${fmt.compact(pattern.peakSlot.tokens)} tokens in one hour-slot` : 'No recorded volume',
    },
    {
      label: 'Daypart lead',
      value: pattern.tokens ? `${pattern.dayparts.lead.range} / ${fmt.pct(pattern.dayparts.lead.share)}` : '—',
      note: 'Largest six-hour share of volume',
    },
    { label: 'Half-volume footprint', value: `${pattern.halfVolumeSlots} / ${SLOTS_IN_WEEK}`, note: 'Hour-slots holding 50% of tokens' },
    { label: 'Quiet stretch', value: quiet ? clockRange(quiet.start, quiet.end) : '—', note: 'Longest run under 12% of the peak hour' },
  ])
}

function renderPatternEmpty() {
  const message = 'No recorded volume in the selected period.'
  $('#patternHeat').innerHTML = `<p class="pattern-empty">${message}</p>`
  for (const selector of ['#patternDayLegend', '#patternDayStats', '#patternWeekLegend', '#patternSplit', '#patternProjectRows', '#patternDayChart', '#patternWeekChart', '#patternProjectChart']) {
    $(selector).innerHTML = ''
  }
  for (const selector of ['#patternHeatCaption', '#patternWeekCaption', '#patternSplitCaption', '#patternProjectCaption']) {
    $(selector).textContent = ''
  }
  $('#patternDayMeta').textContent = 'Hour-of-day totals'
  $('#patternWeekLabel').textContent = 'NO WEEKS'
  $$('#patternWeekNav button').forEach((button) => { button.disabled = true })
  $('#patternNote').textContent = message
}

/**
 * The heatmap, showing either the whole period folded or one calendar week.
 *
 * A week and the period fold are the same 7 by 24 shape, so paging between
 * them is a change of source rather than a second chart. Which one is on
 * screen is stated in the nav rather than left to be inferred from the
 * shading.
 */
function renderPatternHeat(pattern) {
  const weeks = pattern.weeks
  const active = weeks.find((week) => week.key === state.patternWeek) || null
  const matrix = active ? active.matrix : pattern.matrix
  const dayTotals = active ? active.dayTotals : pattern.dayTotals
  const tokens = active ? active.tokens : pattern.tokens
  const peak = active ? active.peakSlot : pattern.peakSlot
  const peakDay = dayTotals.indexOf(Math.max(...dayTotals))
  const { ceiling, clamped } = patternCeiling(matrix.flat())

  const cells = []
  for (let weekday = 0; weekday < WEEKDAY_LABELS.length; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const slot = matrix[weekday][hour]
      // The ramp is deliberately not linear: token volume is heavy-tailed, and
      // a linear map leaves every hour but the busiest indistinguishable even
      // after the outliers are clamped off the top.
      const shade = (Math.min(slot, ceiling) / ceiling) ** .65
      const over = slot > ceiling
      const isPeak = weekday === peak.weekday && hour === peak.hour && slot > 0
      const classes = [shade > .55 ? 'solid' : '', isPeak ? 'peak' : ''].filter(Boolean).join(' ')
      const tip = `${WEEKDAY_LABELS[weekday]} ${clockLabel(hour)} | ${escapeAttribute(fmt.compact(slot))} tokens${over ? ' | above the scale' : ''}`
      cells.push(`<i class="${classes}" style="--heat:${heatMix(shade)}" data-tip="${tip}"></i>`)
    }
  }
  const totals = dayTotals.map((value, weekday) => weekday === peakDay && value > 0
    ? `<b>${escapeText(fmt.compact(value))}</b>`
    : `<span>${escapeText(fmt.compact(value))}</span>`).join('')

  $('#patternHeat').innerHTML = `
    <div class="pattern-heat-grid">
      <div class="pattern-heat-labels">${WEEKDAY_LABELS.map((label) => `<span>${label}</span>`).join('')}</div>
      <div class="pattern-heat-cells">${cells.join('')}<div class="pattern-heat-weekend"></div></div>
      <div class="pattern-heat-totals">${totals}</div>
    </div>
    <div class="pattern-heat-axis">
      <span></span>
      <div class="pattern-heat-hours">${Array.from({ length: 24 }, (_, hour) => `<span>${hour % 3 === 0 ? clockHour(hour) : ''}</span>`).join('')}</div>
      <span class="pattern-heat-sigma">DAY &Sigma;</span>
    </div>
    <div class="pattern-heat-scale">None${[0, .25, .5, .75, 1].map((shade) => `<i class="${shade > .5 ? 'solid' : ''}" style="--heat:${heatMix(shade)}"></i>`).join('')}${escapeText(fmt.compact(ceiling))}${clamped ? ' and above' : ''}<span class="pattern-peak-key"><i></i>Peak slot</span></div>`

  const heaviest = peak.tokens > 0 ? ` Heaviest slot: ${WEEKDAY_NAMES[peak.weekday]} ${clockLabel(peak.hour)}, ${fmt.compact(peak.tokens)} tokens.` : ''
  // The legend already reads "N and above", so the caption only has to say how
  // many. Spelling out what clamping means here cost the caption a second line
  // on some weeks and not others, which is the shift this card cannot afford.
  const clampSentence = clamped ? ` ${clampNote(clamped, 'slot')}.` : ''
  $('#patternHeatCaption').textContent = active
    ? `Week of ${fmt.dayYear(active.key)}: ${fmt.compact(tokens)} tokens, ${fmt.pct(tokens / pattern.tokens)} of the period.${heaviest}${clampSentence}`
    : `${fmt.compact(tokens)} tokens across ${SLOTS_IN_WEEK} hour-slots. Half of that volume sits in ${pattern.halfVolumeSlots} of them.${heaviest}${clampSentence}`

  const index = active ? weeks.findIndex((week) => week.key === active.key) : weeks.length
  $('#patternWeekLabel').textContent = active
    ? `${fmt.day(active.key)} – ${fmt.day(active.endKey)}`
    : `ALL ${weeks.length} WEEK${weeks.length === 1 ? '' : 'S'}`
  $('[data-pattern-week="older"]').disabled = index <= 0
  $('[data-pattern-week="newer"]').disabled = index >= weeks.length
  $('#patternWeekAll').classList.toggle('active', !active)
}

/**
 * Step the heatmap through the weeks in the window.
 *
 * The pages run oldest week to newest and then the folded period, so both
 * arrows always mean the same direction in time and the aggregate is where
 * stepping forward ends rather than a mode beside the sequence.
 */
function shiftPatternWeek(action) {
  const weeks = state.pattern?.weeks || []
  if (!weeks.length) return
  if (action === 'all') {
    state.patternWeek = null
  } else {
    const index = state.patternWeek ? weeks.findIndex((week) => week.key === state.patternWeek) : weeks.length
    const next = clamp(index + (action === 'older' ? -1 : 1), 0, weeks.length)
    state.patternWeek = next === weeks.length ? null : weeks[next].key
  }
  renderPatternHeat(state.pattern)
  bindPageInteractions()
}

/** Gridlines, baseline and hour ticks, shared by the two charts that carry the
 *  hour axis so neither can drift from the other. */
function patternHourFrame(axis, max, clamped) {
  const { top, baseline, span, tickY } = PATTERN_CHART
  const grid = PATTERN_GRID_STEPS.map((step) => {
    const y = top + span * step
    const value = fmt.compact(max * (1 - step))
    return `<line class="pattern-gridline" x1="0" y1="${y.toFixed(1)}" x2="${axis.width}" y2="${y.toFixed(1)}"/><text class="pattern-grid-label" x="0" y="${(y - 4).toFixed(1)}">${escapeText(step === 0 && clamped ? `≥ ${value}` : value)}</text>`
  }).join('')
  const line = `<line class="pattern-axis" x1="0" y1="${baseline}" x2="${axis.width}" y2="${baseline}"/>`
  const ticks = PATTERN_HOUR_TICKS.map((hour) => `<text x="${axis.column(hour).toFixed(1)}" y="${tickY}">${clockHour(hour)}</text>`).join('')
  return { grid, axis: line, ticks }
}

function renderPatternDay(pattern) {
  const { height, top, baseline, span, fallbackWidth } = PATTERN_CHART
  const chart = $('#patternDayChart')
  const axis = hourAxis(patternWidth(chart, fallbackWidth))
  const { ceiling, clamped } = patternCeiling(pattern.days.flatMap((day) => day.hours))
  // A recorded hour of zero still earns a pixel above the baseline, so an
  // empty hour reads as measured rather than as missing.
  const y = (tokens) => baseline - Math.max(1, span * Math.min(tokens, ceiling) / ceiling)
  const scatter = pattern.days.slice(-PATTERN_SCATTER_DAYS)
  const frame = patternHourFrame(axis, ceiling, clamped)

  const band = `<rect class="pattern-band" x="${axis.column(9).toFixed(1)}" y="${top}" width="${(axis.step * 9).toFixed(1)}" height="${baseline - top}"/><text class="pattern-band-label" x="${axis.column(13.5).toFixed(1)}" y="${top + 12}" text-anchor="middle">WORKING HOURS 09&ndash;18</text>`
  const quiet = pattern.quietStretch
  const quietMarks = quiet
    ? `<line class="pattern-quiet" x1="${axis.column(quiet.start).toFixed(1)}" y1="${top}" x2="${axis.column(quiet.start).toFixed(1)}" y2="${baseline}"/><line class="pattern-quiet" x1="${axis.column(quiet.end).toFixed(1)}" y1="${top}" x2="${axis.column(quiet.end).toFixed(1)}" y2="${baseline}"/><text class="pattern-quiet-label" x="${axis.column((quiet.start + quiet.length / 2) % 24).toFixed(1)}" y="${baseline - 6}" text-anchor="middle">QUIET</text>`
    : ''
  const lines = scatter.map((day) => {
    const path = day.hours.map((tokens, hour) => `${hour ? 'L' : 'M'}${axis.dot(hour).toFixed(1)} ${y(tokens).toFixed(1)}`).join(' ')
    const opacity = day.recency === 1 ? '0.45' : recencyFade(day, .03, .12)
    return `<path class="pattern-day-line" d="${path}" stroke-opacity="${opacity}" data-tip="${escapeAttribute(fmt.dayYear(day.key))} | ${escapeAttribute(fmt.compact(day.tokens))} tokens"/>`
  }).join('')
  const mean = pattern.hourMeans.map((tokens, hour) => `${hour ? 'L' : 'M'}${axis.dot(hour).toFixed(1)} ${y(tokens).toFixed(1)}`).join(' ')
  const dots = scatter.flatMap((day) => day.hours.map((tokens, hour) => {
    const over = tokens > ceiling
    return `<circle class="pattern-dot${over ? ' clamped' : ''}" cx="${axis.dot(hour).toFixed(1)}" cy="${y(tokens).toFixed(1)}" r="2.2" fill-opacity="${recencyFade(day, .1, .75)}" data-tip="${escapeAttribute(fmt.day(day.key))} ${clockLabel(hour)} | ${escapeAttribute(fmt.compact(tokens))} tokens${over ? ' | above the scale' : ''}"/>`
  })).join('')

  chart.setAttribute('viewBox', `0 0 ${axis.width} ${height}`)
  chart.innerHTML = `${frame.grid}${band}${quietMarks}${lines}<path class="pattern-mean-line" d="${mean}"/>${dots}${frame.axis}${frame.ticks}`
  $('#patternDayLegend').innerHTML = `
    <span class="pattern-ramp"><i style="opacity:.2"></i><i style="opacity:.55"></i><i></i> Older &rarr; recent day</span>
    <span><i class="pattern-swatch-mean"></i> Hourly mean</span>
    <span><i class="pattern-swatch-thin"></i> Same day</span>
    <span><i class="pattern-swatch-band"></i> Working hours 09&ndash;18</span>
    <span><i class="pattern-swatch-dashed"></i> Quiet stretch (&lt;12% of peak)</span>`
  $('#patternDayStats').innerHTML = [
    ['Busiest hour', clockLabel(pattern.peakHour.index)],
    ['Heaviest slot', `${WEEKDAY_LABELS[pattern.peakSlot.weekday]} ${clockLabel(pattern.peakSlot.hour)}`],
    ['Quietest stretch', quiet ? clockRange(quiet.start, quiet.end) : '—'],
  ].map(([label, value]) => `<div class="pattern-stat"><span>${label}</span><b>${escapeText(value)}</b></div>`).join('')
  const scope = scatter.length < pattern.days.length
    ? `${scatter.length} most recent of ${pattern.days.length} recorded days`
    : `${pattern.days.length} recorded day${pattern.days.length === 1 ? '' : 's'}`
  const note = clampNote(clamped, 'reading')
  $('#patternDayMeta').textContent = note ? `${scope} / ${note}` : scope
}

function renderPatternWeek(pattern) {
  const { height, top, baseline, span, tickY, fallbackWidth } = PATTERN_WEEK_CHART
  const chart = $('#patternWeekChart')
  const axis = weekdayAxis(patternWidth(chart, fallbackWidth))
  const { ceiling, clamped } = patternCeiling(pattern.days.map((day) => day.tokens))
  const y = (tokens) => baseline - span * Math.min(tokens, ceiling) / ceiling
  const scatter = pattern.days.slice(-PATTERN_SCATTER_DAYS)
  const drawn = new Set(scatter.map((day) => day.key))
  const weeks = pattern.weeks
    .map((week) => ({ key: week.key, days: week.days.filter((day) => drawn.has(day.key)) }))
    .filter((week) => week.days.length > 1)
  const latestWeek = weeks[weeks.length - 1]?.key
  const tick = Math.min(14, axis.step * .3)

  const grid = PATTERN_GRID_STEPS.map((step) => {
    const line = top + span * step
    const value = fmt.compact(ceiling * (1 - step))
    return `<line class="pattern-gridline" x1="${axis.left}" y1="${line.toFixed(1)}" x2="${axis.right}" y2="${line.toFixed(1)}"/><text class="pattern-grid-label" x="${axis.left}" y="${(line - 4).toFixed(1)}">${escapeText(step === 0 && clamped ? `≥ ${value}` : value)}</text>`
  }).join('')
  const band = `<rect class="pattern-band" x="${axis.left}" y="${top}" width="${(axis.step * 5).toFixed(1)}" height="${baseline - top}"/>`
  const lines = weeks.map((week) => {
    const days = week.days.slice().sort((one, other) => one.weekday - other.weekday)
    const path = days.map((day, index) => `${index ? 'L' : 'M'}${axis.at(day.weekday).toFixed(1)} ${y(day.tokens).toFixed(1)}`).join(' ')
    const label = `${fmt.day(days[0].key)} – ${fmt.day(days[days.length - 1].key)}`
    return `<path class="pattern-week-line" d="${path}" stroke-opacity="${week.key === latestWeek ? '0.65' : '0.18'}" data-tip="${escapeAttribute(`${label}${week.key === latestWeek ? ' | most recent week' : ''}`)}"/>`
  }).join('')
  const means = pattern.weekdayMeans.map((tokens, weekday) => tokens
    ? `<line class="pattern-mean-tick" x1="${(axis.at(weekday) - tick).toFixed(1)}" y1="${y(tokens).toFixed(1)}" x2="${(axis.at(weekday) + tick).toFixed(1)}" y2="${y(tokens).toFixed(1)}" data-tip="${WEEKDAY_NAMES[weekday]} mean | ${escapeAttribute(fmt.compact(tokens))} tokens"/>`
    : '').join('')
  const dots = scatter.map((day) => {
    const over = day.tokens > ceiling
    return `<circle class="pattern-dot${over ? ' clamped' : ''}" cx="${axis.at(day.weekday).toFixed(1)}" cy="${y(day.tokens).toFixed(1)}" r="4" fill-opacity="${recencyFade(day, .14, .8)}" data-tip="${escapeAttribute(`${fmt.dayYear(day.key)} (${WEEKDAY_NAMES[day.weekday]})`)} | ${escapeAttribute(fmt.compact(day.tokens))} tokens${over ? ' | above the scale' : ''}"/>`
  }).join('')
  const ticks = WEEKDAY_LABELS.map((label, weekday) => `<text class="${weekday >= 5 ? 'pattern-weekend-tick' : ''}" x="${axis.at(weekday).toFixed(1)}" y="${tickY}" text-anchor="middle">${label}</text>`).join('')

  chart.setAttribute('viewBox', `0 0 ${axis.width} ${height}`)
  chart.innerHTML = `${band}${grid}${lines}${means}${dots}<line class="pattern-axis" x1="${axis.left}" y1="${baseline}" x2="${axis.right}" y2="${baseline}"/>${ticks}`
  $('#patternWeekLegend').innerHTML = `
    <span class="pattern-ramp"><i style="opacity:.2"></i><i style="opacity:.55"></i><i></i> Older &rarr; recent day</span>
    <span><i class="pattern-swatch-thin"></i> Most recent week</span>
    <span><i class="pattern-swatch-mean"></i> Weekday mean</span>
    <span><i class="pattern-swatch-band"></i> Working days MON&ndash;FRI</span>`

  const { peakDay, leastDay } = pattern
  const ratio = leastDay.tokens ? peakDay.tokens / leastDay.tokens : null
  const spread = ratio === null ? '' : ` (${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× apart)`
  const weekend = (pattern.dayTotals[5] + pattern.dayTotals[6]) / pattern.tokens
  const note = clampNote(clamped, 'day')
  $('#patternWeekCaption').textContent = `${WEEKDAY_NAMES[peakDay.index]}: ${fmt.compact(peakDay.tokens)}. ${WEEKDAY_NAMES[leastDay.index]}: ${fmt.compact(leastDay.tokens)}${spread}. Weekend: ${fmt.pct(weekend)} of the period.${note ? ` ${note}.` : ''}`
}

/**
 * The four time territories, each labelled inside the bar it draws.
 *
 * The legend used to sit in a table underneath, so reading a segment meant
 * matching a colour to a row. Putting the name and the numbers inside the
 * segment removes that lookup, and it is why the token bar is sized for type
 * rather than for the stripe. The territories are ordered rather than
 * categorical, so they take the portal's four-step tonal ramp instead of four
 * competing hues.
 */
function renderPatternTerritories(pattern) {
  const width = patternWidth($('#patternSplit'), 620)
  const series = pattern.territories.map((territory, index) => ({
    ...territory,
    color: seriesColor(territorySeriesFor(territory.key)),
    // The ramp inverts under the dark palette, so a segment says which end of
    // it it sits on and the stylesheet decides what colour reads on that.
    tone: index < 2 ? 'on-heavy' : 'on-faint',
  }))

  let carried = 0
  const dividers = series.slice(0, -1).map((territory) => {
    carried += territory.timeShare * 100
    return `<div class="pattern-split-divider" style="left:${carried.toFixed(2)}%"></div>`
  }).join('')

  const tip = (territory) => `${escapeAttribute(territory.label)} | ${fmt.pct(territory.timeShare)} of the week | ${fmt.pct(territory.share)} of tokens`
  const timeBar = series.map((territory) => `<i style="--series:${territory.color};width:${(territory.timeShare * 100).toFixed(1)}%" data-tip="${tip(territory)}"></i>`).join('')
  const tokenBar = series.map((territory) => {
    const room = territory.share * width
    const label = room >= 92 ? `<span class="pattern-seg-label">${escapeText(territory.label)}${room >= 150 ? `<small class="pattern-seg-range">${escapeText(territory.range)}</small>` : ''}</span>` : ''
    const value = room >= 54 ? `<b class="pattern-seg-value">${fmt.pct(territory.share)}</b>` : ''
    const meta = room >= 150 ? `<span class="pattern-seg-meta">${escapeText(fmt.compact(territory.tokens))} / ${fmt.pct(territory.timeShare)} of the week</span>` : ''
    return `<i class="${territory.tone}" style="--series:${territory.color};width:${(territory.share * 100).toFixed(1)}%" data-tip="${tip(territory)}">${label}${value}${meta}</i>`
  }).join('')

  $('#patternSplit').innerHTML = `
    <span class="pattern-split-label">Share of the week's hours</span>
    <div class="pattern-split-bars">
      <div class="pattern-split-bar time">${timeBar}</div>
      <span class="pattern-split-label spaced">Share of recorded tokens</span>
      <div class="pattern-split-bar tokens">${tokenBar}</div>
      ${dividers}
    </div>`

  const [work, evening] = series
  // A segment with no room for its name is only a stripe until the caption
  // says whose it is, so the caption names exactly the ones the bar could not.
  //
  // How many that is depends on where the reader is standing, since the fold
  // is cut on local hours, so the note is bounded for the case where the bar
  // names none of them. The sentence ahead of it is 128 characters with every
  // percentage at its widest form, `100%`. The note opens with 18 and closes
  // with 1; the four short names with a widest percentage each come to 56, and
  // the three commas between them to 6. That is 209 against the caption's
  // 210-character budget. A real bar never reaches it: four segments each
  // under 92px cannot fill a bar 368px or wider, and the narrowest window the
  // shell opens draws this one at 453. Three unnamed is the true worst case,
  // at 195, and the ranges are dropped to reach it: each is in its segment's
  // tooltip, and the work-hours range is in the first sentence above.
  const unnamed = series.filter((territory) => territory.share * width < 92)
  const unnamedNote = unnamed.length
    ? ` Unnamed stripes: ${unnamed.map((territory) => `${territory.short} ${fmt.pct(territory.share)}`).join(', ')}.`
    : ''
  $('#patternSplitCaption').textContent = `${fmt.pct(1 - work.share)} of recorded volume ran outside MON–FRI 09–18H, which is ${fmt.pct(1 - work.timeShare)} of the week's hours. Weekday evenings: ${fmt.pct(evening.share)}; work hours: ${fmt.pct(work.share)}.${unnamedNote}`
}

function renderPatternProjects(pattern, projectColors) {
  const { height, baseline, span, fallbackWidth } = PATTERN_CHART
  const chart = $('#patternProjectChart')
  const axis = hourAxis(patternWidth(chart, fallbackWidth))
  const max = Math.max(1, ...pattern.hourTotals)
  const rows = pattern.projects.map((row) => ({
    ...row,
    color: seriesColor(row.other ? OTHER_PROJECT_SERIES : projectSeriesFor(row.project, projectColors)),
  }))
  const frame = patternHourFrame(axis, max, false)
  const stack = []
  for (let hour = 0; hour < 24; hour += 1) {
    let carried = 0
    for (const row of rows) {
      const tokens = row.hours[hour]
      if (tokens <= 0) continue
      const barHeight = span * tokens / max
      const y = baseline - span * (carried + tokens) / max
      stack.push(`<rect class="pattern-stack" style="--series:${row.color}" x="${axis.barX(hour).toFixed(1)}" y="${y.toFixed(1)}" width="${axis.barWidth.toFixed(1)}" height="${Math.max(.5, barHeight).toFixed(1)}" data-tip="${escapeAttribute(row.project)} | ${clockLabel(hour)} | ${escapeAttribute(fmt.compact(tokens))} tokens"/>`)
      carried += tokens
    }
  }

  chart.setAttribute('viewBox', `0 0 ${axis.width} ${height}`)
  chart.innerHTML = `${frame.grid}${stack.join('')}${frame.axis}${frame.ticks}`
  $('#patternProjectRows').innerHTML = `${rows.map((row) => `
    <div class="pattern-row">
      <i style="--series:${row.color}"></i>
      <span class="pattern-row-name">${escapeText(row.project)}</span>
      <span class="pattern-row-muted">${fmt.pct(row.share)}</span>
      <span class="pattern-row-muted">${row.peakHour === null ? '—' : escapeText(clockRange(row.windowStart, row.windowEnd))}</span>
    </div>`).join('')}
    <div class="pattern-row-foot"><span></span><span></span><span>Share</span><span>Peak window</span></div>`

  const peaked = rows.filter((row) => row.peakHour !== null && !row.other).sort((one, other) => one.peakHour - other.peakHour)
  const earliest = peaked[0]
  const latest = peaked[peaked.length - 1]
  $('#patternProjectCaption').textContent = peaked.length > 1
    ? `Earliest peak: ${earliest.project} at ${clockLabel(earliest.peakHour)}. Latest: ${latest.project} at ${clockLabel(latest.peakHour)}.`
    : peaked.length === 1
      ? `${earliest.project} peaks at ${clockLabel(earliest.peakHour)} and is the only named project carrying recorded volume.`
      : ''
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(seconds || 0))
  if (value < 60) return `${value}s`
  const minutes = Math.floor(value / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function sortRows(rows, sort, readers) {
  const read = readers[sort.key]
  return rows.slice().sort((a, b) => {
    const left = read(a)
    const right = read(b)
    if (left < right) return -sort.direction
    if (left > right) return sort.direction
    return 0
  })
}

function sortMark(key, sort) {
  return sort.key === key ? (sort.direction < 0 ? ' ↓' : ' ↑') : ''
}

function renderProjectAnalysis(projectSummary) {
  const sorted = sortRows(projectSummary.all, state.projectSort, {
    project: (row) => row.project.toLowerCase(),
    sessions: (row) => row.sessions,
    cost: (row) => row.cost,
    tokens: (row) => row.tokens,
    avgCost: (row) => row.avgCost,
    durSec: (row) => row.durSec,
    family: (row) => row.family,
    machines: (row) => row.machineCount,
    last: (row) => row.last,
  })
  const top = projectSummary.byCost[0]
  const busiest = projectSummary.all.slice().sort((a, b) => b.sessions - a.sessions)[0]
  renderKpis('#projectKpis', [
    { label: 'Projects', value: String(projectSummary.all.length), note: 'Active in selected period' },
    { label: 'Top spender', value: fmt.usd(top?.cost || 0), note: top?.project || 'No activity' },
    { label: 'Busiest', value: `${busiest?.sessions || 0} sessions`, note: busiest?.project || 'No activity' },
    { label: 'Average / project', value: fmt.usd(projectSummary.totalCost / Math.max(1, projectSummary.all.length)), note: 'API-equivalent value' },
  ])
  $('#projectCount').textContent = `${projectSummary.all.length} project${projectSummary.all.length === 1 ? '' : 's'} / click a row for detail`
  const columns = [
    ['project', 'Project'], ['sessions', 'Sessions'], ['cost', 'Spend'], ['tokens', 'Tokens'], ['avgCost', 'Avg / session'], ['durSec', 'Duration'], ['family', 'Top model'], ['machines', 'Boxes'], ['last', 'Last active'],
  ]
  $('#projectTable').innerHTML = `<thead><tr>${columns.map(([key, label]) => `<th data-project-sort="${key}" class="${['sessions', 'cost', 'tokens', 'avgCost', 'durSec', 'machines'].includes(key) ? 'numeric' : ''}">${label}${sortMark(key, state.projectSort)}</th>`).join('')}</tr></thead><tbody>${sorted.map((row) => `<tr data-analysis-project="${escapeAttribute(row.project)}"><td class="primary">${escapeText(row.project)}</td><td class="numeric">${row.sessions}</td><td class="numeric">${fmt.usd(row.cost)}</td><td class="numeric">${fmt.compact(row.tokens)}</td><td class="numeric">${fmt.usd(row.avgCost)}</td><td class="numeric">${formatDuration(row.durSec)}</td><td><i class="model-mark" style="--series:${styleForFamily(row.family).base}"></i>${escapeText(row.family)}</td><td class="numeric">${row.machineCount}</td><td>${fmt.dateYear(new Date(row.last))}</td></tr>`).join('')}</tbody>`
}

function renderSessionAnalysis(sessions) {
  const query = state.sessionQuery.trim().toLowerCase()
  const filtered = query ? sessions.filter((session) => [session.slug, session.sid, session.project, session.machine, session.provider, ...(session.models || [])].some((value) => String(value || '').toLowerCase().includes(query))) : sessions
  const sorted = sortRows(filtered, state.sessionSort, {
    slug: (session) => session.slug || session.sid || '',
    project: (session) => session.project.toLowerCase(),
    machine: (session) => session.machine.toLowerCase(),
    model: (session) => session.primaryModel,
    start: (session) => Date.parse(session.start),
    durSec: (session) => session.durSec || 0,
    tokens: (session) => session.totalTokens || 0,
    cost: (session) => session.cost || 0,
  })
  $('#sessionCount').textContent = `${sorted.length} of ${sessions.length} sessions / ${fmt.usd(sum(sorted, (session) => session.cost || 0))}`
  const columns = [
    ['slug', 'Session'], ['project', 'Project'], ['machine', 'Machine'], ['model', 'Model'], ['start', 'Started'], ['durSec', 'Duration'], ['tokens', 'Tokens'], ['cost', 'Cost'],
  ]
  $('#sessionTable').innerHTML = `<thead><tr>${columns.map(([key, label]) => `<th data-session-sort="${key}" class="${['durSec', 'tokens', 'cost'].includes(key) ? 'numeric' : ''}">${label}${sortMark(key, state.sessionSort)}</th>`).join('')}</tr></thead><tbody>${sorted.map((session) => {
    const family = familyOf(session.primaryModel)
    return `<tr data-analysis-session="${session._i}"><td>${escapeText(session.slug || session.sid || 'Session')}</td><td class="primary">${escapeText(session.project)}</td><td>${escapeText(session.machine)}</td><td><i class="model-mark" style="--series:${styleForFamily(family).base}"></i>${escapeText(shortModel(session.primaryModel))}</td><td>${fmt.dateYear(new Date(session.start))} / ${clockTime(Date.parse(session.start))}</td><td class="numeric">${escapeText(session.durHuman || formatDuration(session.durSec))}</td><td class="numeric">${fmt.compact(session.totalTokens || 0)}</td><td class="numeric">${fmt.usd(session.cost || 0)}</td></tr>`
  }).join('')}</tbody>`
}

function applyPortalView() {
  $$('.portal-view').forEach((view) => { view.hidden = view.dataset.view !== state.view })
  $$('[data-portal-view]').forEach((trigger) => {
    const active = trigger.dataset.portalView === state.view
    trigger.classList.toggle('active', active)
    if (trigger.getAttribute('role') === 'tab') trigger.setAttribute('aria-selected', String(active))
    else if (active) trigger.setAttribute('aria-current', 'page')
    else trigger.removeAttribute('aria-current')
  })
  document.body.classList.toggle('settings-active', state.view === 'settings')
  // The Pattern charts size themselves to the width they occupy, and a hidden
  // view measures zero, so the first chance to draw them at their real size is
  // the moment the tab is opened.
  if (state.view === 'pattern') layoutPatternCharts()
}

function renderSettings() {
  if (!state.settings) return
  const { ledger, capturePolicy, providers } = state.settings
  const ledgerSource = ledger.source === 'default'
    ? 'Local default'
    : ledger.source === 'detected'
      ? 'Detected synchronized ledger'
      : 'Selected folder'
  $('#settingsLedgerPath').innerHTML = `${escapeText(ledger.root)}<span class="settings-path-meta">${ledgerSource}</span>`
  $('#settingsCaptureNote').textContent = capturePolicy.default === 'continuous'
    ? 'Continuous is the default. Best-effort hooks checkpoint usage while you work; opening the app and Sync now always reconcile available transcripts.'
    : 'Batch sync is the default. No hook is installed unless an agent overrides it; opening the app and Sync now reconcile available transcripts.'
  $$('[data-settings-action="capture-policy"]:not([data-provider])').forEach((button) => {
    const active = button.dataset.strategy === capturePolicy.default
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })
  renderCaptureMonitor(providers)

  $('#settingsProviderLocations').innerHTML = providers.map((provider) => {
    const source = provider.source === 'custom'
      ? 'Custom pointer'
      : provider.source === 'environment'
        ? `${provider.environmentVariable} environment`
        : 'Default location'
    const status = provider.sessions > 0
      ? `${provider.sessions} session${provider.sessions === 1 ? '' : 's'} found`
      : provider.available
        ? 'Folder found / no sessions'
        : 'Folder not found'
    const reset = provider.source === 'custom'
      ? `<button class="settings-button" data-settings-action="reset-provider" data-provider="${provider.provider}">Reset to automatic</button>`
      : ''
    const captureButtons = [
      ['continuous', 'Continuous'],
      ['batch', 'Batch sync'],
    ].map(([strategy, label]) => {
      const active = provider.captureOverride && provider.captureStrategy === strategy
      return `<button class="settings-button${active ? ' active' : ''}" aria-pressed="${active}" data-settings-action="capture-policy" data-provider="${provider.provider}" data-strategy="${strategy}">${label}</button>`
    }).join('')
    const inherited = !provider.captureOverride
    const captureStatus = provider.captureStrategy === 'continuous'
      ? 'Best-effort hook + app reconciliation'
      : 'App open + Sync now only'
    const diagnostic = captureMonitorPresentation(provider.captureMonitor, provider)
    return `<section class="provider-location ${provider.captureMonitor.status}">
      <div class="provider-identity"><h3>${providerMark(provider.provider)}${escapeText(provider.label)}</h3><span class="provider-status">${escapeText(status)} / ${captureStatus}</span></div>
      <div class="capture-diagnostic"><strong>${escapeText(diagnostic.title)}</strong>${captureFacts(diagnostic.facts)}${diagnostic.detail ? `<p>${escapeText(diagnostic.detail)}</p>` : ''}${diagnostic.remedy ? `<p class="capture-remedy">${escapeText(diagnostic.remedy)}</p>` : ''}</div>
      <div class="settings-path">${escapeText(provider.root)}<span class="settings-path-meta">${escapeText(source)}</span></div>
      <div class="settings-segmented" aria-label="${escapeAttribute(provider.label)} capture policy">
        <button class="settings-button${inherited ? ' active' : ''}" aria-pressed="${inherited}" data-settings-action="capture-policy" data-provider="${provider.provider}" data-inherit="true">Use default</button>
        ${captureButtons}
      </div>
      <div class="provider-actions">
        <button class="settings-button" data-settings-action="choose-provider" data-provider="${provider.provider}">Choose folder</button>
        ${reset}
      </div>
    </section>`
  }).join('')
  if (providers.every((provider) => !provider.available)) {
    document.querySelector('details.settings-advanced').open = true
  }
}

function renderCaptureMonitor(providers) {
  $('#captureMonitorSummary').innerHTML = providers.map((provider) => {
    const presentation = captureMonitorPresentation(provider.captureMonitor, provider)
    const remedy = presentation.remedy
      ? `<p class="capture-channel-remedy">${escapeText(presentation.remedy)}</p>`
      : ''
    const detail = presentation.detail
      ? `<p class="capture-channel-detail">${escapeText(presentation.detail)}</p>`
      : ''
    return `<div class="capture-channel ${provider.captureMonitor.status}"><span>${providerMark(provider.provider)}<em class="capture-channel-name">${escapeText(provider.label)}</em></span><strong>${escapeText(presentation.title)}</strong>${captureFacts(presentation.facts)}${detail}${remedy}</div>`
  }).join('')

  const aggregate = captureMonitorAggregate(providers)
  const link = $('[data-capture-monitor-link]')
  link.dataset.captureStatus = aggregate.status
  $('#globalCaptureStatus').textContent = aggregate.label.toUpperCase()
  link.ariaLabel = `Open Settings: Capture ${aggregate.label}`
  link.title = aggregate.detail
  // Shown only while a reinstall would change something, so the control never
  // offers to fix a state it cannot reach.
  $('#captureMonitorRepair').hidden = !repairableProviders(providers).length
}

function repairableProviders(providers) {
  return providers.filter((provider) => provider.captureMonitor.repairable)
}

/** The sentence shown after an action, derived from the state it actually produced. */
function captureOutcomeMessage(action, providers) {
  if (action !== 'repair-capture') return 'Settings are current.'
  const stranded = providers.filter((provider) => provider.captureMonitor.status === 'needs_attention')
  if (!stranded.length) return 'Capture setup repaired.'
  const named = stranded
    .map((provider) => `${provider.label}: ${captureMonitorPresentation(provider.captureMonitor, provider).title.toLowerCase()}`)
    .join('; ')
  return `Repair ran. Still needs attention — ${named}.`
}

function captureMonitorAggregate(providers) {
  const counts = providers.reduce((result, provider) => {
    result[provider.captureMonitor.status] = (result[provider.captureMonitor.status] || 0) + 1
    return result
  }, {})
  if (counts.needs_attention) {
    return { status: 'needs_attention', label: 'Needs attention', detail: `${counts.needs_attention} local capture configuration${counts.needs_attention === 1 ? ' needs' : 's need'} attention.` }
  }
  if (counts.warning) {
    return { status: 'warning', label: 'Warning', detail: warningAggregateDetail(providers) }
  }
  if (counts.observed) {
    return { status: 'observed', label: 'Hook observed', detail: `${counts.observed} local hook${counts.observed === 1 ? '' : 's'} have delivered a checkpoint.` }
  }
  return { status: 'off', label: 'Sync only', detail: 'No local continuous hooks are active.' }
}

/** The warning tier holds two causes, so the sentence names the ones present. */
function warningAggregateDetail(providers) {
  const reasons = providers
    .filter((provider) => provider.captureMonitor.status === 'warning')
    .map((provider) => provider.captureMonitor.reason)
  const awaiting = reasons.filter((reason) => reason === 'awaiting_first_attempt').length
  const failed = reasons.filter((reason) => reason === 'last_attempt_failed').length
  const sentences = []
  if (awaiting) {
    sentences.push(`${awaiting} configured hook${awaiting === 1 ? ' is' : 's are'} waiting for a first observed checkpoint.`)
  }
  if (failed) {
    sentences.push(`${failed} hook${failed === 1 ? '' : 's'} recorded a failed attempt that clears itself on the next successful checkpoint.`)
  }
  return sentences.join(' ')
}

function captureMonitorPresentation(monitor, provider = null) {
  const observation = monitor.observation
  if (monitor.reason === 'batch_capture') {
    return { title: 'Batch sync', detail: 'Hook capture is intentionally off. App open and Sync now reconcile usage.' }
  }
  if (monitor.reason === 'agent_not_detected') {
    return { title: 'Not detected', detail: 'No local agent data folder was found.' }
  }
  // One rule, applied per reason: a button-fixable state gets the Repair
  // control (monitor.repairable, decided by the backend that owns the files);
  // anything else names the exact manual fix, or says plainly that none is
  // needed. hookConfigPath is the file the inspector actually read.
  const configPath = provider?.hookConfigPath || 'this agent’s hook settings file'
  if (monitor.reason === 'hook_missing') {
    return {
      title: 'Needs attention',
      detail: 'Continuous capture is selected, but the local hook is missing.',
      remedy: 'Choose Repair setup to reinstall it.',
    }
  }
  if (monitor.reason === 'hooks_disabled') {
    // Only Claude Code reports this reason: its settings.json carries a
    // disableAllHooks switch that a hook reinstall must not override.
    return {
      title: 'Needs attention',
      detail: 'This agent’s local settings disable hook execution.',
      remedy: `Delete "disableAllHooks": true from ${configPath}, then reopen Settings.`,
    }
  }
  if (monitor.reason === 'settings_invalid') {
    return {
      title: 'Needs attention',
      detail: `The hook settings in ${configPath} could not be read.`,
      remedy: monitor.repairable
        ? 'Choose Repair setup to rewrite it.'
        : 'Fix the JSON in that file, then reopen Settings.',
    }
  }
  if (monitor.reason === 'last_attempt_failed') {
    const failure = observation?.lastFailureMessage || ''
    return {
      title: 'Last attempt failed',
      facts: [
        { label: 'Attempt', value: keywordTime(observation?.lastAttemptAt), state: 'bad' },
        { label: 'Checkpoint', value: keywordTime(observation?.lastSuccessAt), state: 'ok' },
      ],
      detail: failure,
      remedy: 'No action needed: this clears itself on the next successful checkpoint. Usage still arrives on app open and Sync now.',
    }
  }
  if (monitor.reason === 'awaiting_first_attempt') {
    return { title: 'Waiting for first checkpoint', detail: 'Hook configuration is present, but no local delivery has been observed. Another settings scope or a managed policy may still block it.' }
  }
  // The healthy card is the one every agent shows most of the time, so it
  // states its two facts as marked rows instead of a sentence that reads the
  // same on all four. The fallback note lives once, in the row's own copy.
  return {
    title: 'Hook observed',
    facts: [
      { label: 'Attempt', value: keywordTime(observation?.lastAttemptAt), state: 'ok' },
      { label: 'Checkpoint', value: keywordTime(observation?.lastSuccessAt), state: 'ok' },
    ],
  }
}

/** A timestamp said the way someone reads it: recent by keyword, older by date. */
function keywordTime(value) {
  const parsed = Date.parse(value || '')
  if (!Number.isFinite(parsed)) return 'unknown'
  const now = Date.now()
  const elapsed = now - parsed
  if (elapsed >= 0 && elapsed < 60_000) return 'just now'
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.max(1, Math.round(elapsed / 60_000))} min ago`
  const day = localDateKey(new Date(parsed))
  if (day === localDateKey(new Date(now))) return `today ${clockTime(parsed)}`
  if (day === localDateKey(new Date(now - DAY))) return `yesterday ${clockTime(parsed)}`
  // The value shares one line with its label, so an older stamp drops the
  // clock rather than pushing the date under an ellipsis. A checkpoint from
  // another year is not a fact anyone reads to the minute.
  const sameYear = new Date(parsed).getFullYear() === new Date(now).getFullYear()
  if (!sameYear) return fmt.dateYear(new Date(parsed))
  return `${fmt.date(new Date(parsed))} ${clockTime(parsed)}`
}

const FACT_GLYPHS = {
  ok: '<path d="M2.5 6.4 5 8.9l4.5-5.3"/>',
  bad: '<path d="M6 2.4v4.4"/><path d="M6 9.1h.01"/>',
  neutral: '<path d="M2.6 6h6.8"/>',
}

/** Marked fact rows: the glyph carries the state, the label carries the noun. */
function captureFacts(facts) {
  if (!facts?.length) return ''
  return `<ul class="capture-facts">${facts.map((fact) => `
    <li class="capture-fact ${fact.state}"><svg class="capture-fact-mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">${FACT_GLYPHS[fact.state] || FACT_GLYPHS.neutral}</svg><span class="capture-fact-label">${escapeText(fact.label)}</span><span class="capture-fact-value">${escapeText(fact.value)}</span></li>`).join('')}</ul>`
}

async function loadSettings() {
  try {
    const response = await fetch('./api/settings', { cache: 'no-store' })
    const result = await response.json().catch(() => null)
    if (!response.ok) throw new Error(result?.error || `Settings failed (${response.status})`)
    state.settings = result
    renderSettings()
  } catch (error) {
    const link = $('[data-capture-monitor-link]')
    link.dataset.captureStatus = 'not_detected'
    $('#globalCaptureStatus').textContent = 'UNAVAILABLE'
    link.ariaLabel = 'Open Settings: Capture unavailable'
    link.title = 'Capture health could not be loaded.'
    setSettingsStatus(error.message || 'Settings could not load.', true)
    console.error(error.stack || error)
  }
}

async function performSettingsAction(action, detail = {}, trigger = null) {
  setSettingsBusy(true, trigger)
  setSettingsStatus('Applying settings…')
  try {
    const response = await fetch('./api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...detail }),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok) throw new Error(result?.error || `Settings failed (${response.status})`)
    state.settings = result
    renderSettings()
    if (['change-ledger', 'choose-provider', 'reset-provider'].includes(action)) {
      await load()
    }
    setSettingsStatus(captureOutcomeMessage(action, result.providers))
  } catch (error) {
    setSettingsStatus(error.message || 'Settings were not changed.', true)
    console.error(error.stack || error)
  } finally {
    setSettingsBusy(false, trigger)
  }
}

function setSettingsBusy(busy, trigger = null) {
  $$('#settingsView [data-settings-action]').forEach((button) => { button.disabled = busy })
  // A helper run costs seconds, and the page-foot status sits far below the
  // control that started it, so the button itself carries the progress.
  if (!trigger) return
  if (busy) {
    trigger.dataset.idleLabel = trigger.textContent
    trigger.textContent = trigger.dataset.busyLabel || 'Working…'
    trigger.setAttribute('aria-busy', 'true')
    return
  }
  if (trigger.dataset.idleLabel) trigger.textContent = trigger.dataset.idleLabel
  delete trigger.dataset.idleLabel
  trigger.removeAttribute('aria-busy')
}

function setSettingsStatus(message, error = false) {
  const status = $('#settingsStatus')
  status.textContent = message
  status.classList.toggle('error', error)
}

function renderProjects(projects) {
  const rows = projects.byCost.slice(0, 5)
  const max = rows[0]?.cost || 1
  $('.project-list').innerHTML = rows.map((project, index) => {
    const style = styleForFamily(project.family)
    return `
    <div class="project-row project-filter" data-project="${escapeAttribute(project.project)}" data-family="${escapeAttribute(project.family)}" style="--series:${style.color}">
      <span class="rank">${String(index + 1).padStart(2, '0')}</span>
      <span class="name">${escapeText(project.project)}<small><i></i>${escapeText(project.family.toUpperCase())}</small></span>
      <span class="bar"><i style="width:${100 * project.cost / max}%"></i></span>
      <span class="money">${fmt.usd(project.cost)}</span>
    </div>`
  }).join('')
}

function renderTokens(current) {
  $('.token-figure .big').textContent = fmt.pct(current.cacheRatio)
  const total = current.tokens
  const counts = {
    cacheRead: Math.round(144 * share(current.cacheRead, total)),
    cacheWrite: Math.round(144 * share(current.cacheCreate, total)),
    input: Math.round(144 * share(current.input, total)),
  }
  const dots = []
  for (let index = 0; index < 144; index += 1) {
    let className = 'output'
    if (index < counts.cacheRead) className = 'cache-read'
    else if (index < counts.cacheRead + counts.cacheWrite) className = 'cache-write'
    else if (index < counts.cacheRead + counts.cacheWrite + counts.input) className = 'input'
    dots.push(`<i class="${className}"></i>`)
  }
  $('#tokenGrid').innerHTML = dots.join('')
  const labels = $$('.cache-caption span')
  labels[0].textContent = `INPUT ${fmt.compact(current.input)}`
  labels[1].textContent = `WRITE ${fmt.compact(current.cacheCreate)}`
  labels[2].textContent = `READ ${fmt.compact(current.cacheRead)}`
  labels[3].textContent = `OUTPUT ${fmt.compact(current.output)}`
}

function segmentedConic(parts) {
  if (!parts.length) return cssColor('--token-pale', '#d0cdc4')
  const gap = .22
  let cursor = 0
  const stops = []
  parts.forEach((part, index) => {
    const end = index === parts.length - 1 ? 100 : cursor + part.share * 100
    const fillStart = index === 0 ? cursor : cursor + gap / 2
    const fillEnd = index === parts.length - 1 ? end : end - gap / 2
    if (fillEnd > fillStart) stops.push(`${part.color} ${fillStart}% ${fillEnd}%`)
    if (index < parts.length - 1) stops.push(`var(--paper-hi) ${fillEnd}% ${end + gap / 2}%`)
    cursor = end
  })
  return `conic-gradient(${stops.join(', ')})`
}

function renderConcentration(projects) {
  const rows = projects.byCost
  const total = projects.totalCost
  const top = rows.slice(0, 3)
  const styles = top.map((row) => styleForFamily(row.family))
  const shares = top.map((project) => share(project.cost, total))
  const concentration = sum(shares, (value) => value)
  $('.ring-label b').textContent = fmt.pct(concentration)
  $('.ring-label span:first-child').textContent = `Top ${top.length}`
  $('.ring-label span:last-child').textContent = 'of spend'
  $('.note span:last-child').textContent = `${top.length} projects account for ${fmt.pct(concentration)} of period value. ${top[0] ? `${top[0].project} is the largest at ${fmt.usd(top[0].cost)}.` : 'No project activity was recorded.'}`
  const ringParts = top.map((row, index) => ({ share: shares[index], color: styles[index].color }))
  const otherShare = Math.max(0, 1 - concentration)
  if (otherShare) ringParts.push({ share: otherShare, color: cssColor('--token-pale', '#d0cdc4') })
  $('.ring').style.background = segmentedConic(ringParts)
  const detailed = top.map((project, index) => `
    <div class="conc-row project-filter" data-project="${escapeAttribute(project.project)}">
      <span class="rank">${String(index + 1).padStart(2, '0')}</span>
      <i style="--series:${styles[index].color}"></i>
      <span class="name">${escapeText(project.project)}<small>${escapeText(project.family.toUpperCase())} DOMINANT</small></span>
      <span class="share">${fmt.pct(shares[index])}</span>
      <span class="value">${fmt.usdHeadline(project.cost)}</span>
    </div>`).join('')
  const otherValue = Math.max(0, total - sum(top, (project) => project.cost))
  $('.ring-key').innerHTML = detailed + `
    <div class="conc-row">
      <span class="rank">04</span><i style="--series:var(--token-pale)"></i>
      <span class="name">Other projects<small>${Math.max(0, rows.length - top.length)} PROJECTS</small></span>
      <span class="share">${fmt.pct(1 - concentration)}</span><span class="value">${fmt.usdHeadline(otherValue)}</span>
    </div>`
}

function sessionTimes(session) {
  const start = Date.parse(session.start)
  const recordedEnd = Date.parse(session.end || '')
  const fallbackSeconds = Math.max(60, Number(session.durSec) || 60)
  const end = Number.isFinite(recordedEnd) && recordedEnd > start ? recordedEnd : start + fallbackSeconds * 1000
  return { start, end }
}

function clockTime(value) {
  const parts = localParts(new Date(value))
  return `${parts.hour}:${parts.minute}`
}

function quantile(sorted, ratio) {
  if (!sorted.length) return 0
  const index = (sorted.length - 1) * ratio
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

function normalizedLogScale(values) {
  const logged = values.map((value) => Math.log1p(value)).sort((a, b) => a - b)
  const low = quantile(logged, .1)
  const high = quantile(logged, .9)
  return (value) => high > low ? clamp((Math.log1p(value) - low) / (high - low), 0, 1) : .5
}

function densityScale(sessions) {
  const density = (session) => {
    const { start, end } = sessionTimes(session)
    return (session.totalTokens || 0) / Math.max(1, (end - start) / 60_000)
  }
  const normalize = normalizedLogScale(sessions.map(density))
  return (session) => {
    const tokensPerMinute = density(session)
    return { tokensPerMinute, normalized: normalize(tokensPerMinute) }
  }
}

function layoutConcurrent(segments) {
  const sorted = segments.slice().sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute)
  let cluster = []
  let clusterEnd = -1
  const finishCluster = () => {
    if (!cluster.length) return
    const laneEnds = []
    for (const segment of cluster) {
      let lane = laneEnds.findIndex((end) => end <= segment.startMinute)
      if (lane < 0) lane = laneEnds.length
      laneEnds[lane] = segment.endMinute
      segment.lane = lane
    }
    for (const segment of cluster) segment.laneCount = laneEnds.length
    cluster = []
    clusterEnd = -1
  }
  for (const segment of sorted) {
    if (cluster.length && segment.startMinute >= clusterEnd) finishCluster()
    cluster.push(segment)
    clusterEnd = Math.max(clusterEnd, segment.endMinute)
  }
  finishCluster()
  return sorted
}

function rhythmDateKeys(window) {
  const current = state.rhythmAnchor || localDateKey(new Date(window.end))
  if (state.rhythmView === 'week') {
    const currentDate = new Date(`${current}T12:00:00Z`)
    const monday = new Date(currentDate)
    monday.setUTCDate(currentDate.getUTCDate() - ((currentDate.getUTCDay() + 6) % 7))
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(monday)
      date.setUTCDate(monday.getUTCDate() + index)
      return date.toISOString().slice(0, 10)
    })
  }

  const [year, month] = current.split('-').map(Number)
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return Array.from({ length: dayCount }, (_, index) => `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`)
}

/** A project name broken at its first hyphen so a narrow event block wraps it
 *  at a word rather than mid-word. The hyphen stays with the first line: a
 *  block too narrow to wrap at all turns the name sideways onto one line, and
 *  it has to spell the project the reader is looking for. */
function wrappedProjectLabel(project) {
  const value = String(project || 'Unassigned')
  const split = value.indexOf('-')
  if (split < 1) return escapeText(value)
  return `${escapeText(value.slice(0, split + 1))}<br>${escapeText(value.slice(split + 1))}`
}

const WEEK_TIMELINE_HEIGHT = 672
const WEEK_HOUR_HEIGHT = WEEK_TIMELINE_HEIGHT / 24
const MONTH_TIMELINE_HEIGHT = 768

function renderWorkRhythm(sessions, window) {
  const dateKeys = rhythmDateKeys(window)
  const firstDate = dateKeys[0]
  const lastDate = dateKeys[dateKeys.length - 1]
  const visibleSessions = sessions.filter((session) => {
    const { start, end } = sessionTimes(session)
    return localDateKey(new Date(end)) >= firstDate && localDateKey(new Date(start)) <= lastDate
  })
  const segmentsByDate = new Map(dateKeys.map((date) => [date, []]))
  const densityFor = densityScale(visibleSessions)
  const projectColors = state.projectColors

  for (const session of visibleSessions) {
    const { start, end } = sessionTimes(session)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    const startDate = localDateKey(new Date(start))
    const endDate = localDateKey(new Date(end))
    const density = densityFor(session)
    for (const date of dateKeys) {
      if (date < startDate || date > endDate) continue
      const startMinute = date === startDate ? localMinute(new Date(start)) : 0
      let endMinute = date === endDate ? localMinute(new Date(end)) : 1440
      if (date === startDate && date === endDate && endMinute <= startMinute) endMinute = startMinute + 1
      if (endMinute <= 0 || startMinute >= 1440) continue
      segmentsByDate.get(date).push({
        session,
        start,
        end,
        startMinute: clamp(startMinute, 0, 1440),
        endMinute: clamp(endMinute, 0, 1440),
        ...density,
      })
    }
  }

  const monthView = state.rhythmView === 'month'
  const observedThrough = localDateKey(new Date(window.end))
  const field = $('#workRhythm')
  field.className = `rhythm-field ${monthView ? 'month-view' : 'week-view'}`
  field.style.minWidth = monthView ? `${Math.max(1080, 76 + dateKeys.length * 34)}px` : '1020px'
  field.innerHTML = monthView
    ? renderMonthRhythm(dateKeys, segmentsByDate, observedThrough, projectColors)
    : renderWeekRhythm(dateKeys, segmentsByDate, projectColors)
  renderRhythmKey(visibleSessions, projectColors)
  renderRhythmTable(dateKeys, segmentsByDate, monthView ? observedThrough : null)

  $('.rhythm-scroll').scrollLeft = 0
  $$('.rhythm-toggle button').forEach((button) => button.classList.toggle('active', button.dataset.rhythmView === state.rhythmView))
  $$('.rhythm-color-toggle button').forEach((button) => {
    const active = button.dataset.rhythmColor === state.rhythmColor
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  })
  const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${lastDate}T12:00:00Z`))
  $('#rhythmWindow').textContent = monthView ? monthLabel : `${firstDate.slice(5)} – ${lastDate.slice(5)}`
  $('#rhythmCoverage').textContent = `${visibleSessions.length} session${visibleSessions.length === 1 ? '' : 's'}`
  $('#rhythmViewNote').textContent = monthView ? 'Daily columns · 24-hour field' : '24-hour schedule'
  $('#rhythmDescription').textContent = monthView
    ? `Each date is a compact 24-hour view. Full-width ${state.rhythmColor === 'project' ? 'project' : 'model-family'} colors overlap directly when sessions run concurrently; stronger shading indicates higher token velocity.`
    : `A precise wall-clock view of each recorded session. Blocks use ${state.rhythmColor === 'project' ? 'stable project colors' : 'the shared model-family colors'}; darker shading indicates higher token velocity.`
  updateRhythmNavigation(window, dateKeys)
}

function updateRhythmNavigation(window, dateKeys) {
  const latestDate = localDateKey(new Date(window.end))
  const atLatest = state.rhythmView === 'month'
    ? dateKeys[0].slice(0, 7) >= latestDate.slice(0, 7)
    : dateKeys[dateKeys.length - 1] >= latestDate
  $('#rhythmNext').disabled = atLatest
  $('#rhythmToday').disabled = !state.rhythmAnchor
}

function shiftRhythmWindow(direction) {
  const window = currentWindow()
  const anchor = state.rhythmAnchor || localDateKey(new Date(window.end))
  const value = new Date(`${anchor}T12:00:00Z`)
  if (state.rhythmView === 'month') {
    value.setUTCDate(1)
    value.setUTCMonth(value.getUTCMonth() + direction)
  } else {
    value.setUTCDate(value.getUTCDate() + direction * 7)
  }
  state.rhythmAnchor = value.toISOString().slice(0, 10)
  renderWorkRhythm(state.sessions, window)
  bindPageInteractions()
}

function resetRhythmWindow() {
  if (!state.rhythmAnchor) return
  state.rhythmAnchor = null
  renderWorkRhythm(state.sessions, currentWindow())
  bindPageInteractions()
}

function daySessions(segments) {
  return [...new Map(segments.map((segment) => [segment.session._i, segment.session])).values()]
}

function renderRhythmKey(sessions, projectColors) {
  const key = $('#rhythmKey')
  const series = [...new Map(sessions.map((session) => {
    const value = rhythmSeriesFor(session, projectColors)
    return [value.label, value]
  })).values()]
  if (!series.length) {
    key.innerHTML = '<span class="rhythm-key-note">No session activity in view</span>'
    return
  }
  const label = state.rhythmColor === 'project' ? 'Project' : 'Model family'
  key.innerHTML = `<span class="rhythm-key-label">${label}</span>${series.map((value) => `<span class="rhythm-series-key"><i style="--series:${value.base};--fill:${tintColor(value.base, .46)}"></i>${escapeText(value.label)}</span>`).join('')}<span class="rhythm-key-note">Shade = velocity</span>`
}

function minuteLabel(minute) {
  const bounded = clamp(Math.round(minute), 0, 1440)
  const hour = Math.floor(bounded / 60)
  const minutes = bounded % 60
  return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function rhythmDayFlags(date, index, segments = []) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  return [
    day === 1 && index ? 'week-start' : '',
    day === 0 || day === 6 ? 'weekend' : '',
    date === localDateKey(new Date()) ? 'today' : '',
    segments.length ? '' : 'empty',
  ].filter(Boolean).join(' ')
}

function rhythmDayClasses(date, index, segments = []) {
  return `rhythm-day ${rhythmDayFlags(date, index, segments)}`
}

function renderWeekRhythm(dateKeys, segmentsByDate, projectColors) {
  const columns = `repeat(${dateKeys.length}, minmax(126px, 1fr))`
  const dateHead = dateKeys.map((date, index) => {
    const value = new Date(`${date}T12:00:00Z`)
    const segments = segmentsByDate.get(date)
    const sessions = daySessions(segments)
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(value).toUpperCase()
    const label = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' }).format(value).toUpperCase()
    return `<div class="rhythm-date ${rhythmDayFlags(date, index, segments)}"><span>${weekday}</span><b>${label}</b><small>${sessions.length ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}` : 'No sessions'}</small></div>`
  }).join('')
  const timeAxis = Array.from({ length: 9 }, (_, index) => {
    const hour = index * 3
    const position = hour / 24 * WEEK_TIMELINE_HEIGHT
    return `<span class="rhythm-hour${hour === 24 ? ' end' : ''}" style="top:${position}px">${String(hour).padStart(2, '0')}:00</span>`
  }).join('')
  const days = renderWeekRhythmDays(dateKeys, segmentsByDate, projectColors)
  return `<div class="rhythm-calendar-corner"><span>Local</span><b>${LOCAL_LOCATION}</b></div><div class="rhythm-date-head" style="grid-template-columns:${columns}">${dateHead}</div><div class="rhythm-time-axis">${timeAxis}</div><div class="rhythm-days" style="grid-template-columns:${columns}">${days}</div>`
}

function renderWeekRhythmDays(dateKeys, segmentsByDate, projectColors) {
  return dateKeys.map((date, dateIndex) => {
    const segments = segmentsByDate.get(date)
    const events = layoutConcurrent(segments).map((segment) => {
      const top = segment.startMinute / 1440 * WEEK_TIMELINE_HEIGHT
      const height = Math.max(4, (segment.endMinute - segment.startMinute) / 1440 * WEEK_TIMELINE_HEIGHT)
      const left = 100 * segment.lane / segment.laneCount
      const width = 100 / segment.laneCount
      const compact = height < 19 ? ' compact' : height < 38 ? ' brief' : ''
      const family = familyOf(segment.session.primaryModel)
      const seriesColor = rhythmSeriesFor(segment.session, projectColors).base
      const fillColor = tintColor(seriesColor, .34 + segment.normalized * .18)
      const durationMinutes = Math.max(1, (segment.end - segment.start) / 60_000)
      const tip = `${segment.session.project} | ${family} | ${clockTime(segment.start)}–${clockTime(segment.end)} | ${Math.round(durationMinutes)} min | ${fmt.compact(segment.session.totalTokens || 0)} tokens | ${fmt.compact(segment.tokensPerMinute)} tokens/min`
      return `<button class="rhythm-event${compact}" data-session-id="${segment.session._i}" data-tip="${escapeAttribute(tip)}" aria-label="${escapeAttribute(tip)}" style="top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);background:${fillColor};border-left-color:${seriesColor};color:var(--event-ink)"><span>${wrappedProjectLabel(segment.session.project)}</span><small>${clockTime(segment.start)} · ${fmt.compact(segment.tokensPerMinute)}/min</small></button>`
    }).join('')
    return `<div class="${rhythmDayClasses(date, dateIndex, segments)}">${events}</div>`
  }).join('')
}

function monthBands(dateKeys, segmentsByDate) {
  const bandsByDate = new Map()
  for (const date of dateKeys) {
    const segments = segmentsByDate.get(date)
    const bands = []
    for (let startMinute = 0; startMinute < 1440; startMinute += 15) {
      const endMinute = startMinute + 15
      const active = segments.filter((segment) => segment.startMinute < endMinute && segment.endMinute > startMinute)
      if (!active.length) continue
      const ids = active.map((segment) => segment.session._i).sort((a, b) => a - b)
      const key = ids.join(',')
      const previous = bands[bands.length - 1]
      if (previous && previous.key === key) {
        previous.endMinute = endMinute
      } else {
        bands.push({ key, ids, segments: active, startMinute, endMinute })
      }
    }
    bandsByDate.set(date, bands)
  }
  return bandsByDate
}

function renderMonthRhythm(dateKeys, segmentsByDate, observedThrough, projectColors) {
  const bandsByDate = monthBands(dateKeys, segmentsByDate)
  const columns = `repeat(${dateKeys.length}, minmax(34px, 1fr))`
  const dateHead = dateKeys.map((date, index) => {
    const value = new Date(`${date}T12:00:00Z`)
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'narrow', timeZone: 'UTC' }).format(value).toUpperCase()
    const classes = [rhythmDayFlags(date, index, segmentsByDate.get(date)), date > observedThrough ? 'outside-window' : ''].filter(Boolean).join(' ')
    return `<div class="rhythm-date rhythm-month-date ${classes}" title="${date}"><span>${weekday}</span><b>${String(value.getUTCDate()).padStart(2, '0')}</b></div>`
  }).join('')
  const timeAxis = Array.from({ length: 12 }, (_, index) => {
    const hour = index * 2
    return `<span class="rhythm-hour" style="top:${hour / 24 * MONTH_TIMELINE_HEIGHT}px">${String(hour).padStart(2, '0')}:00</span>`
  }).join('')
  const days = renderMonthRhythmDays(dateKeys, segmentsByDate, bandsByDate, projectColors, observedThrough)
  return `<div class="rhythm-calendar-corner"><span>Local</span><b>${LOCAL_LOCATION}</b></div><div class="rhythm-date-head" style="grid-template-columns:${columns}">${dateHead}</div><div class="rhythm-time-axis">${timeAxis}</div><div class="rhythm-days" style="grid-template-columns:${columns}">${days}</div>`
}

function renderMonthRhythmDays(dateKeys, segmentsByDate, bandsByDate, projectColors, observedThrough) {
  return dateKeys.map((date, dateIndex) => {
    const outsideWindow = date > observedThrough
    const bands = (outsideWindow ? [] : bandsByDate.get(date)).map((band) => {
      const top = band.startMinute / 1440 * MONTH_TIMELINE_HEIGHT
      const height = Math.max(2, (band.endMinute - band.startMinute) / 1440 * MONTH_TIMELINE_HEIGHT)
      const density = sum(band.segments, (segment) => segment.tokensPerMinute)
      const layers = band.segments.map((segment) => {
        const seriesColor = rhythmSeriesFor(segment.session, projectColors).base
        const fillColor = tintColor(seriesColor, .34 + segment.normalized * .18)
        return `<span class="rhythm-overlap-layer" style="--layer:${fillColor}"></span>`
      }).join('')
      const sessionLines = band.segments.map((segment) => ({
        velocity: segment.tokensPerMinute,
        text: `${segment.session.project} / ${shortModel(segment.session.primaryModel)} / ${fmt.compact(segment.tokensPerMinute)} tokens/min`,
      })).sort((a, b) => b.velocity - a.velocity).map((item) => item.text)
      const tip = [`${date} ${minuteLabel(band.startMinute)}–${minuteLabel(band.endMinute)}`, `${band.ids.length} active session${band.ids.length === 1 ? '' : 's'} / ${fmt.compact(density)} combined tokens/min`, '', ...sessionLines].join('\n')
      const tipAttribute = escapeAttribute(tip).replace(/\n/g, '&#10;')
      return `<button class="rhythm-overlap-band" data-session-ids="${band.ids.join(',')}" data-date="${date}" data-start-minute="${band.startMinute}" data-end-minute="${band.endMinute}" data-density="${density}" data-tip="${tipAttribute}" aria-label="${escapeAttribute(tip.replace(/\n/g, ', '))}" style="top:${top}px;height:${height}px">${layers}</button>`
    }).join('')
    const classes = [rhythmDayClasses(date, dateIndex, segmentsByDate.get(date)), outsideWindow ? 'outside-window' : ''].filter(Boolean).join(' ')
    return `<div class="${classes}">${bands}</div>`
  }).join('')
}

function renderRhythmTable(dateKeys, segmentsByDate, observedThrough = null) {
  const rows = dateKeys.map((date) => {
    const segments = segmentsByDate.get(date)
    const sessions = daySessions(segments)
    const tokens = sum(sessions, (session) => session.totalTokens || 0)
    const activeStart = segments.length ? Math.min(...segments.map((segment) => segment.startMinute)) : null
    const activeEnd = segments.length ? Math.max(...segments.map((segment) => segment.endMinute)) : null
    const dateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))
    const outsideWindow = observedThrough && date > observedThrough
    return `<tr><th scope="row">${dateLabel}</th><td>${outsideWindow ? 'Outside window' : activeStart === null ? 'None' : `${minuteLabel(activeStart)}–${minuteLabel(activeEnd)}`}</td><td>${outsideWindow ? 'Not observed' : sessions.length}</td><td>${outsideWindow ? 'Not observed' : sessions.length ? fmt.compact(tokens) : '0'}</td></tr>`
  }).join('')
  $('#rhythmTable').innerHTML = `<table><thead><tr><th>Date</th><th>Activity window</th><th>Sessions</th><th>Recorded tokens</th></tr></thead><tbody>${rows}</tbody></table>`
}

function renderTopology(sessions, projectSummary) {
  const projects = foldProjects(projectSummary.byCost, TOPOLOGY_ROWS)
  const familyRows = group(sessions, (session) => familyOf(session.primaryModel), (session) => session.cost || 0)
  const families = familyRows.length > 4 ? [...familyRows.slice(0, 3).map((row) => row.key), 'Other'] : familyRows.map((row) => row.key)
  const visible = new Set(families.filter((family) => family !== 'Other'))
  const cells = projects.flatMap((project) => families.map((family) => family === 'Other'
    ? Object.entries(project.families).filter(([key]) => !visible.has(key)).reduce((total, [, value]) => total + value, 0)
    : project.families[family] || 0))
  const maxCell = Math.max(1, ...cells)
  const grandTotal = projectSummary.totalCost
  const head = families.map((family) => {
    const style = styleForFamily(family)
    return `<th><span class="topology-head" style="--series:${style.color}"><i></i>${escapeText(family)}</span></th>`
  }).join('')
  const body = projects.map((project) => {
    const cellsHtml = families.map((family) => {
      const value = family === 'Other'
        ? Object.entries(project.families).filter(([key]) => !visible.has(key)).reduce((total, [, amount]) => total + amount, 0)
        : project.families[family] || 0
      // The folded row stands for several projects at once, so its cells carry
      // the value and nothing to click: there is no one project to filter on.
      if (project.synthetic) {
        if (!value) return '<td><span class="topology-cell static empty" aria-label="No recorded value"></span></td>'
        return `<td><span class="topology-cell static" style="--cell:${100 * value / maxCell}%" data-tip="${escapeAttribute(project.project)} | ${escapeAttribute(family)} | ${fmt.usd(value)}"><b>${fmt.usd(value)}</b></span></td>`
      }
      if (!value) return '<td><button class="topology-cell empty" aria-label="No recorded value"></button></td>'
      return `<td><button class="topology-cell topology-filter" data-project="${escapeAttribute(project.project)}" data-family="${escapeAttribute(family)}" style="--cell:${100 * value / maxCell}%" data-tip="${escapeAttribute(project.project)} | ${escapeAttribute(family)} | ${fmt.usd(value)}"><b>${fmt.usd(value)}</b></button></td>`
    }).join('')
    const dominant = Object.entries(project.families).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other'
    const caption = project.synthetic
      ? `${project.projects} projects`
      : `${escapeText(dominant)} dominant`
    return `<tr><th class="topology-project">${escapeText(project.project)}<small>${caption}</small></th>${cellsHtml}<td class="topology-total">${fmt.usd(project.cost)}</td></tr>`
  }).join('')
  const foot = families.map((family) => {
    const value = family === 'Other'
      ? sum(familyRows.filter((row) => !visible.has(row.key)), (row) => row.value)
      : familyRows.find((row) => row.key === family)?.value || 0
    return `<td>${fmt.pct(share(value, grandTotal))}</td>`
  }).join('')
  $('#projectTopology').innerHTML = `<table class="topology-table"><thead><tr><th>Project × model</th>${head}<th>Value</th></tr></thead><tbody>${body}</tbody><tfoot><tr><th>Model share</th>${foot}<td>${fmt.usd(grandTotal)}</td></tr></tfoot></table>`
}

function applyProjectView() {
  $('.project-overview-view').hidden = state.projectView !== 'overview'
  $('.project-topology-view').hidden = state.projectView !== 'topology'
  $$('.project-toggle button').forEach((button) => button.classList.toggle('active', button.dataset.projectView === state.projectView))
}

function group(items, keyFor, valueFor) {
  const values = new Map()
  for (const item of items) {
    const key = keyFor(item)
    values.set(key, (values.get(key) || 0) + valueFor(item))
  }
  return [...values].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value)
}

function foldRows(rows, limit) {
  if (rows.length <= limit) return rows
  return [...rows.slice(0, limit - 1), { key: 'Other', value: sum(rows.slice(limit - 1), (row) => row.value) }]
}

function openDetail({ eyebrow, title, stats = [], sections = [] }) {
  $('#detailEyebrow').textContent = eyebrow
  $('#detailTitle').textContent = title
  $('#detailBody').innerHTML = `
    <div class="detail-summary">${stats.map((stat) => `<div class="detail-stat"><span class="micro">${escapeText(stat.label)}</span><b>${escapeText(stat.value)}</b></div>`).join('')}</div>
    ${sections.map((section) => `<section class="detail-section"><h3>${escapeText(section.title)}</h3>${section.html || `<p>${escapeText(section.text || '')}</p>`}</section>`).join('')}`
  $('#detailScrim').hidden = false
  document.body.style.overflow = 'hidden'
}

function closeDetail() {
  $('#detailScrim').hidden = true
  document.body.style.overflow = ''
}

function detailList(rows) {
  return `<div class="detail-list">${rows.map((row) => `<div><span>${escapeText(row.label)}</span><b>${escapeText(row.value)}</b></div>`).join('')}</div>`
}

// The heatmap draws the whole ledger while the range chips select a window
// inside it, so a day is read back from every recorded session rather than
// from the selected period. Sourcing it from `state.current`, as the openers
// for period-scoped marks do, empties every cell outside the selection.
function openDayDetail(dateKey) {
  const sessions = state.sessions.filter((session) => localDateKey(new Date(session.t)) === dateKey)
  const value = summarizeUsage(sessions)
  const projects = group(sessions, (session) => session.project, (session) => session.cost || 0)
  const models = group(sessions, (session) => familyOf(session.primaryModel), (session) => session.cost || 0)
  const ordered = sessions.slice().sort((a, b) => a.t - b.t)
  openDetail({
    eyebrow: 'Day detail',
    title: fmt.dayYear(dateKey),
    stats: [
      { label: 'Day value', value: fmt.usd(value.cost) },
      { label: 'Sessions', value: String(value.sessions) },
      { label: 'Tokens', value: fmt.compact(value.tokens) },
      { label: 'Cache read', value: fmt.pct(value.cacheRatio) },
    ],
    sections: [
      { title: 'Projects', html: detailList(projects.map((row) => ({ label: row.key, value: fmt.usd(row.value) }))) },
      { title: 'Model composition', html: detailList(models.map((row) => ({ label: row.key, value: fmt.usd(row.value) }))) },
      { title: 'Sessions', html: detailList(ordered.map((session) => ({ label: `${clockTime(session.t)} / ${session.project}`, value: fmt.usd(session.cost || 0) }))) },
      { title: 'Measurement', text: 'A session counts toward the local calendar day it finished on, which is the same day the heatmap draws it in. A session that ran across midnight therefore lands entirely on the later day.' },
    ],
  })
}

function openProjectDetail(project) {
  const sessions = state.current.filter((session) => session.project === project)
  const value = summarizeUsage(sessions)
  const models = group(sessions, (session) => familyOf(session.primaryModel), (session) => session.cost || 0)
  const providers = group(sessions, (session) => session.provider, () => 1)
  openDetail({
    eyebrow: 'Project detail',
    title: project,
    stats: [
      { label: 'Period value', value: fmt.usd(value.cost) },
      { label: 'Sessions', value: String(value.sessions) },
      { label: 'Tokens', value: fmt.compact(value.tokens) },
      { label: 'Cache read', value: fmt.pct(value.cacheRatio) },
    ],
    sections: [
      { title: 'Model composition', html: detailList(models.map((row) => ({ label: row.key, value: fmt.usd(row.value) }))) },
      { title: 'Provider activity', html: detailList(providers.map((row) => ({ label: row.key, value: `${row.value} sessions` }))) },
      { title: 'Latest activity', text: sessions.length ? fmt.dateYear(new Date(Math.max(...sessions.map((session) => session.t)))) : 'No activity in this period' },
    ],
  })
}

function openSessionDetail(session) {
  if (!session) return
  const value = summarizeUsage([session])
  const vendorRows = Object.entries(session.byVendor || {}).map(([vendor, usage]) => ({ label: vendor.toUpperCase(), value: `${fmt.usd(usage.cost || 0)} / ${fmt.compact(usage.tokens || 0)} tokens` }))
  const tokenRows = [
    { label: 'Input', value: fmt.compact(session.input || 0) },
    { label: 'Output', value: fmt.compact(session.output || 0) },
    { label: 'Cache write', value: fmt.compact(session.cacheCreate || 0) },
    { label: 'Cache read', value: fmt.compact(session.cacheRead || 0) },
  ]
  openDetail({
    eyebrow: 'Session detail',
    title: session.project,
    stats: [
      { label: 'Period value', value: fmt.usd(value.cost) },
      { label: 'Tokens', value: fmt.compact(value.tokens) },
      { label: 'Duration', value: session.durHuman || formatDuration(session.durSec) },
      { label: 'Cache read', value: fmt.pct(value.cacheRatio) },
    ],
    sections: [
      { title: 'Identity', html: detailList([
        { label: 'Session', value: session.slug || session.sid || 'Unknown' },
        { label: 'Provider', value: String(session.provider || 'unknown').toUpperCase() },
        { label: 'Machine', value: session.machine },
        { label: 'Primary model', value: shortModel(session.primaryModel) },
      ]) },
      { title: 'Token composition', html: detailList(tokenRows) },
      ...(vendorRows.length ? [{ title: 'Vendor allocation', html: detailList(vendorRows) }] : []),
      { title: 'Recorded window', text: `${fmt.dateYear(new Date(session.start))} ${clockTime(Date.parse(session.start))} to ${session.end ? `${fmt.dateYear(new Date(session.end))} ${clockTime(Date.parse(session.end))}` : 'unknown end'}.` },
    ],
  })
}

function openTopologyDetail(project, family) {
  const familyRows = group(state.current, (session) => familyOf(session.primaryModel), (session) => session.cost || 0)
  const visible = new Set(familyRows.slice(0, 3).map((row) => row.key))
  const sessions = state.current.filter((session) => {
    if (session.project !== project) return false
    const sessionFamily = familyOf(session.primaryModel)
    return family === 'Other' ? !visible.has(sessionFamily) : sessionFamily === family
  })
  const value = summarizeUsage(sessions)
  openDetail({
    eyebrow: 'Project × model detail',
    title: `${project} / ${family}`,
    stats: [
      { label: 'Period value', value: fmt.usd(value.cost) },
      { label: 'Sessions', value: String(value.sessions) },
      { label: 'Tokens', value: fmt.compact(value.tokens) },
      { label: 'Cache read', value: fmt.pct(value.cacheRatio) },
    ],
    sections: [
      { title: 'Recent sessions', html: detailList(sessions.slice().sort((a, b) => b.t - a.t).slice(0, 6).map((session) => ({ label: `${fmt.date(new Date(session.t))} / ${shortModel(session.primaryModel)}`, value: fmt.usd(session.cost || 0) }))) },
    ],
  })
}

function openModelDetail(family) {
  const sessions = state.current.filter((session) => familyOf(session.primaryModel) === family)
  const value = summarizeUsage(sessions)
  const projects = group(sessions, (session) => session.project, (session) => session.cost || 0).slice(0, 6)
  openDetail({
    eyebrow: 'Model detail',
    title: family,
    stats: [
      { label: 'Period value', value: fmt.usd(value.cost) },
      { label: 'Sessions', value: String(value.sessions) },
      { label: 'Tokens', value: fmt.compact(value.tokens) },
      { label: 'Average / session', value: fmt.usd(value.avgCost) },
    ],
    sections: [
      { title: 'Highest-value projects', html: detailList(projects.map((row) => ({ label: row.key, value: fmt.usd(row.value) }))) },
      { title: 'Encoding', text: `${family} keeps one fixed base hue throughout the portal. The weekly timeline may use lighter paper-blended tints to encode velocity without changing model identity.` },
    ],
  })
}

function openRhythmDetail(element) {
  const groupedIds = (element.dataset.sessionIds || '').split(',').filter(Boolean)
  if (groupedIds.length) {
    const sessions = groupedIds.map((id) => state.sessions.find((session) => String(session._i) === id)).filter(Boolean)
  const value = summarizeUsage(sessions)
    const startMinute = Number(element.dataset.startMinute)
    const endMinute = Number(element.dataset.endMinute)
    const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    openDetail({
      eyebrow: 'Month activity band',
      title: `${element.dataset.date} / ${clock(startMinute)}`,
      stats: [
        { label: 'Concurrent sessions', value: String(sessions.length) },
        { label: 'Combined tokens', value: fmt.compact(value.tokens) },
        { label: 'Combined velocity', value: `${fmt.compact(Number(element.dataset.density))} / min` },
        { label: 'Band span', value: `${endMinute - startMinute} min` },
      ],
      sections: [
        { title: 'Sessions active in this band', html: detailList(sessions.slice().sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0)).map((session) => ({ label: `${session.project} / ${shortModel(session.primaryModel)}`, value: fmt.compact(session.totalTokens || 0) }))) },
        { title: 'Measurement', text: 'The month ribbon samples the 24-hour wall-clock span in 15-minute intervals. Concurrent sessions are combined and their token velocities are summed. It preserves recorded usage without implying continuous active computation.' },
      ],
    })
    return
  }

  const session = state.sessions.find((item) => String(item._i) === element.dataset.sessionId)
  if (!session) return
  const { start, end } = sessionTimes(session)
  const durationMinutes = Math.max(1, (end - start) / 60_000)
  const tokensPerMinute = (session.totalTokens || 0) / durationMinutes
  openDetail({
    eyebrow: 'Session timeline',
    title: session.project,
    stats: [
      { label: 'Tokens', value: fmt.compact(session.totalTokens || 0) },
      { label: 'Wall span', value: session.durHuman || `${Math.round(durationMinutes)} min` },
      { label: 'Token velocity', value: `${fmt.compact(tokensPerMinute)} / min` },
      { label: 'Period value', value: fmt.usd(session.cost || 0) },
    ],
    sections: [
      { title: 'Recorded session', html: detailList([
        { label: 'Start', value: `${localDateKey(new Date(start))} / ${clockTime(start)}` },
        { label: 'End', value: `${localDateKey(new Date(end))} / ${clockTime(end)}` },
        { label: 'Provider', value: String(session.provider || 'unknown').toUpperCase() },
        { label: 'Model', value: shortModel(session.primaryModel) },
      ]) },
      { title: 'Measurement', text: 'Token velocity is total recorded tokens divided by the session wall-clock span. Darker means more tokens per minute. The span may include idle time, because the transcript does not expose a continuous ready, running, or thinking state.' },
    ],
  })
}

function openMetricDetail(index) {
  const current = summarizeUsage(state.current)
  const definitions = [
    ['Session count', String(current.sessions), 'Recorded agent sessions in the selected period. The background hatch length compares this period with the previous period.'],
    ['Token volume', fmt.compact(current.tokens), 'Total input, output, cache-write, and cache-read tokens. Token types use ordered solid grayscale values rather than model colors.'],
    ['Average session value', fmt.usd(current.avgCost), 'API-equivalent value divided by the number of sessions in the selected period.'],
    ['Cache-read ratio', fmt.pct(current.cacheRatio), 'Share of total tokens supplied through cache reads.'],
  ]
  const [title, value, text] = definitions[index]
  openDetail({ eyebrow: 'Metric detail', title, stats: [{ label: 'Current period', value }], sections: [{ title: 'How to read it', text }] })
}

function applyFamilyFocus(family) {
  state.focusFamily = state.focusFamily === family ? null : family
  $$('[data-family]').forEach((element) => {
    const match = !state.focusFamily || element.dataset.family === state.focusFamily
    element.classList.toggle('dimmed', !match)
    element.classList.toggle('active', Boolean(state.focusFamily && match))
  })
}

function bindPageInteractions() {
  bindTooltips()
  $$('.project-filter').forEach((element) => {
    element.dataset.tip ||= `Open project detail: ${element.dataset.project}`
    element.onclick = () => openProjectDetail(element.dataset.project)
  })
  $$('.model-filter, .model-legend, .stack-segment').forEach((element) => {
    const family = element.dataset.family
    element.onclick = () => {
      applyFamilyFocus(family)
      openModelDetail(family)
    }
  })
  $$('.calendar-cell[data-day]').forEach((cell) => {
    cell.onclick = () => openDayDetail(cell.dataset.day)
  })
  $$('.topology-filter').forEach((cell) => {
    cell.onclick = () => openTopologyDetail(cell.dataset.project, cell.dataset.family)
  })
  $$('.rhythm-event, .rhythm-overlap-band').forEach((event) => {
    event.onclick = () => openRhythmDetail(event)
  })
  $$('[data-pattern-week]').forEach((button) => {
    button.onclick = () => shiftPatternWeek(button.dataset.patternWeek)
  })
  $$('.metric').forEach((metric, index) => {
    metric.onclick = () => openMetricDetail(index)
  })
  $$('[data-analysis-project]').forEach((element) => {
    element.onclick = () => openProjectDetail(element.dataset.analysisProject)
  })
  $$('[data-analysis-session]').forEach((element) => {
    element.onclick = () => openSessionDetail(state.sessions.find((session) => String(session._i) === element.dataset.analysisSession))
  })
  $$('[data-project-sort]').forEach((element) => {
    element.onclick = () => {
      const key = element.dataset.projectSort
      state.projectSort = state.projectSort.key === key
        ? { key, direction: -state.projectSort.direction }
        : { key, direction: key === 'project' || key === 'family' ? 1 : -1 }
    renderProjectAnalysis(summarizeProjects(state.current))
      bindPageInteractions()
    }
  })
  $$('[data-session-sort]').forEach((element) => {
    element.onclick = () => {
      const key = element.dataset.sessionSort
      state.sessionSort = state.sessionSort.key === key
        ? { key, direction: -state.sessionSort.direction }
        : { key, direction: ['slug', 'project', 'machine', 'model'].includes(key) ? 1 : -1 }
      renderSessionAnalysis(state.current)
      bindPageInteractions()
    }
  })
}

function positionTooltip(tooltip, event) {
  const bounds = tooltip.getBoundingClientRect()
  const margin = 12
  let left = event.clientX + 16
  let top = event.clientY + 16
  if (left + bounds.width > window.innerWidth - margin) left = event.clientX - bounds.width - 16
  if (top + bounds.height > window.innerHeight - margin) top = Math.max(margin, event.clientY - bounds.height - 16)
  tooltip.style.left = `${Math.max(margin, left)}px`
  tooltip.style.top = `${top}px`
}

function bindTooltips() {
  const tooltip = $('#tooltip')
  $$('[data-tip]').forEach((element) => {
    element.onmouseenter = () => {
      tooltip.textContent = element.dataset.tip
      tooltip.classList.toggle('multiline', element.classList.contains('rhythm-overlap-band') || element.classList.contains('multiline-tip'))
      tooltip.style.display = 'block'
    }
    element.onmousemove = (event) => positionTooltip(tooltip, event)
    element.onmouseleave = () => { tooltip.style.display = 'none' }
  })
}

let syncResetTimer = null

/** What the button says in each state, and how it is drawn. Syncing is a state
 *  of the button rather than a message beside it: a message beside it moved
 *  the button away from the pointer that had just clicked it (#36). */
const SYNC_STATES = {
  idle: { label: 'REFRESH DATA', className: 'refresh-button' },
  syncing: { label: 'SYNCING', className: 'refresh-button running' },
  complete: { label: 'UP TO DATE', className: 'refresh-button success' },
  error: { label: 'SYNC FAILED', className: 'refresh-button error' },
}

function paintSyncState(status, label) {
  const state = SYNC_STATES[status]
  const button = $('#refreshButton')
  button.disabled = status === 'syncing'
  button.className = state.className
  $('#refreshLabel').textContent = fmt.syncLabel(label || state.label)
}

/**
 * Report a synchronization on the button that started it.
 *
 * `updated` is the session count a completed synchronization rewrote, and the
 * sentence it becomes is composed here rather than by the caller, so the one
 * slot on the page that carries it has one owner deciding what fits.
 */
async function setSyncState(status, updated = 0) {
  if (syncResetTimer) window.clearTimeout(syncResetTimer)
  if (status === 'syncing') {
    paintSyncState('syncing')
    return
  }
  if (status !== 'complete' && status !== 'error') {
    paintSyncState('idle')
    return
  }
  if (status === 'complete') await load()
  paintSyncState(status, status === 'complete' && updated > 0 ? fmt.sessionsUpdated(updated) : '')
  syncResetTimer = window.setTimeout(() => {
    paintSyncState('idle')
    syncResetTimer = null
  }, 3500)
}

window.agentUsageStatSetSyncState = setSyncState

async function refreshData() {
  const button = $('#refreshButton')
  if (button.disabled) return
  await setSyncState('syncing')
  try {
    const response = await fetch('./api/refresh', { method: 'POST' })
    const result = await response.json().catch(() => null)
    if (!response.ok) throw new Error(result?.error || `Refresh failed (${response.status})`)
    await setSyncState('complete', result?.updated || 0)
  } catch (error) {
    await setSyncState('error')
    console.error(error.stack || error)
  }
}

async function load() {
  try {
    const [sessions, meta] = await Promise.all([
      fetch('./data/sessions.json', { cache: 'no-store' }).then((response) => {
        if (!response.ok) throw new Error('sessions.json not found')
        return response.json()
      }),
      fetch('./data/meta.json', { cache: 'no-store' }).then((response) => response.ok ? response.json() : null),
    ])
    state.sessions = sessions.map(normalizeSession).filter((session) => Number.isFinite(session.t))
    state.projectColors = null
    state.patternWeek = null
    state.meta = meta
    const requestedView = window.location.hash.slice(1)
    if (['overview', 'spend', 'tokens', 'pattern', 'projects', 'sessions', 'settings'].includes(requestedView)) state.view = requestedView
    render()
    await loadSettings()
  } catch (error) {
    const stateValue = $$('.top-meta b')[2]
    if (stateValue) stateValue.textContent = 'DATA UNAVAILABLE'
    $('.note span:last-child').textContent = `Real data could not load. Serve the portal directory through Vite, then refresh. ${error.message}`
    console.error(error.stack || error)
  }
}

$$('.ranges .chip').forEach((chip) => chip.addEventListener('click', () => {
  $$('.ranges .chip').forEach((item) => item.classList.remove('active'))
  chip.classList.add('active')
  state.range = chip.textContent.trim()
  render()
}))

$$('[data-portal-view]').forEach((button) => button.addEventListener('click', () => {
  const navigation = selectPortalView({
    currentView: state.view,
    settingsReturnView: state.settingsReturnView,
  }, button.dataset.portalView)
  state.view = navigation.currentView
  state.settingsReturnView = navigation.settingsReturnView
  window.history.replaceState(null, '', `#${state.view}`)
  applyPortalView()
  if (state.view === 'settings') void loadSettings()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}))

$('#settingsView').addEventListener('click', (event) => {
  const button = event.target.closest('[data-settings-action]')
  if (!button || button.disabled) return
  const action = button.dataset.settingsAction
  const detail = {}
  if (button.dataset.strategy) detail.strategy = button.dataset.strategy
  if (button.dataset.inherit) detail.inherit = true
  if (button.dataset.provider) detail.provider = button.dataset.provider
  void performSettingsAction(action, detail, button)
})

$('#sessionSearch').addEventListener('input', (event) => {
  state.sessionQuery = event.target.value
  renderSessionAnalysis(state.current)
  bindPageInteractions()
})

$$('[data-spend-view]').forEach((button) => button.addEventListener('click', () => {
  state.spendView = button.dataset.spendView
  renderSpendField(state.current, currentWindow())
  bindPageInteractions()
}))

$$('[data-token-traffic-view]').forEach((button) => button.addEventListener('click', () => {
  state.tokenTrafficView = button.dataset.tokenTrafficView
  applyTokenTrafficView()
}))

$$('[data-project-view]').forEach((button) => button.addEventListener('click', () => {
  state.projectView = button.dataset.projectView
  applyProjectView()
  bindPageInteractions()
}))

$$('[data-rhythm-color]').forEach((button) => button.addEventListener('click', () => {
  state.rhythmColor = button.dataset.rhythmColor
  renderWorkRhythm(state.sessions, currentWindow())
  bindPageInteractions()
}))

$$('[data-rhythm-view]').forEach((button) => button.addEventListener('click', () => {
  state.rhythmView = button.dataset.rhythmView
  renderWorkRhythm(state.sessions, currentWindow())
  bindPageInteractions()
}))

$('#rhythmPrev').addEventListener('click', () => shiftRhythmWindow(-1))
$('#rhythmToday').addEventListener('click', resetRhythmWindow)
$('#rhythmNext').addEventListener('click', () => shiftRhythmWindow(1))

$('#detailClose').addEventListener('click', closeDetail)
$('#detailScrim').addEventListener('click', (event) => {
  if (event.target === $('#detailScrim')) closeDetail()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDetail()
})

$('#refreshButton').addEventListener('click', refreshData)

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.sessions.length) render()
})

load()
