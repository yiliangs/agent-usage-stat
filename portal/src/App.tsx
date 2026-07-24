/* Agent Usage Stat — app shell: header, search, nav rail, cross-filter state,
   session detail drawer. Loads the usage artifact once; all aggregation is client-side. */
import { useState, useMemo, useRef, useEffect } from 'react'
import { LH, loadData } from './data'
import { LHA } from './agg'
import { LHI } from './icons'
import { Overview } from './overview'
import { Spend } from './spend'
import { Tokens } from './tokens'
import { Projects } from './projects'
import { Sessions } from './sessions'
import { Drawer } from './drill'
import type { Filters, RangeKey, ViewKey } from './types'

const NAV: Array<{ key: ViewKey; label: string; icon: typeof LHI.Pulse }> = [
  { key: 'overview', label: 'Overview', icon: LHI.Pulse },
  { key: 'spend', label: 'Spend', icon: LHI.Coin },
  { key: 'tokens', label: 'Tokens', icon: LHI.Bolt },
  { key: 'projects', label: 'Projects', icon: LHI.Folder },
  { key: 'sessions', label: 'Sessions', icon: LHI.Table },
]
const RANGES: [RangeKey, string][] = [
  ['7d', '7D'],
  ['14d', '14D'],
  ['30d', '30D'],
  ['90d', '90D'],
  ['all', 'ALL'],
]
const HEADS: Record<ViewKey, [string, string]> = {
  overview: ['Spend Overview', 'What is the API-equivalent cost, and where is it going?'],
  spend: ['Spend', 'Where the money goes — by project, model, machine, and session.'],
  tokens: ['Tokens', 'Token composition and how much work the cache is saving.'],
  projects: ['Projects', 'One row per project — spend, tokens, and activity at a glance.'],
  sessions: ['Session Explorer', 'Every recorded session, ready to filter, sort, and inspect.'],
}

// prev-period filter (same dims, previous window) for KPI deltas
function applyPrev(f: Filters) {
  const win = LHA.windowFor(f.range)
  const q = (f.search || '').trim().toLowerCase()
  const useR = f.providers?.size || 0, useP = f.projects.size, useM = f.machines.size, useF = f.models.size
  const out: any[] = []
  for (const s of LH.SESSIONS) {
    if (s.t < win.prevStart || s.t >= win.prevEnd) continue
    if (useR && !f.providers.has(s.provider)) continue
    if (f.vendors?.size && !Object.keys(s.byVendor || {}).some((v) => f.vendors.has(v))) continue
    if (useP && !f.projects.has(s.project)) continue
    if (useM && !f.machines.has(s.machine)) continue
    if (useF && !s.models.some((m: string) => f.models.has(LHA.famOf(m)))) continue
    if (
      q &&
      !(s.project.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q) || s.machine.toLowerCase().includes(q))
    )
      continue
    out.push(s)
  }
  return out
}

export function App() {
  const [ready, setReady] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [view, setView] = useState<ViewKey>('overview')
  const [filters, setFilters] = useState<Filters>({
    range: '30d',
    providers: new Set<string>(),
    vendors: new Set<string>(),
    projects: new Set<string>(),
    machines: new Set<string>(),
    models: new Set<string>(),
    search: '',
  })
  const [drill, setDrill] = useState<any>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchVal, setSearchVal] = useState('')
  const [refreshState, setRefreshState] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [refreshMessage, setRefreshMessage] = useState('')
  const searchRef = useRef<any>(null)

  useEffect(() => {
    loadData()
      .then(() => setReady(true))
      .catch((e) => setLoadErr(e.message || String(e)))
  }, [])

  // Auto-reload when the snapshot on disk changes. The launcher re-runs
  // build-data and then `vite --open` re-focuses this (already-open) tab WITHOUT
  // reloading it — so loadData()'s once-only fetch never re-runs and you keep
  // seeing stale numbers. On every focus/visibility regain we re-check meta.json
  // (tiny, no-store) and hard-reload only when generatedAt actually moved.
  useEffect(() => {
    if (!ready) return
    const base = import.meta.env.BASE_URL || '/'
    const loadedAt = LH.meta?.generatedAt || null
    const check = async () => {
      if (document.hidden) return
      try {
        const m = await fetch(base + 'data/meta.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))
        if (m && m.generatedAt && m.generatedAt !== loadedAt) location.reload()
      } catch {
        /* offline / server down — keep showing what we have */
      }
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [ready])

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }))
  const toggleFilter = (dim: 'providers' | 'projects' | 'machines' | 'models', value: string) =>
    setFilters((f) => {
      const next = new Set(f[dim])
      next.has(value) ? next.delete(value) : next.add(value)
      return { ...f, [dim]: next }
    })
  const clearAll = () => set({ providers: new Set(), vendors: new Set(), projects: new Set(), machines: new Set(), models: new Set(), search: '' })

  const win = useMemo(() => LHA.windowFor(filters.range), [filters.range, ready])
  const bks = useMemo(() => LHA.buckets(win), [win])
  const sessions = useMemo(() => LHA.applyFilters(filters), [filters, ready])
  const prevSessions = useMemo(() => applyPrev(filters), [filters, ready])

  const openProject = (name: string) => { toggleFilter('projects', name); setSearchOpen(false); setSearchVal('') }
  const openSession = (s: any) => setDrill({ session: s })
  const focusProject = (name: string) => {
    setFilters((f) => ({ ...f, projects: new Set<string>([name]) }))
    setView('sessions')
    setDrill(null)
  }
  const goView = (v: ViewKey) => { setView(v); setDrill(null) }

  // keyboard: / focuses search, esc closes
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== searchRef.current) {
        e.preventDefault()
        searchRef.current && searchRef.current.focus()
      }
      if (e.key === 'Escape') { setDrill(null); setSearchOpen(false) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const sres = useMemo(() => {
    const q = searchVal.trim().toLowerCase()
    if (!q || !ready) return { projects: [], sessions: [] }
    const projects = LH.PROJECTS.filter((p) => p.toLowerCase().includes(q)).slice(0, 6)
    const sess = LH.SESSIONS.filter((s) => s.slug.toLowerCase().includes(q) || s.sid.toLowerCase().includes(q)).slice(0, 6)
    return { projects, sessions: sess }
  }, [searchVal, ready])

  const refreshData = async () => {
    if (refreshState === 'running') return
    setRefreshState('running')
    setRefreshMessage('Scanning agent sessions')
    try {
      const base = import.meta.env.BASE_URL || '/'
      const response = await fetch(base + 'api/refresh', { method: 'POST' })
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error(result?.error || `Refresh failed (${response.status})`)
      const updated = Number(result?.updated || 0)
      setRefreshState('success')
      setRefreshMessage(updated ? `${updated} session${updated === 1 ? '' : 's'} updated` : 'Already current')
      window.setTimeout(() => location.reload(), 450)
    } catch (error) {
      setRefreshState('error')
      setRefreshMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const refreshControl = (
    <div className={'refresh-control ' + refreshState}>
      <button className="refreshbtn" onClick={refreshData} disabled={refreshState === 'running'}>
        {refreshState === 'running' ? 'Refreshing' : 'Refresh data'}
      </button>
      {refreshMessage && <span className="refresh-message" title={refreshMessage}>{refreshMessage}</span>}
    </div>
  )

  if (loadErr)
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="zero" style={{ textAlign: 'center' }}>
          <div className="big">no data</div>
          <div>{loadErr}</div>
          {refreshControl}
        </div>
      </div>
    )
  if (!ready)
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="zero">loading ledger…</div>
      </div>
    )
  if (LH.SESSIONS.length === 0)
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="zero" style={{ textAlign: 'center' }}>
          <div className="big">Ready for your first session</div>
          <div>Use Claude Code or Codex, then refresh the ledger.</div>
          {refreshControl}
        </div>
      </div>
    )

  const fmt = LH.fmt
  const allCost = LH.SESSIONS.reduce((a, s) => a + s.cost, 0)

  const activeChips: any[] = []
  filters.models.forEach((k) => activeChips.push({ dim: 'models', value: k, label: LH.FAM_BY[k]?.label || k, sw: LH.FAM_BY[k]?.color, ck: 'Model' }))
  filters.projects.forEach((p) => activeChips.push({ dim: 'projects', value: p, label: p, ck: 'Project' }))
  filters.machines.forEach((m) => activeChips.push({ dim: 'machines', value: m, label: m, ck: 'Machine' }))
  const hasFilters = filters.providers.size > 0 || filters.vendors.size > 0 || activeChips.length > 0 || filters.search

  const viewEl = (() => {
    switch (view) {
      case 'overview':
        return <Overview {...{ sessions, prevSessions, win, bks, filters, toggleFilter, openProject, openSession }} />
      case 'spend':
        return <Spend {...{ sessions, prevSessions, win, bks, openProject, openSession }} />
      case 'tokens':
        return <Tokens {...{ sessions, prevSessions, win, bks, openProject }} />
      case 'projects':
        return <Projects {...{ sessions, focusProject }} />
      case 'sessions':
        return <Sessions {...{ sessions, openSession }} />
      default:
        return null
    }
  })()

  return (
    <div className="app">
      <div className="brandcell"><div className="mk"><Mark /></div></div>

      <div className="head">
        <span className="title"><b>AGENT</b>Usage Stat</span>
        <span className="sp" />
        <div className="gsearch">
          <span className="ic"><LHI.Search s={14} /></span>
          <input
            ref={searchRef}
            placeholder="Search projects or session id…"
            value={searchVal}
            onChange={(e) => { setSearchVal(e.target.value); setSearchOpen(true) }}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
          />
          {!searchVal && <span className="kbd">/</span>}
          {searchOpen && searchVal && (
            <div className="gsearch-pop">
              {sres.projects.length === 0 && sres.sessions.length === 0 && <div className="gsearch-sec">no matches</div>}
              {sres.projects.length > 0 && <div className="gsearch-sec">Projects</div>}
              {sres.projects.map((p) => (
                <div className="gsearch-it" key={p} onMouseDown={() => openProject(p)}>
                  <LHI.Folder s={14} style={{ color: 'var(--txt2)' }} />
                  <span className="nm">{p}</span>
                </div>
              ))}
              {sres.sessions.length > 0 && <div className="gsearch-sec">Sessions</div>}
              {sres.sessions.map((s) => (
                <div className="gsearch-it" key={s._i} onMouseDown={() => { openSession(s); setSearchOpen(false); setSearchVal('') }}>
                  <span className="mono" style={{ fontSize: 12, color: 'var(--txt0)' }}>{s.slug}</span>
                  <span className="meta">{s.project}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <span className="sp" />
        {refreshControl}
        <div className="fresh">
          <span className="dot" />
          Built <b>{fmt.rel(LH.BUILD.getTime())}</b>
          <span className="sepv" />
          <b title="total spend across the whole ledger">{fmt.usd0(allCost)}</b> spend
          <span className="sepv" />
          <b>{fmt.int(LH.SESSIONS.length)}</b> sessions
          <span className="sepv" />
          <b>{LH.PROJECTS.length}</b> projects
        </div>
      </div>

      <div className="nav">
        {NAV.map((n) => (
          <button key={n.key} className={'navbtn' + (view === n.key ? ' on' : '')} onClick={() => goView(n.key)}>
            <n.icon s={18} />
            <span className="tip">{n.label}</span>
          </button>
        ))}
      </div>

      <div className="main">
        <div className="filterbar">
          <span className="fb-lab">Range</span>
          <div className="daterange">
            {RANGES.map(([k, l]) => (
              <button key={k} className={filters.range === k ? 'on' : ''} onClick={() => set({ range: k })}>{l}</button>
            ))}
          </div>
          <span className="fb-sep" />
          <span className="fb-lab">Provider</span>
          <div className="daterange">
            {[
              ['', 'ALL'],
              ['claude', 'CLAUDE'],
              ['codex', 'CODEX'],
            ].map(([key, label]) => (
              <button
                key={label}
                className={(key === '' ? filters.providers.size === 0 : filters.providers.has(key)) ? 'on' : ''}
                onClick={() => set({ providers: key ? new Set([key]) : new Set() })}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="fb-sep" />
          <span className="fb-lab">Vendor</span>
          <div className="daterange">
            {[
              ['', 'ALL'],
              ['anthropic', 'ANTHROPIC'],
              ['openai', 'OPENAI'],
            ].map(([key, label]) => (
              <button
                key={label}
                className={(key === '' ? filters.vendors.size === 0 : filters.vendors.has(key)) ? 'on' : ''}
                onClick={() => set({ vendors: key ? new Set([key]) : new Set() })}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="fb-sep" />
          <span className="fb-lab">Filters</span>
          {filters.providers.size === 0 && filters.vendors.size === 0 && activeChips.length === 0 && !filters.search && (
            <span className="chip empty"><span className="ck">none · click any chart element</span></span>
          )}
          {filters.search && (
            <span className="chip">
              <span className="ck">Search</span>
              {filters.search}
              <button className="x" onClick={() => set({ search: '' })}>×</button>
            </span>
          )}
          {activeChips.map((c, i) => (
            <span className="chip" key={i}>
              {c.sw && <span className="sw" style={{ background: c.sw }} />}
              <span className="ck">{c.ck}</span>
              {c.label}
              <button className="x" onClick={() => toggleFilter(c.dim, c.value)}>×</button>
            </span>
          ))}
          {hasFilters && <button className="clearall" onClick={clearAll}>Clear all</button>}
          <span className="sp" style={{ flex: 1 }} />
        </div>

        <div className="content" style={view === 'sessions' ? { display: 'flex', flexDirection: 'column' } : undefined}>
          <div className="viewhead">
            <div>
              <div className="eyebrow">{view === 'overview' ? 'AT A GLANCE' : 'ANALYSIS'}</div>
              <h1>{HEADS[view][0]}</h1>
            </div>
            <div className="sp" />
            <div className="sub">{HEADS[view][1]}</div>
          </div>
          {viewEl}
        </div>
      </div>

      <Drawer drill={drill} onClose={() => setDrill(null)} />
    </div>
  )
}

function Mark() {
  return (
    <svg width={26} height={26} viewBox="0 0 26 26" fill="none">
      <rect x={4} y={2.5} width={18} height={21} rx={3} stroke="var(--txt2)" strokeWidth={1.4} />
      <path d="M8 7h10M8 11h10M8 15h6" stroke="var(--txt0)" strokeWidth={1.5} strokeLinecap="round" />
      <circle cx={18.5} cy={18.5} r={2} fill="var(--lime)" />
    </svg>
  )
}
