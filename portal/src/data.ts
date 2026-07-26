/* ============================================================
   Agent Usage Stat — data layer (artifact loader)
   Loads data/sessions.json (built from per-session usage shards by
   scripts/build-data.mjs), normalizes it into the in-memory shape the
   rest of the app expects, and exposes the LH singleton (the ES-module
   equivalent of a global). All aggregation is client-side over this array.

   Key normalizations vs the raw artifact:
   - start/end ISO strings -> epoch-ms numbers (every chart bins on numbers)
   - primary model + model family derived (cost/token rollups attribute a whole
     session to its primary family — the CSV does not split cost per model)
   - per-session _i index; derived PROJECTS / MACHINES / MODELS / BUILD / SPAN
   ============================================================ */
import type { RawSession, Meta } from './types'

// ---- model family palette (muted, distinct, leadership-friendly) ----
export interface FamDef {
  key: string
  label: string
  color: string
  border: string
}
const FAMS: FamDef[] = [
  { key: 'opus', label: 'Opus', color: '#C88754', border: '#6E4329' },
  { key: 'sonnet', label: 'Sonnet', color: '#8FB0D4', border: '#3F5E7E' },
  { key: 'haiku', label: 'Haiku', color: '#A8DDB8', border: '#4E8A63' },
  { key: 'fable', label: 'Fable', color: '#B6A0CE', border: '#5B4A6E' },
  { key: 'sol', label: 'Sol', color: '#9BC7A5', border: '#42694A' },
  { key: 'terra', label: 'Terra', color: '#D5B47A', border: '#735A2F' },
  { key: 'luna', label: 'Luna', color: '#94B6D8', border: '#405F7D' },
  { key: 'codex', label: 'Codex', color: '#82C6BE', border: '#356D67' },
  { key: 'gpt', label: 'GPT', color: '#A9B0B8', border: '#525A63' },
  { key: 'other', label: 'Other', color: '#BFBBB0', border: '#5F5A50' },
]
const FAM_BY: Record<string, FamDef> = {}
FAMS.forEach((f) => (FAM_BY[f.key] = f))

export function familyOf(model: string): string {
  const m = (model || '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('fable')) return 'fable'
  if (m.endsWith('-sol')) return 'sol'
  if (m.endsWith('-terra')) return 'terra'
  if (m.endsWith('-luna')) return 'luna'
  if (m.includes('codex')) return 'codex'
  if (m.includes('gpt-')) return 'gpt'
  return 'other'
}
// pretty short label for a full model id (claude-opus-4-8 -> Opus 4.8)
export function modelShort(model: string): string {
  const gptTier = /^gpt-([\d.]+)-(sol|terra|luna|codex)$/i.exec(model)
  if (gptTier) {
    const tier = gptTier[2]
    return `${gptTier[1]} ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`
  }
  if (/^gpt-/i.test(model)) {
    const parts = model.replace(/^gpt-/i, '').split('-')
    return `GPT ${parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')}`
  }
  if (model === 'codex-auto-review') return 'Auto Review'
  const m = (model || '').replace(/^claude-/, '').replace(/\[.*\]$/, '')
  const parts = m.split('-')
  const name = parts.shift() || m
  const ver = parts.join('.').replace(/\.(?=\d$)/, '.')
  const cap = name.charAt(0).toUpperCase() + name.slice(1)
  return ver ? cap + ' ' + ver : cap
}

// ---- token-type palette (input / output / cache write / cache read) ----
export interface TokDef {
  key: 'input' | 'output' | 'cacheCreate' | 'cacheRead'
  label: string
  color: string
  border: string
}
const TOKENS: TokDef[] = [
  { key: 'input', label: 'Input', color: '#8FB0D4', border: '#3F5E7E' },
  { key: 'output', label: 'Output', color: '#C88754', border: '#6E4329' },
  { key: 'cacheCreate', label: 'Cache Write', color: '#B6A0CE', border: '#5B4A6E' },
  { key: 'cacheRead', label: 'Cache Read', color: '#7FC6B5', border: '#3C6E62' },
]

const STATUS = { good: '#86b07a', warn: '#dd6a3d', bad: '#c8524a', lime: '#D2FE05' }
const DAY = 86400000

// A loaded session carries normalized numeric times + derived fields.
export interface LSession extends Omit<RawSession, 'start' | 'end' | 'turns'> {
  start: number
  end: number | null
  t: number // billing time = end (fallback start); ALL window/bucket math uses this
  primaryModel: string
  fam: string // primary model family key
  _i: number
  turns: LTurn[]
}

export interface LTurn {
  id: string
  start: number
  end: number
  t: number
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  totalTokens: number
  cost: number
  models: string[]
  primaryModel: string
  fam: string
}

// ---- formatting ----
const fmt = {
  int: (n: number | null) => (n == null ? '—' : Math.round(n).toLocaleString('en-US')),
  compact: (n: number | null) => {
    if (n == null) return '—'
    const a = Math.abs(n)
    if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'
    if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'
    if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K'
    return Math.round(n).toLocaleString('en-US')
  },
  num: (n: number | null, d = 1) =>
    n == null ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
  pct: (n: number | null, d = 1) => (n == null ? '—' : (n * 100).toFixed(d) + '%'),
  pct0: (n: number | null) => (n == null ? '—' : Math.round(n * 100) + '%'),
  // currency
  usd: (n: number | null, d = 2) =>
    n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
  usd0: (n: number | null) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US')),
  usdC: (n: number | null) => {
    if (n == null) return '—'
    const a = Math.abs(n)
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'
    return '$' + n.toFixed(2)
  },
  // ms duration (charts.tsx Histogram default x-formatter)
  ms: (ms: number | null) =>
    ms == null ? '—' : ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's',
  // seconds duration -> human
  dur: (sec: number | null) => {
    if (sec == null) return '—'
    const s = Math.round(sec)
    if (s < 60) return s + 's'
    const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24)
    if (d > 0) return d + 'd ' + (h % 24) + 'h'
    if (h > 0) return h + 'h ' + (m % 60) + 'm'
    return m + 'm ' + (s % 60) + 's'
  },
  date: (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  dateY: (t: number) => new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
  time: (t: number) => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
  datetime: (t: number) =>
    new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  rel: (t: number) => {
    const diff = (Date.now() - t) / 1000
    if (diff < 60) return 'just now'
    if (diff < 3600) return Math.round(diff / 60) + 'm ago'
    if (diff < 86400) return Math.round(diff / 3600) + 'h ago'
    return Math.round(diff / 86400) + 'd ago'
  },
}

// ---- the LH singleton (mutated in place by loadData) ----
export interface LHShape {
  SESSIONS: LSession[]
  PROJECTS: string[]
  MACHINES: string[]
  FAMS: FamDef[]
  FAM_BY: Record<string, FamDef>
  TOKENS: TokDef[]
  STATUS: typeof STATUS
  BUILD: Date
  SPAN: number
  DAY: number
  startOfWindow: Date
  meta: Meta | null
  fmt: typeof fmt
}

export const LH: LHShape = {
  SESSIONS: [],
  PROJECTS: [],
  MACHINES: [],
  FAMS,
  FAM_BY,
  TOKENS,
  STATUS,
  BUILD: new Date(),
  SPAN: 90,
  DAY,
  startOfWindow: new Date(),
  meta: null,
  fmt,
}

const base = import.meta.env.BASE_URL || '/'
let loaded = false

export async function loadData(): Promise<void> {
  if (loaded) return
  const [sessRaw, metaRaw] = await Promise.all([
    fetch(base + 'data/sessions.json').then((r) => {
      if (!r.ok) throw new Error('sessions.json not found (run: npm run data)')
      return r.json()
    }),
    fetch(base + 'data/meta.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ])

  const sessions: LSession[] = (sessRaw as RawSession[]).map((s, i) => {
    const primaryModel = s.models[0] || ''
    const startMs = Date.parse(s.start)
    const endMs = s.end ? Date.parse(s.end) : null
    const turns: LTurn[] = (s.turns || []).map((turn) => {
      const turnStart = Date.parse(turn.start)
      const turnEnd = Date.parse(turn.end)
      const turnPrimaryModel = turn.models[0] || primaryModel
      return {
        ...turn,
        start: turnStart,
        end: turnEnd,
        t: turnEnd,
        primaryModel: turnPrimaryModel,
        fam: familyOf(turnPrimaryModel),
      }
    })
    return {
      ...s,
      start: startMs,
      end: endMs,
      t: endMs ?? startMs, // spend lands on when the session ENDED
      primaryModel,
      fam: familyOf(primaryModel),
      turns,
      _i: i,
    }
  })

  // BUILD / SPAN / window
  let minStart = Infinity, maxStart = -Infinity
  for (const s of sessions) {
    if (s.start < minStart) minStart = s.start
    if (s.start > maxStart) maxStart = s.start
  }
  const meta = metaRaw as Meta | null
  const generatedAt = meta?.generatedAt ? Date.parse(meta.generatedAt) : Number.NaN
  const buildMs = Number.isFinite(generatedAt) ? generatedAt : Date.now()
  const latestSession = Number.isFinite(maxStart) ? maxStart : buildMs
  const earliestSession = Number.isFinite(minStart) ? minStart : latestSession
  const BUILD = new Date(Math.max(buildMs, latestSession))
  const SPAN = Math.max(1, Math.ceil((BUILD.getTime() - earliestSession) / DAY) + 1)
  const startOfWindow = new Date(BUILD.getTime() - SPAN * DAY)

  const PROJECTS = Array.from(new Set(sessions.map((s) => s.project))).filter(Boolean).sort((a, b) => a.localeCompare(b))
  const MACHINES = Array.from(new Set(sessions.map((s) => s.machine))).filter(Boolean).sort()

  LH.SESSIONS.length = 0
  LH.SESSIONS.push(...sessions)
  LH.PROJECTS = PROJECTS
  LH.MACHINES = MACHINES
  LH.BUILD = BUILD
  LH.SPAN = SPAN
  LH.startOfWindow = startOfWindow
  LH.meta = meta
  loaded = true
}
