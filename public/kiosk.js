import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

const LEFT = "links";
const RIGHT = "rechts";

let leftPdfs = [];
let rightPdfs = [];

let currentLeftPdfIndex = 0;
let currentRightPdfIndex = 0;
let currentLeftPage = 1;
let currentRightPage = 1;

let flipTimer = null;
let renderInProgress = false;
let pendingRender = false;

// Interval/Observer Handles (für sauberes Cleanup)
let reloadInterval = null;
let refreshInterval = null;
let tickerInterval = null;
let configInterval = null;
let resizeObserver = null;

// -------------------- PDF.js Cache (FIX gegen Memory-Wachstum) --------------------
/**
 * Cache pro PDF-URL, damit getDocument() nicht ständig neue Dokumente lädt
 * und interne Caches/Objekte ansammeln.
 */
const pdfDocCache = new Map(); // url -> { loadingTask, pdf }

/** @param {string} url */
async function getPdfDocument(url) {
  const cached = pdfDocCache.get(url);
  if (cached?.pdf) return cached.pdf;

  const loadingTask = pdfjsLib.getDocument(url);
  const pdf = await loadingTask.promise;

  pdfDocCache.set(url, { loadingTask, pdf });
  return pdf;
}

/** @param {string} url */
async function destroyPdfDocument(url) {
  const entry = pdfDocCache.get(url);
  if (!entry) return;

  try {
    // pdf.destroy() gibt Speicher frei (wichtig!)
    if (entry.pdf?.destroy) await entry.pdf.destroy();
    // loadingTask.destroy() kann laufendes Laden abbrechen
    if (entry.loadingTask?.destroy) entry.loadingTask.destroy();
  } catch (e) {
    console.warn("PDF destroy failed:", url, e);
  } finally {
    pdfDocCache.delete(url);
  }
}

/** @param {string[]} keepUrls */
async function prunePdfCache(keepUrls) {
  const keep = new Set(keepUrls);
  const toDrop = [];
  for (const url of pdfDocCache.keys()) {
    if (!keep.has(url)) toDrop.push(url);
  }
  await Promise.all(toDrop.map(destroyPdfDocument));
}

async function destroyAllPdfs() {
  const urls = Array.from(pdfDocCache.keys());
  await Promise.all(urls.map(destroyPdfDocument));
}

// -------------------- Utilities --------------------
function pdfUrl(side, file) {
  return `/pdf/${side}/${encodeURIComponent(file)}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} failed (${res.status})`);
  return await res.json();
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForNonZeroSize(el) {
  return new Promise((resolve) => {
    const check = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) return resolve();
      requestAnimationFrame(check);
    };
    check();
  });
}

async function waitForStableSize(el, tries = 60) {
  let lastW = -1,
    lastH = -1;
  for (let i = 0; i < tries; i++) {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0 && w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    await new Promise((r) => requestAnimationFrame(r));
  }
}

function setNoPlan(side, visible) {
  const el = document.getElementById(side === LEFT ? "leftNoPlan" : "rightNoPlan");
  const canvas = document.getElementById(side === LEFT ? "leftCanvas" : "rightCanvas");
  if (!el || !canvas) return;

  el.style.display = visible ? "flex" : "none";
  canvas.style.display = visible ? "none" : "block";

  if (visible) {
    // Canvas leeren, damit kein altes Bild stehen bleibt
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
  }
}

// -------------------- Rendering --------------------
async function renderPdfPage(canvasId, side, pdfFile, pageNumber) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  const parent = canvas.parentElement;
  if (!parent) return;

  // 80% der Pane-Größe
  const cssW = parent.clientWidth * 0.8;
  const cssH = parent.clientHeight * 0.8;

  if (cssW <= 0 || cssH <= 0) return;

  const url = pdfUrl(side, pdfFile);

  // FIX: Dokument cachen statt jedes Mal neu laden
  const pdf = await getPdfDocument(url);

  // Falls numPages sich geändert hat oder pageNumber ungültig ist:
  const safePageNumber = Math.max(1, Math.min(pageNumber, pdf.numPages));

  const page = await pdf.getPage(safePageNumber);

  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(cssW / baseViewport.width, cssH / baseViewport.height);
  const viewport = page.getViewport({ scale });

  const dpr = window.devicePixelRatio || 1;

  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport }).promise;

  // FIX: Seite aufräumen (reduziert RAM-Wachstum)
  if (typeof page.cleanup === "function") page.cleanup();

  // Optional: Dokument-Caches in pdf.js freigeben (kann CPU kosten, aber hilft bei Langläufern)
  if (typeof pdf.cleanup === "function") pdf.cleanup();
}

async function updatePdfViewers() {
  // Render lock
  if (renderInProgress) {
    pendingRender = true;
    return;
  }
  renderInProgress = true;

  try {
    const jobs = [];

    // Links
    if (leftPdfs.length > 0) {
      setNoPlan(LEFT, false);
      const left = leftPdfs[currentLeftPdfIndex];
      if (left?.file) {
        const page = Math.max(1, Math.min(currentLeftPage, left.numPages || currentLeftPage));
        jobs.push(renderPdfPage("leftCanvas", LEFT, left.file, page));
      }
    } else {
      setNoPlan(LEFT, true);
    }

    // Rechts
    if (rightPdfs.length > 0) {
      setNoPlan(RIGHT, false);
      const right = rightPdfs[currentRightPdfIndex];
      if (right?.file) {
        const page = Math.max(1, Math.min(currentRightPage, right.numPages || currentRightPage));
        jobs.push(renderPdfPage("rightCanvas", RIGHT, right.file, page));
      }
    } else {
      setNoPlan(RIGHT, true);
    }

    await Promise.all(jobs);
  } catch (e) {
    console.error("Render Fehler:", e);
  } finally {
    renderInProgress = false;
    if (pendingRender) {
      pendingRender = false;
      setTimeout(() => updatePdfViewers(), 0);
    }
  }
}

// -------------------- Flip --------------------
function flipPages() {
  // Links nur flippen, wenn etwas vorhanden
  if (leftPdfs.length > 0) {
    const cur = leftPdfs[currentLeftPdfIndex];
    const numPages = cur?.numPages || 1;

    if (currentLeftPage < numPages) {
      currentLeftPage++;
    } else {
      currentLeftPage = 1;
      currentLeftPdfIndex = (currentLeftPdfIndex + 1) % leftPdfs.length;
    }
  }

  // Rechts nur flippen, wenn etwas vorhanden
  if (rightPdfs.length > 0) {
    const cur = rightPdfs[currentRightPdfIndex];
    const numPages = cur?.numPages || 1;

    if (currentRightPage < numPages) {
      currentRightPage++;
    } else {
      currentRightPage = 1;
      currentRightPdfIndex = (currentRightPdfIndex + 1) % rightPdfs.length;
    }
  }

  updatePdfViewers();
}

function startFlipTimer(intervalMs) {
  if (flipTimer) clearInterval(flipTimer);
  flipTimer = setInterval(flipPages, intervalMs);
}

// -------------------- Data refresh --------------------
async function refreshPdfLists() {
  leftPdfs = await fetchJson(`/getPdfs?folder=${LEFT}`);
  rightPdfs = await fetchJson(`/getPdfs?folder=${RIGHT}`);

  currentLeftPdfIndex = leftPdfs.length ? Math.min(currentLeftPdfIndex, leftPdfs.length - 1) : 0;
  currentRightPdfIndex = rightPdfs.length ? Math.min(currentRightPdfIndex, rightPdfs.length - 1) : 0;

  currentLeftPage = 1;
  currentRightPage = 1;

  // FIX: Cache pruning (PDFs entfernen, die nicht mehr existieren / nicht mehr gelistet sind)
  const keepUrls = [
    ...leftPdfs.map((p) => pdfUrl(LEFT, p.file)),
    ...rightPdfs.map((p) => pdfUrl(RIGHT, p.file)),
  ];
  await prunePdfCache(keepUrls);
}

async function loadTicker() {
  try {
    const data = await fetchJson("/kiosk/ticker");
    const el = document.getElementById("tickerText");
    if (el) el.textContent = data.text || "";
  } catch (e) {
    console.error("Ticker konnte nicht geladen werden", e);
  }
}

async function applyConfig() {
  try {
    const cfg = await fetchJson("/kiosk/config");
    startFlipTimer(cfg.flipIntervalMs || 10000);
  } catch (e) {
    console.error("Config konnte nicht geladen werden", e);
    startFlipTimer(10000);
  }
}

async function checkReload() {
  try {
    const data = await fetchJson("/kiosk/reload-status");
    if (data.reload === true) {
      await fetch("/kiosk/ack-reload", { method: "POST" });
      window.location.reload();
    }
  } catch {
    // ruhig bleiben
  }
}

async function stableFirstRender() {
  const leftCanvas = document.getElementById("leftCanvas");
  const rightCanvas = document.getElementById("rightCanvas");
  if (!leftCanvas || !rightCanvas) return;

  const leftPane = leftCanvas.parentElement;
  const rightPane = rightCanvas.parentElement;
  if (!leftPane || !rightPane) return;

  await Promise.all([waitForNonZeroSize(leftPane), waitForNonZeroSize(rightPane)]);
  await Promise.all([waitForStableSize(leftPane), waitForStableSize(rightPane)]);

  await updatePdfViewers();
  await wait(250);
  await updatePdfViewers();
}

// -------------------- ResizeObserver Debounce (optional, reduziert Render-Sturm) --------------------
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function cleanupTimersAndObservers() {
  if (flipTimer) clearInterval(flipTimer);

  if (reloadInterval) clearInterval(reloadInterval);
  if (refreshInterval) clearInterval(refreshInterval);
  if (tickerInterval) clearInterval(tickerInterval);
  if (configInterval) clearInterval(configInterval);

  if (resizeObserver) {
    try {
      resizeObserver.disconnect();
    } catch {}
    resizeObserver = null;
  }
}

// -------------------- Init --------------------
async function init() {
  // Reload polling immer aktiv
  reloadInterval = setInterval(checkReload, 2000);

  try {
    await refreshPdfLists();
    await loadTicker();
    await applyConfig();

    await stableFirstRender();

    window.addEventListener("load", async () => {
      await wait(50);
      await stableFirstRender();
    });

    // Updates
    refreshInterval = setInterval(async () => {
      try {
        await refreshPdfLists();
        await updatePdfViewers();
      } catch (e) {
        console.error("PDF Refresh Fehler:", e);
      }
    }, 120000);

    tickerInterval = setInterval(loadTicker, 120000);
    configInterval = setInterval(applyConfig, 120000);

    // Resize stabil (mit debounce, damit es nicht spammt)
    const leftCanvas = document.getElementById("leftCanvas");
    const rightCanvas = document.getElementById("rightCanvas");
    if (leftCanvas?.parentElement && rightCanvas?.parentElement) {
      const debouncedUpdate = debounce(() => updatePdfViewers(), 100);
      resizeObserver = new ResizeObserver(debouncedUpdate);
      resizeObserver.observe(leftCanvas.parentElement);
      resizeObserver.observe(rightCanvas.parentElement);
    }

    // Wichtig: Cleanup bei Unload/Reload (hilft gegen Leaks bei Soft-Navigation)
    window.addEventListener("beforeunload", () => {
      cleanupTimersAndObservers();
      // best-effort: cache freigeben
      // (beforeunload kann async abbrechen, aber schadet nicht)
      destroyAllPdfs();
    });
  } catch (e) {
    console.error("Init Fehler:", e);
  }
}

init();
