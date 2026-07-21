import { createHash, createHmac } from 'crypto'
import { promises as dns } from 'dns'
import { promises as fs } from 'fs'
import net from 'net'
import path from 'path'
import { gunzipSync } from 'zlib'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Lead = {
  id: string; name: string; domain: string; website: string; description: string | null
  industry: string | null; email: string | null; phone: string | null; linkedinUrl: string | null
  address: string | null; rating: number | null; reviewCount: number | null; mapsUrl: string | null
  filingType: string | null; filingDate: string | null; source: string; status: 'enriched' | 'domain-only' | 'filing'
}

const niches: Record<string, string[]> = {
  landscaping: ['landscaping', 'landscape contractor', 'lawn care', 'lawn service'],
  'beauty salon': ['beauty salon', 'hair salon', 'nail salon', 'beauty spa'],
  'pressure washing': ['pressure washing', 'power washing', 'exterior cleaning'],
  roofing: ['roofing contractor', 'roofer'],
  hvac: ['hvac contractor', 'air conditioning contractor'],
  cleaning: ['commercial cleaning', 'house cleaning service'],
}

const industryTerms: Record<string, string[]> = {
  Landscaping: niches.landscaping, Beauty: niches['beauty salon'], 'Pressure Washing': niches['pressure washing'],
  Roofing: niches.roofing, HVAC: niches.hvac, Cleaning: niches.cleaning,
  Software: ['software', 'saas', 'cloud platform'], Marketing: ['marketing', 'advertising', 'seo'],
  Construction: ['construction', 'contractor', 'building services'], Consulting: ['consulting', 'advisory'],
}

const emptyLead = (name: string, source: string): Lead => ({
  id: createHash('sha256').update(`${source}:${name}`).digest('hex').slice(0, 24), name, domain: '', website: '',
  description: null, industry: null, email: null, phone: null, linkedinUrl: null, address: null, rating: null,
  reviewCount: null, mapsUrl: null, filingType: null, filingDate: null, source, status: 'domain-only',
})

function cleanDomain(value: string) { try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') } catch { return '' } }
function displayName(domain: string) { return domain.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) }
function uniqueDomains(values: string[]) { return Array.from(new Set(values.map(cleanDomain).filter(domain => domain.includes('.')))) }
function isPrivateIp(ip: string) { return net.isIPv4(ip) ? /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) : ip === '::1' || /^(fc|fd|fe80:)/i.test(ip) }
async function publicHostname(hostname: string) { try { const records = await dns.lookup(hostname, { all: true }); return records.length > 0 && records.every(record => !isPrivateIp(record.address)) } catch { return false } }
function textContent(html: string) { return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim() }
function meta(html: string, key: string) { const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); for (const pattern of [new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'), new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`, 'i')]) { const match = html.match(pattern); if (match) return match[1].trim() } return null }

async function dailyDomains() { try { const directory = path.join(process.cwd(), 'data', 'daily'); const files = (await fs.readdir(directory)).filter(file => file.endsWith('.gz')).sort().reverse(); const values: string[] = []; for (const file of files) values.push(...gunzipSync(await fs.readFile(path.join(directory, file))).toString('utf8').split(/\r?\n/)); return uniqueDomains(values) } catch { return [] } }

async function enrichWebsite(domain: string, source: string): Promise<Lead> {
  const base = { ...emptyLead(displayName(domain), source), domain, website: `https://${domain}` }
  if (!(await publicHostname(domain))) return base
  for (const protocol of ['https', 'http']) try {
    const response = await fetch(`${protocol}://${domain}`, { redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'SwiftFlowLeadResearch/1.0' } })
    if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) continue
    const html = (await response.text()).slice(0, 750_000), text = textContent(html).slice(0, 30_000)
    const title = meta(html, 'og:title') || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim(), description = meta(html, 'description') || meta(html, 'og:description')
    const email = html.match(/mailto:([^?"'\s>]+)/i)?.[1] || text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null
    const phone = html.match(/tel:([^?"'\s>]+)/i)?.[1]?.replace(/%20/g, ' ') || null
    const linkedinUrl = html.match(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:company|in)\/[^"'\s<]+/i)?.[0] || null
    const haystack = ` ${title || ''} ${description || ''} ${text.slice(0, 5000)} `.toLowerCase()
    const industry = Object.entries(industryTerms).find(([, terms]) => terms.some(term => haystack.includes(term)))?.[0] || null
    return { ...base, name: title?.split(/[|–—-]/)[0].trim() || base.name, website: response.url, description: description?.slice(0, 280) || null, industry, email, phone, linkedinUrl, status: 'enriched' }
  } catch { /* fallback */ }
  return base
}

async function googlePlaces(niche: string, location: string, limit: number): Promise<Lead[]> {
  const key = process.env.GOOGLE_PLACES_API_KEY
  if (!key || !niche) return []
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', signal: AbortSignal.timeout(12000), headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.businessStatus,places.googleMapsUri,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.websiteUri,places.types' },
    body: JSON.stringify({ textQuery: `${niche} in ${location || 'Florida'}`, pageSize: Math.min(limit, 20), includePureServiceAreaBusinesses: true }),
  })
  if (!response.ok) throw new Error(`Google Places returned ${response.status}`)
  const data = await response.json()
  return (data.places || []).map((place: any) => {
    const website = place.websiteUri || '', domain = cleanDomain(website), lead = emptyLead(place.displayName?.text || 'Local business', 'Google Places')
    return { ...lead, id: place.id || lead.id, domain, website, industry: niche, phone: place.nationalPhoneNumber || null, address: place.formattedAddress || null, rating: place.rating ?? null, reviewCount: place.userRatingCount ?? null, mapsUrl: place.googleMapsUri || null, description: place.businessStatus === 'OPERATIONAL' ? 'Operational business on Google Maps' : place.businessStatus || null, status: 'enriched' as const }
  })
}

function parseSunbiz(text: string, niche: string): Lead[] {
  const lines = text.split(/\r?\n/).filter(Boolean), terms = niches[niche] || [niche]
  return lines.filter(line => !niche || terms.some(term => line.toLowerCase().includes(term))).slice(0, 250).map(line => {
    const document = line.slice(0, 12).trim(), name = line.slice(12, 204).trim() || line.slice(0, 120).trim()
    const lead = emptyLead(name, 'Sunbiz')
    return { ...lead, id: document || lead.id, description: `Florida public filing ${document}`.trim(), industry: niche || null, filingType: /ANNUAL|RENEW/i.test(line) ? 'Renewal / annual report' : 'New filing', filingDate: null, status: 'filing' as const }
  })
}

async function sunbizLeads(niche: string) {
  const urls = (process.env.SUNBIZ_DAILY_URLS || '').split(',').map(v => v.trim()).filter(Boolean).slice(0, 7), leads: Lead[] = []
  for (const value of urls) try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || !(await publicHostname(url.hostname))) continue; const headers: Record<string,string> = {}; if (process.env.SUNBIZ_BASIC_AUTH) headers.Authorization = `Basic ${Buffer.from(process.env.SUNBIZ_BASIC_AUTH).toString('base64')}`; const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); if (response.ok) leads.push(...parseSunbiz((await response.text()).slice(0, 15_000_000), niche)) } catch { /* optional source */ }
  return leads
}

async function kasprLeads(niche: string, location: string, limit: number) {
  if (!process.env.KASPR_API_KEY || !process.env.KASPR_API_URL) return [] as Lead[]
  const response = await fetch(process.env.KASPR_API_URL, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.KASPR_API_KEY}` }, body: JSON.stringify({ query: niche, location, limit }) })
  if (!response.ok) throw new Error(`Kaspr returned ${response.status}`)
  const data = await response.json(), records = Array.isArray(data) ? data : data.leads || data.results || []
  return records.slice(0, limit).map((item: any) => ({ ...emptyLead(item.companyName || item.name || 'Kaspr lead', 'Kaspr'), domain: cleanDomain(item.domain || item.website || ''), website: item.website || '', industry: item.industry || niche || null, email: item.email || null, phone: item.phone || item.phoneNumber || null, linkedinUrl: item.linkedinUrl || item.linkedin || null, address: item.address || null, status: 'enriched' as const }))
}

async function deliver(leads: Lead[]) { const webhook = process.env.SWIFTFLOW_WEBHOOK_URL; if (!webhook) return { delivered: false, reason: 'Add SWIFTFLOW_WEBHOOK_URL to enable delivery.' }; const payload = JSON.stringify({ event: 'leads.created', leads }), headers: Record<string,string> = { 'Content-Type': 'application/json', 'Idempotency-Key': createHash('sha256').update(payload).digest('hex') }; if (process.env.SWIFTFLOW_WEBHOOK_SECRET) headers['X-SwiftFlow-Signature'] = `sha256=${createHmac('sha256', process.env.SWIFTFLOW_WEBHOOK_SECRET).update(payload).digest('hex')}`; const response = await fetch(webhook, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(`SwiftFlow returned ${response.status}`); return { delivered: true } }

export async function GET() { return NextResponse.json({ ok: true, connectors: { sunbiz: Boolean(process.env.SUNBIZ_DAILY_URLS), googlePlaces: Boolean(process.env.GOOGLE_PLACES_API_KEY), kaspr: Boolean(process.env.KASPR_API_KEY && process.env.KASPR_API_URL), websites: true } }) }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})), limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50), niche = String(body.industry || '').toLowerCase().trim(), location = String(body.location || 'Florida').trim()
    const enabled = { websites: body.sources?.websites !== false, sunbiz: body.sources?.sunbiz !== false, google: body.sources?.google !== false, kaspr: Boolean(body.sources?.kaspr) }
    const pasted = uniqueDomains(String(body.domains || '').split(/[\s,;]+/)), daily = enabled.websites ? await dailyDomains() : []
    const webDomains = uniqueDomains([...pasted, ...daily]).slice(0, limit), webLeads: Lead[] = []
    for (let offset = 0; offset < webDomains.length; offset += 5) webLeads.push(...await Promise.all(webDomains.slice(offset, offset + 5).map(domain => enrichWebsite(domain, pasted.includes(domain) ? 'Imported' : 'New domain feed'))))
    const [sunbiz, google, kaspr] = await Promise.all([enabled.sunbiz ? sunbizLeads(niche) : [], enabled.google ? googlePlaces(niche, location, limit) : [], enabled.kaspr ? kasprLeads(niche, location, limit) : []])
    const minRating = Number(body.minRating) || 0, minReviews = Number(body.minReviews) || 0, filing = String(body.filing || 'all')
    const seen = new Set<string>(), leads = [...google, ...sunbiz, ...kaspr, ...webLeads].filter(lead => {
      if (filing === 'new' && lead.filingType && !lead.filingType.startsWith('New')) return false
      if (filing === 'renewal' && lead.filingType && !lead.filingType.startsWith('Renewal')) return false
      if (lead.rating !== null && lead.rating < minRating || lead.reviewCount !== null && lead.reviewCount < minReviews) return false
      if (body.hasPhone && !lead.phone || body.hasWebsite && !lead.website) return false
      const key = lead.domain || `${lead.name}:${lead.address || ''}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true
    }).slice(0, limit)
    const delivery = body.deliver ? await deliver(leads) : { delivered: false, reason: 'Delivery off' }
    return NextResponse.json({ leads, discovered: webDomains.length + sunbiz.length + google.length + kaspr.length, enriched: leads.filter(l => l.status === 'enriched').length, sources: { websites: webLeads.length, sunbiz: sunbiz.length, googlePlaces: google.length, kaspr: kaspr.length }, configured: { sunbiz: Boolean(process.env.SUNBIZ_DAILY_URLS), googlePlaces: Boolean(process.env.GOOGLE_PLACES_API_KEY), kaspr: Boolean(process.env.KASPR_API_KEY && process.env.KASPR_API_URL) }, delivery })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Lead pull failed' }, { status: 500 }) }
}
