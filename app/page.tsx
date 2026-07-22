'use client'

import { FormEvent, useMemo, useState } from 'react'
import { ArrowDownTrayIcon, ArrowPathIcon, BoltIcon, CheckCircleIcon, GlobeAltIcon, MagnifyingGlassIcon, MapPinIcon, PaperAirplaneIcon, PlusIcon, StarIcon } from '@heroicons/react/24/outline'

type Lead = { id: string; name: string; domain: string; website: string; description: string | null; industry: string | null; email: string | null; phone: string | null; linkedinUrl: string | null; address: string | null; rating: number | null; reviewCount: number | null; mapsUrl: string | null; filingType: string | null; source: string; status: 'enriched' | 'domain-only' | 'filing' }
const presets = ['Landscaping', 'Beauty salon', 'Pressure washing', 'Roofing', 'HVAC', 'Cleaning']

export default function Home() {
  const [leads, setLeads] = useState<Lead[]>([]), [query, setQuery] = useState('')
  const [industry, setIndustry] = useState('Landscaping'), [location, setLocation] = useState('Orlando, FL'), [limit, setLimit] = useState(25)
  const [minRating, setMinRating] = useState(0), [minReviews, setMinReviews] = useState(0), [filing, setFiling] = useState('all')
  const [hasPhone, setHasPhone] = useState(false), [hasWebsite, setHasWebsite] = useState(false), [deliver, setDeliver] = useState(false)
  const [sources, setSources] = useState({ google: true, sunbiz: true })
  const [loading, setLoading] = useState(false), [message, setMessage] = useState('Choose a service and location to begin.')
  const [stats, setStats] = useState({ discovered: 0, enriched: 0, crosschecked: 0 })
  const visible = useMemo(() => leads.filter(lead => !query || JSON.stringify(lead).toLowerCase().includes(query.toLowerCase())), [leads, query])

  const pull = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setMessage('Searching selected sources…')
    try {
      const response = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ industry, location, limit, minRating, minReviews, filing, hasPhone, hasWebsite, sources, deliver }) })
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Search failed')
      setLeads(data.leads || []); setStats({ discovered: data.discovered || 0, enriched: data.enriched || 0, crosschecked: data.crosschecked || 0 })
      const missing = [sources.google && !data.configured?.googlePlaces ? 'Google Places' : '', sources.sunbiz && !data.configured?.sunbiz ? 'Sunbiz feed' : ''].filter(Boolean)
      setMessage(`${data.leads.length} leads ready.${missing.length ? ` Configure ${missing.join(', ')} to activate those sources.` : ''}`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Search failed') } finally { setLoading(false) }
  }

  const exportCsv = () => { if (!leads.length) return setMessage('Pull leads before exporting.'); const fields: (keyof Lead)[] = ['name','source','industry','address','phone','email','website','mapsUrl','rating','reviewCount','filingType','linkedinUrl']; const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`; const csv = [fields.join(','), ...leads.map(lead => fields.map(field => quote(lead[field])).join(','))].join('\n'); const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); anchor.download = `swiftflow-leads-${new Date().toISOString().slice(0,10)}.csv`; anchor.click(); URL.revokeObjectURL(anchor.href) }
  const toggleSource = (key: keyof typeof sources) => setSources(value => ({ ...value, [key]: !value[key] }))

  return <main className="simple-shell">
    <header className="simple-header"><a className="simple-brand" href="#"><span><BoltIcon /></span>SwiftFlow</a><div className="keyless-badge"><CheckCircleIcon /> Public-data ready</div></header>
    <section className="simple-hero"><p>LOCAL LEAD DISCOVERY</p><h1>Find service businesses.<br /><span>Build your pipeline.</span></h1><div className="source-line"><GlobeAltIcon /> Sunbiz filings · Google Places</div></section>
    <section className="simple-workspace">
      <form className="simple-form" onSubmit={pull}>
        <div className="simple-form-head"><div><h2>New search</h2><p>Pick a niche, area, and sources.</p></div><span className="live-dot">Live</span></div>
        <label>Service category</label><div className="preset-grid">{presets.map(item => <button type="button" key={item} className={industry === item ? 'active' : ''} onClick={() => setIndustry(item)}>{item}</button>)}</div>
        <label>Custom category<input value={industry} onChange={event => setIndustry(event.target.value)} placeholder="e.g. pool cleaning" /></label>
        <label>Location<div className="input-icon"><MapPinIcon /><input value={location} onChange={event => setLocation(event.target.value)} placeholder="City, state or ZIP" /></div></label>
        <label>Sources</label><div className="source-toggles">{([['sunbiz','Sunbiz filings'],['google','Google cross-check']] as const).map(([key,label]) => <button type="button" key={key} className={sources[key] ? 'active' : ''} onClick={() => toggleSource(key)}><i />{label}</button>)}</div><p className="filter-note">Google enriches up to 10 Sunbiz matches per search to control API usage.</p>
        <div className="filter-grid"><label>Minimum rating<select value={minRating} onChange={e => setMinRating(Number(e.target.value))}><option value="0">Any</option><option value="3">3.0+</option><option value="4">4.0+</option><option value="4.5">4.5+</option></select></label><label>Minimum reviews<select value={minReviews} onChange={e => setMinReviews(Number(e.target.value))}><option value="0">Any</option><option value="5">5+</option><option value="20">20+</option><option value="50">50+</option></select></label></div>
        <div className="filter-grid"><label>Sunbiz filing<select value={filing} onChange={e => setFiling(e.target.value)}><option value="all">New + renewal</option><option value="new">New only</option><option value="renewal">Renewals only</option></select></label><label>Maximum<select value={limit} onChange={e => setLimit(Number(e.target.value))}><option>10</option><option>25</option><option>50</option></select></label></div>
        <div className="check-row"><button type="button" className={hasPhone ? 'active' : ''} onClick={() => setHasPhone(v => !v)}>Has phone</button><button type="button" className={hasWebsite ? 'active' : ''} onClick={() => setHasWebsite(v => !v)}>Has website</button></div>
        <button type="button" className={`delivery-compact ${deliver ? 'on' : ''}`} onClick={() => setDeliver(v => !v)}><PaperAirplaneIcon /> Send results to SwiftFlow <i /></button>
        <button className="simple-primary" disabled={loading}>{loading ? <><ArrowPathIcon className="spin" /> Searching…</> : <><MagnifyingGlassIcon /> Find leads</>}</button><p className="simple-message">{message}</p>
      </form>
      <div className="simple-results">
        <div className="simple-results-head"><div><h2>Leads</h2><p>{stats.discovered.toLocaleString()} filings · {stats.crosschecked} Google matched · {stats.enriched} enriched</p></div><div className="simple-actions"><div className="simple-search"><MagnifyingGlassIcon /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter results" /></div><button onClick={exportCsv}><ArrowDownTrayIcon /> Export</button></div></div>
        {!visible.length ? <div className="simple-empty"><span><PlusIcon /></span><h3>Your local leads will appear here</h3><p>Try Landscaping in Orlando, FL to start.</p></div> : <div className="simple-list">{visible.map(lead => <article key={`${lead.source}-${lead.id}`} className="simple-lead"><div className="simple-logo">{lead.name.slice(0,2).toUpperCase()}</div><div className="simple-company"><a href={lead.website || lead.mapsUrl || '#'} target="_blank" rel="noreferrer">{lead.name}</a><p>{lead.address || lead.domain || lead.filingType || 'Public business record'} · {lead.source}</p><small>{lead.description || lead.industry || 'Business details available from source.'}</small></div><div className="simple-contact"><span>{lead.rating ? <><StarIcon /> {lead.rating} ({lead.reviewCount || 0})</> : lead.industry || lead.filingType || 'Unclassified'}</span><a href={lead.phone ? `tel:${lead.phone}` : undefined}>{lead.phone || 'No public phone'}</a><small>{lead.email || ''}</small></div><div className={`simple-status ${lead.status}`}>{lead.source}</div></article>)}</div>}
      </div>
    </section><footer className="simple-footer">Use public business data responsibly and follow source terms and applicable outreach laws.</footer>
  </main>
}
