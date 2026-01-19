import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static('public'));

app.use(
  '/vendor/pdfjs',
  express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'legacy', 'build'))
);

const DATA_DIR = path.join(__dirname, 'data');
const TICKER_FILE = path.join(DATA_DIR, 'ticker.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const RELOAD_FILE = path.join(DATA_DIR, 'reload.json');

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(TICKER_FILE)) {
    fs.writeFileSync(TICKER_FILE, JSON.stringify({ text: '' }, null, 2), 'utf-8');
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultConfig = {
      adminPassword: 'changeme',
      tickerPin: '1234',
      flipIntervalMs: 10000,
      folders: {
        links: 'public/links',
        rechts: 'public/rechts'
      }
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf-8');
  } else {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (!('tickerPin' in cfg)) {
      cfg.tickerPin = '1234';
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
    }
  }

  if (!fs.existsSync(RELOAD_FILE)) {
    fs.writeFileSync(RELOAD_FILE, JSON.stringify({ reload: false }, null, 2), 'utf-8');
  }
}

function readConfig() {
  ensureDataFiles();
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function writeConfig(cfg) {
  ensureDataFiles();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

function readTicker() {
  ensureDataFiles();
  return JSON.parse(fs.readFileSync(TICKER_FILE, 'utf-8'));
}

function writeTicker(text) {
  ensureDataFiles();
  fs.writeFileSync(TICKER_FILE, JSON.stringify({ text }, null, 2), 'utf-8');
}

function resolveFolderPath(folderPathFromConfig) {
  return path.isAbsolute(folderPathFromConfig)
    ? folderPathFromConfig
    : path.join(__dirname, folderPathFromConfig);
}

/* ---------------------------
   Admin Auth (Basic Auth)
---------------------------- */

function parseBasicAuth(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  try {
    const raw = Buffer.from(h.slice(6), 'base64').toString('utf-8');
    const idx = raw.indexOf(':');
    if (idx < 0) return null;
    return { user: raw.slice(0, idx), pass: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

function requireAdminAuth(req, res, next) {
  const cfg = readConfig();
  const expectedPass = (process.env.ADMIN_PASSWORD || cfg.adminPassword || '').toString();

  const creds = parseBasicAuth(req);
  const ok = creds && creds.pass === expectedPass;

  if (!ok) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Auth required');
  }
  next();
}

app.use((req, res, next) => {
  if (req.path === '/admin.html' || req.path.startsWith('/admin/')) {
    return requireAdminAuth(req, res, next);
  }
  next();
});

/* ---------------------------
   PIN-Auth für Ticker-Seite
---------------------------- */

function requireTickerPin(req, res, next) {
  const cfg = readConfig();
  const expectedPin = (process.env.TICKER_PIN || cfg.tickerPin || '').toString();
  const got = (req.header('X-Ticker-Pin') || '').toString();
  if (!expectedPin || got !== expectedPin) {
    return res.status(401).json({ ok: false, error: 'PIN falsch' });
  }
  next();
}

/* ---------------------------
   PDF Handling + Cache
---------------------------- */

function getPdfFilesFromConfig(side) {
  const cfg = readConfig();
  const configured = cfg.folders?.[side];
  if (!configured) throw new Error(`Kein Ordner für ${side} konfiguriert`);

  const folderPath = resolveFolderPath(configured);

  return new Promise((resolve, reject) => {
    fs.readdir(folderPath, (err, files) => {
      if (err) return reject(err);
      const pdfFiles = files.filter(file => path.extname(file).toLowerCase() === '.pdf');
      resolve({ folderPath, pdfFiles });
    });
  });
}

async function getPdfPageCount(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdfDocument = await getDocument({ data }).promise;
  return pdfDocument.numPages;
}

let pdfCache = { links: [], rechts: [], lastReload: null };

async function rebuildPdfCache() {
  for (const side of ['links', 'rechts']) {
    const { folderPath, pdfFiles } = await getPdfFilesFromConfig(side);

    const pdfInfoPromises = pdfFiles.map(async file => {
      const fullPath = path.join(folderPath, file);
      const numPages = await getPdfPageCount(fullPath);
      return { file, numPages };
    });

    pdfCache[side] = await Promise.all(pdfInfoPromises);
  }

  pdfCache.lastReload = new Date().toISOString();
  console.log(`[CACHE] PDFs neu eingelesen: ${pdfCache.lastReload}`);
}

/* ---------------------------
   Public API (Kiosk)
---------------------------- */

app.get('/getPdfs', (req, res) => {
  const folder = req.query.folder;
  if (!['links', 'rechts'].includes(folder)) {
    return res.status(400).json({ error: 'folder muss links oder rechts sein' });
  }
  res.json(pdfCache[folder] || []);
});

app.get('/pdf/:side/:file', (req, res) => {
  const { side, file } = req.params;
  if (!['links', 'rechts'].includes(side)) return res.status(400).send('invalid side');

  const cfg = readConfig();
  const configured = cfg.folders?.[side];
  const folderPath = resolveFolderPath(configured);

  const safeName = path.basename(file);
  const fullPath = path.join(folderPath, safeName);

  if (!fullPath.startsWith(folderPath)) return res.status(403).send('forbidden');
  if (!fs.existsSync(fullPath)) return res.status(404).send('not found');

  res.setHeader('Content-Type', 'application/pdf');
  fs.createReadStream(fullPath).pipe(res);
});

app.get('/kiosk/config', (req, res) => {
  const cfg = readConfig();
  const { adminPassword, tickerPin, ...safeCfg } = cfg;
  res.json(safeCfg);
});

app.get('/kiosk/ticker', (req, res) => {
  res.json(readTicker());
});

app.get('/kiosk/reload-status', (req, res) => {
  ensureDataFiles();
  res.json(JSON.parse(fs.readFileSync(RELOAD_FILE, 'utf-8')));
});

app.post('/kiosk/ack-reload', (req, res) => {
  ensureDataFiles();
  fs.writeFileSync(RELOAD_FILE, JSON.stringify({ reload: false }, null, 2), 'utf-8');
  res.json({ ok: true });
});

/* ---------------------------
   Simple Ticker Page (PIN)
---------------------------- */

app.get('/ticker', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ticker.html'));
});

// Lauftext setzen + Reload triggern (PIN-geschützt)
app.post('/ticker/set', requireTickerPin, (req, res) => {
  const text = (req.body?.text ?? '').toString();
  writeTicker(text);

  // NEU: Kiosk-Reload auslösen
  ensureDataFiles();
  fs.writeFileSync(RELOAD_FILE, JSON.stringify({ reload: true }, null, 2), 'utf-8');

  res.json({ ok: true, reloadTriggered: true });
});

/* ---------------------------
   Admin API (geschützt)
---------------------------- */

app.post('/admin/reload', async (req, res) => {
  try {
    await rebuildPdfCache();
    res.json({ ok: true, lastReload: pdfCache.lastReload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Fehler beim Neu-Einlesen' });
  }
});

app.get('/admin/ticker', (req, res) => {
  res.json(readTicker());
});

app.post('/admin/ticker', (req, res) => {
  const text = (req.body?.text ?? '').toString();
  writeTicker(text);
  res.json({ ok: true });
});

app.get('/admin/config', (req, res) => {
  const cfg = readConfig();
  const { adminPassword, tickerPin, ...safeCfg } = cfg;
  res.json(safeCfg);
});

app.post('/admin/config', async (req, res) => {
  try {
    const { flipIntervalSeconds, folders } = req.body ?? {};

    const sec = Number(flipIntervalSeconds);
    if (!Number.isFinite(sec) || sec < 1 || sec > 600) {
      return res.status(400).json({ ok: false, error: 'flipIntervalSeconds muss zwischen 1 und 600 liegen' });
    }

    const newLinks = (folders?.links ?? '').toString().trim();
    const newRechts = (folders?.rechts ?? '').toString().trim();
    if (!newLinks || !newRechts) {
      return res.status(400).json({ ok: false, error: 'Beide Ordner müssen gesetzt sein' });
    }

    const absLinks = resolveFolderPath(newLinks);
    const absRechts = resolveFolderPath(newRechts);

    if (!fs.existsSync(absLinks) || !fs.lstatSync(absLinks).isDirectory()) {
      return res.status(400).json({ ok: false, error: `Ordner links existiert nicht: ${absLinks}` });
    }
    if (!fs.existsSync(absRechts) || !fs.lstatSync(absRechts).isDirectory()) {
      return res.status(400).json({ ok: false, error: `Ordner rechts existiert nicht: ${absRechts}` });
    }

    const current = readConfig();
    const updated = {
      ...current,
      flipIntervalMs: Math.round(sec * 1000),
      folders: { links: newLinks, rechts: newRechts }
    };

    writeConfig(updated);
    await rebuildPdfCache();

    const { adminPassword, tickerPin, ...safeCfg } = updated;
    res.json({ ok: true, config: safeCfg, lastReload: pdfCache.lastReload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Fehler beim Speichern der Konfiguration' });
  }
});

app.post('/admin/trigger-reload', (req, res) => {
  ensureDataFiles();
  fs.writeFileSync(RELOAD_FILE, JSON.stringify({ reload: true }, null, 2), 'utf-8');
  res.json({ ok: true });
});

/* ---------------------------
   Boot
---------------------------- */

ensureDataFiles();
await rebuildPdfCache();
setInterval(() => rebuildPdfCache().catch(console.error), 120000);

app.listen(port, () => console.log(`Server läuft auf http://localhost:${port}`));
