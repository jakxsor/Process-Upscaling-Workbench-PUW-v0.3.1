"use strict";

// Small "screen director" on top of Playwright: a visible cursor, a caption bar, a title card and
// a smooth camera (zoom + pan) that frames one element at a time. Everything it injects lives on
// <html>, outside <body>, so the camera transform on <body> never moves the overlays.

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const repoRoot = path.resolve(__dirname, "..", "..");
const VIEW = { width: 1920, height: 1080 };

const PAGE_CSS = `
html { overflow: hidden !important; background: #0d2b27; }
body { width: 100vw; height: 100vh; overflow: hidden !important; transform-origin: 0 0;
       transition: transform .8s cubic-bezier(.45,0,.2,1); will-change: transform; }
#dv-cursor { position: fixed; left: 0; top: 0; width: 34px; height: 34px; z-index: 2147483647; pointer-events: none;
             transition: transform .55s cubic-bezier(.45,0,.2,1); transform: translate(-100px,-100px);
             filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
.dv-ripple { position: fixed; z-index: 2147483646; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
             border: 3px solid #f59e0b; pointer-events: none; animation: dv-ripple .7s ease-out forwards; }
@keyframes dv-ripple { to { transform: scale(5); opacity: 0; } }
#dv-halo { position: fixed; z-index: 2147483644; pointer-events: none; border-radius: 10px; opacity: 0;
           box-shadow: 0 0 0 3px rgba(15,155,132,.9), 0 0 0 9999px rgba(10,34,31,.18); transition: opacity .5s; }
#dv-halo.on { opacity: 1; }
#dv-caption { position: fixed; left: 50%; bottom: 44px; z-index: 2147483645; pointer-events: none; max-width: 1500px;
              transform: translate(-50%, 20px); opacity: 0; transition: opacity .45s, transform .45s;
              background: rgba(10,34,31,.93); color: #fff; padding: 16px 30px; border-radius: 16px;
              font: 500 30px/1.3 Inter, -apple-system, "Segoe UI", sans-serif; text-align: center;
              box-shadow: 0 10px 34px rgba(0,0,0,.35); }
#dv-caption.on { opacity: 1; transform: translate(-50%, 0); }
#dv-caption b { color: #5eead4; font-weight: 700; }
#dv-caption .dv-step { display: inline-block; background: #0f9b84; color: #fff; border-radius: 999px; padding: 0 14px;
                       margin-right: 14px; font-size: 24px; font-weight: 700; vertical-align: 2px; }
#dv-title { position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; align-items: center;
            justify-content: center; gap: 22px; color: #fff; text-align: center; opacity: 0; transition: opacity .7s;
            background: radial-gradient(circle at 30% 20%, #14776a 0%, #0d2b27 70%); pointer-events: none;
            font-family: Inter, -apple-system, "Segoe UI", sans-serif; }
#dv-title.on { opacity: 1; }
#dv-title .dv-kicker { font-size: 26px; letter-spacing: .18em; text-transform: uppercase; color: #5eead4; font-weight: 600; }
#dv-title .dv-main { font-size: 74px; font-weight: 750; max-width: 1400px; line-height: 1.1; }
#dv-title .dv-sub { font-size: 32px; color: #c7ece6; max-width: 1200px; line-height: 1.35; }
`;

const CURSOR_SVG = `<svg viewBox="0 0 24 24" width="34" height="34"><path d="M3 2 L3 19 L7.6 14.8 L10.6 21.6 L13.4 20.4 L10.5 13.7 L16.8 13.4 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

function waitForServer(url, attempts = 60) {
  return new Promise((resolve, reject) => {
    const tryOnce = remaining => {
      http.get(url, res => { res.resume(); resolve(); }).on("error", () => {
        if (remaining <= 0) reject(new Error("server did not start"));
        else setTimeout(() => tryOnce(remaining - 1), 250);
      });
    };
    tryOnce(attempts);
  });
}

async function startServer() {
  const port = 8900 + Math.floor(Math.random() * 90);
  const server = spawn(process.env.PYTHON || "python3", ["start.py", "--no-browser", "--port", String(port)], { cwd: repoRoot, stdio: "ignore" });
  const url = `http://127.0.0.1:${port}/`;
  await waitForServer(url);
  return { server, url };
}

// Runs one scene: opens a fresh recorded browser context, hands a director to `scene`, saves the video.
async function recordScene(browser, baseUrl, outDir, name, scene) {
  const rawDir = path.join(outDir, ".raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const context = await browser.newContext({ viewport: VIEW, recordVideo: { dir: rawDir, size: VIEW } });
  const page = await context.newPage();
  const t0 = Date.now();
  page.on("pageerror", error => console.log(`  [page error] ${error.message}`));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.click("#confirmModalCancel");   // first-visit tutorial offer
  await page.addStyleTag({ content: PAGE_CSS });
  await page.evaluate(svg => {
    window.__cam = { s: 1, tx: 0, ty: 0 };
    const cursor = document.createElement("div");
    cursor.id = "dv-cursor"; cursor.innerHTML = svg;
    const caption = document.createElement("div"); caption.id = "dv-caption";
    const title = document.createElement("div"); title.id = "dv-title";
    const halo = document.createElement("div"); halo.id = "dv-halo";
    document.body.appendChild(halo);   // inside <body> so it scales with the page content
    document.documentElement.append(cursor, caption, title);
  }, CURSOR_SVG);

  const d = director(page);
  await scene(d, page);
  await page.waitForTimeout(800);
  const startAt = d.startedAt ? (d.startedAt - t0) / 1000 : 0;
  const video = page.video();
  await context.close();
  const raw = path.join(rawDir, `${name}.webm`);
  await video.saveAs(raw);
  const final = path.join(outDir, `${name}.webm`);
  await trim(raw, final, Math.max(0, startAt - 0.15));
  console.log(`saved ${final}`);
}

function trim(input, output, from) {
  const ffmpeg = process.env.FFMPEG || path.join(process.env.HOME, "Library/Caches/ms-playwright/ffmpeg-1011/ffmpeg-mac");
  return new Promise((resolve, reject) => {
    const args = ["-y", "-loglevel", "error", "-ss", String(from), "-i", input, "-c:v", "libvpx", "-b:v", "6M", "-crf", "8", "-an", output];
    const proc = spawn(ffmpeg, args, { stdio: "inherit" });
    proc.on("exit", code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

function director(page) {
  const d = { startedAt: 0 };
  const wait = ms => page.waitForTimeout(ms);
  const locate = sel => (typeof sel === "string" ? page.locator(sel).first() : sel);

  // Camera: frame the element (or {x,y,w,h} in screen coords) filling the screen, capped at `max` zoom.
  d.zoom = async (target, { max = 2.4, pad = 36, lift = 0.47, maxH = 0 } = {}) => {
    // A caption describes one shot: fade it before the camera moves so it never lingers over the next.
    await page.evaluate(() => document.getElementById("dv-caption").classList.remove("on"));
    // Focus changes and scrollIntoView() scroll the document even under overflow:hidden, which
    // would shift every later measurement; the camera is the only thing allowed to move the page.
    await page.evaluate(() => window.scrollTo(0, 0));
    const measure = () => page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, target);
    let rect = target;
    if (typeof target === "string") {
      // Re-renders and smooth scrolls move elements for a few hundred ms after a click: wait
      // until two consecutive measurements agree before framing.
      rect = await measure();
      for (let i = 0; rect && i < 12; i += 1) {
        await wait(150);
        const again = await measure();
        const same = again && Math.abs(again.x - rect.x) < 1 && Math.abs(again.y - rect.y) < 1 && Math.abs(again.w - rect.w) < 1 && Math.abs(again.h - rect.h) < 1;
        rect = again;
        if (same) break;
      }
    }
    if (!rect) { console.log(`  [warn] zoom target not found: ${target}`); return; }
    // A target taller than the screen is framed from its top edge, `maxH` pixels down.
    if (maxH && rect.h > maxH) rect.h = maxH;
    await page.evaluate(({ rect, max, pad, lift, W, H }) => {
      const cam = window.__cam;
      const n = { x: (rect.x - cam.tx) / cam.s, y: (rect.y - cam.ty) / cam.s, w: rect.w / cam.s, h: rect.h / cam.s };
      // Leave room for the caption bar at the bottom.
      const usableH = H - 140;
      const s = Math.max(1, Math.min(W / (n.w + 2 * pad), usableH / (n.h + 2 * pad), max));
      // Centre the target even when it sits at a page edge: the dark <html> background shows
      // through as a margin instead of the camera stopping short and leaving it off-centre.
      const tx = W / 2 - s * (n.x + n.w / 2);
      const ty = H * lift - s * (n.y + n.h / 2);
      window.__cam = { s, tx, ty };
      document.body.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
      // Soft halo around what is being framed.
      const halo = document.getElementById("dv-halo");
      halo.style.cssText = `left:${n.x - 6}px; top:${n.y - 6}px; width:${n.w + 12}px; height:${n.h + 12}px`;
      halo.classList.add("on");
    }, { rect, max, pad, lift, W: VIEW.width, H: VIEW.height });
    await wait(900);
  };
  d.unzoom = async () => {
    await page.evaluate(() => document.getElementById("dv-caption").classList.remove("on"));
    await page.evaluate(() => { window.__cam = { s: 1, tx: 0, ty: 0 }; document.body.style.transform = "translate(0px,0px) scale(1)"; document.getElementById("dv-halo").classList.remove("on"); });
    await wait(900);
  };

  d.title = async (kicker, main, sub = "", hold = 1800) => {
    if (!d.startedAt) d.startedAt = Date.now();
    await page.evaluate(({ kicker, main, sub }) => {
      const t = document.getElementById("dv-title");
      t.innerHTML = `<div class="dv-kicker">${kicker}</div><div class="dv-main">${main}</div>${sub ? `<div class="dv-sub">${sub}</div>` : ""}`;
      t.classList.add("on");
    }, { kicker, main, sub });
    await wait(hold);
    await page.evaluate(() => document.getElementById("dv-title").classList.remove("on"));
    await wait(800);
  };

  // Caption bar. `step` is an optional number shown as a badge; **word** becomes highlighted.
  d.say = async (text, { step = null, hold = 0 } = {}) => {
    if (!d.startedAt) d.startedAt = Date.now();
    await page.evaluate(({ text, step }) => {
      const c = document.getElementById("dv-caption");
      const html = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      c.innerHTML = (step ? `<span class="dv-step">${step}</span>` : "") + html;
      c.classList.add("on");
    }, { text, step });
    await wait(hold || Math.max(1800, text.length * 38));
  };
  d.mute = async () => { await page.evaluate(() => document.getElementById("dv-caption").classList.remove("on")); await wait(450); };

  d.wait = wait;
  d.eval = (fn, arg) => page.evaluate(fn, arg);

  // Glide the visible cursor to the centre of the element (or an offset inside it).
  d.pointAt = async (sel, { dx = 0.5, dy = 0.5 } = {}) => {
    const box = await locate(sel).boundingBox();
    if (!box) { console.log(`  [warn] pointAt target not found: ${sel}`); return null; }
    const x = box.x + box.width * dx;
    const y = box.y + box.height * dy;
    await page.evaluate(({ x, y }) => { document.getElementById("dv-cursor").style.transform = `translate(${x - 6}px, ${y - 4}px)`; }, { x, y });
    await wait(600);
    await page.mouse.move(x, y);
    return { x, y };
  };

  d.click = async (sel, opts = {}) => {
    const p = await d.pointAt(sel, opts);
    if (!p) return;
    await page.evaluate(({ x, y }) => {
      const r = document.createElement("div"); r.className = "dv-ripple"; r.style.left = `${x}px`; r.style.top = `${y}px`;
      document.documentElement.appendChild(r); setTimeout(() => r.remove(), 800);
    }, p);
    await wait(120);
    await page.mouse.down(); await page.mouse.up();
    await page.evaluate(() => window.scrollTo(0, 0));
    await wait(opts.after ?? 700);
  };

  // Confirm dialog (e.g. "Convert this block into its own task group?"): frame it and click OK.
  d.confirmOk = async () => {
    await d.zoom("#confirmModal .modal-panel, #confirmModal > *", { max: 2.2 });
    await d.click("#confirmModalOk", { after: 1500 });
    await d.unzoom();
  };

  d.page = page;
  return d;
}

async function main(scenes) {
  const wanted = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
  const outFlag = process.argv.find(arg => arg.startsWith("--out="));
  const outDir = path.resolve(outFlag ? outFlag.slice(6) : "tutorial_videos");
  fs.mkdirSync(outDir, { recursive: true });
  const selected = scenes.filter(scene => !wanted.length || wanted.some(w => scene.name.startsWith(w)));
  const { server, url } = await startServer();
  const browser = await chromium.launch();
  try {
    for (const scene of selected) {
      console.log(`recording ${scene.name}`);
      await recordScene(browser, url, outDir, scene.name, scene.run);
    }
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(path.join(outDir, ".raw"), { recursive: true, force: true });
  }
}

module.exports = { main, VIEW };
