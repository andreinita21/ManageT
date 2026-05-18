/**
 * End-to-end smoke test for the terminal regression fixes.
 *
 * Tests against the production build via the Cloudflare tunnel. Verifies:
 *   1. Login works
 *   2. Terminal opens without WebSocket error / xterm crash
 *   3. Shell runs as `andrei`, not root
 *   4. Output appears without pressing Enter
 *   5. Scrollback persists after closing and reopening the page
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "https://managet.andreinita.com";
const EMAIL = process.env.TEST_EMAIL || "andrei@test.com";
const PASSWORD = process.env.TEST_PASSWORD || "2006";

async function dump(page, label) {
  const errors = await page.evaluate(() => {
    return window.__capturedErrors || [];
  });
  console.log(`[${label}] errors captured:`, errors);
}

async function login(page) {
  console.log(`[step] navigate ${BASE}/login`);
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL(/\/dashboard/, { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  console.log("[step] logged in → dashboard");
}

async function findServer(page, namePattern) {
  // Wait for the dashboard's server list to render, then click the first
  // server whose name matches the pattern.
  await page.waitForSelector("a, button", { timeout: 15000 });
  const link = page.locator(`text=${namePattern}`).first();
  await link.waitFor({ state: "visible", timeout: 15000 });
  return link;
}

async function readTerminalText(page) {
  // Read the entire xterm buffer (scrollback + visible) via the xterm
  // API rather than DOM, which only shows the visible viewport.
  return await page.evaluate(() => {
    // xterm instance is held in a closure; grab it off the canvas's
    // dataset if exposed, otherwise scrape the DOM as a fallback.
    const canvases = document.querySelectorAll(".xterm");
    for (const el of canvases) {
      // @ts-ignore — xterm puts itself on the element for debug.
      const term = el._xtermTerminal || el.xterm;
      if (term && term.buffer && term.buffer.active) {
        const buf = term.buffer.active;
        const lines = [];
        for (let i = 0; i < buf.length; i++) {
          const ln = buf.getLine(i);
          if (ln) lines.push(ln.translateToString());
        }
        return lines.join("\n");
      }
    }
    const rows = document.querySelectorAll(".xterm-rows > div");
    return Array.from(rows).map((r) => r.textContent).join("\n");
  });
}

async function countWsMessages(page) {
  // Returns the count of terminal:output messages received via WS.
  return await page.evaluate(() => window.__wsOutputCount || 0);
}

async function openTerminalFromServer(page, serverName) {
  console.log(`[step] open server ${serverName}`);
  const serverLink = await findServer(page, serverName);
  await serverLink.click();
  await page.waitForLoadState("networkidle");
  console.log(`[step] looking for "Open Terminal" button`);
  const openBtn = page.locator('button:has-text("Open Terminal"), a:has-text("Open Terminal")').first();
  await openBtn.waitFor({ state: "visible", timeout: 15000 });
  await openBtn.click();
  // Terminal page lives at /terminal?server=<id>
  await page.waitForURL(/\/terminal/, { timeout: 15000 });
  console.log(`[step] terminal page loaded`);
}

async function waitForPrompt(page, maxMs = 15000) {
  // The shell should write a prompt within a few seconds of attach.
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const text = await readTerminalText(page);
    if (text && (text.match(/[$%#~>]\s*$/m) || text.match(/@[\w.-]+/))) return text;
    await page.waitForTimeout(500);
  }
  return null;
}

async function typeAndCapture(page, cmd, settleMs = 1500) {
  // xterm is a canvas/dom hybrid — Playwright .type() into the focused
  // .xterm goes through to the WS.
  await page.locator(".xterm").click();
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(settleMs);
  return await readTerminalText(page);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });

  // Capture console errors so we can surface xterm crashes etc.
  const consoleErrors = [];
  context.on("page", (p) => {
    p.on("pageerror", (err) => consoleErrors.push({ kind: "pageerror", msg: err.message }));
    p.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push({ kind: "console.error", msg: m.text() });
    });
  });

  const page = await context.newPage();
  page.on("pageerror", (err) => consoleErrors.push({ kind: "pageerror", msg: err.message }));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push({ kind: "console.error", msg: m.text() });
  });

  let result = { passed: [], failed: [] };

  try {
    await login(page);
    result.passed.push("login");

    // Open a terminal — pick Mac mini specifically since the user said
    // that's the most-broken host.
    await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });
    await openTerminalFromServer(page, /Mac mini|markI|Pi/i);
    result.passed.push("open terminal page");

    // Wait for prompt to appear without us pressing Enter.
    const initialText = await waitForPrompt(page, 20000);
    if (initialText) {
      console.log("[ok] prompt appeared. Text snapshot:\n" + initialText.split("\n").slice(0, 10).join("\n"));
      result.passed.push("prompt-renders-without-Enter");
    } else {
      result.failed.push("prompt-never-appeared");
    }

    // Type whoami — should print "andrei" not "root"
    const whoamiText = await typeAndCapture(page, "whoami", 2000);
    if (whoamiText.match(/\bandrei\b/) && !whoamiText.match(/\broot\b/)) {
      result.passed.push("whoami=andrei");
    } else {
      result.failed.push("whoami output: " + whoamiText.split("\n").slice(-5).join(" | "));
    }

    // Run seq 1 50 — should produce 50 lines of output
    const seqText = await typeAndCapture(page, "seq 1 50", 3000);
    const has50 = seqText.includes("50") && seqText.includes("1");
    if (has50) result.passed.push("seq-output-visible");
    else result.failed.push("seq output missing");

    // ----- the big one: close the page, reopen, verify scrollback -----
    // Find the session id this page is bound to by querying the API.
    // Then reopen via /terminal?session=<id> which is the *attach* path
    // (not create-new). The serverId is in the current URL.
    const serverIdMatch = page.url().match(/server=([0-9a-f-]+)/);
    let attachUrl = page.url();
    if (serverIdMatch) {
      const serverId = serverIdMatch[1];
      const sessions = await page.evaluate(async (sid) => {
        const res = await fetch(`/api/sessions?serverId=${sid}`);
        if (!res.ok) return null;
        const j = await res.json();
        return j.data ?? j;
      }, serverId);
      const active = (Array.isArray(sessions) ? sessions : []).filter(
        (s) => s.status === "active"
      );
      // Pick the most-recently-updated active session.
      active.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      if (active.length > 0) {
        attachUrl = `${BASE}/terminal?session=${active[0].id}`;
        console.log(`[step] resolved session id ${active[0].id} for server ${serverId}`);
      } else {
        console.log("[step] no active sessions found via API — falling back to server url");
      }
    }
    console.log("[step] will reopen via " + attachUrl);

    // Close cleanly; ignore tear-down errors.
    try { await page.close({ runBeforeUnload: false }); } catch {}
    await new Promise((r) => setTimeout(r, 2500));

    const page2 = await context.newPage();
    page2.on("pageerror", (err) => consoleErrors.push({ kind: "pageerror.reopen", msg: err.message }));
    page2.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push({ kind: "console.error.reopen", msg: m.text() });
    });
    // Instrument WS on page2 so we can count terminal:output messages
    // AND capture every send/receive for diagnosis.
    await page2.addInitScript(() => {
      window.__wsOutputCount = 0;
      window.__wsOutputBytes = 0;
      window.__wsLog = [];
      const OrigWS = window.WebSocket;
      window.WebSocket = function (...args) {
        const ws = new OrigWS(...args);
        window.__wsLog.push({ kind: "open", url: args[0] });
        ws.addEventListener("message", (e) => {
          try {
            const m = JSON.parse(e.data);
            window.__wsLog.push({ kind: "recv", type: m.type, preview: JSON.stringify(m).slice(0, 200) });
            if (m.type === "terminal:output") {
              window.__wsOutputCount++;
              window.__wsOutputBytes += (m.data || "").length;
            }
          } catch {}
        });
        const origSend = ws.send.bind(ws);
        ws.send = function (data) {
          try {
            const p = typeof data === "string" ? JSON.parse(data) : null;
            if (p) window.__wsLog.push({ kind: "send", type: p.type, preview: JSON.stringify(p).slice(0, 200) });
          } catch {}
          return origSend(data);
        };
        return ws;
      };
      Object.setPrototypeOf(window.WebSocket, OrigWS);
      window.WebSocket.prototype = OrigWS.prototype;
    });
    await page2.goto(attachUrl, { waitUntil: "networkidle" });
    await page2.waitForTimeout(8000); // give attach + replay + xterm parse time
    const wsCount = await countWsMessages(page2);
    const wsBytes = await page2.evaluate(() => window.__wsOutputBytes || 0);
    const wsLog = await page2.evaluate(() => window.__wsLog || []);
    console.log(`[reopened] WS terminal:output messages=${wsCount} bytes=${wsBytes}`);
    console.log(`[reopened] WS log (${wsLog.length} entries):`);
    wsLog.forEach((e) => console.log(`  ${e.kind} ${e.type ?? ''}: ${e.preview ?? e.url ?? ''}`));
    const replayText = await readTerminalText(page2);
    console.log("[reopened] terminal text:\n" + replayText.split("\n").slice(0, 30).join("\n"));

    const hasReplayedSeq = replayText.includes("50") && replayText.match(/whoami/);
    if (hasReplayedSeq) {
      result.passed.push("scrollback-survived-page-close");
    } else {
      result.failed.push("scrollback-lost-on-page-reopen — no 'seq' or 'whoami' visible after close+reopen");
    }
  } catch (e) {
    result.failed.push("test crashed: " + (e && e.message) || String(e));
  }

  console.log("\n========== RESULT ==========");
  console.log("PASS:", JSON.stringify(result.passed, null, 2));
  console.log("FAIL:", JSON.stringify(result.failed, null, 2));
  console.log("BROWSER ERRORS (" + consoleErrors.length + "):");
  consoleErrors.slice(0, 30).forEach((e) => console.log(`  [${e.kind}] ${e.msg}`));

  await browser.close();
  process.exit(result.failed.length > 0 ? 1 : 0);
})();
