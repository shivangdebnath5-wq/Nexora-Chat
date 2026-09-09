// Nexora Pinterest backend
// ---------------------------------------------------------------------------
// This is the ONLY place Pinterest credentials (client secret, access/refresh
// tokens) ever exist. The frontend (index.html / script.js) never talks to
// Pinterest directly — it only calls GET /api/pinterest/preview on this
// server, which fetches the public pin/board page and reads its Open Graph
// tags (see the big comment above fetchPinterestPreview for why — short
// version: Pinterest's v5 API can't look up arbitrary public pins). No
// secret or token value is ever sent to the browser in any response.
//
// Setup:
//   1. npm install
//   2. Fill in .env (ALLOWED_ORIGIN is all /api/pinterest/preview needs).
//   3. node server.js — previews work immediately, no OAuth required.
//
//   PINTEREST_CLIENT_ID / PINTEREST_CLIENT_SECRET / PINTEREST_REDIRECT_URI /
//   PINTEREST_REFRESH_TOKEN are only needed if you want the dormant
//   /oauth/pinterest/* routes below for future *authenticated* features
//   (posting Pins, managing boards) — the preview endpoint doesn't use them.
//
// Data-retention note: Pinterest's developer guidelines prohibit storing
// data fetched through their API except for campaign analytics. Nothing
// here is written to disk or a database — the cache below is in-memory
// only, short-lived, and wiped on every restart.
// ---------------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const {
  PINTEREST_CLIENT_ID,
  PINTEREST_CLIENT_SECRET,
  PINTEREST_REDIRECT_URI,
  PINTEREST_REFRESH_TOKEN,
  ALLOWED_ORIGIN,
  PORT
} = process.env;

if (!PINTEREST_CLIENT_ID || !PINTEREST_CLIENT_SECRET) {
  console.warn('⚠️  PINTEREST_CLIENT_ID / PINTEREST_CLIENT_SECRET are not set in .env — only the dormant /oauth/pinterest/* routes are affected; GET /api/pinterest/preview does not need them.');
}

const app = express();

// Lock CORS down to your actual frontend origin(s). Never '*' here — this
// server holds a secret and (after setup) a live access token, so only your
// own deployed Nexora frontend should be allowed to call it.
const allowedOrigins = (ALLOWED_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  }
}));

// This endpoint is unauthenticated from the frontend's side — anyone who can
// load Nexora can trigger a preview fetch — so rate-limit it rather than let
// it become an open relay for Pinterest API calls on your credentials.
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 30 }));

// --- In-memory only, see data-retention note above -------------------------
let accessToken = null;
let accessTokenExpiresAt = 0;
const previewCache = new Map(); // url -> { data, expiresAt }
const PREVIEW_CACHE_TTL_MS = 5 * 60 * 1000;

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  if (!PINTEREST_REFRESH_TOKEN) {
    throw new Error('No PINTEREST_REFRESH_TOKEN in .env yet. Visit /oauth/pinterest/start once to get one.');
  }
  const basicAuth = Buffer.from(`${PINTEREST_CLIENT_ID}:${PINTEREST_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.pinterest.com/v5/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: PINTEREST_REFRESH_TOKEN })
  });
  if (!res.ok) {
    throw new Error(`Pinterest token refresh failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  accessToken = json.access_token;
  accessTokenExpiresAt = Date.now() + (json.expires_in - 60) * 1000; // refresh a minute early
  return accessToken;
}

// --- One-time OAuth setup ---------------------------------------------------
app.get('/oauth/pinterest/start', (req, res) => {
  if (!PINTEREST_CLIENT_ID || !PINTEREST_REDIRECT_URI) {
    return res.status(500).send('Set PINTEREST_CLIENT_ID and PINTEREST_REDIRECT_URI in .env first.');
  }
  const scope = 'boards:read,pins:read,user_accounts:read';
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = `https://www.pinterest.com/oauth/?client_id=${encodeURIComponent(PINTEREST_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(PINTEREST_REDIRECT_URI)}&response_type=code` +
    `&scope=${encodeURIComponent(scope)}&state=${state}`;
  res.redirect(authUrl);
});

app.get('/oauth/pinterest/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Pinterest denied authorization: ${error}`);
  if (!code) return res.status(400).send('Missing ?code from Pinterest.');
  try {
    const basicAuth = Buffer.from(`${PINTEREST_CLIENT_ID}:${PINTEREST_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch('https://api.pinterest.com/v5/oauth/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: PINTEREST_REDIRECT_URI })
    });
    const json = await tokenRes.json();
    if (!tokenRes.ok) return res.status(500).send(`Token exchange failed: ${JSON.stringify(json)}`);
    // Shown once, here, so you can copy it. Never logged, never written to
    // disk by this server — if you lose it, just redo this flow once.
    res.send(`
      <h2>Pinterest connected ✅</h2>
      <p>Copy this into your .env as <code>PINTEREST_REFRESH_TOKEN</code>, then restart the server:</p>
      <pre style="padding:12px;background:#eee;border-radius:8px;word-break:break-all;">${json.refresh_token}</pre>
      <p>You can close this tab after that.</p>
    `);
  } catch (err) {
    res.status(500).send('OAuth callback failed: ' + err.message);
  }
});

// --- URL classification ------------------------------------------------
function isPinterestUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  return /(^|\.)pinterest\.[a-z.]+$/i.test(u.hostname) || /(^|\.)pin\.it$/i.test(u.hostname);
}

// --- Open Graph fetch + parse -----------------------------------------
// IMPORTANT — why this doesn't call Pinterest's REST API for the preview:
// Pinterest's v5 `GET /v5/pins/{pin_id}` is documented as "Get a Pin owned
// by the operation user_account" — it only returns pins that belong to
// (or are shared with) whichever account issued the access token. It is
// NOT a general "look up any public pin by URL" endpoint, and Pinterest's
// own docs list the response for anyone else's pin as 403 "You are not
// permitted to access that resource." Since Nexora users share pins from
// all over Pinterest — not just from one connected account — every one of
// those lookups was failing by design, which is why every single preview
// showed "Couldn't load a Pinterest preview" regardless of OAuth/env setup.
//
// Fix: fetch the public pin/board page itself and read its Open Graph
// meta tags — the same technique Facebook/Slack/Discord/iMessage use to
// unfurl links generally, and Pinterest's own pin/board pages carry
// og:title/og:image/og:description for exactly this reason. This needs no
// Pinterest auth at all, so previews now work even before the one-time
// OAuth setup below (getAccessToken/oauth routes) has ever been completed.
// That OAuth scaffolding is left in place and untouched, in case you want
// authenticated write access (posting Pins, managing boards) later — it's
// just no longer on the path for read-only previews.
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeHtmlEntities(value) {
  return value
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function readMetaTag(html, property) {
  // Open Graph tags can appear with either attribute order.
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${property}["']`, 'i')
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match) return decodeHtmlEntities(match[1]);
  }
  return null;
}

// A single fetch handles pin.it short links, canonical pin links, and board
// links uniformly: `redirect: 'follow'` transparently follows pin.it's
// server-side redirect, and res.url / the response body are already the
// FINAL page's — no separate "resolve the short link" round trip needed.
// Bounded with its own timeout so a slow/hanging response from Pinterest
// can't sit open long enough for Render's own proxy to kill the connection
// first — that would show up to the browser as a bare network failure
// (net::ERR_FAILED / "Failed to fetch") instead of a clean JSON error.
async function fetchPinterestPage(pageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let res;
  try {
    res = await fetch(pageUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' }
    });
  } catch (err) {
    throw Object.assign(new Error(`Could not reach Pinterest: ${err.message}`), { status: 504 });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw Object.assign(new Error(`Pinterest page fetch error (${res.status})`), { status: res.status === 404 ? 404 : 502 });
  const html = await res.text();
  return { html, finalUrl: res.url || pageUrl };
}

function buildPreviewFromPage(html, finalUrl) {
  let path = '/';
  try { path = new URL(finalUrl).pathname; } catch { /* fall through with default */ }
  const isPin = /\/pin\/\d+/.test(path);

  const title = readMetaTag(html, 'og:title');
  const description = readMetaTag(html, 'og:description');
  const image = readMetaTag(html, 'og:image');
  const ogUrl = readMetaTag(html, 'og:url') || finalUrl;

  if (!title && !image) {
    // No usable Open Graph data at all — most likely a private/removed pin,
    // or Pinterest served something unexpected (e.g. a consent wall).
    throw Object.assign(new Error('No preview data available for this Pinterest link'), { status: 404 });
  }

  if (isPin) {
    return { ok: true, type: 'pin', url: ogUrl, title: title || 'Pinterest pin', description: description || '', image, creator: null };
  }
  // Board (or profile) pages don't expose a clean pin-count or per-pin
  // thumbnail grid via Open Graph alone, so those fields are omitted rather
  // than guessed — the frontend already renders the card correctly without
  // them (see pinterestCardHTML's `data.pinCount != null` / `pins ?` checks).
  return { ok: true, type: 'board', url: ogUrl, title: title || 'Pinterest board', pinCount: null, creator: null, previewPins: image ? [{ image, url: ogUrl }] : [] };
}

async function fetchPinterestPreview(rawUrl) {
  const { html, finalUrl } = await fetchPinterestPage(rawUrl);
  return buildPreviewFromPage(html, finalUrl);
}

// --- The one endpoint the frontend calls -----------------------------------
app.get('/api/pinterest/preview', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Missing url' });
  if (!isPinterestUrl(rawUrl)) return res.status(422).json({ ok: false, error: 'Not a recognized Pinterest URL' });

  const cached = previewCache.get(rawUrl);
  if (cached && Date.now() < cached.expiresAt) return res.json(cached.data);

  try {
    const data = await fetchPinterestPreview(rawUrl);
    previewCache.set(rawUrl, { data, expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS });
    res.json(data);
  } catch (err) {
    console.error('Pinterest preview error:', err.message);
    res.status(err.status || 500).json({ ok: false, error: 'Failed to load Pinterest preview' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/healthz', (req, res) => res.json({ ok: true }));

const port = PORT || 3001;
app.listen(port, '0.0.0.0', () => console.log(`Nexora Pinterest backend listening on :${port}`));