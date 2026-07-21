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
  id: string
  name: string
  domain: string
  website: string
  description: string | null
  industry: string | null
  email: string | null
  phone: string | null
  linkedinUrl: string | null
  source: string
  status: 'enriched' | 'domain-only'
}

const industryTerms: Record<string, string[]> = {
  'AI & Automation': ['artificial intelligence', 'automation', 'machine learning', ' ai '],
  Software: ['software', 'saas', 'cloud platform', 'developer'],
  Marketing: ['marketing', 'advertising', 'seo', 'branding'],
  'E-commerce': ['ecommerce', 'e-commerce', 'online store', 'shop online'],
  Finance: ['finance', 'financial', 'fintech', 'accounting'],
  Healthcare: ['healthcare', 'health care', 'medical', 'clinic'],
  Construction: ['construction', 'contractor', 'building services'],
  Consulting: ['consulting', 'consultancy', 'advisory'],
}

function cleanDomain(value: string) {
  try {
    const input = /^https?:\/\//i.test(value) ? value : `https://${value}`
    return new URL(input).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  } catch { return '' }
}

function displayName(domain: string) {
  return domain.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

function uniqueDomains(values: string[]) {
  return Array.from(new Set(values.map(cleanDomain).filter(domain => domain.includes('.'))))
}

async function dailyDomains() {
  const directory = path.join(process.cwd(), 'data', 'daily')
  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.gz')).sort().reverse()
  const values: string[] = []
  for (const file of files) {
    values.push(...gunzipSync(await fs.readFile(path.join(directory, file))).toString('utf8').split(/\r?\n/))
  }
  return uniqueDomains(values)
}

function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
  return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')
}

async function publicHostname(hostname: string) {
  try {
    const records = await dns.lookup(hostname, { all: true })
    return records.length > 0 && records.every(record => !isPrivateIp(record.address))
  } catch { return false }
}

function textContent(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
}

function meta(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escaped}["']`, 'i'),
  ]
  for (const pattern of patterns) { const match = html.match(pattern); if (match) return match[1].trim() }
  return null
}

async function enrichWebsite(domain: string, source: string): Promise<Lead> {
  const base: Lead = { id: createHash('sha256').update(domain).digest('hex').slice(0, 24), name: displayName(domain), domain, website: `https://${domain}`, description: null, industry: null, email: null, phone: null, linkedinUrl: null, source, status: 'domain-only' }
  if (!(await publicHostname(domain))) return base
  for (const protocol of ['https', 'http']) {
    try {
      const response = await fetch(`${protocol}://${domain}`, { redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'SwiftFlowLeadResearch/1.0 (+public-company-research)' } })
      if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) continue
      const html = (await response.text()).slice(0, 750_000)
      const text = textContent(html).slice(0, 30_000)
      const title = meta(html, 'og:title') || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()
      const description = meta(html, 'description') || meta(html, 'og:description')
      const email = html.match(/mailto:([^?"'\s>]+)/i)?.[1] || text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || null
      const phone = html.match(/tel:([^?"'\s>]+)/i)?.[1]?.replace(/%20/g, ' ') || null
      const linkedinUrl = html.match(/https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:company|in)\/[^"'\s<]+/i)?.[0] || null
      const haystack = ` ${title || ''} ${description || ''} ${text.slice(0, 5000)} `.toLowerCase()
      const industry = Object.entries(industryTerms).find(([, terms]) => terms.some(term => haystack.includes(term)))?.[0] || null
      return { ...base, name: title?.split(/[|–—-]/)[0].trim() || base.name, website: response.url, description: description?.slice(0, 280) || null, industry, email, phone, linkedinUrl, status: 'enriched' }
    } catch { /* try HTTP fallback */ }
  }
  return base
}

async function externalFeedDomains() {
  const urls = (process.env.LEAD_SOURCE_URLS || '').split(',').map(value => value.trim()).filter(Boolean).slice(0, 5)
  const results: string[] = []
  for (const value of urls) {
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || !(await publicHostname(url.hostname))) continue
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
      const body = (await response.text()).slice(0, 2_000_000)
      results.push(...body.match(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}/gi) || [])
    } catch { /* ignore unavailable optional feeds */ }
  }
  return uniqueDomains(results)
}

async function deliver(leads: Lead[]) {
  const webhook = process.env.SWIFTFLOW_WEBHOOK_URL
  if (!webhook) return { delivered: false, reason: 'Add SWIFTFLOW_WEBHOOK_URL to enable delivery.' }
  const payload = JSON.stringify({ event: 'leads.created', leads })
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': createHash('sha256').update(payload).digest('hex') }
  if (process.env.SWIFTFLOW_WEBHOOK_SECRET) headers['X-SwiftFlow-Signature'] = `sha256=${createHmac('sha256', process.env.SWIFTFLOW_WEBHOOK_SECRET).update(payload).digest('hex')}`
  const response = await fetch(webhook, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`SwiftFlow returned ${response.status}`)
  return { delivered: true }
}

export async function GET() {
  const domains = await dailyDomains()
  return NextResponse.json({ ok: true, domains: domains.length, keylessEnrichment: true, webhookConfigured: Boolean(process.env.SWIFTFLOW_WEBHOOK_URL) })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50)
    const pasted = uniqueDomains(String(body.domains || '').split(/[\s,;]+/))
    const [daily, external] = await Promise.all([dailyDomains(), externalFeedDomains()])
    const domains = uniqueDomains([...pasted, ...external, ...daily]).slice(0, limit)
    const leads: Lead[] = []
    for (let offset = 0; offset < domains.length; offset += 5) leads.push(...await Promise.all(domains.slice(offset, offset + 5).map(domain => enrichWebsite(domain, pasted.includes(domain) ? 'Imported' : external.includes(domain) ? 'Public feed' : 'New domain feed'))))
    const query = String(body.query || '').toLowerCase().trim()
    const industry = String(body.industry || '').toLowerCase().trim()
    const filtered = leads
      .filter(lead => !query || JSON.stringify(lead).toLowerCase().includes(query))
      .sort((a, b) => Number(JSON.stringify(b).toLowerCase().includes(industry)) - Number(JSON.stringify(a).toLowerCase().includes(industry)))
    const delivery = body.deliver ? await deliver(filtered) : { delivered: false, reason: 'Delivery off' }
    return NextResponse.json({ leads: filtered, discovered: daily.length + external.length + pasted.length, enriched: filtered.filter(lead => lead.status === 'enriched').length, sources: { daily: daily.length, publicFeeds: external.length, imported: pasted.length }, delivery })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Lead pull failed' }, { status: 500 })
  }
}
