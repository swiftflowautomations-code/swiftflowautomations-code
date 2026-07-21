import { createHash, createHmac } from 'crypto'
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
  for (const value of urls) try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol)) continue; const headers: Record<string,string> = {}; if (process.env.SUNBIZ_BASIC_AUTH) headers.Authorization = `Basic ${Buffer.from(process.env.SUNBIZ_BASIC_AUTH).toString('base64')}`; const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); if (response.ok) leads.push(...parseSunbiz((await response.text()).slice(0, 15_000_000), niche)) } catch { /* optional source */ }
  return leads
}

async function deliver(leads: Lead[]) { const webhook = process.env.SWIFTFLOW_WEBHOOK_URL; if (!webhook) return { delivered: false, reason: 'Add SWIFTFLOW_WEBHOOK_URL to enable delivery.' }; const payload = JSON.stringify({ event: 'leads.created', leads }), headers: Record<string,string> = { 'Content-Type': 'application/json', 'Idempotency-Key': createHash('sha256').update(payload).digest('hex') }; if (process.env.SWIFTFLOW_WEBHOOK_SECRET) headers['X-SwiftFlow-Signature'] = `sha256=${createHmac('sha256', process.env.SWIFTFLOW_WEBHOOK_SECRET).update(payload).digest('hex')}`; const response = await fetch(webhook, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(`SwiftFlow returned ${response.status}`); return { delivered: true } }

export async function GET() { return NextResponse.json({ ok: true, connectors: { sunbiz: Boolean(process.env.SUNBIZ_DAILY_URLS), googlePlaces: Boolean(process.env.GOOGLE_PLACES_API_KEY) } }) }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})), limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50), niche = String(body.industry || '').toLowerCase().trim(), location = String(body.location || 'Florida').trim()
    const enabled = { sunbiz: body.sources?.sunbiz !== false, google: body.sources?.google !== false }
    const [sunbiz, google] = await Promise.all([enabled.sunbiz ? sunbizLeads(niche) : [], enabled.google ? googlePlaces(niche, location, limit) : []])
    const minRating = Number(body.minRating) || 0, minReviews = Number(body.minReviews) || 0, filing = String(body.filing || 'all')
    const seen = new Set<string>(), leads = [...google, ...sunbiz].filter(lead => {
      if (filing === 'new' && lead.filingType && !lead.filingType.startsWith('New')) return false
      if (filing === 'renewal' && lead.filingType && !lead.filingType.startsWith('Renewal')) return false
      if (lead.rating !== null && lead.rating < minRating || lead.reviewCount !== null && lead.reviewCount < minReviews) return false
      if (body.hasPhone && !lead.phone || body.hasWebsite && !lead.website) return false
      const key = lead.domain || `${lead.name}:${lead.address || ''}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true
    }).slice(0, limit)
    const delivery = body.deliver ? await deliver(leads) : { delivered: false, reason: 'Delivery off' }
    return NextResponse.json({ leads, discovered: sunbiz.length + google.length, enriched: leads.filter(l => l.status === 'enriched').length, sources: { sunbiz: sunbiz.length, googlePlaces: google.length }, configured: { sunbiz: Boolean(process.env.SUNBIZ_DAILY_URLS), googlePlaces: Boolean(process.env.GOOGLE_PLACES_API_KEY) }, delivery })
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Lead pull failed' }, { status: 500 }) }
}
