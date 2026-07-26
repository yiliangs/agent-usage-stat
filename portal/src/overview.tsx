/* Agent Usage Stat — Overview (flagship). Spend health at a glance. */
import { useState, useMemo } from 'react'
import { LH } from './data'
import { LHA } from './agg'
import { LHC } from './charts'
import { LHU } from './ui'

const fmt = LH.fmt

export function Overview({ sessions, prevSessions, win, bks, filters, toggleFilter, openProject, openSession }: any) {
  const [hidden, setHidden] = useState<any>({})
  const toggleHide = (k: string) => setHidden((h: any) => ({ ...h, [k]: !h[k] }))

  const t = useMemo(() => LHA.totals(sessions), [sessions])
  const pt = useMemo(() => LHA.totals(prevSessions), [prevSessions])
  const costStack = useMemo(() => LHA.costOverTime(sessions, bks), [sessions, bks])
  const costSpark = useMemo(() => LHA.costSeries(sessions, bks), [sessions, bks])
  const sessSpark = useMemo(() => LHA.sessionSeries(sessions, bks), [sessions, bks])
  const tokSpark = useMemo(() => LHA.tokenSeries(sessions, bks), [sessions, bks])
  const cacheSpark = useMemo(() => LHA.cacheHitSeries(sessions, bks).map((v) => v ?? 0), [sessions, bks])
  const cumSpend = useMemo(() => LHA.cumulative(costSpark), [costSpark])
  const mix = useMemo(() => LHA.modelMix(sessions), [sessions])
  const tops = useMemo(() => LHA.topProjects(sessions, 'cost').slice(0, 7), [sessions])
  const big = useMemo(() => LHA.biggestSessions(sessions, 7), [sessions])

  const unit = win.unit === 'day' ? 'day' : 'week'
  const kpis = [
    { k: 'Total Spend', v: fmt.usd0(t.cost), cur: t.cost, prev: pt.cost, invert: true, spark: costSpark, sparkColor: '#C88754' },
    { k: 'Sessions', v: fmt.int(t.sessions), cur: t.sessions, prev: pt.sessions, spark: sessSpark, sparkColor: '#8FB0D4' },
    { k: 'Tokens', v: fmt.compact(t.tokens), cur: t.tokens, prev: pt.tokens, spark: tokSpark, sparkColor: '#7FC6B5' },
    { k: 'Avg / Session', v: fmt.usd(t.avgCost), cur: t.avgCost, prev: pt.avgCost, invert: true, spark: costSpark, sparkColor: '#BFBBB0' },
    { k: 'Cache Read', v: fmt.pct0(t.cacheHit), cur: t.cacheHit, prev: pt.cacheHit, spark: cacheSpark, sparkColor: '#A8DDB8' },
  ]
  const totMix = mix.reduce((a, m) => a + m.cost, 0)

  return (
    <>
      <LHU.KpiStrip items={kpis} />

      {/* Row B — spend over time + model mix */}
      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', marginTop: 14 }}>
        <LHU.Card
          title="Spend Over Time"
          hint={'usd · per ' + unit + ' · by response model'}
          right={<LHU.Legend feats={costStack} hidden={hidden} onToggle={toggleHide} />}
        >
          <LHC.StackedBars series={costStack} labels={bks.map((b: any) => b.label)} height={250} hidden={hidden} yFmt={fmt.usdC} />
        </LHU.Card>

        <LHU.Card title="Model Mix" hint="share of spend">
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0 16px' }}>
            <LHC.Donut segments={mix.map((m) => ({ value: m.cost, color: m.color }))} centerTop={fmt.usdC(totMix)} centerBot="SPEND" />
          </div>
          <div className="fmix">
            {mix.map((m) => (
              <div key={m.key}>
                <div
                  className="fmrow"
                  onClick={() => toggleFilter('models', m.key)}
                  style={{ cursor: 'pointer' }}
                >
                  <span className="sw" style={{ background: m.color, opacity: filters.models.size && !filters.models.has(m.key) ? 0.3 : 1 }} />
                  <span className="nm">{m.label}</span>
                  <span className="q tnum">
                    {fmt.pct0(m.share)}
                    <i>{fmt.usdC(m.cost)}</i>
                  </span>
                  <span className="bar">
                    <span className="f" style={{ width: 100 * m.share + '%', background: m.color, opacity: 0.85 }} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </LHU.Card>
      </div>

      {/* Row C — cumulative spend + top projects + biggest sessions */}
      <div className="grid" style={{ gridTemplateColumns: '1.2fr 1fr 1.1fr', marginTop: 14 }}>
        <LHU.Card title="Cumulative Spend" hint={'running total · per ' + unit}>
          <LHC.MultiLine
            labels={bks.map((b: any) => b.label)}
            height={210}
            yFmt={fmt.usdC}
            series={[{ key: 'cum', label: 'Cumulative', color: '#D2FE05', values: cumSpend, w: 2 }]}
          />
        </LHU.Card>

        <LHU.Card title="Top Projects" hint="by spend · click to filter">
          <LHU.HList
            rows={tops.map((p: any, i: number) => ({
              key: p.project,
              rank: String(i + 1).padStart(2, '0'),
              name: p.project,
              sub: p.sessions + ' ses',
              value: p.cost,
              valLabel: fmt.usd(p.cost),
              color: LH.FAM_BY[p.topFam]?.color || 'var(--txt1)',
              onClick: () => openProject(p.project),
            }))}
          />
        </LHU.Card>

        <LHU.Card title="Highest-Cost Sessions" hint="by cost · click to open">
          <LHU.HList
            rows={big.map((s: any, i: number) => ({
              key: s._i,
              rank: String(i + 1).padStart(2, '0'),
              name: s.project,
              sub: fmt.date(s.start),
              swatch: LH.FAM_BY[s.fam]?.color,
              value: s.cost,
              valLabel: fmt.usd(s.cost),
              onClick: () => openSession(s),
            }))}
          />
        </LHU.Card>
      </div>
    </>
  )
}
