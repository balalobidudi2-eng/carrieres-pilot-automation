require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

if (!process.env.AUTOMATION_SECRET) {
  console.warn('WARNING: AUTOMATION_SECRET non configuree');
}

const sessions = new Map();

function requireAuth(req, res, next) {
  const secret = process.env.AUTOMATION_SECRET;
  if (!secret || req.headers['x-automation-secret'] !== secret) {
    return res.status(401).json({ error: 'Non autorise' });
  }
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }));

app.post('/sessions', requireAuth, async (req, res) => {
  const { sessionId, initialUrl } = req.body;
  if (!sessionId || !initialUrl) return res.status(400).json({ error: 'sessionId et initialUrl requis' });
  if (sessions.has(sessionId)) return res.status(409).json({ error: 'Session deja existante' });
  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--window-size=1280,720','--disable-dev-shm-usage','--disable-gpu'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    const page = await context.newPage();
    await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    sessions.set(sessionId, { browser, context, page, createdAt: Date.now() });
    console.log('[sessions] Creee:', sessionId);
    res.json({ success: true, sessionId });
  } catch (e) {
    console.error('[sessions] Erreur:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sessions/:id/cookies', requireAuth, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session non trouvee' });
  try {
    const currentUrl = session.page.url();
    const cookies = await session.context.cookies();
    res.json({ success: true, cookies, currentUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/sessions/:id', requireAuth, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.json({ success: true });
  try {
    await session.browser.close();
    sessions.delete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > 10 * 60 * 1000) {
      s.browser.close().catch(() => {});
      sessions.delete(id);
    }
  }
}, 60 * 1000);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  const secret = url.searchParams.get('secret');
  const wsSecret = process.env.AUTOMATION_SECRET;
  if (!wsSecret || secret !== wsSecret) { ws.close(1008, 'Non autorise'); return; }
  const session = sessions.get(sessionId);
  if (!session) { ws.close(1008, 'Session non trouvee'); return; }
  const interval = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) { clearInterval(interval); return; }
    try { const shot = await session.page.screenshot({ type: 'jpeg', quality: 65 }); ws.send(shot); }
    catch { clearInterval(interval); }
  }, 200);
  ws.on('message', async (data) => {
    try {
      const { type, x, y, text, key, delta } = JSON.parse(data.toString());
      if (type === 'click') await session.page.mouse.click(x, y);
      else if (type === 'type') await session.page.keyboard.type(text);
      else if (type === 'key') await session.page.keyboard.press(key);
      else if (type === 'scroll') await session.page.mouse.wheel(0, delta);
    } catch (e) { console.error('[ws] Action error:', e.message); }
  });
  ws.on('close', () => { clearInterval(interval); });
});

const PORT = parseInt(process.env.PORT || '3001', 10);
console.log('[startup] PORT=' + PORT);
server.listen(PORT, '0.0.0.0', () => console.log('[startup] Listening on 0.0.0.0:' + PORT));
server.on('error', (e) => { console.error('[startup] ERROR:', e.message); process.exit(1); });
