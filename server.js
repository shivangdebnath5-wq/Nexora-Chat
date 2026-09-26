// Nexora Pinterest backend
// ---------------------------------------------------------------------------
// This is the ONLY place Pinterest credentials (client secret, access/refresh
// tokens) ever exist. The frontend (index.html / script.js) never talks to
// Pinterest directly — it only calls GET /api/pinterest/preview on this
// server, which does the Pinterest API call itself and hands back a small,
// pre-shaped JSON object. No secret or token value is ever sent to the
// browser in any response from this server.
//
// Setup (see README notes in the chat reply for the full walkthrough):
//   1. npm install
//   2. Fill in .env (PINTEREST_CLIENT_ID, PINTEREST_CLIENT_SECRET,
//      PINTEREST_REDIRECT_URI, ALLOWED_ORIGIN).
//   3. node server.js, then visit /oauth/pinterest/start ONCE in a browser
//      to authorize and get a refresh token — paste it into .env as
//      PINTEREST_REFRESH_TOKEN, restart. After that this route is never
//      needed again; getAccessToken() below refreshes silently forever.
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
  PINTEREST_CLIENT_ID: RAW_PINTEREST_CLIENT_ID,
  PINTEREST_CLIENT_SECRET: RAW_PINTEREST_CLIENT_SECRET,
  PINTEREST_REDIRECT_URI,
  PINTEREST_REFRESH_TOKEN: RAW_PINTEREST_REFRESH_TOKEN,
  ALLOWED_ORIGIN,
  PORT
} = process.env;

// Defensive .trim(): a trailing newline or space on a credential pasted into
// Render's env var UI is invisible in the dashboard but corrupts the Basic
// auth header / refresh_token body param below byte-for-byte, and Pinterest
// reports that as a generic 401 "code 2: Authentication failed" — the exact
// symptom reported. Scoped to only the 3 values that feed the refresh call.
const PINTEREST_CLIENT_ID = RAW_PINTEREST_CLIENT_ID?.trim();
const PINTEREST_CLIENT_SECRET = RAW_PINTEREST_CLIENT_SECRET?.trim();
const PINTEREST_REFRESH_TOKEN = RAW_PINTEREST_REFRESH_TOKEN?.trim();

if (!PINTEREST_CLIENT_ID || !PINTEREST_CLIENT_SECRET) {
  console.warn('⚠️  PINTEREST_CLIENT_ID / PINTEREST_CLIENT_SECRET are not set in .env — Pinterest endpoints will fail until they are.');
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
  if (!PINTEREST_CLIENT_ID || !PINTEREST_CLIENT_SECRET) {
    // Fail fast with a clear reason rather than sending a Basic-auth header
    // built from `undefined` (which Pinterest would also reject as 401, but
    // with a far more confusing trail to follow in the logs).
    throw new Error('PINTEREST_CLIENT_ID and/or PINTEREST_CLIENT_SECRET are not set in the environment.');
  }
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
    // Surface Pinterest's own { code, message } instead of just the raw
    // response text, so the real reason (e.g. "code 2: Authentication
    // failed") is immediately visible in Render's logs, not just an HTTP
    // status. Falls back to the raw text if Pinterest didn't return JSON.
    const rawBody = await res.text();
    let detail = rawBody;
    try {
      const parsed = JSON.parse(rawBody);
      detail = `Pinterest code ${parsed.code ?? '?'}: ${parsed.message || parsed.error_description || rawBody}`;
    } catch { /* not JSON — rawBody stands as-is */ }
    throw new Error(`Pinterest token refresh failed (HTTP ${res.status}) — ${detail}`);
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
function classifyPinterestUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (!/(^|\.)pinterest\.[a-z.]+$/i.test(u.hostname) && !/(^|\.)pin\.it$/i.test(u.hostname)) return null;

  if (/(^|\.)pin\.it$/i.test(u.hostname)) return { type: 'short', url: rawUrl };

  const pinMatch = u.pathname.match(/\/pin\/(\d+)/);
  if (pinMatch) return { type: 'pin', id: pinMatch[1] };

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && !['pin', 'search', 'today', 'ideas', 'topics'].includes(parts[0])) {
    return { type: 'board', username: parts[0], slug: parts[1] };
  }
  return null;
}

async function fetchPinPreview(pinId, headers) {
  const res = await fetch(`https://api.pinterest.com/v5/pins/${pinId}`, { headers });
  if (!res.ok) throw Object.assign(new Error('Pinterest API error'), { status: res.status });
  const pin = await res.json();
  return {
    ok: true,
    type: 'pin',
    url: pin.link || `https://www.pinterest.com/pin/${pinId}/`,
    title: pin.title || pin.grid_title || 'Pinterest pin',
    description: pin.description || '',
    image: pin.media?.images?.['1200x']?.url || pin.media?.images?.orig?.url || null,
    creator: pin.pinner ? {
      name: `${pin.pinner.first_name || ''} ${pin.pinner.last_name || ''}`.trim() || pin.pinner.username,
      username: pin.pinner.username,
      profileUrl: pin.pinner.username ? `https://www.pinterest.com/${pin.pinner.username}/` : null,
      avatar: pin.pinner.image_medium_url || null
    } : null
  };
}

// NOTE ON BOARDS (fixed): Pinterest's v5 API only exposes
// GET /v5/boards/{board_id}, keyed by numeric board_id — there is no v5
// endpoint that resolves a third party's vanity "/username/board-slug/"
// path to that id, and GET /v5/boards itself only lists the boards owned
// by whichever account this app's OAuth token belongs to, not arbitrary
// other users' boards. The previous implementation called
// `/v5/boards/${username}%2F${slug}`, treating the vanity path as if it
// were a board_id — Pinterest's API doesn't support that shape and always
// rejected it, which is why board links never loaded.
//
// Fix: board previews now resolve through Pinterest's public oEmbed
// endpoint (https://www.pinterest.com/oembed.json?url=...), which Pinterest
// documents as covering pin, board, and profile URLs and which needs no
// OAuth token — it works for any public board, not just ones this app's
// connected account owns. It returns real title/author/thumbnail data, so
// board links now load with genuine Pinterest data instead of a guaranteed
// 404. (Pins are untouched above — v5's pin endpoint is well-documented and
// already worked correctly.)
async function fetchBoardPreview(classified) {
  const boardUrl = `https://www.pinterest.com/${classified.username}/${classified.slug}/`;
  const oembedRes = await fetch(`https://www.pinterest.com/oembed.json?url=${encodeURIComponent(boardUrl)}`);
  if (!oembedRes.ok) throw Object.assign(new Error('Pinterest oEmbed error'), { status: oembedRes.status });
  const oembed = await oembedRes.json();

  // oEmbed gives one representative thumbnail per board (not a documented
  // multi-image field), so the collage renders with the real image(s) this
  // public endpoint actually returns — same previewPins shape as before,
  // just populated with genuine data instead of failing outright.
  const previewPins = oembed.thumbnail_url ? [{ image: oembed.thumbnail_url, url: boardUrl }] : [];

  return {
    ok: true,
    type: 'board',
    url: boardUrl,
    title: oembed.title || 'Pinterest board',
    pinCount: null,
    creator: oembed.author_name ? {
      name: oembed.author_name,
      username: classified.username,
      profileUrl: oembed.author_url || `https://www.pinterest.com/${classified.username}/`,
      avatar: null
    } : { name: classified.username, username: classified.username, profileUrl: `https://www.pinterest.com/${classified.username}/`, avatar: null },
    previewPins
  };
}

// --- The one endpoint the frontend calls -----------------------------------
app.get('/api/pinterest/preview', async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).json({ ok: false, error: 'Missing url' });

  const cached = previewCache.get(rawUrl);
  if (cached && Date.now() < cached.expiresAt) return res.json(cached.data);

  try {
    let classified = classifyPinterestUrl(rawUrl);
    if (!classified) return res.status(422).json({ ok: false, error: 'Not a recognized Pinterest URL' });

    if (classified.type === 'short') {
      const resolved = await fetch(rawUrl, { redirect: 'follow' });
      classified = classifyPinterestUrl(resolved.url);
      if (!classified) return res.status(422).json({ ok: false, error: 'Could not resolve short link' });
    }

    const token = await getAccessToken();
    const headers = { Authorization: `Bearer ${token}` };

    const data = classified.type === 'pin'
      ? await fetchPinPreview(classified.id, headers)
      : await fetchBoardPreview(classified);

    previewCache.set(rawUrl, { data, expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS });
    res.json(data);
  } catch (err) {
    console.error('Pinterest preview error:', err.message);
    res.status(err.status || 500).json({ ok: false, error: 'Failed to load Pinterest preview' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// --- GIPHY integration ------------------------------------------------------
// Same reasoning as Pinterest above: the GIPHY API key lives only in this
// process's environment (already set on Render), never in the frontend.
// Reuses the /api/ rate limiter and CORS setup already configured above —
// nothing about those needed to change for this to be covered by them.
const { GIPHY_API_KEY } = process.env;
if (!GIPHY_API_KEY) {
  console.warn('⚠️  GIPHY_API_KEY is not set in the environment — GIPHY endpoints will fail until it is. (Expected env var name: GIPHY_API_KEY — rename in Render if you used a different one.)');
}

const giphyCache = new Map(); // cacheKey -> { data, expiresAt } — in-memory only, same data-retention posture as the Pinterest cache above.
const GIPHY_CACHE_TTL_MS = 5 * 60 * 1000;

function mapGiphyResults(json) {
  return (json.data || []).map(g => ({
    id: g.id,
    title: g.title || '',
    preview: g.images?.fixed_width?.url || g.images?.downsized?.url || g.images?.original?.url,
    url: g.images?.original?.url || g.images?.downsized?.url
  })).filter(g => g.preview && g.url);
}

async function giphyRequest(cacheKey, giphyUrl) {
  const cached = giphyCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  if (!GIPHY_API_KEY) throw new Error('GIPHY_API_KEY not configured');
  const res = await fetch(giphyUrl);
  if (!res.ok) throw Object.assign(new Error('GIPHY API error'), { status: res.status });
  const json = await res.json();
  const data = { ok: true, gifs: mapGiphyResults(json) };
  giphyCache.set(cacheKey, { data, expiresAt: Date.now() + GIPHY_CACHE_TTL_MS });
  return data;
}

app.get('/api/giphy/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, error: 'Missing q' });
  try {
    const data = await giphyRequest(
      `search:${q.toLowerCase()}`,
      `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(GIPHY_API_KEY)}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13`
    );
    res.json(data);
  } catch (err) {
    console.error('GIPHY search error:', err.message);
    res.status(err.status || 500).json({ ok: false, error: 'Failed to search GIPHY' });
  }
});

app.get('/api/giphy/trending', async (req, res) => {
  try {
    const data = await giphyRequest(
      'trending',
      `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(GIPHY_API_KEY)}&limit=24&rating=pg-13`
    );
    res.json(data);
  } catch (err) {
    console.error('GIPHY trending error:', err.message);
    res.status(err.status || 500).json({ ok: false, error: 'Failed to load trending GIFs' });
  }
});

const port = PORT || 3001;
app.listen(port, '0.0.0.0', () => console.log(`Nexora Pinterest backend listening on :${port}`));