const DAY = 86_400_000
const RANGE_DAYS = { '07D': 7, '14D': 14, '30D': 30, '90D': 90 }
const state = { sessions: [], meta: null, current: [], range: '30D', spendView: 'bars', projectView: 'overview', focusFamily: null }

const MODEL_STYLES = {
  fable: { color: '#3172c1' },
  sol: { color: '#ba5d37' },
  opus: { color: '#238e6e' },
  sonnet: { color: '#a97e0e' },
  haiku: { color: '#b56181' },
  terra: { color: '#0f7c0e' },
  luna: { color: '#6459b7' },
  codex: { color: '#b84e4e' },
  gpt: { color: '#6459b7' },
  other: { color: '#7d807c' },
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

function styleForFamily(family) {
  return MODEL_STYLES[(family || 'other').toLowerCase()] || MODEL_STYLES.other
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
  renderWorkRhythm(current, period)
  applyProjectView()
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

  $('.period-range strong').textContent = state.range
  $('.period-range span').innerHTML = `${fmt.dateYear(new Date(window.start))}<br>${fmt.dateYear(new Date(window.end))}`
  $('.folio .index').textContent = `${String(current.length).padStart(2, '0')} / ${String(state.sessions.length).padStart(2, '0')}`
}

function renderSummary(current, previous) {
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
  renderSpendHeatmap(sessions, window)
  $('.spend-bars-view').hidden = state.spendView !== 'bars'
  $('.spend-heatmap-view').hidden = state.spendView !== 'heatmap'
  $$('.spend-toggle button').forEach((button) => button.classList.toggle('active', button.dataset.spendView === state.spendView))
}

function renderSpendHeatmap(sessions, window) {
  const selectedDays = RANGE_DAYS[state.range]
  const count = selectedDays || clamp(Math.ceil((window.end - window.start) / DAY), 30, 180)
  const buckets = makeBuckets(sessions, window.start, window.end, count)
  const maxCost = Math.max(1, ...buckets.map((bucket) => bucket.cost))
  const leading = (new Date(buckets[0].start).getDay() + 6) % 7
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
  $('#spendHeatmap').innerHTML = blanks + buckets.map((bucket, index) => `
    <button class="calendar-cell level-${level(bucket.cost)}${index === peakIndex ? ' peak' : ''}"
      data-tip="${fmt.date(new Date(bucket.start))} | ${fmt.usd(bucket.cost)} | ${bucket.sessions} sessions"
      aria-label="${fmt.dateYear(new Date(bucket.start))}: ${fmt.usd(bucket.cost)}, ${bucket.sessions} sessions"></button>`).join('')
  const activeDays = buckets.filter((bucket) => bucket.sessions).length
  const totalCost = sum(buckets, (bucket) => bucket.cost)
  const peak = buckets[peakIndex]
  $('#heatmapSummary').innerHTML = `
    <div><span>Active days</span><b>${activeDays} / ${buckets.length}</b></div>
    <div><span>Peak day</span><b>${fmt.usd(peak.cost)}</b></div>
    <div><span>Daily average</span><b>${fmt.usd(totalCost / Math.max(1, buckets.length))}</b></div>`
}

function renderSpendChart(sessions, window) {
  const count = state.range === '07D' ? 7 : state.range === '14D' ? 14 : 30
  const buckets = makeBuckets(sessions, window.start, window.end, count)
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
  const left = 58, right = 738, chartTop = 54, baseline = 471
  const chartWidth = right - left, chartHeight = baseline - chartTop
  const slot = chartWidth / Math.max(1, buckets.length)
  const barWidth = Math.min(28, Math.max(8, slot * .68))
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
    <text class="annotation" x="${Math.min(620, peakX + 10)}" y="31">PERIOD PEAK</text>
    <text class="annotation" x="${Math.min(620, peakX + 10)}" y="46">${fmt.usd(peak.cost)} / ${peak.sessions} SESSIONS</text>
    ${labels}`
  bindTooltips()
}

function renderCumulativeSpend(sessions, window) {
  const selectedDays = RANGE_DAYS[state.range]
  const count = selectedDays || clamp(Math.ceil((window.end - window.start) / DAY), 30, 120)
  const buckets = makeBuckets(sessions, window.start, window.end, count)
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
  const markerStep = Math.max(1, Math.round(values.length / 7))
  const points = values.map((value, index) => index % markerStep === 0 || index === values.length - 1
    ? `<circle class="${index === values.length - 1 ? 'cumulative-end' : 'cumulative-point'}" cx="${xFor(index)}" cy="${yFor(value)}" r="${index === values.length - 1 ? 5 : 3.5}" data-tip="${fmt.date(new Date(buckets[index].start))} | cumulative ${fmt.usd(value)} | day ${fmt.usd(buckets[index].cost)}"/>`
    : '').join('')
  const labels = [0, Math.round((buckets.length - 1) / 2), buckets.length - 1].map((index) => `<text x="${xFor(index)}" y="406" text-anchor="${index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'}">${fmt.date(new Date(buckets[index].start))}</text>`).join('')
  $('.cumulative-plot').innerHTML = `<defs><linearGradient id="cumulativeFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8e8b83" stop-opacity=".28"/><stop offset="1" stop-color="#8e8b83" stop-opacity=".03"/></linearGradient></defs>${grid}<path class="cumulative-area" d="${area}"/><path class="cumulative-line" d="${line}"/>${points}${labels}<text x="${right}" y="25" text-anchor="end" class="annotation">PERIOD TOTAL / ${fmt.usd(values[values.length - 1] || 0)}</text>`
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

function renderConcentration(sessions) {
  const rows = projectRows(sessions)
  const total = sum(rows, (row) => row.value)
  const top = rows.slice(0, 3)
  const styles = top.map((row) => styleForFamily(row.family))
  const shares = top.map((row) => total ? row.value / total : 0)
  const concentration = shares.reduce((value, share) => value + share, 0)
  $('.ring-label b').textContent = fmt.pct(concentration)
  $('.ring-label span:first-child').textContent = `Top ${top.length}`
  $('.ring-label span:last-child').textContent = 'of period value'
  $('.note span:last-child').textContent = `${top.length} projects account for ${fmt.pct(concentration)} of period value. ${top[0] ? `${top[0].key} is the largest at ${fmt.usd(top[0].value)}.` : 'No project activity was recorded.'}`
  const first = (shares[0] || 0) * 100
  const second = first + (shares[1] || 0) * 100
  const third = second + (shares[2] || 0) * 100
  $('.ring').style.background = `conic-gradient(${styles[0]?.color || '#3172c1'} 0 ${first}%, ${styles[1]?.color || '#ba5d37'} ${first}% ${second}%, ${styles[2]?.color || '#238e6e'} ${second}% ${third}%, #d0cdc4 ${third}% 100%)`
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
      <span class="rank">04</span><i style="--series:#d0d1cd"></i>
      <span class="name">Other projects<small>${Math.max(0, rows.length - top.length)} PROJECTS</small></span>
      <span class="share">${fmt.pct(1 - concentration)}</span><span class="value">${fmt.usd(otherValue)}</span>
    </div>`
}

function renderWorkRhythm(sessions, window) {
  const selectedDays = RANGE_DAYS[state.range]
  const dayCount = Math.min(30, selectedDays || 30)
  const dateKeys = []
  for (let offset = dayCount - 1; offset >= 0; offset -= 1) {
    const key = localDateKey(new Date(window.end - offset * DAY))
    if (!dateKeys.includes(key)) dateKeys.push(key)
  }
  const buckets = new Map()
  for (const session of sessions) {
    const start = new Date(session.start)
    const date = localDateKey(start)
    const hour = localHour(start)
    if (!dateKeys.includes(date)) continue
    const key = `${date}|${hour}`
    const bucket = buckets.get(key) || { sessions: [], cost: 0, tokens: 0, families: {} }
    const family = familyOf(session.primaryModel)
    bucket.sessions.push(session)
    bucket.cost += session.cost || 0
    bucket.tokens += session.totalTokens || 0
    bucket.families[family] = (bucket.families[family] || 0) + 1
    buckets.set(key, bucket)
  }
  const maxCount = Math.max(1, ...[...buckets.values()].map((bucket) => bucket.sessions.length))
  const dayTotals = Array(dateKeys.length).fill(0)
  const level = (count) => {
    if (!count) return 0
    const ratio = count / maxCount
    if (ratio < .25) return 1
    if (ratio < .5) return 2
    if (ratio < .8) return 3
    return 4
  }
  const dateHead = dateKeys.map((date) => {
    const labelDate = new Date(`${date}T12:00:00Z`)
    const label = new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' }).format(labelDate).toUpperCase()
    return `<span class="rhythm-date">${label}</span>`
  }).join('')
  const rows = Array.from({ length: 24 }, (_, hour) => {
    let hourTotal = 0
    const cells = dateKeys.map((date, dateIndex) => {
      const bucket = buckets.get(`${date}|${hour}`)
      const count = bucket?.sessions.length || 0
      hourTotal += count
      dayTotals[dateIndex] += count
      if (!count) return '<span class="rhythm-cell"></span>'
      const dominant = Object.entries(bucket.families).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Other'
      const ids = bucket.sessions.map((session) => session._i).join(',')
      return `<button class="rhythm-cell has-data level-${level(count)}${count === maxCount ? ' peak' : ''}" data-session-ids="${ids}" data-date="${date}" data-hour="${hour}" data-tip="${date} ${String(hour).padStart(2, '0')}:00 | ${count} sessions | ${fmt.usd(bucket.cost)} | ${dominant}" aria-label="${date}, ${hour}:00, ${count} sessions"></button>`
    }).join('')
    return `<span class="rhythm-hour">${String(hour).padStart(2, '0')}:00</span>${cells}<span class="rhythm-row-total">${hourTotal || '·'}</span>`
  }).join('')
  const maxDay = Math.max(1, ...dayTotals)
  const totalsRow = dayTotals.map((count) => `<span class="rhythm-total" style="--bar:${100 * count / maxDay}%"><i></i><b>${count || ''}</b></span>`).join('')
  const field = $('#workRhythm')
  field.style.gridTemplateColumns = `70px repeat(${dateKeys.length}, minmax(27px, 1fr)) 58px`
  field.style.minWidth = `${Math.max(900, 70 + dateKeys.length * 31 + 58)}px`
  field.innerHTML = `<span></span>${dateHead}<span class="rhythm-date">Σ</span>${rows}<span class="rhythm-total-label">Day total</span>${totalsRow}<span class="rhythm-total-sum">${sum(dayTotals, (value) => value)}</span>`
  $('#rhythmWindow').textContent = `Latest ${dateKeys.length} days`
  $('#rhythmCoverage').textContent = `${sum(dayTotals, (value) => value)} session starts`
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
      { title: 'Encoding', text: `${family} uses a fixed solid color throughout the portal. Pattern is reserved for non-model secondary information.` },
    ],
  })
}

function openRhythmDetail(element) {
  const ids = (element.dataset.sessionIds || '').split(',').filter(Boolean)
  const sessions = ids.map((id) => state.sessions.find((session) => String(session._i) === id)).filter(Boolean)
  const value = totals(sessions)
  const projects = new Set(sessions.map((session) => session.project))
  const hour = `${String(element.dataset.hour).padStart(2, '0')}:00`
  openDetail({
    eyebrow: 'Local-time activity',
    title: `${element.dataset.date} / ${hour}`,
    stats: [
      { label: 'Session starts', value: String(value.sessions) },
      { label: 'Period value', value: fmt.usd(value.cost) },
      { label: 'Tokens', value: fmt.compact(value.tokens) },
      { label: 'Projects', value: String(projects.size) },
    ],
    sections: [
      { title: 'Sessions beginning in this hour', html: detailList(sessions.slice().sort((a, b) => (b.cost || 0) - (a.cost || 0)).map((session) => ({ label: `${session.project} / ${shortModel(session.primaryModel)}`, value: fmt.usd(session.cost || 0) }))) },
      { title: 'Measurement', text: 'This field records session starts in America/Chicago local time. It does not claim continuous hourly activity inside long-running sessions.' },
    ],
  })
}

function openMetricDetail(index) {
  const current = totals(state.current)
  const definitions = [
    ['Session count', String(current.sessions), 'Recorded agent sessions in the selected period. The background hatch length compares this period with the previous period.'],
    ['Token volume', fmt.compact(current.tokens), 'Total input, output, cache-write, and cache-read tokens. Token types use grayscale patterns rather than model colors.'],
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
  $$('.rhythm-cell.has-data').forEach((cell) => {
    cell.onclick = () => openRhythmDetail(cell)
  })
  $$('.metric').forEach((metric, index) => {
    metric.onclick = () => openMetricDetail(index)
  })
}

function bindTooltips() {
  const tooltip = $('#tooltip')
  $$('[data-tip]').forEach((element) => {
    element.onmouseenter = () => {
      tooltip.textContent = element.dataset.tip
      tooltip.style.display = 'block'
    }
    element.onmousemove = (event) => {
      tooltip.style.left = `${event.clientX + 16}px`
      tooltip.style.top = `${event.clientY + 16}px`
    }
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
    $('.footer span:first-child').innerHTML = '<strong>Style study 13</strong> / modular real-data prototype / original portal unchanged'
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

$$('[data-spend-view]').forEach((button) => button.addEventListener('click', () => {
  state.spendView = button.dataset.spendView
  renderSpendField(state.current, currentWindow())
  bindPageInteractions()
}))

$$('[data-project-view]').forEach((button) => button.addEventListener('click', () => {
  state.projectView = button.dataset.projectView
  applyProjectView()
  bindPageInteractions()
}))

$('#detailClose').addEventListener('click', closeDetail)
$('#detailScrim').addEventListener('click', (event) => {
  if (event.target === $('#detailScrim')) closeDetail()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDetail()
})

$('#refreshButton').addEventListener('click', refreshData)

load()
