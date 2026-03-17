require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

if (!process.env.AUTOMATION_SECRET) console.warn('WARNING: AUTOMATION_SECRET non configuree');

const sessions = new Map();

function requireAuth(req, res, next) {
  const secret = process.env.AUTOMATION_SECRET;
  if (!secret || req.headers['x-automation-secret'] !== secret) return res.status(401).json({ error: 'Non autorise' });
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessions.size }));

// Résolution automatique Cloudflare Turnstile via 2captcha
async function autoSolveTurnstile(page) {
  try {
    console.log('[CAPTCHA] autoSolveTurnstile start, page:', page.url());

    // Laisser le challenge Cloudflare apparaître avant de chercher le sitekey.
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    for (let i = 0; i < 10; i++) {
      const hasJsOrDomSitekey = await page.evaluate(() => {
        return !!(
          window._cf_chl_opt?.chlApiSitekey
          || window._cf_chl_opt?.chlApiParams?.sitekey
          || window.CF_CHLG_SITEKEY
          || document.querySelector('[data-sitekey]')
        );
      }).catch(() => false);
      const hasCloudflareFrame = page.frames().some(frame => {
        const url = frame.url();
        return url.includes('challenges.cloudflare.com') || url.includes('/cdn-cgi/challenge-platform/');
      });
      if (hasJsOrDomSitekey || hasCloudflareFrame) break;
      await page.waitForTimeout(1000).catch(() => {});
    }

    console.log('[CAPTCHA] Après attente, page:', page.url());
    console.log('[CAPTCHA] Frames détectées:', page.frames().map(frame => frame.url()));

    // Stratégie 1 : variables JS globales (page interstitielle Cloudflare)
    let sitekey = await page.evaluate(() => {
      return window._cf_chl_opt?.chlApiSitekey
          || window._cf_chl_opt?.chlApiParams?.sitekey
          || window.CF_CHLG_SITEKEY
          || null;
    }).catch(() => null);

    // Stratégie 2 : attributs DOM standard
    if (!sitekey) {
      sitekey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        return el?.dataset?.sitekey || null;
      }).catch(() => null);
    }

    // Stratégie 3 : iframe Cloudflare — sitekey dans querystring ou chemin URL
    if (!sitekey) {
      for (const frame of page.frames()) {
        const url = frame.url();
        const m1 = url.match(/[?&](?:sitekey|k)=(0x[A-Za-z0-9]{10,})/);
        if (m1) { sitekey = m1[1]; break; }
        const m2 = url.match(/\/(0x[A-Za-z0-9]{10,})\//);
        if (m2) { sitekey = m2[1]; break; }
      }
    }

    // Stratégie 4 : scan HTML brut (regex large)
    if (!sitekey) {
      const html = await page.content().catch(() => '');
      const patterns = [
        /chlApiSitekey['":\s]+"(0x[A-Za-z0-9]{10,})"/,
        /data-sitekey=["'](0x[A-Za-z0-9]{10,})["']/,
        /'(0x[A-Za-z0-9]{10,})'/,
        /"(0x[A-Za-z0-9]{10,})"/,
      ];
      for (const re of patterns) {
        const m = html.match(re);
        if (m) { sitekey = m[1]; break; }
      }
    }

    if (!sitekey) {
      const htmlPreview = await page.content().then(html => html.slice(0, 2000)).catch(() => '');
      console.log('[CAPTCHA] Sitekey introuvable sur cette page');
      console.log('[CAPTCHA] URL au moment de l\'échec :', page.url());
      console.log('[CAPTCHA] Extrait HTML :', htmlPreview);
      return false;
    }

    console.log('[CAPTCHA] Sitekey trouvé :', sitekey);

    // Extraire les paramètres CF supplémentaires nécessaires pour que le token soit accepté
    const cfParams = await page.evaluate(() => {
      // Source 1 : _turnstileParams injecté par le site (le plus fiable)
      const tp = window._turnstileParams || {};

      const opt = window._cf_chl_opt || {};
      let action   = tp.action   || opt.chlApiParams?.action || opt.chlAction || null;
      let data     = tp.data     || opt.chlApiParams?.cData  || opt.chlData   || null;
      let pagedata = tp.pagedata || opt.chlPageData || null;
      let userAgent = tp.userAgent || navigator.userAgent || null;
      // Sitekey depuis _turnstileParams (peut affiner celui trouvé via DOM/iframe)
      let tpSitekey = tp.sitekey || null;

      // Parfois dans l'URL de l'iframe : ?action=managed&cData=xxx
      const cfFrame = Array.from(document.querySelectorAll('iframe')).find(f =>
        f.src && (f.src.includes('challenges.cloudflare.com') || f.src.includes('cdn-cgi/challenge-platform'))
      );
      if (cfFrame) {
        try {
          const u = new URL(cfFrame.src);
          action   = action   || u.searchParams.get('action');
          data     = data     || u.searchParams.get('cData');
          pagedata = pagedata || u.searchParams.get('chlPageData');
        } catch {}
      }
      return { action, data, pagedata, userAgent, tpSitekey };
    }).catch(() => ({ action: null, data: null, pagedata: null, userAgent: null, tpSitekey: null }));

    // Priorité au sitekey issu de _turnstileParams s'il est présent
    if (cfParams.tpSitekey) sitekey = cfParams.tpSitekey;
    console.log('[CAPTCHA] Paramètres CF extraits:', cfParams);

    const cleanUrl = page.url().split('?')[0].split('#')[0];
    const rawUrlNoHash = page.url().split('#')[0];
    const candidateUrls = Array.from(new Set([
      cleanUrl,
      rawUrlNoHash,
      'https://secure.indeed.com/auth',
      'https://fr.indeed.com/account/login',
    ]));

    // Construire la task 2captcha — avec proxy si configuré
    const buildTask = (websiteURL) => {
      const task = {
        websiteURL,
        websiteKey: sitekey,
      };
      if (cfParams.action)    task.action    = cfParams.action;
      if (cfParams.data)      task.data      = cfParams.data;
      if (cfParams.pagedata)  task.pagedata  = cfParams.pagedata;

      const proxyAddr = process.env.CAPTCHA_PROXY_ADDRESS;
      if (proxyAddr) {
        task.type          = 'TurnstileTask';
        task.proxyType     = process.env.CAPTCHA_PROXY_TYPE     || 'http';
        task.proxyAddress  = proxyAddr;
        task.proxyPort     = parseInt(process.env.CAPTCHA_PROXY_PORT || '8080', 10);
        task.proxyLogin    = process.env.CAPTCHA_PROXY_LOGIN    || undefined;
        task.proxyPassword = process.env.CAPTCHA_PROXY_PASSWORD || undefined;
        console.log('[CAPTCHA] Mode proxy activé:', proxyAddr + ':' + task.proxyPort);
      } else {
        task.type = 'TurnstileTaskProxyless';
      }
      return task;
    };

    // Soumettre à 2captcha (fallback sur plusieurs URL de page)
    let taskId = null;
    for (const websiteURL of candidateUrls) {
      const task = buildTask(websiteURL);
      console.log('[CAPTCHA] URL soumise à 2captcha :', websiteURL, '| type:', task.type);
      const taskRes = await fetch('https://api.2captcha.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: process.env.CAPTCHA_API_KEY, task })
      });
      const taskData = await taskRes.json();
      if (!taskData.errorId && taskData.taskId) {
        taskId = taskData.taskId;
        break;
      }
      console.log('[CAPTCHA] Erreur création tâche 2captcha :', {
        errorId: taskData.errorId,
        errorCode: taskData.errorCode,
        errorDescription: taskData.errorDescription,
        websiteURL,
        sitekey,
      });
    }

    if (!taskId) {
      return false;
    }

    // Polling du résultat (max 2 min)
    let token = null;
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await fetch('https://api.2captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: process.env.CAPTCHA_API_KEY, taskId })
      });
      const data = await res.json();
      if (data.status === 'ready') { token = data.solution?.token; break; }
    }

    if (!token) {
      console.log('[CAPTCHA] Timeout 2captcha');
      return false;
    }

    // Injection du token dans la page
    console.log('[CAPTCHA] Token obtenu, début injection:', token.substring(0, 20) + '...');
    const injected = await page.evaluate((t) => {
      const result = { method: null, widgetFound: false, callbackName: null, inputsFound: 0 };

      // Cas 1 : widget Turnstile embarqué — appeler data-callback directement
      const widget = document.querySelector('.cf-turnstile, [data-sitekey]');
      result.widgetFound = !!widget;
      if (widget?.dataset?.callback) {
        result.callbackName = widget.dataset.callback;
        const fn = window[widget.dataset.callback];
        if (typeof fn === 'function') {
          fn(t);
          result.method = 'widget-callback';
          return result;
        }
      }

      // Cas 2 : champ caché standard + dispatch events
      const inputs = document.querySelectorAll('[name="cf-turnstile-response"]');
      result.inputsFound = inputs.length;
      inputs.forEach(el => {
        el.value = t;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      if (inputs.length) result.method = 'hidden-input';

      // Cas 3 : page interstitielle CF — callback JS
      if (window._cf_chl_opt?.chlCB) {
        window[window._cf_chl_opt.chlCB]?.(t);
        result.method = 'cf-interstitial';
        return result;
      }

      // Cas 4 : soumettre le formulaire directement
      const form = document.querySelector('#challenge-form')
                || document.querySelector('form[action*="challenge"]');
      if (form) {
        const hidden = form.querySelector('[name="cf-turnstile-response"]')
                    || document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'cf-turnstile-response';
        hidden.value = t;
        if (!hidden.parentNode) form.appendChild(hidden);
        form.submit();
        result.method = 'form-submit';
      }

      return result;
    }, token);

    console.log('[CAPTCHA] Résultat injection:', JSON.stringify(injected));
    if (!injected.method) {
      console.log('[CAPTCHA] ATTENTION: Aucune stratégie d\'injection n\'a fonctionné (widget:', injected.widgetFound, ', inputs:', injected.inputsFound, ', callback:', injected.callbackName, ')');
      return false;
    }

    // Attendre que la page réagisse (navigation ou changement d'URL)
    const urlBefore = page.url();
    await Promise.race([
      page.waitForNavigation({ timeout: 10000 }),
      page.waitForURL(url => url !== urlBefore, { timeout: 10000 }),
    ]).catch(() => {});

    console.log('[CAPTCHA] Après injection, URL:', page.url());
    return true;

  } catch (err) {
    console.error('[CAPTCHA] Erreur :', err.message);
    return false;
  }
}

app.post('/sessions', requireAuth, async (req, res) => {
  const { sessionId, initialUrl } = req.body;
  if (!sessionId || !initialUrl) return res.status(400).json({ error: 'sessionId et initialUrl requis' });
  if (sessions.has(sessionId)) return res.status(409).json({ error: 'Session deja existante' });
  try {
    const { chromium } = require('playwright');
    const proxyAddress = process.env.CAPTCHA_PROXY_ADDRESS;
    const proxyPort = process.env.CAPTCHA_PROXY_PORT;
    const proxyLogin = process.env.CAPTCHA_PROXY_LOGIN;
    const proxyPassword = process.env.CAPTCHA_PROXY_PASSWORD;

    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,720', '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-infobars', '--no-first-run', '--no-default-browser-check',
        '--lang=fr-FR,fr', '--disable-ipc-flooding-protection',
      ],
    };

    if (proxyAddress && proxyPort) {
      launchOptions.proxy = {
        server: `http://${proxyAddress}:${proxyPort}`,
        username: proxyLogin,
        password: proxyPassword,
      };
      console.log(`[PROXY] Mode proxy activé: ${proxyAddress}:${proxyPort}`);
    } else {
      console.log('[PROXY] Aucun proxy configuré');
    }

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      if (!window.chrome) {
        window.chrome = {
          app: { isInstalled: false },
          runtime: {},
          csi() {}, loadTimes() {},
        };
      }
      const makeMime = (type, suffixes, desc) => { const m = Object.create(MimeType.prototype); Object.defineProperties(m, { type: { value: type }, suffixes: { value: suffixes }, description: { value: desc } }); return m; };
      const makePlugin = (name, filename, desc, mimes) => { const p = Object.create(Plugin.prototype); Object.defineProperties(p, { name: { value: name }, filename: { value: filename }, description: { value: desc }, length: { value: mimes.length } }); mimes.forEach((m, i) => { p[i] = m; m.enabledPlugin = p; }); p.item = (i) => p[i]; p.namedItem = (t) => mimes.find(m => m.type === t) || null; return p; };
      const plugins = [
        makePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format', [makeMime('application/x-google-chrome-pdf', 'pdf', 'Portable Document Format')]),
        makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', '', [makeMime('application/pdf', 'pdf', '')]),
        makePlugin('Native Client', 'internal-nacl-plugin', '', [makeMime('application/x-nacl', '', 'Native Client Executable'), makeMime('application/x-pnacl', '', 'Portable Native Client Executable')]),
      ];
      const pluginArr = Object.create(PluginArray.prototype);
      plugins.forEach((p, i) => { pluginArr[i] = p; });
      Object.defineProperty(pluginArr, 'length', { value: plugins.length });
      pluginArr.item = (i) => pluginArr[i]; pluginArr.namedItem = (n) => plugins.find(p => p.name === n) || null; pluginArr.refresh = () => {};
      Object.defineProperty(navigator, 'plugins', { get: () => pluginArr });
      const allMimes = plugins.flatMap(p => Array.from({ length: p.length }, (_, i) => p[i]));
      const mimeArr = Object.create(MimeTypeArray.prototype);
      allMimes.forEach((m, i) => { mimeArr[i] = m; });
      Object.defineProperty(mimeArr, 'length', { value: allMimes.length });
      mimeArr.item = (i) => mimeArr[i]; mimeArr.namedItem = (t) => allMimes.find(m => m.type === t) || null;
      Object.defineProperty(navigator, 'mimeTypes', { get: () => mimeArr });
      Object.defineProperty(navigator, 'languages', { get: () => ['fr-FR', 'fr', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      if (navigator.permissions && navigator.permissions.query) {
        const orig = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (params) => params.name === 'notifications' ? Promise.resolve({ state: 'default', onchange: null }) : orig(params);
      }
    });
    const page = await context.newPage();
    await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const sessionObj = { browser, context, page, createdAt: Date.now() };
    sessions.set(sessionId, sessionObj);
    // Auto-solve Turnstile si 2captcha configuré
    console.log('[captcha] Trigger autoSolveTurnstile on initial page:', page.url());
    autoSolveTurnstile(page).then(solved => { if (solved) console.log('[captcha] Auto-solved on load'); }).catch(() => {});
    // Suivre les popups (Google OAuth, etc.)
    context.on('page', async (newPage) => {
      try {
        await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        sessionObj.page = newPage;
        console.log('[sessions] Popup ouverte:', newPage.url());
        console.log('[captcha] Trigger autoSolveTurnstile on popup page:', newPage.url());
        autoSolveTurnstile(newPage).then(solved => { if (solved) console.log('[captcha] Auto-solved on popup'); }).catch(() => {});
        newPage.on('close', () => {
          const pages = context.pages();
          if (pages.length > 0) { sessionObj.page = pages[pages.length - 1]; console.log('[sessions] Popup fermee, retour:', sessionObj.page.url()); }
        });
      } catch (e) { console.error('[sessions] Popup error:', e.message); }
    });
    console.log('[sessions] Creee:', sessionId);
    res.json({ success: true, sessionId });
  } catch (e) {
    console.error('[sessions] Erreur:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sessions/:id/cookies', requireAuth, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    console.log('[sessions] Not found for /cookies:', req.params.id, 'known:', Array.from(sessions.keys()));
    return res.status(404).json({ error: 'Session non trouvee' });
  }
  try {
    const currentUrl = session.page.url();
    const cookies = await session.context.cookies();
    res.json({ success: true, cookies, currentUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Endpoint pour résoudre manuellement un CAPTCHA Turnstile sur la session active
app.post('/sessions/:id/solve-captcha', requireAuth, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    console.log('[sessions] Not found for /solve-captcha:', req.params.id, 'known:', Array.from(sessions.keys()));
    return res.status(404).json({ error: 'Session non trouvee' });
  }
  const solved = await autoSolveTurnstile(session.page);
  return res.json({ success: !!solved });
});

app.delete('/sessions/:id', requireAuth, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    console.log('[sessions] Not found for DELETE:', req.params.id, 'known:', Array.from(sessions.keys()));
    return res.json({ success: true });
  }
  try {
    await session.browser.close();
    sessions.delete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (now - s.createdAt > 10 * 60 * 1000) { s.browser.close().catch(() => {}); sessions.delete(id); }
  }
}, 60 * 1000);

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  const secret = url.searchParams.get('secret');
  if (!process.env.AUTOMATION_SECRET || secret !== process.env.AUTOMATION_SECRET) { ws.close(1008, 'Non autorise'); return; }
  const session = sessions.get(sessionId);
  if (!session) {
    console.log('[sessions] Not found for websocket:', sessionId, 'known:', Array.from(sessions.keys()));
    ws.close(1008, 'Session non trouvee');
    return;
  }
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
server.listen(PORT, '0.0.0.0', () => console.log('[startup] Listening on 0.0.0.0:' + PORT));
server.on('error', (e) => { console.error('[startup] ERROR:', e.message); process.exit(1); });
