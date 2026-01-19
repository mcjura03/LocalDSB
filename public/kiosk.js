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
  let lastW = -1, lastH = -1;
  for (let i = 0; i < tries; i++) {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0 && w === lastW && h === lastH) return;
    lastW = w; lastH = h;
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
    ctx && ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
  }
}

async function renderPdfPage(canvasId, side, pdfFile, pageNumber) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d", { alpha: true });
  const parent = canvas.parentElement;

  // 80% der Pane-Größe
  const cssW = parent.clientWidth * 0.8;
  const cssH = parent.clientHeight * 0.8;

  const loadingTask = pdfjsLib.getDocument(pdfUrl(side, pdfFile));
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNumber);

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
      jobs.push(
        renderPdfPage("leftCanvas", LEFT, leftPdfs[currentLeftPdfIndex].file, currentLeftPage)
      );
    } else {
      setNoPlan(LEFT, true);
    }

    // Rechts
    if (rightPdfs.length > 0) {
      setNoPlan(RIGHT, false);
      jobs.push(
        renderPdfPage("rightCanvas", RIGHT, rightPdfs[currentRightPdfIndex].file, currentRightPage)
      );
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

function flipPages() {
  // Links nur flippen, wenn etwas vorhanden
  if (leftPdfs.length > 0) {
    if (currentLeftPage < leftPdfs[currentLeftPdfIndex].numPages) {
      currentLeftPage++;
    } else {
      currentLeftPage = 1;
      currentLeftPdfIndex = (currentLeftPdfIndex + 1) % leftPdfs.length;
    }
  }

  // Rechts nur flippen, wenn etwas vorhanden
  if (rightPdfs.length > 0) {
    if (currentRightPage < rightPdfs[currentRightPdfIndex].numPages) {
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

async function refreshPdfLists() {
  leftPdfs = await fetchJson(`/getPdfs?folder=${LEFT}`);
  rightPdfs = await fetchJson(`/getPdfs?folder=${RIGHT}`);

  currentLeftPdfIndex = leftPdfs.length ? Math.min(currentLeftPdfIndex, leftPdfs.length - 1) : 0;
  currentRightPdfIndex = rightPdfs.length ? Math.min(currentRightPdfIndex, rightPdfs.length - 1) : 0;

  currentLeftPage = 1;
  currentRightPage = 1;
}

async function loadTicker() {
  try {
    const data = await fetchJson("/kiosk/ticker");
    document.getElementById("tickerText").textContent = data.text || "";
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
  const leftPane = document.getElementById("leftCanvas").parentElement;
  const rightPane = document.getElementById("rightCanvas").parentElement;

  await Promise.all([waitForNonZeroSize(leftPane), waitForNonZeroSize(rightPane)]);
  await Promise.all([waitForStableSize(leftPane), waitForStableSize(rightPane)]);

  await updatePdfViewers();
  await wait(250);
  await updatePdfViewers();
}

async function init() {
  // Reload polling immer aktiv
  setInterval(checkReload, 2000);

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
    setInterval(async () => {
      try {
        await refreshPdfLists();
        await updatePdfViewers();
      } catch (e) {
        console.error("PDF Refresh Fehler:", e);
      }
    }, 120000);

    setInterval(loadTicker, 120000);
    setInterval(applyConfig, 120000);

    // Resize stabil
    const leftPane = document.getElementById("leftCanvas").parentElement;
    const rightPane = document.getElementById("rightCanvas").parentElement;
    const ro = new ResizeObserver(() => updatePdfViewers());
    ro.observe(leftPane);
    ro.observe(rightPane);
  } catch (e) {
    console.error("Init Fehler:", e);
  }
}

init();
