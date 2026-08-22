/**
 * The status-area panel: the ledger in one glance, without the dashboard.
 *
 * It reads the same generated snapshot the dashboard reads and states what it
 * finds. Every figure and every string comes from `glance-model.js`, so the
 * panel itself only fills slots and draws the geometry those figures describe.
 */

import { buildGlance, glanceFigures } from './glance-model.js'

const slots = new Map(
  [...document.querySelectorAll('[data-glance]')].map((node) => [node.dataset.glance, node]),
)
const trafficChart = document.querySelector('[data-glance-traffic]')
const trafficAxis = document.querySelector('[data-glance-axis]')
const heatmap = document.querySelector('[data-glance-heatmap]')
const modelList = document.querySelector('[data-glance-models]')
const modelsEmpty = document.querySelector('[data-glance-models-empty]')
const latestPane = document.querySelector('[data-glance-latest]')

/**
 * Rebuild the panel from the snapshot on disk.
 *
 * A snapshot the desktop shell has not written yet is an empty ledger, not a
 * failure: the panel is opened during first run too, and it says so instead of
 * showing a stale figure or nothing at all.
 */
export async function refresh() {
  const [sessions, meta] = await Promise.all([
    readJson('./data/sessions.json', []),
    readJson('./data/meta.json', null),
  ])
  const now = Date.now()
  const figures = glanceFigures(
    buildGlance(Array.isArray(sessions) ? sessions : [], {
      now,
      generatedAt: meta?.generatedAt ?? null,
    }),
    { now },
  )

  write('updated', figures.updated)
  write('today-tokens', figures.today.tokens)
  write('today-cost', figures.today.cost)
  write('today-note', figures.today.note)
  write('today-delta', figures.today.delta)
  write('week-meta', figures.week.meta)
  write('project-name', figures.project.name)
  write('project-note', figures.project.note)
  writeTraffic(figures.traffic)
  writeActivity(figures.activity)
  writeModels(figures.models)
  writeLatest(figures.latest)
  document.body.dataset.glanceReady = 'true'
}

/** One bar an hour, each a share of the busiest hour in the window. */
function writeTraffic(traffic) {
  write('traffic-peak', traffic.peak)
  trafficChart.replaceChildren(...traffic.hours.map((height) => {
    const bar = document.createElement('i')
    bar.style.height = percent(height)
    if (height <= 0) bar.dataset.empty = 'true'
    return bar
  }))
  trafficAxis.replaceChildren(...traffic.axis.map((label) => {
    const mark = document.createElement('span')
    mark.textContent = label
    return mark
  }))
}

/**
 * A day a cell, a week a column.
 *
 * The first column is padded to the weekday the window opens on, so every row
 * is one weekday down the whole strip rather than a rolling offset.
 */
function writeActivity(activity) {
  write('activity-note', activity.note)
  const pad = Array.from({ length: activity.leadingDays }, () => {
    const cell = document.createElement('i')
    cell.dataset.pad = 'true'
    return cell
  })
  heatmap.replaceChildren(...pad, ...activity.levels.map((level) => {
    const cell = document.createElement('i')
    cell.dataset.level = String(level)
    return cell
  }))
}

/** One meter a family, largest first, so the shares compare along one edge. */
function writeModels(models) {
  modelsEmpty.hidden = models.length > 0
  modelList.replaceChildren(...models.map((slice) => {
    const row = document.createElement('li')
    row.className = 'glance-model'

    const name = document.createElement('span')
    name.textContent = slice.family

    const meter = document.createElement('span')
    meter.className = 'glance-meter'
    const fill = document.createElement('i')
    fill.style.width = percent(slice.share)
    fill.style.background = `var(${slice.variable}, ${slice.fallback})`
    meter.append(fill)

    const share = document.createElement('span')
    share.className = 'glance-share'
    share.textContent = slice.percent

    row.append(name, meter, share)
    return row
  }))
}

function writeLatest(latest) {
  latestPane.hidden = latest === null
  if (latest === null) return
  write('latest-project', latest.project)
  write('latest-when', latest.when)
  write('latest-detail', latest.detail)
}

function write(slot, text) {
  const node = slots.get(slot)
  if (node) node.textContent = text
}

/**
 * A share as a CSS length.
 *
 * These are the only numbers the panel produces itself, because a bar's height
 * and a meter's width are geometry rather than figures anyone reads.
 * Everything printed comes from `glance-model.js`, where it is bounded.
 */
function percent(share) {
  const value = Number.isFinite(share) ? Math.max(0, Math.min(1, share)) : 0
  return `${Math.round(value * 10000) / 100}%`
}

async function readJson(path, fallback) {
  try {
    const response = await fetch(path, { cache: 'no-store' })
    if (!response.ok) return fallback
    return await response.json()
  } catch {
    return fallback
  }
}

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-panel-action]')
  if (!trigger) return
  void fetch('./api/panel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: trigger.dataset.panelAction }),
  })
})

// The shell reopens this window rather than rebuilding it, so it re-reads the
// snapshot on demand: once now, and again whenever the ledger changes.
window.agentUsageStatRefreshPanel = refresh
void refresh()
