import { createHash, createHmac } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import SftpClient from 'ssh2-sftp-client'

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

const emptyLead = (name: string, source: string): Lead => ({
  id: createHash('sha256').update(`${source}:${name}`).digest('hex').slice(0, 24), name, domain: '', website: '',
  description: null, industry: null, email: null, phone: null, linkedinUrl: null, address: null, rating: null,
  reviewCount: null, mapsUrl: null, filingType: null, filingDate: null, source, status: 'domain-only',
})

function cleanDomain(value: string) { try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '') } catch { return '' } }

async function googlePlaceSearch(textQuery: string, limit: number): Promise<Lead[]> {
  const key = process.env.GOOGLE_PLACES_API_KEY
  if (!key || !textQuery) return []
  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', signal: AbortSignal.timeout(12000), headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.businessStatus,places.googleMapsUri,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.websiteUri,places.types' },
    body: JSON.stringify({ textQuery, pageSize: Math.min(limit, 20), includePureServiceAreaBusinesses: true }),
  })
  if (!response.ok) throw new Error(`Google Places returned ${response.status}`)
  const data = await response.json()
  return (data.places || []).map((place: any) => {
    const website = place.websiteUri || '', domain = cleanDomain(website), lead = emptyLead(place.displayName?.text || 'Local business', 'Google Places')
    return { ...lead, id: place.id || lead.id, domain, website, phone: place.nationalPhoneNumber || null, address: place.formattedAddress || null, rating: place.rating ?? null, reviewCount: place.userRatingCount ?? null, mapsUrl: place.googleMapsUri || null, description: place.businessStatus === 'OPERATIONAL' ? 'Operational business on Google Maps' : place.businessStatus || null, status: 'enriched' as const }
  })
}

async function googlePlaces(niche: string, location: string, limit: number) {
  return (await googlePlaceSearch(`${niche} in ${location || 'Florida'}`, limit)).map(lead => ({ ...lead, industry: niche }))
}

function normalizedName(value: string) { return value.toLowerCase().replace(/\b(llc|incorporated|inc|corp|corporation|company|co|ltd|pllc|lp)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim() }
function nameScore(left: string, right: string) { const a = new Set(normalizedName(left).split(' ').filter(Boolean)), b = new Set(normalizedName(right).split(' ').filter(Boolean)); if (!a.size || !b.size) return 0; return Array.from(a).filter(token => b.has(token)).length / Math.max(a.size, b.size) }

async function crosscheckSunbiz(leads: Lead[], location: string, maxLookups: number) {
  if (!process.env.GOOGLE_PLACES_API_KEY) return { leads, matched: 0 }
  const checked = leads.slice(0, Math.min(maxLookups, 10)), enriched: Lead[] = []
  for (let offset = 0; offset < checked.length; offset += 3) {
    const group = await Promise.all(checked.slice(offset, offset + 3).map(async filing => {
      const candidates = await googlePlaceSearch(`"${filing.name}" in ${location || 'Florida'}`, 3).catch(() => [])
      const match = candidates.map(candidate => ({ candidate, score: nameScore(filing.name, candidate.name) })).sort((a, b) => b.score - a.score)[0]
      if (!match || match.score < 0.5) return filing
      return { ...filing, ...match.candidate, id: filing.id, name: filing.name, industry: filing.industry, filingType: filing.filingType, filingDate: filing.filingDate, source: 'Sunbiz + Google', description: `Florida filing cross-checked against Google Places (${Math.round(match.score * 100)}% name match).`, status: 'enriched' as const }
    }))
    enriched.push(...group)
  }
  return { leads: [...enriched, ...leads.slice(checked.length)], matched: enriched.filter(lead => lead.source === 'Sunbiz + Google').length }
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
  const client = new SftpClient(), leads: Lead[] = []
  try {
    await client.connect({ host: process.env.SUNBIZ_SFTP_HOST || 'sftp.floridados.gov', port: 22, username: process.env.SUNBIZ_SFTP_USERNAME || 'Public', password: process.env.SUNBIZ_SFTP_PASSWORD || 'PubAccess1845!', readyTimeout: 15000 })
    const files = (await client.list('doc/cor')).filter(file => /^\d{8}c\.txt$/i.test(file.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 5)
    for (const file of files) {
      const contents = await client.get(`doc/cor/${file.name}`)
      leads.push(...parseSunbiz(Buffer.isBuffer(contents) ? contents.toString('utf8') : String(contents), niche).map(lead => ({ ...lead, filingDate: `${file.name.slice(0,4)}-${file.name.slice(4,6)}-${file.name.slice(6,8)}` })))
      if (leads.length >= 250) break
    }
  } finally { await client.end().catch(() => undefined) }
  return leads
}

async function deliver(leads: Lead[]) { const webhook = process.env.SWIFTFLOW_WEBHOOK_URL; if (!webhook) return { delivered: false, reason: 'Add SWIFTFLOW_WEBHOOK_URL to enable delivery.' }; const payload = JSON.stringify({ event: 'leads.created', leads }), headers: Record<string,string> = { 'Content-Type': 'application/json', 'Idempotency-Key': createHash('sha256').update(payload).digest('hex') }; if (process.env.SWIFTFLOW_WEBHOOK_SECRET) headers['X-SwiftFlow-Signature'] = `sha256=${createHmac('sha256', process.env.SWIFTFLOW_WEBHOOK_SECRET).update(payload).digest('hex')}`; const response = await fetch(webhook, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(`SwiftFlow returned ${response.status}`); return { delivered: true } }

export async function GET() { return NextResponse.json({ ok: true, connectors: { sunbiz: true, googlePlaces: Boolean(process.env.GOOGLE_PLACES_API_KEY) } }) }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})), limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50), niche = String(body.industry || '').toLowerCase().trim(), location = String(body.location || 'Florida').trim()
    const enabled = { sunbiz: body.sources?.sunbiz !== false, google: body.sources?.google !== false }
    const rawSunbiz = enabled.sunbiz ? await sunbizLeads(niche) : []
    const crosschecked = enabled.google && enabled.sunbiz ? await crosscheckSunbiz(rawSunbiz, location, limit) : { leads: rawSunbiz, matched: 0 }
    const google = enabled.google && !enabled.sunbiz ? await googlePlaces(niche, location, limit) : []
    const sunbiz = crosschecked.leads
    const minRating = Number(body.minRating) || 0, minReviews = Number(body.minReviews) || 0, filing = String(body.filing || 'all')
    const seen = new Set<string>(), leads = [...google, ...sunbiz].filter(lead => {
      if (filing === 'new' && lead.filingType && !lead.filingType.startsWith('New')) return false
      if (filing === 'renewal' && lead.filingType && !lead.filingType.startsWith('Renewal')) return false
      if (lead.rating !== null && lead.rating < minRating || lead.reviewCount !== null && lead.reviewCount < minReviews) return false
      if (body.hasPhone && !lead.phone || body.hasWebsite && !lead.website) return false
      const key = lead.domain || `${lead.name}:${lead.address || ''}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true
    }).slice(0, limit)
    const delivery = body.deliver ? await deliver(leads) : { delivered: false, reason: 'Delivery off' }
    return NextResponse.json({ leads, discovered: rawSunbiz.length + google.length, enriched: leads.filter(l => l.status === 'enriched').length, crosschecked: crosschecked.matched, sources: { sunbiz: rawSunbiz.length, googlePlaces: google.length + crosschecked.matched }, configured: { sunbiz: true, googlePlaces: Boolean(process.env.GOOGLE_PLACES_API_KEY) }, delivery })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Lead pull failed' }, { status: 500 }) }
}
