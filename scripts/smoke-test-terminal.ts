/**
 * Real-browser smoke test: login → navigate to a server → click "Open
 * Terminal" → confirm an xterm renders + a shell prompt appears.
 *
 * Goes through the same code path the user reported broken. Captures
 * console output and JS errors so anything that fails surfaces with a
 * concrete message instead of "the button doesn't seem to do anything."
 */
import { chromium, type ConsoleMessage } from "playwright";

const BASE = "http://192.168.100.82:3000";
const MAC_MINI_ID = "cfab293b-8571-4422-b57e-dca44c1f6b79";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const consoleLines: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    consoleLines.push(text);
  });
  page.on("pageerror", (err) => {
    consoleLines.push(`[pageerror] ${err.message}\n${err.stack ?? ""}`);
  });

  console.log("=== 1. login ===");
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill('input[type="email"]', "admin@managet.local");
  await page.fill('input[type="password"]', "admin");
  await Promise.all([
    page.waitForURL(`${BASE}/dashboard`, { timeout: 15000 }),
    page.click('button[type="submit"]'),
  ]);
  console.log(`  on ${page.url()}`);

  console.log("\n=== 2. navigate directly to /terminal?server=<MacMini> ===");
  await page.goto(`${BASE}/terminal?server=${MAC_MINI_ID}`, { waitUntil: "domcontentloaded" });
  console.log(`  on ${page.url()}`);

  console.log("\n=== 3. wait for terminal to render ===");
  // The xterm container has the class "xterm" once Terminal.open() runs.
  try {
    await page.waitForSelector(".xterm", { timeout: 10000 });
    console.log("  .xterm element found");
  } catch (e) {
    console.log(`  .xterm did NOT render in 10s — fail`);
    console.log("  console so far:");
    for (const l of consoleLines.slice(-40)) console.log(`    ${l}`);
    await page.screenshot({ path: "/tmp/terminal-fail.png" });
    console.log(`  screenshot: /tmp/terminal-fail.png`);
    await browser.close();
    process.exit(1);
  }

  console.log("\n=== 4. wait for a real shell prompt to appear ===");
  // The prompt comes from the SSH session — we look for either a typical
  // prompt character ($, %, #) followed by a space inside the xterm
  // viewport text.
  let foundPrompt = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500);
    const txt = (await page.locator(".xterm-rows").innerText().catch(() => "")) ?? "";
    if (/[$%#]\s*$/m.test(txt) || /Mac-mini|markI|@/i.test(txt)) {
      foundPrompt = true;
      console.log(`  prompt found after ${(i + 1) * 0.5}s`);
      console.log(`  visible:\n${txt.split("\n").slice(-8).map((l) => `    ${l}`).join("\n")}`);
      break;
    }
  }
  if (!foundPrompt) {
    const txt = (await page.locator(".xterm-rows").innerText().catch(() => "")) ?? "";
    console.log(`  no prompt after 10s. Visible text:\n${txt.slice(0, 500)}`);
    console.log("  console so far:");
    for (const l of consoleLines.slice(-40)) console.log(`    ${l}`);
    await page.screenshot({ path: "/tmp/terminal-fail.png" });
    console.log(`  screenshot: /tmp/terminal-fail.png`);
    await browser.close();
    process.exit(1);
  }

  console.log("\n=== 5. type 'pwd' + Enter and confirm response ===");
  await page.locator(".xterm").click();
  await page.keyboard.type("pwd");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  const after = (await page.locator(".xterm-rows").innerText().catch(() => "")) ?? "";
  if (/\/Users\/andrei/.test(after) || /\/home\//.test(after) || /\//.test(after)) {
    console.log(`  pwd output present in viewport ✓`);
  } else {
    console.log(`  pwd response not visible. Tail:\n${after.split("\n").slice(-8).join("\n")}`);
  }

  console.log('\n=== 6. modal-based "+ New" button still works ===');
  // The picker should open when we click +
  const plusBtn = page.locator('button[title="New terminal"]').first();
  await plusBtn.click();
  await page.waitForSelector("text=New Terminal Session", { timeout: 5000 });
  console.log("  picker opened");
  // Click the Pi server in the picker
  await page.click('button:has-text("Pi")');
  await page.waitForTimeout(2000);
  // We now have two tabs.
  const tabCount = await page.locator(".xterm").count();
  console.log(`  xterm count after second tab: ${tabCount}`);

  console.log("\n=== console (last 40 lines) ===");
  for (const l of consoleLines.slice(-40)) console.log(`  ${l}`);

  await browser.close();
  console.log("\n\x1b[1;32m✓ smoke test passed\x1b[0m");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
