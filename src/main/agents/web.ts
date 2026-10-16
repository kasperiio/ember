// Internet research helpers for local models: search (DuckDuckGo HTML) and page reading.
// Only the search terms leave the PC; they are scrubbed of paths, URLs, emails and keys first.

export function scrubQuery(q: string): string {
  return q
    .replace(/[A-Za-z]:\\[^\s"']+/g, '') // windows paths
    .replace(/\/(?:[\w.-]+\/)+[\w.-]*/g, '') // unix paths
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
    .replace(/\b(?:sk|pk|ghp|gho|xox[bap]|AKIA|AIza)[A-Za-z0-9_-]{10,}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export async function webSearch(query: string, max = 6): Promise<SearchResult[]> {
  const q = scrubQuery(query)
  if (!q) return []
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ember/0.1', Accept: 'text/html' }
  })
  const html = await res.text()
  const out: SearchResult[] = []
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && out.length < max) {
    let url = m[1]
    const uddg = /uddg=([^&]+)/.exec(url)
    if (uddg) url = decodeURIComponent(uddg[1])
    out.push({ title: strip(m[2]), url, snippet: strip(m[3]) })
  }
  return out
}

function strip(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Fetch a URL and return readable text (HTML stripped). PDFs and YouTube are summarised to what is available. */
export async function fetchUrlText(url: string, maxChars = 30000): Promise<string> {
  const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/.exec(url)
  if (yt) {
    const t = await youtubeTranscript(yt[1]).catch(() => null)
    if (t) return t.slice(0, maxChars)
  }
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ember/0.1' }, redirect: 'follow' })
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('pdf') || url.toLowerCase().endsWith('.pdf')) {
    const buf = Buffer.from(await res.arrayBuffer())
    return pdfText(buf).slice(0, maxChars)
  }
  const html = await res.text()
  if (!ct.includes('html')) return html.slice(0, maxChars)
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<(br|p|div|li|h\d|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return strip(body).replace(/\n\s*\n/g, '\n').slice(0, maxChars)
}

/** Very small PDF text extractor: pulls text operators from uncompressed streams and inflates FlateDecode streams. */
function pdfText(buf: Buffer): string {
  const zlib = require('zlib') as typeof import('zlib')
  const parts: string[] = []
  const str = buf.toString('latin1')
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  let m: RegExpExecArray | null
  while ((m = re.exec(str))) {
    let data = Buffer.from(m[1], 'latin1')
    try {
      data = zlib.inflateSync(data)
    } catch {
      // not compressed
    }
    const s = data.toString('latin1')
    const tj = /\[(.*?)\]\s*TJ|\((.*?)\)\s*Tj/g
    let t: RegExpExecArray | null
    while ((t = tj.exec(s))) {
      if (t[2] != null) parts.push(t[2])
      else parts.push(t[1].replace(/\(([^)]*)\)[^(]*/g, '$1'))
    }
    parts.push('\n')
  }
  return parts.join('').replace(/\\\(/g, '(').replace(/\\\)/g, ')')
}

async function youtubeTranscript(id: string): Promise<string | null> {
  const page = await (await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text()
  const m = /"captionTracks":(\[.*?\])/.exec(page)
  if (!m) return null
  const tracks = JSON.parse(m[1]) as { baseUrl: string; languageCode: string }[]
  const track = tracks.find((t) => t.languageCode.startsWith('en')) ?? tracks[0]
  if (!track) return null
  const xml = await (await fetch(track.baseUrl)).text()
  return strip(xml.replace(/<text[^>]*>/g, ' ').replace(/<\/text>/g, ''))
}
