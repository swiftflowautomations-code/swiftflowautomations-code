'use client'

import { FormEvent, useMemo, useState } from 'react'
import { ArrowDownTrayIcon, ArrowPathIcon, BoltIcon, BuildingOffice2Icon, CheckCircleIcon, ChevronDownIcon, ClockIcon, MagnifyingGlassIcon, MapPinIcon, PaperAirplaneIcon, PlusIcon, SignalIcon, SparklesIcon, UsersIcon } from '@heroicons/react/24/outline'

type Lead = { id: string; name: string; domain: string; website: string; industry: string | null; location: string | null; country: string | null; employees: number | null; enriched: boolean }
const industries = ['Automation', 'Marketing', 'Software', 'Design', 'Consulting', 'E-commerce']

export default function Home() {
  const [selectedIndustries, setSelectedIndustries] = useState<string[]>([])
  const [country, setCountry] = useState('Any country')
  const [minimum, setMinimum] = useState('')
  const [maximum, setMaximum] = useState('')
  const [limit, setLimit] = useState(50)
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState('Not run yet')
  const [query, setQuery] = useState('')
  const [leads, setLeads] = useState<Lead[]>([])
  const [totalDomains, setTotalDomains] = useState(0)
  const [message, setMessage] = useState('Pull leads to load the live domain feed.')
  const [error, setError] = useState('')
  const [deliverEnabled, setDeliverEnabled] = useState(false)
  const [delivered, setDelivered] = useState(0)

  const visibleLeads = useMemo(() => leads.filter(lead => !query || `${lead.name} ${lead.domain} ${lead.industry || ''}`.toLowerCase().includes(query.toLowerCase())), [leads, query])

  const runPull = async (event?: FormEvent) => {
    event?.preventDefault()
    setRunning(true); setError('')
    try {
      const response = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ industries: selectedIndustries, country, minimum, maximum, limit, deliver: deliverEnabled }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Lead pull failed')
      setLeads(data.leads || []); setTotalDomains(data.totalDomains || 0); setLastRun('Just now')
      setMessage(data.warning || data.delivery?.reason || 'Lead pull completed.')
      setDelivered(data.delivery?.delivered ? data.leads.length : 0)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Lead pull failed') }
    finally { setRunning(false) }
  }

  const toggleIndustry = (value: string) => setSelectedIndustries(current => current.includes(value) ? current.filter(item => item !== value) : [...current, value])
  const clearFilters = () => { setSelectedIndustries([]); setCountry('Any country'); setMinimum(''); setMaximum('') }
  const exportCsv = () => {
    if (!leads.length) { setError('Pull leads before exporting.'); return }
    const fields: (keyof Lead)[] = ['name', 'domain', 'website', 'industry', 'location', 'country', 'employees']
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const csv = [fields.join(','), ...leads.map(lead => fields.map(field => escape(lead[field])).join(','))].join('\n')
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href)
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#dashboard"><span className="brand-mark"><BoltIcon /></span><span>Swift<span>Flow</span></span></a>
      <nav className="nav-list" aria-label="Main navigation">
        <p>Workspace</p><a className="nav-item active" href="#dashboard"><SparklesIcon /> Lead puller</a><a className="nav-item" href="#leads"><UsersIcon /> All leads <span className="nav-count">{leads.length}</span></a><a className="nav-item" href="#activity"><SignalIcon /> Activity</a>
        <p>Manage</p><a className="nav-item" href="#filters"><PaperAirplaneIcon /> Connections</a><a className="nav-item" href="#filters"><BuildingOffice2Icon /> Workspace</a>
      </nav>
      <div className="sidebar-card"><div className="sidebar-card-icon"><SparklesIcon /></div><strong>Live lead sourcing</strong><p>Domains come directly from the repository&apos;s latest compressed feed.</p><a href="#filters">Review filters →</a></div>
      <button className="profile-button"><span className="avatar">IB</span><span><strong>Isaac Bell</strong><small>Admin workspace</small></span><ChevronDownIcon /></button>
    </aside>

    <main className="main-content" id="dashboard">
      <header className="topbar"><div><p className="eyebrow">LEAD GENERATION</p><h1>Lead puller</h1><p>Pull genuine new-domain leads and send them into your workflow.</p></div><div className="top-actions"><span className="connection-status"><i /> Live feed ready</span><button className="icon-button" aria-label="Refresh leads" onClick={() => runPull()} disabled={running}><ArrowPathIcon /></button></div></header>

      <section className="metrics-grid" aria-label="Lead metrics">
        <article className="metric-card"><span className="metric-icon purple"><UsersIcon /></span><div><small>Domains available</small><strong>{totalDomains || '—'}</strong><p>Live repository feed</p></div></article>
        <article className="metric-card"><span className="metric-icon green"><CheckCircleIcon /></span><div><small>Latest pull</small><strong>{leads.length || '—'}</strong><p><b>Real records</b> loaded</p></div></article>
        <article className="metric-card"><span className="metric-icon blue"><PaperAirplaneIcon /></span><div><small>Sent to flow</small><strong>{delivered || '—'}</strong><p>{deliverEnabled ? 'Delivery requested' : 'Delivery disabled'}</p></div></article>
        <article className="metric-card"><span className="metric-icon amber"><ClockIcon /></span><div><small>Last pull</small><strong className="time-value">{lastRun}</strong><p>Run on demand</p></div></article>
      </section>

      <div className="workspace-grid">
        <form className="filter-panel" id="filters" onSubmit={runPull}>
          <div className="panel-heading"><div><h2>Build your lead list</h2><p>Set the criteria for your next pull.</p></div><button type="button" className="text-button" onClick={clearFilters}>Clear all</button></div>
          <label className="field-label">Target industries <span>Requires enrichment key</span></label>
          <div className="chip-list">{industries.map(value => <button type="button" key={value} onClick={() => toggleIndustry(value)} className={`chip ${selectedIndustries.includes(value) ? 'selected' : ''}`}>{selectedIndustries.includes(value) && <CheckCircleIcon />}{value}</button>)}<button type="button" className="chip add" onClick={() => setMessage('Custom industries can be added after enrichment is configured.')}><PlusIcon /> Add industry</button></div>
          <div className="two-column-fields">
            <label><span className="field-label">Country</span><div className="select-wrap"><MapPinIcon /><select value={country} onChange={event => setCountry(event.target.value)}><option>Any country</option><option>United States</option><option>Canada</option><option>United Kingdom</option><option>Tunisia</option><option>Botswana</option></select><ChevronDownIcon /></div></label>
            <label><span className="field-label">Lead limit</span><div className="select-wrap"><UsersIcon /><select value={limit} onChange={event => setLimit(Number(event.target.value))}><option>25</option><option>50</option><option>100</option><option>250</option></select><ChevronDownIcon /></div></label>
          </div>
          <label className="field-label">Company size <span>Requires enrichment key</span></label>
          <div className="range-fields"><label><small>Minimum</small><input type="number" value={minimum} onChange={event => setMinimum(event.target.value)} placeholder="No minimum" /></label><span>—</span><label><small>Maximum</small><input type="number" value={maximum} onChange={event => setMaximum(event.target.value)} placeholder="No maximum" /></label></div>
          <button type="button" className="delivery-box" onClick={() => setDeliverEnabled(value => !value)}><span><PaperAirplaneIcon /></span><div><strong>Deliver to SwiftFlow</strong><p>Requires SWIFTFLOW_WEBHOOK_URL.</p></div><span className={`toggle ${deliverEnabled ? '' : 'off'}`}><i /></span></button>
          <div className="estimate"><span><SparklesIcon /></span><p><strong>Up to {limit} real leads</strong> will be pulled from the latest feed.</p></div>
          {(message || error) && <div className={`status-message ${error ? 'error' : ''}`}>{error || message}</div>}
          <button className="primary-button" disabled={running}>{running ? <><ArrowPathIcon className="spin" /> Pulling leads…</> : <><BoltIcon /> Pull leads now</>}</button>
        </form>

        <section className="results-panel" id="leads">
          <div className="panel-heading results-heading"><div><h2>Latest matches</h2><p>Real records from the repository domain feed.</p></div><button type="button" className="secondary-button" onClick={exportCsv}><ArrowDownTrayIcon /> Export</button></div>
          <div className="search-box"><MagnifyingGlassIcon /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search leads…" /><button type="button">All leads <ChevronDownIcon /></button></div>
          <div className="lead-list">{visibleLeads.map(lead => <article className="lead-row" key={lead.id}>
            <span className="company-logo violet">{lead.name.slice(0, 2).toUpperCase()}</span>
            <div className="lead-company"><strong>{lead.name}</strong><a href={lead.website} target="_blank" rel="noreferrer">{lead.domain}</a></div>
            <div className="lead-detail"><small>INDUSTRY</small><span>{lead.industry || 'Needs enrichment'}</span></div>
            <div className="lead-detail location"><small>LOCATION</small><span>{lead.location || lead.country || 'Unknown'}</span></div>
            <div className="lead-detail employees"><small>SIZE</small><span>{lead.employees ? `${lead.employees} people` : 'Unknown'}</span></div>
            <span className="score"><i style={{ width: '100%' }} />REAL</span>
          </article>)}</div>
          {!visibleLeads.length && <div className="empty-state"><MagnifyingGlassIcon /><strong>No leads loaded</strong><p>Click “Pull leads now” to query the live feed.</p></div>}
          <div className="results-footer"><p>Showing {visibleLeads.length} of {leads.length} pulled leads</p><button type="button" onClick={() => setQuery('')}>Clear search <span>→</span></button></div>
        </section>
      </div>
    </main>
  </div>
}
