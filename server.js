require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const APP_VERSION = 'v3.3-adzuna-presolve';

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

if (!process.env.AUTOMATION_SECRET) console.warn('WARNING: AUTOMATION_SECRET non configuree');

const sessions = new Map();

// Persistance des cookies Indeed via Neon/PostgreSQL
const { Pool } = require('pg');
const dbPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;
if (!dbPool) console.warn('[DB] DATABASE_URL non configuré — cookies non persistés');

function requireAuth(req, res, next) {
  const secret = process.env.AUTOMATION_SECRET;
  if (!secret || req.headers['x-automation-secret'] !== secret) return res.status(401).json({ error: 'Non autorise' });
  next();
}

// ─── Détection de plateforme ─────────────────────────────────────────────────
function detectPlatform(jobUrl) {
  if (!jobUrl) return 'unknown';
  const url = jobUrl.toLowerCase();
  if (url.includes('adzuna.fr') || url.includes('adzuna.com')) return 'adzuna';
  if (url.includes('indeed.com') || url.includes('smartapply.indeed')) return 'indeed';
  if (url.includes('meteojob.com')) return 'meteojob';
  if (url.includes('hellowork.com')) return 'hellowork';
  if (url.includes('francetravail.fr') || url.includes('pole-emploi.fr')) return 'francetravail';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('welcometothejungle.com')) return 'wttj';
  return 'generic';
}

function cookieDomainForPlatform(platform) {
  const map = {
    indeed: 'indeed.com', meteojob: 'meteojob.com', hellowork: 'hellowork.com',
    francetravail: 'francetravail.fr', linkedin: 'linkedin.com', wttj: 'welcometothejungle.com',
  };
  return map[platform] || null;
}

// ─── Init DB : table multi-plateforme ────────────────────────────────────────
async function initDb() {
  if (!dbPool) return;
  try {
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_platform_cookies (
        user_id    TEXT NOT NULL,
        domain     TEXT NOT NULL,
        cookies    JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, domain)
      )
    `);
    console.log('[DB] user_platform_cookies table OK');
  } catch (e) {
    console.error('[DB] initDb error:', e.message);
  }
}
initDb();

// ─── Chargement cookies multi-plateforme ─────────────────────────────────────
async function loadCookiesFromDb(userId, platform) {
  if (!dbPool || !userId) return null;
  const domain = cookieDomainForPlatform(platform);
  if (domain) {
    try {
      const r = await dbPool.query(
        'SELECT cookies FROM user_platform_cookies WHERE user_id = $1 AND domain = $2',
        [userId, domain]
      );
      if (r.rows.length) {
        const c = r.rows[0].cookies;
        const cookies = Array.isArray(c) ? c : JSON.parse(c);
        console.log(`[DB] ${cookies.length} cookies chargés (user_platform_cookies) pour ${domain}`);
        return cookies;
      }
    } catch (e) { console.warn('[DB] loadCookies upc error:', e.message); }
  }
  // Fallback : table indeed_cookies pour Indeed
  if (platform === 'indeed') {
    try {
      const r = await dbPool.query('SELECT cookies FROM indeed_cookies WHERE user_id = $1', [userId]);
      if (r.rows.length) {
        const c = r.rows[0].cookies;
        const cookies = Array.isArray(c) ? c : JSON.parse(c);
        console.log(`[DB] ${cookies.length} cookies chargés (indeed_cookies fallback)`);
        return cookies;
      }
    } catch (e) { console.warn('[DB] loadCookies fallback error:', e.message); }
  }
  return null;
}

// ─── Stratégies de candidature par plateforme ────────────────────────────────
async function applyIndeed(page) {
  console.log('[APPLY] Indeed — URL:', page.url());
  const currentUrl = page.url();
  if (currentUrl.includes('/auth') || currentUrl.includes('login')) {
    return { success: false, platform: 'indeed', error: 'Redirigé vers login — cookies invalides ou expirés' };
  }
  const selectors = [
    '[data-testid="indeedApplyButton"]',
    '.jobsearch-IndeedApplyButton',
    'button[id*="apply"]',
    'button:has-text("Postuler")',
    'a:has-text("Postuler maintenant")',
    'button:has-text("Apply now")',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        console.log(`[APPLY] Indeed — bouton trouvé: ${sel}`);
        await btn.click();
        await page.waitForTimeout(2000);
        return { success: true, platform: 'indeed', selector: sel, resultUrl: page.url() };
      }
    } catch {}
  }
  return { success: false, platform: 'indeed', error: 'Bouton postuler non trouvé' };
}

async function applyMeteoJob(page) {
  console.log('[APPLY] MeteoJob — URL:', page.url());

  // Fermer le modal de consentement cookies (TarteAuCitron) s'il est présent
  try {
    const consentSelectors = [
      '#tarteaucitronAllAllowed2',
      '#tarteaucitronAllAllowed',
      '#tarteaucitronPersonalize2',
      'button:has-text("Tout accepter")',
      'button:has-text("J\'accepte tout")',
      'button:has-text("Tout autoriser")',
      '#tarteaucitronClosePanel',
    ];
    for (const sel of consentSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const visible = await btn.isVisible();
          if (visible) {
            console.log(`[APPLY] MeteoJob — fermeture modal cookies: ${sel}`);
            await btn.click();
            await page.waitForTimeout(1500);
            break;
          }
        }
      } catch {}
    }
  } catch {}

  const selectors = [
    'a[href*="postuler"]',
    'a[href*="apply"]',
    'button:has-text("Postuler")',
    'a:has-text("Postuler")',
    'a:has-text("Je postule")',
    'button:has-text("Je postule")',
    'a:has-text("POSTULER")',
    '.apply-button',
    '[data-testid="apply-button"]',
    '[data-testid="apply-btn"]',
    'button[class*="apply"]',
    'a[class*="apply"]',
    'a[class*="postuler"]',
    'button[class*="postuler"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const visible = await btn.isVisible().catch(() => false);
        if (visible) {
          console.log(`[APPLY] MeteoJob — bouton trouvé: ${sel}`);
          await btn.click();
          await page.waitForTimeout(2000);
          return { success: true, platform: 'meteojob', selector: sel, resultUrl: page.url() };
        }
      }
    } catch {}
  }
  try {
    const btn = page.getByRole('link', { name: /postuler|je postule/i }).first();
    if (await btn.count() > 0) {
      console.log('[APPLY] MeteoJob — bouton via getByRole');
      await btn.click();
      await page.waitForTimeout(2000);
      return { success: true, platform: 'meteojob', selector: 'role:link:postuler', resultUrl: page.url() };
    }
  } catch {}

  // Log page title and try to detect job offer links for debugging
  try {
    const title = await page.title();
    const offerLinks = await page.$$eval('a[href]', els =>
      els.map(e => e.href).filter(h => h && (h.includes('/offre') || h.includes('/jobs/') || h.includes('postuler'))).slice(0, 5)
    );
    console.log(`[APPLY] MeteoJob — titre: "${title}", offresLinks: ${JSON.stringify(offerLinks)}`);
  } catch {}
  return { success: false, platform: 'meteojob', error: 'Bouton postuler non trouvé' };
}

async function applyHelloWork(page) {
  console.log('[APPLY] HelloWork — URL:', page.url());
  const selectors = [
    'a:has-text("Postuler")',
    'button:has-text("Postuler")',
    '[data-cy="apply-btn"]',
    '.btn-apply',
    'a[href*="postuler"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        console.log(`[APPLY] HelloWork — bouton trouvé: ${sel}`);
        await btn.click();
        await page.waitForTimeout(2000);
        return { success: true, platform: 'hellowork', selector: sel, resultUrl: page.url() };
      }
    } catch {}
  }
  return { success: false, platform: 'hellowork', error: 'Bouton postuler non trouvé' };
}

async function applyFranceTravail(page) {
  console.log('[APPLY] FranceTravail — URL:', page.url());
  const selectors = [
    'button:has-text("Je postule")',
    'a:has-text("Je postule")',
    '[data-testid="postuler-btn"]',
    'button:has-text("Postuler")',
    'a:has-text("Postuler")',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        console.log(`[APPLY] FranceTravail — bouton trouvé: ${sel}`);
        await btn.click();
        await page.waitForTimeout(2000);
        return { success: true, platform: 'francetravail', selector: sel, resultUrl: page.url() };
      }
    } catch {}
  }
  return { success: false, platform: 'francetravail', error: 'Bouton postuler non trouvé' };
}

async function applyGeneric(page) {
  console.log('[APPLY] Generic — URL:', page.url());
  const selectors = [
    'button:has-text("Postuler")',
    'a:has-text("Postuler")',
    'button:has-text("Je postule")',
    'a:has-text("Je postule")',
    'button:has-text("Apply")',
    'a:has-text("Apply")',
    'button:has-text("Apply now")',
    '[class*="apply-btn"]',
    '[id*="apply-btn"]',
    '[class*="postuler"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        console.log(`[APPLY] Generic — bouton trouvé: ${sel}`);
        await btn.click();
        await page.waitForTimeout(2000);
        return { success: true, platform: 'generic', selector: sel, resultUrl: page.url() };
      }
    } catch {}
  }
  return { success: false, platform: 'generic', error: 'Aucun bouton postuler trouvé' };
}

// ─── Pré-résolution URL Adzuna via HTTP simple (bypass bot detection Playwright) ──
async function preResolveAdzunaUrl(url) {
  if (!url.includes('adzuna.fr') && !url.includes('adzuna.com')) return url;
  console.log(`[URL] Résolution Adzuna via HTTP: ${url.slice(0, 100)}`);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8',
        'Cache-Control': 'no-cache',
      },
    });
    // Cas 1 : HTTP redirect automatique vers domaine non-Adzuna
    const finalUrl = resp.url;
    if (!finalUrl.includes('adzuna')) {
      console.log(`[URL] Adzuna résolu via redirect HTTP: ${finalUrl}`);
      return finalUrl;
    }
    // Cas 2 : parser le HTML pour trouver l'URL de la plateforme employeur
    const html = await resp.text();
    const knownPlatforms = [
      'meteojob.com', 'hellowork.com', 'francetravail.fr', 'pole-emploi.fr',
      'indeed.com', 'linkedin.com', 'welcometothejungle.com', 'apec.fr',
      'cadremploi.fr', 'monster.fr', 'regionsjob.com', 'jobteaser.com',
    ];
    for (const platform of knownPlatforms) {
      const esc = platform.replace('.', '\\.');
      const match = html.match(new RegExp(`https?://(?:[\\w-]+\\.)*${esc}/[^"'\\s<>]+`, 'i'));
      if (match) {
        console.log(`[URL] Adzuna résolu via HTML (${platform}): ${match[0].slice(0, 120)}`);
        return match[0];
      }
    }
    console.log(`[URL] Adzuna — résolution HTTP sans résultat, Playwright en fallback`);
  } catch (e) {
    console.warn(`[URL] Adzuna pré-résolution erreur: ${e.message}`);
  }
  return url;
}

// ─── Navigation avec suivi de redirections (HTTP + JS) ───────────────────────
async function navigateWithRedirects(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  } catch (e) {
    // Timeout ou erreur réseau — continuer avec l'URL courante
    console.warn(`[NAV] Navigation timeout/erreur, URL courante: ${page.url()} — ${e.message}`);
  }
  // Attendre redirections JS éventuelles (window.location, meta-refresh…)
  await page.waitForTimeout(3000);
  const finalUrl = page.url();
  console.log(`[NAV] URL initiale: ${url}`);
  console.log(`[NAV] URL finale après redirections: ${finalUrl}`);
  return finalUrl;
}

// ─── Stratégie Adzuna : suivre le lien vers la plateforme cible ─────────────────
async function applyAdzuna(page) {
  console.log('[APPLY] Adzuna — URL:', page.url());

  // Détecter le blocage bot (page "Accès refusé")
  const title = await page.title().catch(() => '');
  const isBlocked = title.toLowerCase().includes('refus') || title.toLowerCase().includes('denied') || title.toLowerCase().includes('blocked');
  if (isBlocked) {
    console.warn(`[APPLY] Adzuna — page bloquée par bot detection (titre: "${title}"). L'IP native Railway sera utilisée — vérifier la configuration proxy.`);
    return { success: false, platform: 'adzuna', error: `Bot detection Adzuna: "${title}". Utiliser un proxy résidentiel ou passer l'URL MeteoJob directement.` };
  }

  // Logger le titre et les liens visibles pour debug
  try {
    const title = await page.title();
    const allLinks = await page.$$eval('a[href]', els =>
      els.slice(0, 15).map(e => ({ text: e.textContent?.trim().slice(0, 50), href: e.href?.slice(0, 100) }))
    );
    console.log(`[APPLY] Adzuna — titre: "${title}", liens: ${JSON.stringify(allLinks)}`);
  } catch {}

  // 1. Fermer le modal d'alerte email s'il existe
  const modalDismissSelectors = [
    'a:has-text("Non merci, je veux voir l\'offre d\'emploi")',
    'a:has-text("Non merci")',
    'button:has-text("Non merci")',
    '[data-ui="skip-alert-signup"]',
    '.skip-link',
    '.modal__close',
    '[class*="skip"]',
  ];
  for (const sel of modalDismissSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible().catch(() => false)) {
        console.log(`[APPLY] Adzuna — fermeture modal: ${sel}`);
        await btn.click();
        await page.waitForTimeout(1500);
        break;
      }
    } catch {}
  }

  // 2. Cliquer sur le lien vers la plateforme cible (MeteoJob, etc.)
  const applySelectors = [
    'a:has-text("Voir l\'annonce")',
    'a:has-text("Voir l\'offre")',
    'a:has-text("Voir l\'offre d\'emploi")',
    'a:has-text("Postuler maintenant")',
    'a:has-text("Postuler")',
    '.btn-apply',
    '.ad_details__apply a',
    '[class*="apply"] a',
    '[class*="apply-btn"]',
    'a[data-ui="apply-button"]',
    'a[href*="meteojob"]',
    'a[href*="hellowork"]',
    'a[href*="indeed"]',
    'a[href*="francetravail"]',
    'a[href*="linkedin"]',
  ];

  for (const sel of applySelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible().catch(() => false)) {
        const href = await btn.getAttribute('href').catch(() => null);
        console.log(`[APPLY] Adzuna — bouton trouvé: ${sel} (href: ${href?.slice(0, 80)})`);
        // Si le lien ouvre dans un nouvel onglet, forcer la navigation dans la page courante
        await btn.evaluate(el => { el.removeAttribute('target'); });
        await btn.click();
        // Attendre la navigation vers la plateforme cible
        try {
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
        } catch {
          await page.waitForTimeout(3000);
        }
        const newUrl = page.url();
        const newPlatform = detectPlatform(newUrl);
        console.log(`[APPLY] Adzuna — redirigé vers: ${newUrl} (${newPlatform})`);
        if (newPlatform !== 'adzuna') {
          return applyByPlatform(page, newPlatform);
        }
        break;
      }
    } catch {}
  }

  return { success: false, platform: 'adzuna', error: 'Lien vers la plateforme cible non trouvé sur Adzuna' };
}

// ─── Dispatch apply selon plateforme finale ───────────────────────────────────
async function applyByPlatform(page, platform) {
  switch (platform) {
    case 'indeed':        return applyIndeed(page);
    case 'meteojob':      return applyMeteoJob(page);
    case 'hellowork':     return applyHelloWork(page);
    case 'francetravail': return applyFranceTravail(page);
    case 'adzuna':        return applyAdzuna(page);
    default:              return applyGeneric(page);
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, sessions: sessions.size, version: APP_VERSION }));

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

    // Stratégie 3 : iframe Cloudflare — sitekey + pagedata dans l'URL
    let iframePagedata = null;
    if (!sitekey) {
      for (const frame of page.frames()) {
        const url = frame.url();
        const m1 = url.match(/[?&](?:sitekey|k)=(0x[A-Za-z0-9]{10,})/);
        if (m1) { sitekey = m1[1]; }
        const m2 = url.match(/\/(0x[A-Za-z0-9]{10,})\//);
        if (m2) { sitekey = m2[1]; }
        // Extraire pagedata : segment après /light/ ou /dark/ dans l'URL Cloudflare
        const mp = url.match(/\/(?:light|dark)\/([A-Za-z0-9+=_-]{2,10})\//);  // sans / dans la classe
        if (mp) { iframePagedata = mp[1]; }
        if (sitekey) break;
      }
    }
    if (iframePagedata) console.log('[CAPTCHA] pagedata extrait depuis iframe:', iframePagedata);

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
      if (cfParams.action)                        task.action   = cfParams.action;
      if (cfParams.data)                          task.data     = cfParams.data;
      if (cfParams.pagedata || iframePagedata)    task.pagedata = cfParams.pagedata || iframePagedata;

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

    // Attendre que le widget Turnstile soit rendu avant d'injecter
    await page.waitForSelector('[name="cf-turnstile-response"], .cf-turnstile, [data-sitekey]', { timeout: 8000 }).catch(() => {});

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
  const { sessionId, initialUrl, userId } = req.body;
  if (!sessionId || !initialUrl) return res.status(400).json({ error: 'sessionId et initialUrl requis' });
  if (sessions.has(sessionId)) return res.status(409).json({ error: 'Session deja existante' });

  // Détection initiale de plateforme + pré-résolution URL Adzuna via HTTP
  let detectedPlatform = detectPlatform(initialUrl);
  let effectiveUrl = initialUrl;
  if (detectedPlatform === 'adzuna') {
    effectiveUrl = await preResolveAdzunaUrl(initialUrl);
    detectedPlatform = detectPlatform(effectiveUrl);
  }
  const initialPlatform = detectedPlatform;
  console.log(`[SESSION] Plateforme initiale: ${initialPlatform} pour ${effectiveUrl}`);

  let storedCookies = null;
  if (userId && initialPlatform !== 'adzuna') {
    storedCookies = await loadCookiesFromDb(userId, initialPlatform);
  }

  // Cookies obligatoires pour Indeed uniquement sur URL directe (pas via agrégateur)
  if (initialPlatform === 'indeed' && (!storedCookies || !storedCookies.length)) {
    return res.status(400).json({ error: 'Cookies Indeed non disponibles. Utilisez l\'extension pour les envoyer d\'abord.', platform: 'indeed' });
  }

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
      // Pour Adzuna : ne pas utiliser le proxy (leur bot detection bloque les IPs de proxy datacenter)
      if (initialPlatform !== 'adzuna') {
        launchOptions.proxy = {
          server: `http://${proxyAddress}:${proxyPort}`,
          username: proxyLogin,
          password: proxyPassword,
        };
        console.log(`[PROXY] Mode proxy activé: ${proxyAddress}:${proxyPort}`);
      } else {
        console.log(`[PROXY] Proxy désactivé pour adzuna (détection bot sur IPs proxy)`);
      }
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
    // Injecter les cookies AVANT toute navigation (si disponibles)
    if (storedCookies && storedCookies.length) {
      await context.addCookies(storedCookies);
      console.log(`[SESSION] Cookies pré-injectés: ${storedCookies.length} (platform: ${initialPlatform})`);
    } else {
      console.log(`[SESSION] Aucun cookie initial — navigation sans authentification (platform: ${initialPlatform})`);
    }
    const page = await context.newPage();
    // Naviguer en suivant toutes les redirections (HTTP + JS)
    const finalUrl = await navigateWithRedirects(page, effectiveUrl);
    const platform = detectPlatform(finalUrl);
    console.log(`[SESSION] Plateforme finale détectée: ${platform}`);

    // Si la plateforme finale diffère de l'initiale (ex: adzuna→meteojob),
    // charger et injecter les cookies de la plateforme finale, puis recharger
    if (platform !== initialPlatform && userId) {
      const finalCookies = await loadCookiesFromDb(userId, platform);
      if (finalCookies && finalCookies.length) {
        await context.addCookies(finalCookies);
        console.log(`[SESSION] Cookies injectés pour plateforme finale ${platform}: ${finalCookies.length}`);
        await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      }
    }

    const sessionObj = { browser, context, page, createdAt: Date.now(), platform };
    sessions.set(sessionId, sessionObj);
    // Auto-solve Turnstile si 2captcha configuré
    console.log('[captcha] Trigger autoSolveTurnstile on initial page:', page.url());
    autoSolveTurnstile(page).then(solved => { if (solved) console.log('[captcha] Auto-solved on load'); }).catch(() => {});
    // Auto-candidature selon la plateforme finale (async, non-bloquant)
    (async () => {
      try {
        await page.waitForTimeout(3000);
        const applyResult = await applyByPlatform(page, platform);
        sessionObj.applyResult = applyResult;
        console.log(`[SESSION] Résultat candidature (${platform}):`, JSON.stringify(applyResult));
      } catch (applyErr) {
        console.error(`[SESSION] Apply error (${platform}):`, applyErr.message);
        sessionObj.applyResult = { success: false, platform, error: applyErr.message };
      }
    })();
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

// CORS preflight pour l'extension Firefox
app.options('/store-cookies', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-automation-secret');
  res.sendStatus(204);
});

// Réception des cookies depuis l'extension Firefox (multi-plateforme)
app.post('/store-cookies', requireAuth, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { userId, cookies, domain } = req.body;
  if (!userId || !Array.isArray(cookies) || !cookies.length) {
    return res.status(400).json({ error: 'userId et cookies requis' });
  }
  const cookieDomain = domain || 'indeed.com';
  if (dbPool) {
    try {
      // Stockage dans la table multi-plateforme
      await dbPool.query(
        `INSERT INTO user_platform_cookies (user_id, domain, cookies, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, domain) DO UPDATE SET cookies = $3, updated_at = NOW()`,
        [userId, cookieDomain, JSON.stringify(cookies)]
      );
      // Rétrocompatibilité : indeed_cookies pour indeed.com
      if (cookieDomain === 'indeed.com') {
        await dbPool.query(
          `INSERT INTO indeed_cookies (user_id, cookies, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (user_id) DO UPDATE SET cookies = $2, updated_at = NOW()`,
          [userId, JSON.stringify(cookies)]
        );
      }
      console.log(`[cookies] Stockés: userId=${userId}, domain=${cookieDomain} (${cookies.length} cookies)`);
    } catch (dbErr) {
      console.error('[cookies] DB error:', dbErr.message);
      return res.status(500).json({ error: 'Erreur DB: ' + dbErr.message });
    }
  } else {
    console.warn('[cookies] dbPool non disponible — cookies non persistés');
  }
  return res.json({ success: true, domain: cookieDomain });
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
server.listen(PORT, '0.0.0.0', () => console.log(`[startup] version=${APP_VERSION} Listening on 0.0.0.0:` + PORT));
server.on('error', (e) => { console.error('[startup] ERROR:', e.message); process.exit(1); });
