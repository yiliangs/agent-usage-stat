/* ============================================================
   Agent Usage Stat — aggregation engine
   Pure functions over the in-memory session array. Everything the views
   need is derived here so cross-filtering is instant. Reads LH.* at call
   time so the async-loaded data is always current.

   Cost-attribution note: the logbook records one cost per session, not a
   per-model split. Any "by model" rollup attributes the whole session cost
   (and tokens) to its PRIMARY model family (first model id listed). Token-
   TYPE rollups (input/output/cache) are exact — those columns are per session.
   ============================================================ */
import { LH, familyOf, modelShort } from './data'
import type { Filters, RangeKey } from './types'

function startOfLocalDay(ms: number) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function addLocalDays(ms: number, days: number) {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

function windowFor(range: RangeKey) {
  const END = LH.BUILD.getTime()
  const days = range === '7d' ? 7 : range === '14d' ? 14 : range === '30d' ? 30 : range === '90d' ? 90 : LH.SPAN + 1
  // Portal labels are local calendar dates, so filtering and buckets must use
  // the same local-midnight boundary. Mixing UTC windows with local labels can
  // move late-evening usage into the neighboring displayed day.
  const start = addLocalDays(startOfLocalDay(END), -days)
  const unit = days <= 92 ? 'day' : 'week'
  return { days, start, end: END, prevStart: addLocalDays(start, -days), prevEnd: start, unit }
}

// apply all filters → array of sessions
function applyFilters(f: Filters) {
  const win = windowFor(f.range)
  const q = (f.search || '').trim().toLowerCase()
  const useR = f.providers?.size || 0, useP = f.projects.size, useM = f.machines.size, useF = f.models.size
  const useV = f.vendors?.size || 0
  const out: any[] = []
  const S = LH.SESSIONS
  for (let i = 0; i < S.length; i++) {
    const s = S[i]
    if (s.t < win.start || s.t > win.end) continue
    if (useR && !f.providers.has(s.provider)) continue
    if (useV && !Object.keys(s.byVendor || {}).some((v) => f.vendors.has(v))) continue
    if (useP && !f.projects.has(s.project)) continue
    if (useM && !f.machines.has(s.machine)) continue
    if (useF && !s.models.some((m: string) => f.models.has(familyOf(m)))) continue
    if (
      q &&
      !(
        s.project.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.sid.toLowerCase().includes(q) ||
        s.machine.toLowerCase().includes(q) ||
        s.branch.toLowerCase().includes(q)
      )
    )
      continue
    out.push(s)
  }
  return out
}

// ---- time bucketing ----
function buckets(win: any) {
  const out: any[] = []
  if (win.unit === 'day') {
    let start = startOfLocalDay(win.start)
    while (start <= win.end) {
      const end = addLocalDays(start, 1)
      out.push({ start, end, label: LH.fmt.date(start) })
      start = end
    }
  } else {
    const first = new Date(startOfLocalDay(win.start))
    const weekdayFromMonday = (first.getDay() + 6) % 7
    let start = addLocalDays(first.getTime(), -weekdayFromMonday)
    while (start <= win.end) {
      const end = addLocalDays(start, 7)
      out.push({ start, end, label: LH.fmt.date(start) })
      start = end
    }
  }
  return out
}
function bucketIndex(bks: any[], ms: number) {
  for (let i = 0; i < bks.length; i++) if (ms >= bks[i].start && ms < bks[i].end) return i
  return bks.length && ms >= bks[bks.length - 1].start ? bks.length - 1 : -1
}

// New shards can retain exact turn slices. Older shards fall back to their
// session aggregate so every provider still flows through the same functions.
function temporalSlices(session: any): any[] {
  return session.turns?.length ? session.turns : [session]
}

// ---- headline totals ----
function totals(sessions: any[]) {
  const t: any = {
    sessions: sessions.length, cost: 0, tokens: 0, input: 0, output: 0,
    cacheCreate: 0, cacheRead: 0, durSec: 0, projects: new Set(), machines: new Set(),
  }
  for (const s of sessions) {
    t.cost += s.cost
    t.tokens += s.totalTokens
    t.input += s.input
    t.output += s.output
    t.cacheCreate += s.cacheCreate
    t.cacheRead += s.cacheRead
    t.durSec += s.durSec
    t.projects.add(s.project)
    t.machines.add(s.machine)
  }
  t.projectCount = t.projects.size
  t.machineCount = t.machines.size
  t.avgCost = t.sessions ? t.cost / t.sessions : 0
  t.cacheHit = t.tokens ? t.cacheRead / t.tokens : 0
  return t
}

// ---- cost over time, stacked by model family ----
function costOverTime(sessions: any[], bks: any[]) {
  const FAMS = LH.FAMS
  const series = FAMS.map((f) => ({ key: f.key, label: f.label, color: f.color, border: f.border, values: bks.map(() => 0) }))
  const byKey: any = {}
  series.forEach((s) => (byKey[s.key] = s))
  for (const s of sessions) {
    for (const slice of temporalSlices(s)) {
      const bi = bucketIndex(bks, slice.t)
      if (bi < 0) continue
      byKey[slice.fam].values[bi] += slice.cost
    }
  }
  // drop all-zero families so the legend stays tight
  return series.filter((s) => s.values.some((v) => v > 0))
}

// ---- tokens over time, stacked by token type (exact) ----
function tokensOverTime(sessions: any[], bks: any[]) {
  const TOK = LH.TOKENS
  const series = TOK.map((t) => ({ key: t.key, label: t.label, color: t.color, border: t.border, values: bks.map(() => 0) }))
  for (const s of sessions) {
    for (const slice of temporalSlices(s)) {
      const bi = bucketIndex(bks, slice.t)
      if (bi < 0) continue
      series[0].values[bi] += slice.input
      series[1].values[bi] += slice.output
      series[2].values[bi] += slice.cacheCreate
      series[3].values[bi] += slice.cacheRead
    }
  }
  return series
}

// ---- scalar series (sparklines + single-line charts) ----
function scalarSeries(sessions: any[], bks: any[], pick: (s: any) => number) {
  const v = bks.map(() => 0)
  for (const session of sessions) {
    for (const slice of temporalSlices(session)) {
      const bi = bucketIndex(bks, slice.t)
      if (bi >= 0) v[bi] += pick(slice)
    }
  }
  return v
}
const costSeries = (s: any[], b: any[]) => scalarSeries(s, b, (x) => x.cost)
const tokenSeries = (s: any[], b: any[]) => scalarSeries(s, b, (x) => x.totalTokens)
const sessionSeries = (s: any[], b: any[]) => scalarSeries(s, b, () => 1)
function cumulative(arr: number[]) {
  let acc = 0
  return arr.map((v) => (acc += v))
}
// cache-hit ratio per bucket (cacheRead / total tokens)
function cacheHitSeries(sessions: any[], bks: any[]) {
  const read = bks.map(() => 0), tot = bks.map(() => 0)
  for (const session of sessions) {
    for (const slice of temporalSlices(session)) {
      const bi = bucketIndex(bks, slice.t)
      if (bi >= 0) { read[bi] += slice.cacheRead; tot[bi] += slice.totalTokens }
    }
  }
  return bks.map((_, i) => (tot[i] ? read[i] / tot[i] : null))
}

// ---- model mix (by cost, primary family) ----
function modelMix(sessions: any[]) {
  const FAMS = LH.FAMS
  const m: any = {}
  FAMS.forEach((f) => (m[f.key] = { cost: 0, tokens: 0, sessions: 0, models: new Set<string>() }))
  let totCost = 0, totTok = 0
  for (const s of sessions) {
    m[s.fam].cost += s.cost
    m[s.fam].tokens += s.totalTokens
    m[s.fam].sessions += 1
    if (s.primaryModel) m[s.fam].models.add(modelShort(s.primaryModel))
    totCost += s.cost
    totTok += s.totalTokens
  }
  return FAMS.map((f) => ({
    key: f.key,
    label: f.key === 'gpt' && m[f.key].models.size ? [...m[f.key].models].sort().join(' / ') : f.label,
    color: f.color, border: f.border,
    cost: m[f.key].cost, tokens: m[f.key].tokens, sessions: m[f.key].sessions,
    share: totCost ? m[f.key].cost / totCost : 0,
    tokShare: totTok ? m[f.key].tokens / totTok : 0,
  }))
    .filter((f) => f.sessions > 0)
    .sort((a, b) => b.cost - a.cost)
}

// ---- token mix (by type, exact) ----
function tokenMix(sessions: any[]) {
  const TOK = LH.TOKENS
  const sums = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
  for (const s of sessions) {
    sums.input += s.input; sums.output += s.output
    sums.cacheCreate += s.cacheCreate; sums.cacheRead += s.cacheRead
  }
  const total = sums.input + sums.output + sums.cacheCreate + sums.cacheRead
  return TOK.map((t) => ({
    key: t.key, label: t.label, color: t.color, border: t.border,
    value: (sums as any)[t.key], share: total ? (sums as any)[t.key] / total : 0,
  })).sort((a, b) => b.value - a.value)
}

// ---- project rollup (roster + top-N) ----
function projectRoster(sessions: any[]) {
  const map: any = {}
  for (const s of sessions) {
    let p = map[s.project]
    if (!p)
      p = map[s.project] = {
        project: s.project, sessions: 0, cost: 0, tokens: 0, durSec: 0,
        first: Infinity, last: 0, machines: new Set(), famCost: {},
      }
    p.sessions++
    p.cost += s.cost
    p.tokens += s.totalTokens
    p.durSec += s.durSec
    if (s.start < p.first) p.first = s.start
    if (s.start > p.last) p.last = s.start
    p.machines.add(s.machine)
    p.famCost[s.fam] = (p.famCost[s.fam] || 0) + s.cost
  }
  return Object.values(map).map((p: any) => {
    let topFam: string | null = null, topVal = -1
    for (const k in p.famCost) if (p.famCost[k] > topVal) { topVal = p.famCost[k]; topFam = k }
    return {
      ...p, machines: p.machines.size, topFam,
      avgCost: p.sessions ? p.cost / p.sessions : 0,
    }
  })
}
function topProjects(sessions: any[], by = 'cost') {
  return projectRoster(sessions).sort((a: any, b: any) => b[by] - a[by])
}

// ---- machine / location rollup (donuts) ----
function byDimCost(sessions: any[], dim: string) {
  const m: any = {}
  for (const s of sessions) {
    const k = s[dim] || '—'
    if (!m[k]) m[k] = { key: k, cost: 0, sessions: 0, tokens: 0 }
    m[k].cost += s.cost
    m[k].sessions++
    m[k].tokens += s.totalTokens
  }
  return Object.values(m).sort((a: any, b: any) => b.cost - a.cost)
}

// ---- biggest sessions (by cost) ----
function biggestSessions(sessions: any[], n = 12) {
  return sessions.slice().sort((a, b) => b.cost - a.cost).slice(0, n)
}

export const LHA = {
  windowFor,
  applyFilters,
  famOf: familyOf,
  buckets,
  bucketIndex,
  totals,
  costOverTime,
  tokensOverTime,
  costSeries,
  tokenSeries,
  sessionSeries,
  cumulative,
  cacheHitSeries,
  modelMix,
  tokenMix,
  projectRoster,
  topProjects,
  byDimCost,
  biggestSessions,
}
