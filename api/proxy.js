// Minimal serverless proxy so the static frontend can reach data sources that
// do not send CORS headers (Yahoo Finance, FRED) without a backend.
//
// Usage:  GET /api/proxy?url=<encoded absolute URL>
// Only hosts in ALLOWED_HOSTS are permitted, GET only, no redirects followed.

const ALLOWED_HOSTS = new Set([
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'economic-calendar.tradingview.com',
  'nfs.faireconomy.media',
  'fred.stlouisfed.org',
]);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const raw = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!raw) return res.status(400).json({ error: 'missing url parameter' });

  let target;
  try {
    target = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'invalid url' });
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return res.status(403).json({ error: 'host not allowed' });
  }

  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (target.hostname === 'economic-calendar.tradingview.com') {
    headers.Origin = 'https://www.tradingview.com';
    headers.Referer = 'https://www.tradingview.com/';
  }

  try {
    const upstream = await fetch(target.toString(), { headers, redirect: 'error' });
    const body = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', ct.includes('json') ? 'application/json' : ct);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.send(body);
  } catch (err) {
    return res.status(502).json({ error: 'upstream fetch failed', detail: String(err?.message || err) });
  }
}
