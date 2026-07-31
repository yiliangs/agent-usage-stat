import { buildTokenTraffic, robustTokenTrafficScale } from './token-traffic.js'

const DAY = 86_400_000
const RANGE_DAYS = { '07D': 7, '14D': 14, '30D': 30, '90D': 90 }
const state = {
  sessions: [],
  meta: null,
  current: [],
  range: '30D',
  view: 'overview',
  spendView: 'heatmap',
  projectView: 'overview',
  tokenTrafficView: 'chart',
  tokenTraffic: null,
  rhythmView: 'week',
  rhythmAnchor: null,
  focusFamily: null,
  projectSort: { key: 'cost', direction: -1 },
  sessionSort: { key: 'start', direction: -1 },
  sessionQuery: '',
}

const MODEL_STYLES = {
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

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const sum = (items, read) => items.reduce((total, item) => total + read(item), 0)
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const fmt = {
  usd: (value) => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  compact: (value) => {
    const magnitude = Math.abs(value)
    if (magnitude >= 1e9) return (value / 1e9).toFixed(2) + 'B'
    if (magnitude >= 1e6) return (value / 1e6).toFixed(2) + 'M'
    if (magnitude >= 1e3) return (value / 1e3).toFixed(1) + 'K'
    return Math.round(value).toLocaleString('en-US')
  },
  date: (value) => new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short' }).format(value).toUpperCase(),
  dateYear: (value) => new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).format(value).toUpperCase(),
  time: (value) => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value),
  pct: (value) => Math.round(value * 100) + '%',
}

const LOCAL_TIME_ZONE = 'America/Chicago'
const localPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: LOCAL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})
const trafficTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: LOCAL_TIME_ZONE,
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function localParts(value) {
  return Object.fromEntries(localPartsFormatter.formatToParts(value).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
}

function localDateKey(value) {
  const parts = localParts(value)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function localHour(value) {
  return Number(localParts(value).hour)
}

function localMinute(value) {
  const parts = localParts(value)
  return Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60
}

function familyOf(model) {
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

function cssColor(variable, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback
}

function colorChannels(hex) {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16))
}

function styleForFamily(family) {
  const style = MODEL_STYLES[(family || 'other').toLowerCase()] || MODEL_STYLES.other
  const base = cssColor(style.variable, style.fallback)
  return { base, color: tintColor(base, .78) }
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

function normalize(session, index) {
  const time = Date.parse(session.end || session.start)
  return {
    ...session,
    _i: index,
    t: Number.isFinite(time) ? time : Date.parse(session.start),
    project: session.project || 'Unassigned',
    machine: session.machine || 'Unknown',
    provider: session.provider || 'claude',
    primaryModel: session.models?.[0] || 'unknown',
  }
}

function currentWindow() {
  const generated = Date.parse(state.meta?.generatedAt || '')
  const latest = Math.max(...state.sessions.map((session) => session.t), Date.now())
  const end = Number.isFinite(generated) ? Math.max(generated, latest) : latest
  const days = RANGE_DAYS[state.range]
  const start = days ? end - days * DAY : Math.min(...state.sessions.map((session) => session.t))
  return { start, end, days: days || Math.max(1, Math.ceil((end - start) / DAY)) }
}

function sessionsIn(start, end) {
  return state.sessions.filter((session) => session.t >= start && session.t <= end)
}

function totals(sessions) {
  const tokens = sum(sessions, (session) => session.totalTokens || 0)
  const cacheRead = sum(sessions, (session) => session.cacheRead || 0)
  return {
    cost: sum(sessions, (session) => session.cost || 0),
    sessions: sessions.length,
    tokens,
    cacheRead,
    input: sum(sessions, (session) => session.input || 0),
    output: sum(sessions, (session) => session.output || 0),
    cacheCreate: sum(sessions, (session) => session.cacheCreate || 0),
    avgCost: sessions.length ? sum(sessions, (session) => session.cost || 0) / sessions.length : 0,
    cacheRatio: tokens ? cacheRead / tokens : 0,
  }
}

function deltaText(current, previous, invert = false) {
  if (!previous) return 'No prior-period baseline'
  const change = (current - previous) / Math.abs(previous)
  const direction = change > 0 ? 'above' : 'below'
  const favorable = invert ? change < 0 : change > 0
  return `${Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}% ${direction} prior period${favorable ? '' : ''}`
}

function makeBuckets(sessions, start, end, preferredCount = 30) {
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

function makeCalendarBuckets(sessions, end, preferredCount = 30) {
  const count = Math.max(1, Math.round(preferredCount))
  const endDate = new Date(`${localDateKey(new Date(end))}T12:00:00Z`)
  const dateKeys = Array.from({ length: count }, (_, index) => {
    const date = new Date(endDate)
    date.setUTCDate(endDate.getUTCDate() - (count - index - 1))
    return date.toISOString().slice(0, 10)
  })
  const buckets = dateKeys.map((key) => ({
    key,
    start: Date.parse(`${key}T12:00:00Z`),
    cost: 0,
    sessions: 0,
    tokens: 0,
    families: {},
  }))
  const byDate = new Map(buckets.map((bucket) => [bucket.key, bucket]))
  for (const session of sessions) {
    const bucket = byDate.get(localDateKey(new Date(session.t)))
    if (!bucket) continue
    const family = familyOf(session.primaryModel)
    bucket.cost += session.cost || 0
    bucket.sessions += 1
    bucket.tokens += session.totalTokens || 0
    bucket.families[family] = (bucket.families[family] || 0) + (session.cost || 0)
  }
  return buckets
}

function render() {
  const period = currentWindow()
  const current = sessionsIn(period.start, period.end)
  const previous = sessionsIn(period.start - period.days * DAY, period.start)
  const currentTotals = totals(current)
  const previousTotals = totals(previous)
  state.current = current

  renderHeader(period, current)
  renderSummary(currentTotals, previousTotals)
  renderCadence(current, period)
  renderSpendField(current, period)
  renderCumulativeSpend(current, period)
  renderModels(current)
  renderProjects(current)
  renderConcentration(current)
  renderTopology(current)
  renderTokens(currentTotals)
  renderWorkRhythm(state.sessions, period)
  renderAnalysisViews(current, previous, period)
  applyProjectView()
  applyPortalView()
  bindPageInteractions()
}

function renderHeader(window, current) {
  const generated = new Date(state.meta?.generatedAt || Date.now())
  const machines = group(current, (session) => session.machine, () => 1)
  const machine = machines[0]?.key || state.sessions[0]?.machine || 'UNKNOWN'
  const metaValues = $$('.top-meta b')
  if (metaValues[0]) metaValues[0].textContent = machine.toUpperCase()
  if (metaValues[1]) metaValues[1].textContent = fmt.dateYear(generated)
  if (metaValues[2]) metaValues[2].textContent = `LIVE / ${fmt.time(generated)}`

  $('.period-range span').innerHTML = `${fmt.dateYear(new Date(window.start))}<br>${fmt.dateYear(new Date(window.end))}`
  $('.folio .index').textContent = `${String(current.length).padStart(2, '0')} / ${String(state.sessions.length).padStart(2, '0')}`
}

function renderSummary(current, previous) {
  $('.period-range strong').textContent = fmt.compact(current.tokens)
  $('.hero-number .value').textContent = fmt.usd(current.cost)
  const delta = $('.hero-number .delta')
  delta.innerHTML = `<i class="delta-mark"></i>${deltaText(current.cost, previous.cost, true)}`
  $('.hero-number').style.setProperty('--meter', `${100 * current.cost / Math.max(1, current.cost + previous.cost)}%`)

  const metrics = $$('.metric')
  const values = [
    [current.sessions.toLocaleString('en-US'), previous.sessions ? deltaText(current.sessions, previous.sessions) : 'No prior baseline'],
    [fmt.compact(current.tokens), previous.tokens ? deltaText(current.tokens, previous.tokens) : 'No prior baseline'],
    [fmt.usd(current.avgCost), previous.avgCost ? deltaText(current.avgCost, previous.avgCost, true) : 'No prior baseline'],
    [fmt.pct(current.cacheRatio), `${fmt.compact(current.cacheRead)} tokens`],
  ]
  const meterValues = [
    100 * current.sessions / Math.max(1, current.sessions + previous.sessions),
    100 * current.tokens / Math.max(1, current.tokens + previous.tokens),
    100 * current.avgCost / Math.max(.01, current.avgCost + previous.avgCost),
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
  const buckets = makeBuckets(sessions, window.start, window.end, bucketCount)
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
  const currentKeys = new Set(selectedDays
    ? makeCalendarBuckets([], window.end, selectedDays).map((bucket) => bucket.key)
    : buckets.map((bucket) => bucket.key))
  const firstCurrent = [...currentKeys][0]
  const priorEnd = Date.parse(`${firstCurrent}T12:00:00Z`) - DAY
  const priorKeys = new Set(selectedDays
    ? makeCalendarBuckets([], priorEnd, selectedDays).map((bucket) => bucket.key)
    : [])
  const rawMaxCost = Math.max(0, ...buckets.map((bucket) => bucket.cost))
  const maxCost = Math.max(1, rawMaxCost)
  const leading = (new Date(buckets[0].start).getUTCDay() + 6) % 7
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
    return `<button class="calendar-cell level-${level(bucket.cost)}${windowClass}${rawMaxCost > 0 && index === peakIndex ? ' peak' : ''}"
      data-tip="${fmt.date(new Date(bucket.start))} | ${fmt.usd(bucket.cost)} | ${bucket.sessions} sessions | ${period}"
      aria-label="${fmt.dateYear(new Date(bucket.start))}: ${fmt.usd(bucket.cost)}, ${bucket.sessions} sessions, ${period}"></button>`
  }).join('')
  const currentCost = sum(buckets.filter((bucket) => currentKeys.has(bucket.key)), (bucket) => bucket.cost)
  const priorCost = sum(buckets.filter((bucket) => priorKeys.has(bucket.key)), (bucket) => bucket.cost)
  const change = priorCost ? (currentCost - priorCost) / priorCost : null
  $('#heatmapSummary').innerHTML = `
    <div><span>${selectedDays ? `Current ${selectedDays}D` : 'Ledger total'}</span><b>${fmt.usd(currentCost)}</b></div>
    <div><span>${selectedDays ? `Prior ${selectedDays}D` : 'Prior window'}</span><b>${selectedDays ? fmt.usd(priorCost) : 'N/A'}</b></div>
    <div><span>Period change</span><b>${change === null ? 'N/A' : `${change >= 0 ? '+' : ''}${Math.round(change * 100)}%`}</b></div>`
  const monthLabels = $$('.calendar-months span')
  monthLabels[0].textContent = fmt.dateYear(new Date(buckets[0].start))
  monthLabels[1].textContent = fmt.dateYear(new Date(buckets[buckets.length - 1].start))
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
      return `<rect class="chart-mark stack-segment" data-family="${escapeHtml(segment.family)}" data-tip="${fmt.date(new Date(bucket.start))} | ${segment.family} | ${fmt.usd(segment.value)}" x="${x.toFixed(1)}" y="${cursor}" width="${barWidth.toFixed(1)}" height="${height}" rx=".8" fill="${style.color}"/>`
    }).join('')
  }).join('')

  const labelIndexes = [...new Set([0, Math.round((buckets.length - 1) * .2), Math.round((buckets.length - 1) * .4), Math.round((buckets.length - 1) * .6), Math.round((buckets.length - 1) * .8), buckets.length - 1])]
  const labels = labelIndexes.map((index) => {
    const x = left + slot * index + slot / 2
    const anchor = index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'
    return `<text x="${x}" y="500" text-anchor="${anchor}">${fmt.date(new Date(buckets[index].start))}</text>`
  }).join('')

  $('.legend').innerHTML = families.map((family) => {
    const style = styleForFamily(family)
    return `<span class="model-legend" data-family="${escapeHtml(family)}"><i style="background:${style.color}"></i>${escapeHtml(family)}</span>`
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
    const date = new Date(buckets[index].start)
    const weeklyCheckpoint = date.getUTCDay() === 1
    if (index !== 0 && !weeklyCheckpoint && index !== values.length - 1) return ''
    const isEnd = index === values.length - 1
    const role = isEnd ? 'period total' : index === 0 ? 'period start' : 'weekly checkpoint'
    return `<circle class="${isEnd ? 'cumulative-end' : 'cumulative-point'}" cx="${xFor(index)}" cy="${yFor(value)}" r="${isEnd ? 5 : 3.5}" data-tip="${fmt.date(date)} | ${role} | cumulative ${fmt.usd(value)} | day ${fmt.usd(buckets[index].cost)}"/>`
  }).join('')
  const labels = [0, Math.round((buckets.length - 1) / 2), buckets.length - 1].map((index) => `<text x="${xFor(index)}" y="406" text-anchor="${index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'}">${fmt.date(new Date(buckets[index].start))}</text>`).join('')
  $('.cumulative-plot').innerHTML = `<defs><linearGradient id="cumulativeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--token-mid)" stop-opacity=".28"/><stop offset="1" stop-color="var(--token-mid)" stop-opacity=".03"/></linearGradient></defs>${grid}<path class="cumulative-area" d="${area}"/><path class="cumulative-line" d="${line}"/>${points}${labels}<text x="${right}" y="25" text-anchor="end" class="annotation">PERIOD TOTAL / ${fmt.usd(values[values.length - 1] || 0)}</text>`
}

function renderModels(sessions) {
  const rows = group(sessions, (session) => familyOf(session.primaryModel), (session) => session.cost || 0)
  const total = sum(rows, (row) => row.value)
  const visible = foldRows(rows, 4)
  let cursor = 0
  const stops = visible.map((row) => {
    const start = cursor
    cursor += 100 * row.value / Math.max(1, total)
    return `${styleForFamily(row.key).color} ${start}% ${cursor}%`
  })
  $('.model-ring').style.background = `conic-gradient(${stops.join(', ')})`
  const largest = visible[0]
  $('.model-pie-caption b').textContent = largest ? fmt.pct(largest.value / Math.max(1, total)) : '0%'
  $('.model-pie-caption span').textContent = largest ? `${largest.key} / largest share` : 'No activity'
  $('.model-pie-key').innerHTML = visible.map((row) => {
    const share = row.value / Math.max(1, total)
    const style = styleForFamily(row.key)
    return `<div class="model-pie-row model-filter" data-family="${escapeHtml(row.key)}" style="--series:${style.color}"><i></i><span>${escapeHtml(row.key.toUpperCase())}</span><b>${fmt.pct(share)}</b></div>`
  }).join('')
}

function projectRows(sessions) {
  const projects = new Map()
  for (const session of sessions) {
    const project = projects.get(session.project) || { key: session.project, value: 0, families: {} }
    const family = familyOf(session.primaryModel)
    project.value += session.cost || 0
    project.families[family] = (project.families[family] || 0) + (session.cost || 0)
    projects.set(session.project, project)
  }
  return [...projects.values()].map((project) => ({
    ...project,
    family: Object.entries(project.families).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other',
  })).sort((a, b) => b.value - a.value)
}

function renderAnalysisViews(current, previous, period) {
  renderSpendAnalysis(current, previous, period)
  renderTokenAnalysis(current, previous, period)
  renderProjectAnalysis(current)
  renderSessionAnalysis(current)
}

function renderKpis(selector, items) {
  $(selector).innerHTML = items.map((item) => `
    <div class="analysis-kpi">
      <span class="micro">${escapeHtml(item.label)}</span>
      <b>${escapeHtml(item.value)}</b>
      <small>${escapeHtml(item.note || '')}</small>
    </div>`).join('')
}

function dailyUsageRows(sessions, period) {
  const count = clamp(Math.ceil((period.end - period.start) / DAY), 7, 30)
  const rows = makeCalendarBuckets(sessions, period.end, count).map((bucket) => ({
    ...bucket,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
  }))
  const byDate = new Map(rows.map((row) => [row.key, row]))
  for (const session of sessions) {
    const row = byDate.get(localDateKey(new Date(session.t)))
    if (!row) continue
    row.input += session.input || 0
    row.output += session.output || 0
    row.cacheCreate += session.cacheCreate || 0
    row.cacheRead += session.cacheRead || 0
  }
  return rows
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
    return `<line class="gridline" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/><text x="${left - 8}" y="${y + 3}" text-anchor="end">${escapeHtml(formatValue(value))}</text>`
  }).join('')
  const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])]
  const labels = labelIndexes.map((index) => `<text x="${xFor(index)}" y="232" text-anchor="${index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'}">${fmt.date(new Date(`${rows[index].key}T12:00:00Z`))}</text>`).join('')
  svg.innerHTML = `${grid}<line class="axis" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/><path class="area" d="${area}"/><path class="line" d="${line}"/>${values.map((value, index) => `<circle cx="${xFor(index)}" cy="${yFor(value)}" r="3" fill="${styleForFamily(Object.entries(rows[index].families || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other').base}" data-tip="${escapeHtml(rows[index].key)} | ${escapeHtml(formatValue(value))}"></circle>`).join('')}${labels}`
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
    ? `<text class="traffic-axis-label" x="${index * slot + 1}" y="270" text-anchor="${index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'}">${escapeHtml(trafficTimeFormatter.format(new Date(bucket.start)).toUpperCase())}</text>`
    : '').join('')
  const yLabels = Array.from({ length: 5 }, (_, index) => {
    const value = scale.max * (4 - index) / 4
    const y = breakY + usableHeight * index / 4
    return `<text x="48" y="${y + 3}" text-anchor="end">${escapeHtml(fmt.compact(value))}</text>`
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
  svg.innerHTML = `<title id="tokenTrafficTitle">Token traffic through the selected period</title><desc id="tokenTrafficDescription">${escapeHtml(description)}</desc>${clip}${grid}${barGroup}${breakMarkers}<line class="traffic-axis" x1="0" y1="${bottom}" x2="${width}" y2="${bottom}"/>${labels}<rect class="traffic-hover-band" id="tokenTrafficHoverBand" x="0" y="${top}" width="${slot}" height="${plotHeight}" hidden/><line class="traffic-crosshair" id="tokenTrafficCrosshair" x1="0" y1="${top}" x2="0" y2="${bottom}" hidden/><rect class="traffic-hit-field" x="0" y="${top}" width="${width}" height="${plotHeight}"/>`
  $('#tokenTrafficTableBody').innerHTML = active.length ? active.map((bucket) => `
    <tr>
      <td>${escapeHtml(trafficTimeFormatter.format(new Date(bucket.start)).toUpperCase())}</td>
      <td class="numeric">${escapeHtml(fmt.compact(bucket.totalTokens))}</td>
      <td class="numeric">${escapeHtml(fmt.compact(bucket.input))}</td>
      <td class="numeric">${escapeHtml(fmt.compact(bucket.output))}</td>
      <td class="numeric">${escapeHtml(fmt.compact(bucket.cacheCreate))}</td>
      <td class="numeric">${escapeHtml(fmt.compact(bucket.cacheRead))}</td>
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
    ? `<text class="traffic-axis-label" x="${index * slot + slot / 2}" y="226">${escapeHtml(fmt.date(new Date(`${row.key}T12:00:00Z`)))}</text>`
    : '').join('')
  const yLabels = Array.from({ length: 5 }, (_, index) => {
    const value = scale.max * (4 - index) / 4
    const y = breakY + usableHeight * index / 4
    return `<text x="48" y="${y + 3}" text-anchor="end">${escapeHtml(fmt.compact(value))}</text>`
  }).join('')
  const yBreak = scale.broken
    ? `<text class="traffic-break-label" x="48" y="10" text-anchor="end">BREAK</text><path class="traffic-y-break" d="M42 ${breakY - 4}l3 3l3 -3l3 3 M42 ${breakY + 1}l3 3l3 -3l3 3"/>`
    : ''
  const hitBuckets = rows.map((row, index) => {
    const date = fmt.date(new Date(`${row.key}T12:00:00Z`))
    const tip = `${date}\nTOTAL ${fmt.compact(row.tokens)}\nINPUT ${fmt.compact(row.input)} · OUTPUT ${fmt.compact(row.output)}\nCACHE WRITE ${fmt.compact(row.cacheCreate)} · CACHE READ ${fmt.compact(row.cacheRead)}`
    return `<rect class="traffic-hit-bucket multiline-tip" x="${index * slot}" y="${top}" width="${slot}" height="${plotHeight}" data-tip="${escapeHtml(tip)}"/>`
  }).join('')
  const description = scale.broken
    ? `Daily token volume shown as bars with ${scale.outlierCount} outlier day${scale.outlierCount === 1 ? '' : 's'} cut above ${fmt.compact(scale.max)} tokens. Hover retains actual values.`
    : 'Daily token volume shown as monochrome bars on a linear scale.'
  const clip = scale.broken ? `<defs><clipPath id="dailyTokenClip"><rect x="0" y="${breakY}" width="${width}" height="${usableHeight + 1}"/></clipPath></defs>` : ''
  const barGroup = scale.broken ? `<g clip-path="url(#dailyTokenClip)">${bars}</g>` : bars
  const svg = $('#tokenTrend')
  svg.setAttribute('viewBox', `0 0 ${width} 245`)
  svg.style.width = `${width}px`
  svg.innerHTML = `<title id="dailyTokenTitle">Daily token volume</title><desc id="dailyTokenDescription">${escapeHtml(description)}</desc>${clip}${grid}${barGroup}${breakMarkers}<line class="traffic-axis" x1="0" y1="${bottom}" x2="${width}" y2="${bottom}"/>${labels}${hitBuckets}`
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
      : row.project ? ` data-analysis-project="${escapeHtml(row.project)}"` : ''
    return `<${tag} class="analysis-bar-row"${attributes}><span class="analysis-bar-label">${escapeHtml(row.label)}${row.note ? `<small>${escapeHtml(row.note)}</small>` : ''}</span><span class="analysis-bar-track"><i style="width:${100 * row.value / max}%;${row.color ? `background:${row.color}` : ''}"></i></span><span class="analysis-bar-value">${escapeHtml(options.format ? options.format(row.value) : fmt.compact(row.value))}</span></${tag}>`
  }).join('') : '<p class="note">No recorded activity in this period.</p>'
}

function renderComposition(selector, rows, total, formatValue = fmt.usd) {
  $(selector).innerHTML = rows.length ? rows.map((row) => `
    <div class="composition-row" style="--series:${row.color || styleForFamily(row.key).base}">
      <i></i><span>${escapeHtml(row.key)}</span><b>${fmt.pct(row.value / Math.max(1, total))} / ${escapeHtml(formatValue(row.value))}</b>
      <span class="composition-meter"><i style="width:${100 * row.value / Math.max(1, total)}%"></i></span>
    </div>`).join('') : '<p class="note">No recorded activity in this period.</p>'
}

function renderSpendAnalysis(current, previous, period) {
  const value = totals(current)
  const prior = totals(previous)
  const activeDays = new Set(current.map((session) => localDateKey(new Date(session.t)))).size
  const maximum = current.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0))[0]
  renderKpis('#spendKpis', [
    { label: 'Total spend', value: fmt.usd(value.cost), note: deltaText(value.cost, prior.cost, true) },
    { label: 'Average / session', value: fmt.usd(value.avgCost), note: `${value.sessions} recorded sessions` },
    { label: 'Spend / active day', value: fmt.usd(value.cost / Math.max(1, activeDays)), note: `${activeDays} active day${activeDays === 1 ? '' : 's'}` },
    { label: 'Most expensive', value: fmt.usd(maximum?.cost || 0), note: maximum?.project || 'No sessions' },
  ])
  const days = dailyUsageRows(current, period)
  renderLineChart('#spendTrend', days, (row) => row.cost, fmt.usd)
  const machines = group(current, (session) => session.machine, (session) => session.cost || 0)
  renderComposition('#spendMachines', machines, value.cost)
  renderAnalysisBars('#spendProjects', projectRows(current).slice(0, 10).map((row) => ({ label: row.key, note: row.family, value: row.value, project: row.key, color: styleForFamily(row.family).base })), { format: fmt.usd })
  renderAnalysisBars('#spendSessions', current.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, 10).map((session) => ({ label: session.project, note: `${session.slug || session.sid || 'Session'} / ${shortModel(session.primaryModel)}`, value: session.cost || 0, sessionId: session._i, color: styleForFamily(familyOf(session.primaryModel)).base })), { format: fmt.usd })
}

function renderTokenAnalysis(current, previous, period) {
  const value = totals(current)
  const prior = totals(previous)
  const tokensPerDollar = value.cost ? value.tokens / value.cost : 0
  renderKpis('#tokenKpis', [
    { label: 'Total tokens', value: fmt.compact(value.tokens), note: deltaText(value.tokens, prior.tokens) },
    { label: 'Output', value: fmt.compact(value.output), note: fmt.pct(value.output / Math.max(1, value.tokens)) + ' of volume' },
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
  const projects = aggregateProjects(current).sort((a, b) => b.tokens - a.tokens).slice(0, 10)
  renderAnalysisBars('#tokenProjects', projects.map((project) => ({ label: project.project, note: project.family, value: project.tokens, project: project.project, color: styleForFamily(project.family).base })))
  const cacheRows = days.filter((row) => row.tokens > 0).slice(-10).map((row) => ({ label: row.key.slice(5), note: `${fmt.compact(row.cacheRead)} cache-read tokens`, value: row.cacheRead / row.tokens }))
  renderAnalysisBars('#cacheDays', cacheRows, { format: fmt.pct })
}

function aggregateProjects(sessions) {
  const rows = new Map()
  for (const session of sessions) {
    const row = rows.get(session.project) || {
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
    row.sessions += 1
    row.cost += session.cost || 0
    row.tokens += session.totalTokens || 0
    row.durSec += session.durSec || 0
    row.machines.add(session.machine)
    row.families[family] = (row.families[family] || 0) + (session.cost || 0)
    row.last = Math.max(row.last, session.t)
    rows.set(session.project, row)
  }
  return [...rows.values()].map((row) => ({
    ...row,
    machineCount: row.machines.size,
    avgCost: row.cost / Math.max(1, row.sessions),
    family: Object.entries(row.families).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other',
  }))
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

function renderProjectAnalysis(sessions) {
  const projects = aggregateProjects(sessions)
  const sorted = sortRows(projects, state.projectSort, {
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
  const top = projects.slice().sort((a, b) => b.cost - a.cost)[0]
  const busiest = projects.slice().sort((a, b) => b.sessions - a.sessions)[0]
  renderKpis('#projectKpis', [
    { label: 'Projects', value: String(projects.length), note: 'Active in selected period' },
    { label: 'Top spender', value: fmt.usd(top?.cost || 0), note: top?.project || 'No activity' },
    { label: 'Busiest', value: `${busiest?.sessions || 0} sessions`, note: busiest?.project || 'No activity' },
    { label: 'Average / project', value: fmt.usd(sum(projects, (row) => row.cost) / Math.max(1, projects.length)), note: 'API-equivalent value' },
  ])
  $('#projectCount').textContent = `${projects.length} project${projects.length === 1 ? '' : 's'} / click a row for detail`
  const columns = [
    ['project', 'Project'], ['sessions', 'Sessions'], ['cost', 'Spend'], ['tokens', 'Tokens'], ['avgCost', 'Avg / session'], ['durSec', 'Duration'], ['family', 'Top model'], ['machines', 'Boxes'], ['last', 'Last active'],
  ]
  $('#projectTable').innerHTML = `<thead><tr>${columns.map(([key, label]) => `<th data-project-sort="${key}" class="${['sessions', 'cost', 'tokens', 'avgCost', 'durSec', 'machines'].includes(key) ? 'numeric' : ''}">${label}${sortMark(key, state.projectSort)}</th>`).join('')}</tr></thead><tbody>${sorted.map((row) => `<tr data-analysis-project="${escapeHtml(row.project)}"><td class="primary">${escapeHtml(row.project)}</td><td class="numeric">${row.sessions}</td><td class="numeric">${fmt.usd(row.cost)}</td><td class="numeric">${fmt.compact(row.tokens)}</td><td class="numeric">${fmt.usd(row.avgCost)}</td><td class="numeric">${formatDuration(row.durSec)}</td><td><i class="model-mark" style="--series:${styleForFamily(row.family).base}"></i>${escapeHtml(row.family)}</td><td class="numeric">${row.machineCount}</td><td>${fmt.dateYear(new Date(row.last))}</td></tr>`).join('')}</tbody>`
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
    return `<tr data-analysis-session="${session._i}"><td>${escapeHtml(session.slug || session.sid || 'Session')}</td><td class="primary">${escapeHtml(session.project)}</td><td>${escapeHtml(session.machine)}</td><td><i class="model-mark" style="--series:${styleForFamily(family).base}"></i>${escapeHtml(shortModel(session.primaryModel))}</td><td>${fmt.dateYear(new Date(session.start))} / ${clockTime(Date.parse(session.start))}</td><td class="numeric">${escapeHtml(session.durHuman || formatDuration(session.durSec))}</td><td class="numeric">${fmt.compact(session.totalTokens || 0)}</td><td class="numeric">${fmt.usd(session.cost || 0)}</td></tr>`
  }).join('')}</tbody>`
}

function applyPortalView() {
  $$('.portal-view').forEach((view) => { view.hidden = view.dataset.view !== state.view })
  $$('[data-portal-view]').forEach((button) => {
    const active = button.dataset.portalView === state.view
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', String(active))
  })
}

function renderProjects(sessions) {
  const rows = projectRows(sessions).slice(0, 5)
  const max = rows[0]?.value || 1
  $('.project-list').innerHTML = rows.map((row, index) => {
    const style = styleForFamily(row.family)
    return `
    <div class="project-row project-filter" data-project="${escapeHtml(row.key)}" data-family="${escapeHtml(row.family)}" style="--series:${style.color}">
      <span class="rank">${String(index + 1).padStart(2, '0')}</span>
      <span class="name">${escapeHtml(row.key)}<small><i></i>${escapeHtml(row.family.toUpperCase())}</small></span>
      <span class="bar"><i style="width:${100 * row.value / max}%"></i></span>
      <span class="money">${fmt.usd(row.value)}</span>
    </div>`
  }).join('')
}

function renderTokens(current) {
  $('.token-figure .big').textContent = fmt.pct(current.cacheRatio)
  const total = Math.max(1, current.tokens)
  const counts = {
    cacheRead: Math.round(144 * current.cacheRead / total),
    cacheWrite: Math.round(144 * current.cacheCreate / total),
    input: Math.round(144 * current.input / total),
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

function renderConcentration(sessions) {
  const rows = projectRows(sessions)
  const total = sum(rows, (row) => row.value)
  const top = rows.slice(0, 3)
  const styles = top.map((row) => styleForFamily(row.family))
  const shares = top.map((row) => total ? row.value / total : 0)
  const concentration = shares.reduce((value, share) => value + share, 0)
  $('.ring-label b').textContent = fmt.pct(concentration)
  $('.ring-label span:first-child').textContent = `Top ${top.length}`
  $('.ring-label span:last-child').textContent = 'of spend'
  $('.note span:last-child').textContent = `${top.length} projects account for ${fmt.pct(concentration)} of period value. ${top[0] ? `${top[0].key} is the largest at ${fmt.usd(top[0].value)}.` : 'No project activity was recorded.'}`
  const ringParts = top.map((row, index) => ({ share: shares[index], color: styles[index].color }))
  const otherShare = Math.max(0, 1 - concentration)
  if (otherShare) ringParts.push({ share: otherShare, color: cssColor('--token-pale', '#d0cdc4') })
  $('.ring').style.background = segmentedConic(ringParts)
  const detailed = top.map((row, index) => `
    <div class="conc-row project-filter" data-project="${escapeHtml(row.key)}">
      <span class="rank">${String(index + 1).padStart(2, '0')}</span>
      <i style="--series:${styles[index].color}"></i>
      <span class="name">${escapeHtml(row.key)}<small>${escapeHtml(row.family.toUpperCase())} DOMINANT</small></span>
      <span class="share">${fmt.pct(shares[index])}</span>
      <span class="value">${fmt.usd(row.value)}</span>
    </div>`).join('')
  const otherValue = Math.max(0, total - sum(top, (row) => row.value))
  $('.ring-key').innerHTML = detailed + `
    <div class="conc-row">
      <span class="rank">04</span><i style="--series:var(--token-pale)"></i>
      <span class="name">Other projects<small>${Math.max(0, rows.length - top.length)} PROJECTS</small></span>
      <span class="share">${fmt.pct(1 - concentration)}</span><span class="value">${fmt.usd(otherValue)}</span>
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

function interpolateColor(start, end, amount) {
  const channels = (hex) => [0, 2, 4].map((index) => parseInt(hex.slice(index + 1, index + 3), 16))
  const from = channels(start)
  const to = channels(end)
  const mixed = from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount))
  return `rgb(${mixed.join(', ')})`
}

function monthHeatScale(values) {
  const normalize = normalizedLogScale(values)
  const chill = cssColor('--heat-chill', '#176F98')
  const neutral = cssColor('--heat-neutral', '#D8D2C5')
  const busy = cssColor('--heat-busy', '#A3483A')
  return (value) => {
    const normalized = normalize(value)
    const color = normalized <= .5
      ? interpolateColor(chill, neutral, normalized / .5)
      : interpolateColor(neutral, busy, (normalized - .5) / .5)
    return { normalized, color }
  }
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

function wrappedProjectLabel(project) {
  const value = String(project || 'Unassigned')
  const split = value.indexOf('-')
  if (split < 1) return escapeHtml(value)
  return `${escapeHtml(value.slice(0, split))}<br>${escapeHtml(value.slice(split + 1))}`
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
    ? renderMonthRhythm(dateKeys, segmentsByDate, observedThrough)
    : renderWeekRhythm(dateKeys, segmentsByDate)
  renderRhythmKey(visibleSessions, monthView)
  renderRhythmTable(dateKeys, segmentsByDate, monthView ? observedThrough : null)

  $('.rhythm-scroll').scrollLeft = 0
  $$('.rhythm-toggle button').forEach((button) => button.classList.toggle('active', button.dataset.rhythmView === state.rhythmView))
  const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${lastDate}T12:00:00Z`))
  $('#rhythmWindow').textContent = monthView ? monthLabel : `${firstDate.slice(5)} – ${lastDate.slice(5)}`
  $('#rhythmCoverage').textContent = `${visibleSessions.length} session${visibleSessions.length === 1 ? '' : 's'}`
  $('#rhythmViewNote').textContent = monthView ? 'Daily columns · 24-hour field' : '24-hour schedule'
  $('#rhythmDescription').textContent = monthView
    ? 'Each date is a vertical 24-hour heatmap. Cool blue marks chill intervals, warm brick red marks the busiest combined token velocity, and neutral bands sit between.'
    : 'A precise wall-clock view of each recorded session. Blocks use the shared model-family colors; darker shading indicates higher token velocity.'
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

function renderRhythmKey(sessions, monthView) {
  const key = $('#rhythmKey')
  if (monthView) {
    key.innerHTML = '<span class="rhythm-density-key"><span>Chill</span><i></i><span>Busy</span></span>'
    return
  }
  const families = [...new Set(sessions.map((session) => familyOf(session.primaryModel)))]
  if (!families.length) {
    key.innerHTML = '<span class="rhythm-key-note">No model activity in view</span>'
    return
  }
  key.innerHTML = `<span class="rhythm-key-label">Model family</span>${families.map((family) => {
    const series = styleForFamily(family).base
    return `<span class="rhythm-family-key"><i style="--series:${series};--fill:${tintColor(series, .46)}"></i>${escapeHtml(family)}</span>`
  }).join('')}<span class="rhythm-key-note">Shade = velocity</span>`
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

function renderWeekRhythm(dateKeys, segmentsByDate) {
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
  const days = renderWeekRhythmDays(dateKeys, segmentsByDate)
  return `<div class="rhythm-calendar-corner"><span>Local</span><b>Chicago</b></div><div class="rhythm-date-head" style="grid-template-columns:${columns}">${dateHead}</div><div class="rhythm-time-axis">${timeAxis}</div><div class="rhythm-days" style="grid-template-columns:${columns}">${days}</div>`
}

function renderWeekRhythmDays(dateKeys, segmentsByDate) {
  return dateKeys.map((date, dateIndex) => {
    const segments = segmentsByDate.get(date)
    const events = layoutConcurrent(segments).map((segment) => {
      const top = segment.startMinute / 1440 * WEEK_TIMELINE_HEIGHT
      const height = Math.max(4, (segment.endMinute - segment.startMinute) / 1440 * WEEK_TIMELINE_HEIGHT)
      const left = 100 * segment.lane / segment.laneCount
      const width = 100 / segment.laneCount
      const compact = height < 19 ? ' compact' : height < 38 ? ' brief' : ''
      const family = familyOf(segment.session.primaryModel)
      const seriesColor = styleForFamily(family).base
      const fillColor = tintColor(seriesColor, .34 + segment.normalized * .18)
      const durationMinutes = Math.max(1, (segment.end - segment.start) / 60_000)
      const tip = `${segment.session.project} | ${family} | ${clockTime(segment.start)}–${clockTime(segment.end)} | ${Math.round(durationMinutes)} min | ${fmt.compact(segment.session.totalTokens || 0)} tokens | ${fmt.compact(segment.tokensPerMinute)} tokens/min`
      return `<button class="rhythm-event${compact}" data-session-id="${segment.session._i}" data-tip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}" style="top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);background:${fillColor};border-left-color:${seriesColor};color:var(--event-ink)"><span>${wrappedProjectLabel(segment.session.project)}</span><small>${clockTime(segment.start)} · ${fmt.compact(segment.tokensPerMinute)}/min</small></button>`
    }).join('')
    return `<div class="${rhythmDayClasses(date, dateIndex, segments)}">${events}</div>`
  }).join('')
}

function monthBands(dateKeys, segmentsByDate) {
  const bandsByDate = new Map()
  const values = []
  for (const date of dateKeys) {
    const segments = segmentsByDate.get(date)
    const bands = []
    for (let startMinute = 0; startMinute < 1440; startMinute += 15) {
      const endMinute = startMinute + 15
      const active = segments.filter((segment) => segment.startMinute < endMinute && segment.endMinute > startMinute)
      if (!active.length) continue
      const density = sum(active, (segment) => segment.tokensPerMinute)
      const ids = active.map((segment) => segment.session._i).sort((a, b) => a - b)
      const key = ids.join(',')
      const previous = bands[bands.length - 1]
      if (previous && previous.key === key) {
        previous.endMinute = endMinute
      } else {
        bands.push({ key, ids, density, sessions: active.map((segment) => segment.session), startMinute, endMinute })
        values.push(density)
      }
    }
    bandsByDate.set(date, bands)
  }
  return { bandsByDate, colorFor: monthHeatScale(values) }
}

function renderMonthRhythm(dateKeys, segmentsByDate, observedThrough) {
  const { bandsByDate, colorFor } = monthBands(dateKeys, segmentsByDate)
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
  const days = renderMonthRhythmDays(dateKeys, segmentsByDate, bandsByDate, colorFor, observedThrough)
  return `<div class="rhythm-calendar-corner"><span>Local</span><b>Chicago</b></div><div class="rhythm-date-head" style="grid-template-columns:${columns}">${dateHead}</div><div class="rhythm-time-axis">${timeAxis}</div><div class="rhythm-days" style="grid-template-columns:${columns}">${days}</div>`
}

function renderMonthRhythmDays(dateKeys, segmentsByDate, bandsByDate, colorFor, observedThrough) {
  return dateKeys.map((date, dateIndex) => {
    const outsideWindow = date > observedThrough
    const bands = (outsideWindow ? [] : bandsByDate.get(date)).map((band) => {
      const top = band.startMinute / 1440 * MONTH_TIMELINE_HEIGHT
      const height = Math.max(2, (band.endMinute - band.startMinute) / 1440 * MONTH_TIMELINE_HEIGHT)
      const heat = colorFor(band.density)
      const activity = heat.normalized < .36 ? 'Chill' : heat.normalized > .68 ? 'Busy' : 'Moderate'
      const sessionLines = band.sessions.map((session) => {
        const { start, end } = sessionTimes(session)
        const velocity = (session.totalTokens || 0) / Math.max(1, (end - start) / 60_000)
        return { velocity, text: `${session.project} / ${shortModel(session.primaryModel)} / ${fmt.compact(velocity)} tokens/min` }
      }).sort((a, b) => b.velocity - a.velocity).map((item) => item.text)
      const tip = [`${date} ${minuteLabel(band.startMinute)}–${minuteLabel(band.endMinute)}`, `${activity} activity / ${band.ids.length} concurrent session${band.ids.length === 1 ? '' : 's'} / ${fmt.compact(band.density)} combined tokens/min`, '', ...sessionLines].join('\n')
      const tipAttribute = escapeHtml(tip).replace(/\n/g, '&#10;')
      const opacity = .74 + Math.abs(heat.normalized - .5) * .28
      return `<button class="rhythm-density-band" data-session-ids="${band.ids.join(',')}" data-date="${date}" data-start-minute="${band.startMinute}" data-end-minute="${band.endMinute}" data-density="${band.density}" data-activity="${activity}" data-tip="${tipAttribute}" aria-label="${escapeHtml(tip.replace(/\n/g, ', '))}" style="top:${top}px;height:${height}px;--band:${heat.color};--band-opacity:${opacity}"></button>`
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

function renderTopology(sessions) {
  const projects = projectRows(sessions).slice(0, 7)
  const familyRows = group(sessions, (session) => familyOf(session.primaryModel), (session) => session.cost || 0)
  const families = familyRows.length > 4 ? [...familyRows.slice(0, 3).map((row) => row.key), 'Other'] : familyRows.map((row) => row.key)
  const visible = new Set(families.filter((family) => family !== 'Other'))
  const cells = projects.flatMap((project) => families.map((family) => family === 'Other'
    ? Object.entries(project.families).filter(([key]) => !visible.has(key)).reduce((total, [, value]) => total + value, 0)
    : project.families[family] || 0))
  const maxCell = Math.max(1, ...cells)
  const grandTotal = sum(projectRows(sessions), (row) => row.value)
  const head = families.map((family) => {
    const style = styleForFamily(family)
    return `<th><span class="topology-head" style="--series:${style.color}"><i></i>${escapeHtml(family)}</span></th>`
  }).join('')
  const body = projects.map((project) => {
    const cellsHtml = families.map((family) => {
      const value = family === 'Other'
        ? Object.entries(project.families).filter(([key]) => !visible.has(key)).reduce((total, [, amount]) => total + amount, 0)
        : project.families[family] || 0
      if (!value) return '<td><button class="topology-cell empty" aria-label="No recorded value"></button></td>'
      return `<td><button class="topology-cell topology-filter" data-project="${escapeHtml(project.key)}" data-family="${escapeHtml(family)}" style="--cell:${100 * value / maxCell}%" data-tip="${escapeHtml(project.key)} | ${family} | ${fmt.usd(value)}"><b>${fmt.usd(value)}</b></button></td>`
    }).join('')
    const dominant = Object.entries(project.families).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other'
    return `<tr><th class="topology-project">${escapeHtml(project.key)}<small>${escapeHtml(dominant)} dominant</small></th>${cellsHtml}<td class="topology-total">${fmt.usd(project.value)}</td></tr>`
  }).join('')
  const foot = families.map((family) => {
    const value = family === 'Other'
      ? sum(familyRows.filter((row) => !visible.has(row.key)), (row) => row.value)
      : familyRows.find((row) => row.key === family)?.value || 0
    return `<td>${fmt.pct(value / Math.max(1, grandTotal))}</td>`
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

function escapeHtml(value) {
  const node = document.createElement('span')
  node.textContent = String(value)
  return node.innerHTML
}

function openDetail({ eyebrow, title, stats = [], sections = [] }) {
  $('#detailEyebrow').textContent = eyebrow
  $('#detailTitle').textContent = title
  $('#detailBody').innerHTML = `
    <div class="detail-summary">${stats.map((stat) => `<div class="detail-stat"><span class="micro">${escapeHtml(stat.label)}</span><b>${escapeHtml(stat.value)}</b></div>`).join('')}</div>
    ${sections.map((section) => `<section class="detail-section"><h3>${escapeHtml(section.title)}</h3>${section.html || `<p>${escapeHtml(section.text || '')}</p>`}</section>`).join('')}`
  $('#detailScrim').hidden = false
  document.body.style.overflow = 'hidden'
}

function closeDetail() {
  $('#detailScrim').hidden = true
  document.body.style.overflow = ''
}

function detailList(rows) {
  return `<div class="detail-list">${rows.map((row) => `<div><span>${escapeHtml(row.label)}</span><b>${escapeHtml(row.value)}</b></div>`).join('')}</div>`
}

function openProjectDetail(project) {
  const sessions = state.current.filter((session) => session.project === project)
  const value = totals(sessions)
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
  const value = totals([session])
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
  const value = totals(sessions)
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
  const value = totals(sessions)
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
    const value = totals(sessions)
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
  const current = totals(state.current)
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
  $$('.topology-filter').forEach((cell) => {
    cell.onclick = () => openTopologyDetail(cell.dataset.project, cell.dataset.family)
  })
  $$('.rhythm-event, .rhythm-density-band').forEach((event) => {
    event.onclick = () => openRhythmDetail(event)
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
      renderProjectAnalysis(state.current)
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
      tooltip.classList.toggle('multiline', element.classList.contains('rhythm-density-band') || element.classList.contains('multiline-tip'))
      tooltip.style.display = 'block'
    }
    element.onmousemove = (event) => positionTooltip(tooltip, event)
    element.onmouseleave = () => { tooltip.style.display = 'none' }
  })
}

async function refreshData() {
  const button = $('#refreshButton')
  const message = $('#refreshMessage')
  if (button.disabled) return
  button.disabled = true
  button.className = 'refresh-button running'
  message.textContent = 'Scanning sessions'
  try {
    const response = await fetch('./api/refresh', { method: 'POST' })
    const result = await response.json().catch(() => null)
    if (!response.ok) throw new Error(result?.error || `Refresh failed (${response.status})`)
    await load()
    button.className = 'refresh-button success'
    message.textContent = result?.updated ? `${result.updated} sessions updated` : 'Already current'
  } catch (error) {
    button.className = 'refresh-button error'
    message.textContent = error.message || String(error)
  } finally {
    button.disabled = false
    window.setTimeout(() => {
      button.className = 'refresh-button'
      message.textContent = ''
    }, 3500)
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
    state.sessions = sessions.map(normalize).filter((session) => Number.isFinite(session.t))
    state.meta = meta
    const requestedView = window.location.hash.slice(1)
    if (['overview', 'spend', 'tokens', 'projects', 'sessions'].includes(requestedView)) state.view = requestedView
    render()
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
  state.view = button.dataset.portalView
  window.history.replaceState(null, '', `#${state.view}`)
  applyPortalView()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}))

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
