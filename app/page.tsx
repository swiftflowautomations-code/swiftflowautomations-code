'use client'

import { FormEvent, useMemo, useState } from 'react'
import { ArrowDownTrayIcon, ArrowPathIcon, BoltIcon, CheckCircleIcon, GlobeAltIcon, MagnifyingGlassIcon, PaperAirplaneIcon, PlusIcon } from '@heroicons/react/24/outline'

type Lead = { id: string; name: string; domain: string; website: string; description: string | null; industry: string | null; email: string | null; phone: string | null; linkedinUrl: string | null; source: string; status: 'enriched' | 'domain-only' }

export default function Home() {
  const [leads, setLeads] = useState<Lead[]>([])
  const [domains, setDomains] = useState('')
  const [query, setQuery] = useState('')
  const [industry, setIndustry] = useState('')
  const [limit, setLimit] = useState(10)
  const [deliver, setDeliver] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('Ready to search public sources.')
  const [stats, setStats] = useState({ discovered: 0, enriched: 0, sources: 0 })

  const visible = useMemo(() => leads.filter(lead => !query || JSON.stringify(lead).toLowerCase().includes(query.toLowerCase())), [leads, query])

  const pull = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setMessage('Searching feeds and researching websites…')
    try {
      const response = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domains, industry, limit, deliver }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Search failed')
      setLeads(data.leads || [])
      setStats({ discovered: data.discovered || 0, enriched: data.enriched || 0, sources: Object.values(data.sources || {}).filter(Number).length })
      setMessage(data.delivery?.delivered ? `${data.leads.length} leads sent to SwiftFlow.` : `${data.leads.length} leads ready.`)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Search failed') }
    finally { setLoading(false) }
  }

  const exportCsv = () => {
    if (!leads.length) return setMessage('Pull leads before exporting.')
    const fields: (keyof Lead)[] = ['name', 'domain', 'website', 'industry', 'email', 'phone', 'linkedinUrl', 'source']
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
    const csv = [fields.join(','), ...leads.map(lead => fields.map(field => quote(lead[field])).join(','))].join('\n')
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); anchor.download = `swiftflow-leads-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(anchor.href)
  }

  return <main className="simple-shell">
    <header className="simple-header">
      <a className="simple-brand" href="#"><span><BoltIcon /></span>SwiftFlow</a>
      <div className="keyless-badge"><CheckCircleIcon /> Keyless enrichment</div>
    </header>

    <section className="simple-hero">
      <p>PUBLIC LEAD DISCOVERY</p>
      <h1>Find companies.<br /><span>Build your pipeline.</span></h1>
      <div className="source-line"><GlobeAltIcon /> New domains · Public feeds · Your lists · Company websites</div>
    </section>

    <section className="simple-workspace">
      <form className="simple-form" onSubmit={pull}>
        <div className="simple-form-head"><div><h2>New search</h2><p>No enrichment API key required.</p></div><span className="live-dot">Live</span></div>
        <label>Industry or niche<input value={industry} onChange={event => setIndustry(event.target.value)} placeholder="e.g. automation, software, marketing" /></label>
        <label>Add your own domains <span>Optional</span><textarea value={domains} onChange={event => setDomains(event.target.value)} placeholder={'acme.com\nexample.org\nPaste as many as you like'} /></label>
        <div className="simple-row"><label>Maximum leads<select value={limit} onChange={event => setLimit(Number(event.target.value))}><option>5</option><option>10</option><option>25</option><option>50</option></select></label><button type="button" className={`simple-toggle ${deliver ? 'on' : ''}`} onClick={() => setDeliver(value => !value)}><span><PaperAirplaneIcon /> Send to flow</span><i /></button></div>
        <button className="simple-primary" disabled={loading}>{loading ? <><ArrowPathIcon className="spin" /> Researching…</> : <><MagnifyingGlassIcon /> Find leads</>}</button>
        <p className="simple-message">{message}</p>
      </form>

      <div className="simple-results">
        <div className="simple-results-head"><div><h2>Leads</h2><p>{stats.discovered.toLocaleString()} discovered · {stats.enriched} researched · {stats.sources} sources</p></div><div className="simple-actions"><div className="simple-search"><MagnifyingGlassIcon /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter" /></div><button onClick={exportCsv}><ArrowDownTrayIcon /> Export</button></div></div>
        {!visible.length ? <div className="simple-empty"><span><PlusIcon /></span><h3>Your leads will appear here</h3><p>Start a search or paste domains to research.</p></div> : <div className="simple-list">{visible.map(lead => <article key={lead.id} className="simple-lead">
          <div className="simple-logo">{lead.name.slice(0, 2).toUpperCase()}</div>
          <div className="simple-company"><a href={lead.website} target="_blank" rel="noreferrer">{lead.name}</a><p>{lead.domain} · {lead.source}</p><small>{lead.description || 'Public website details were unavailable.'}</small></div>
          <div className="simple-contact"><span>{lead.industry || 'Unclassified'}</span><a href={lead.email ? `mailto:${lead.email}` : undefined}>{lead.email || 'No public email'}</a><small>{lead.phone || ''}</small></div>
          <div className={`simple-status ${lead.status}`}>{lead.status === 'enriched' ? 'Researched' : 'Domain'}</div>
        </article>)}</div>}
      </div>
    </section>
    <footer className="simple-footer">Public company research only · Respect robots.txt, site terms, and applicable outreach laws.</footer>
  </main>
}
