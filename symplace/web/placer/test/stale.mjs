/** 옛 판이 캐시에 남은 채 새 판을 열어도 페이지가 사는가 — headless Chromium.
 *
 *  빌드 없는 정적 사이트의 함정: 브라우저는 보통 새로고침에서 index.html 만 다시 받고 부속 모듈(view.mjs 등)은
 *  캐시가 신선하면 그대로 쓴다 (휴리스틱 신선도 = 마지막 수정 뒤 지난 시간의 10%). 그래서 새 index.html 이
 *  옛 모듈과 섞여 뜰 수 있고, 새 모듈이 옛 모듈에 없는 이름을 import 하면 모듈 그래프 전체가 죽어 예제 목록까지
 *  빈다 (실제로 있었던 일 — draw.mjs 가 view.mjs 의 새 export 를 가져왔다).
 *
 *  옛 판(기본: origin/main, 없으면 HEAD~1)을 20 일 전 mtime 으로 두고 한 번 열어 캐시에 넣은 뒤, 파일을 작업
 *  트리의 새 판으로 바꾸고 보통 새로고침한다. 예제 목록이 그대로 떠야 한다.
 *
 *  실행:  node symplace/web/placer/test/stale.mjs [옛 판 git ref]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchChromium } from "./_browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const git = (cmd) => execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const refOk = (r) => { try { git(`rev-parse --verify --quiet ${r}`); return true; } catch { return false; } };
const oldRef = process.argv[2] ?? ["origin/main", "main", "HEAD~1"].find(refOk) ?? "HEAD";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"));
const site = path.join(tmp, "site");
fs.mkdirSync(site);
execSync(`git archive ${oldRef} | tar -x -C ${site}`, { cwd: ROOT });
execSync(`find ${site} -type f -exec touch -d '20 days ago' {} +`);
console.log(`옛 판 ${oldRef} (${git(`rev-parse --short ${oldRef}`)}) -> 새 판 (작업 트리)`);

const port = 8790 + Math.floor(Math.random() * 100);
const srv = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "-d", site], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await launchChromium({ gpu: false });
let fails = 0;
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const probe = async (tag, want) => {
    await page.waitForTimeout(1500);
    const n = await page.$$eval("#ex option", (o) => o.length);
    console.log(`  ${tag}: 예제 ${n} 개${errs.length ? " · 오류 " + errs.map((e) => e.slice(0, 120)).join(" | ") : ""}`);
    if (want && (!n || errs.length)) { fails++; console.log("  실패"); }
    errs.length = 0;
  };
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });
  await probe("옛 판", false);
  // 새 판으로 바꾼다 — 작업 트리의 파일 그대로 (git 이 무시하는 것은 빼고)
  fs.rmSync(site, { recursive: true, force: true });
  fs.mkdirSync(site);
  const files = git("ls-files --cached --others --exclude-standard").split("\n").filter(Boolean);
  for (const f of files) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(site, f)), { recursive: true });
    fs.copyFileSync(src, path.join(site, f));
  }
  await page.reload({ waitUntil: "networkidle" });
  await probe("새 판, 보통 새로고침 (옛 모듈이 캐시에)", true);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await page.reload({ waitUntil: "networkidle" });
  await probe("새 판, 캐시 비우고", true);
} finally {
  await browser.close();
  srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `\n실패 ${fails} 건` : "\n통과");
process.exit(fails ? 1 : 0);
