import { createHash, createHmac } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { gunzipSync } from 'zlib'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type CompanyData = Record<string, any>

const countryByTld: Record<string, string> = {
  us: 'United States', ca: 'Canada', uk: 'United Kingdom', tn: 'Tunisia',
  bw: 'Botswana', au: 'Australia', de: 'Germany', fr: 'France', io: 'Global',
}

function companyName(domain: string) {
  return domain.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

function normalize(domain: string, company?: CompanyData) {
  const tld = domain.split('.').pop() || ''
  const employeeCount = company?.employees_count ?? company?.employee_count ?? null
  return {
    id: createHash('sha256').update(domain).digest('hex').slice(0, 24),
    name: company?.name || companyName(domain),
    domain: company?.domain || domain,
    website: company?.website || `https://${domain}`,
    industry: company?.industry || null,
    location: company?.locality || company?.city || null,
    country: company?.country || company?.country_code || countryByTld[tld] || null,
    employees: employeeCount ? Number(employeeCount) : null,
    linkedinUrl: company?.linkedin_url || null,
    enriched: Boolean(company?.name),
    source: 'LeadsDB daily domain feed',
  }
}

async function domainsFromFeed() {
  const directory = path.join(process.cwd(), 'data', 'daily')
  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.gz')).sort().reverse()
  const domains = new Set<string>()
  for (const file of files) {
    const lines = gunzipSync(await fs.readFile(path.join(directory, file))).toString('utf8').split(/\r?\n/)
    for (const value of lines) {
      const domain = value.trim().toLowerCase().replace(/\.$/, '')
      if (domain.includes('.') && !domain.includes(' ')) domains.add(domain)
    }
  }
  return Array.from(domains)
}

async function enrich(domain: string) {
  const key = process.env.ABSTRACT_API_COMPANY_ENRICHMENT_API_KEY
  if (!key) return undefined
  const base = process.env.ABSTRACT_API_COMPANY_ENRICHMENT_API_URL || 'https://companyenrichment.abstractapi.com/v1/'
  const response = await fetch(`${base}?${new URLSearchParams({ api_key: key, domain })}`, { cache: 'no-store' })
  if (!response.ok) return undefined
  return response.json() as Promise<CompanyData>
}

async function deliver(leads: ReturnType<typeof normalize>[]) {
  const webhook = process.env.SWIFTFLOW_WEBHOOK_URL
  if (!webhook) return { delivered: false, reason: 'SWIFTFLOW_WEBHOOK_URL is not configured' }
  const payload = JSON.stringify({ event: 'leads.created', leads })
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': createHash('sha256').update(payload).digest('hex'),
  }
  if (process.env.SWIFTFLOW_WEBHOOK_SECRET) {
    headers['X-SwiftFlow-Signature'] = `sha256=${createHmac('sha256', process.env.SWIFTFLOW_WEBHOOK_SECRET).update(payload).digest('hex')}`
  }
  const response = await fetch(webhook, { method: 'POST', headers, body: payload })
  if (!response.ok) throw new Error(`SwiftFlow webhook returned ${response.status}`)
  return { delivered: true }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 250)
    const country = String(body.country || '')
    const industries = Array.isArray(body.industries) ? body.industries.map((item: string) => item.toLowerCase()) : []
    const minimum = body.minimum === '' ? null : Number(body.minimum)
    const maximum = body.maximum === '' ? null : Number(body.maximum)
    const hasEnrichment = Boolean(process.env.ABSTRACT_API_COMPANY_ENRICHMENT_API_KEY)
    const allDomains = await domainsFromFeed()
    const leads: ReturnType<typeof normalize>[] = []

    for (let offset = 0; offset < allDomains.length && leads.length < limit; offset += 5) {
      const batch = allDomains.slice(offset, offset + 5)
      const enriched = await Promise.all(batch.map(domain => enrich(domain).catch(() => undefined)))
      batch.forEach((domain, index) => {
        const lead = normalize(domain, enriched[index])
        const matchesCountry = !country || country === 'Any country' || lead.country === country
        const matchesIndustry = !industries.length || !hasEnrichment || industries.some((item: string) => String(lead.industry || '').toLowerCase().includes(item))
        const matchesMinimum = minimum === null || !hasEnrichment || (lead.employees !== null && lead.employees >= minimum)
        const matchesMaximum = maximum === null || !hasEnrichment || (lead.employees !== null && lead.employees <= maximum)
        if (matchesCountry && matchesIndustry && matchesMinimum && matchesMaximum && leads.length < limit) leads.push(lead)
      })
    }

    const delivery = body.deliver ? await deliver(leads) : { delivered: false, reason: 'Delivery disabled' }
    return NextResponse.json({
      leads,
      totalDomains: allDomains.length,
      enriched: hasEnrichment,
      delivery,
      warning: !hasEnrichment ? 'Showing real domain leads. Add ABSTRACT_API_COMPANY_ENRICHMENT_API_KEY for industry, size, and company details.' : null,
    })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to pull leads' }, { status: 500 })
  }
}
