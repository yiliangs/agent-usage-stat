/**
 * The status-area panel: the ledger in one glance, without the dashboard.
 *
 * It reads the same generated snapshot the dashboard reads and states what it
 * finds. Every figure and every string comes from `glance-model.js`, so the
 * panel itself only fills slots and never decides what a number means or how
 * wide it may be.
 */

import { buildGlance, glanceFigures } from './glance-model.js'

const slots = new Map(
  [...document.querySelectorAll('[data-glance]')].map((node) => [node.dataset.glance, node]),
)
const latestBand = document.querySelector('[data-glance-latest]')
const emptyNote = document.querySelector('[data-glance-empty]')

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
  for (const band of ['today', 'week']) {
    write(`${band}-tokens`, figures[band].tokens)
    write(`${band}-cost`, figures[band].cost)
    write(`${band}-note`, figures[band].note)
  }
  writeLatest(figures.latest)
  document.body.dataset.glanceReady = 'true'
}

function writeLatest(latest) {
  const known = latest !== null
  emptyNote.hidden = known
  for (const key of ['latest-project', 'latest-when', 'latest-detail']) {
    slots.get(key).hidden = !known
  }
  latestBand.querySelector('.glance-name').hidden = !known
  if (!known) return
  write('latest-project', latest.project)
  write('latest-when', latest.when)
  write('latest-detail', latest.detail)
}

function write(slot, text) {
  const node = slots.get(slot)
  if (node) node.textContent = text
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
