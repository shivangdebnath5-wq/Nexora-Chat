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
  PINTEREST_CLIENT_ID,
  PINTEREST_CLIENT_SECRET,
  PINTEREST_REDIRECT_URI,
  PINTEREST_REFRESH_TOKEN,
  ALLOWED_ORIGIN,
  PORT
} = process.env;

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
// NOTE ON BOARDS: Pinterest's v5 API addresses boards by numeric board_id
// (GET /v5/boards/{board_id}), not by the vanity "/username/board-slug/"
// path people actually paste around. I don't have a verified, documented v5
// endpoint that resolves a third party's vanity board URL straight to an
// id — this implementation's board path is a best-effort attempt and is the
// one part of this integration you should test for real once credentials
// are live; the pin path (GET /v5/pins/{pin_id}) is the well-documented,
// confident part.
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

async function fetchBoardPreview(classified, headers) {
  // Best-effort: try the vanity path as a board_id lookup first (some
  // Pinterest surfaces do embed the resolvable id in the slug); if that
  // 404s, there's currently no further public fallback wired in here.
  const boardRes = await fetch(`https://api.pinterest.com/v5/boards/${classified.username}%2F${classified.slug}`, { headers });
  if (!boardRes.ok) throw Object.assign(new Error('Pinterest API error (board lookup unverified — see comment above fetchBoardPreview)'), { status: boardRes.status });
  const board = await boardRes.json();

  let previewPins = [];
  try {
    const pinsRes = await fetch(`https://api.pinterest.com/v5/boards/${board.id}/pins?page_size=4`, { headers });
    if (pinsRes.ok) {
      const pinsJson = await pinsRes.json();
      previewPins = (pinsJson.items || []).slice(0, 4).map(p => ({
        image: p.media?.images?.['400x300']?.url || p.media?.images?.orig?.url || null,
        url: p.link || `https://www.pinterest.com/pin/${p.id}/`
      })).filter(p => p.image);
    }
  } catch { /* preview pins are optional decoration; ignore failures */ }

  return {
    ok: true,
    type: 'board',
    url: `https://www.pinterest.com/${classified.username}/${classified.slug}/`,
    title: board.name || 'Pinterest board',
    pinCount: board.pin_count ?? null,
    creator: board.owner ? {
      name: board.owner.username,
      username: board.owner.username,
      profileUrl: `https://www.pinterest.com/${board.owner.username}/`,
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
      : await fetchBoardPreview(classified, headers);

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