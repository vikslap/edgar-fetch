#!/usr/bin/env node
/* Sends one Telegram message after every workflow run: ✅ with the numbers, or ❌ with the failed step.
   Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, BUILD, DEPLOY (step outcomes), RUN_URL, TRIGGER, SITE_URL */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const env = process.env;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let L = {};
try { L = JSON.parse(fs.readFileSync(path.join(ROOT, "state/build_log.json"), "utf8")); } catch {}
const n = (v) => (v == null ? "?" : Number(v).toLocaleString("en-US"));
const day = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : "unknown");
const why = env.TRIGGER === "push" ? " (after a code update)" : env.TRIGGER === "workflow_dispatch" ? " (run by hand)" : "";
const ok = env.BUILD === "success" && env.DEPLOY === "success";
const DQ_NAMES = { op_income: "op. income", bs_balance: "balance sheet", eps: "EPS", net_profit: "net profit", shares: "share count" };
function dqLines(d) {
  const p = Object.entries(d.pctOk || {}).filter(([, v]) => v != null).map(([k, v]) => `${DQ_NAMES[k] || k} ${v}%`).join(" · ");
  let t = p ? `\nData checks passing: ${p}` : "";
  if (d.topGap && d.topGap.length) t += `\nMost common unmapped tags: ${d.topGap.map(([k, [tag, n]]) => `${tag} (${k}, ${n} cos)`).join("; ")}`;
  const ts = d.test || {};
  if (ts.mismatches && ts.mismatches.length) t += `\n❗ Test set vs 10-K: ${ts.mismatches.slice(0, 4).join("; ")}${ts.mismatches.length > 4 ? ` (+${ts.mismatches.length - 4} more)` : ""}`;
  else t += `\nTest set: ${20 - (ts.notBuilt || 0)}/20 companies built, hand-checked 10-K figures match`;
  if (ts.changes || ts.statusChanges) t += ` · ${ts.changes} value(s) changed since last run${ts.statusChanges ? `, ${ts.statusChanges} check status change(s)` : ""} (see state/data_quality.json)`;
  return t;
}
let text;
if (ok) {
  const warn = [];
  if (L.listed && L.rows < L.listed * 0.8) warn.push(`only ${n(L.rows)} of ${n(L.listed)} companies built`);
  if (L.rows && L.prices < L.rows * 0.8) warn.push(`prices for only ${n(L.prices)} stocks`);
  if (L.rows && L.history < L.rows * 0.5) warn.push(`price history for only ${n(L.history)} stocks (Yahoo refusing?): golden-cross fields incomplete`);
  if (L.rows && L.factsSnaps < L.rows * 0.9) warn.push(`saved copies for only ${n(L.factsSnaps)} companies`);
  if (L.factsSnaps && L.companySnaps < L.factsSnaps * 0.9) warn.push(`filings lists for only ${n(L.companySnaps)} companies`);
  text = `${warn.length ? "⚠️" : "✅"} <b>EDGAR Fetch updated</b>${why}\n` +
    `Data built ${day(L.built)} IST · ${n(L.minutes)} min\n` +
    `Companies: ${n(L.rows)} of ${n(L.listed)} listed · prices ${n(L.prices)} · history ${n(L.history)}\n` +
    `Saved copies: ${n(L.factsSnaps)} financials, ${n(L.companySnaps)} filings lists` +
    (L.dq ? dqLines(L.dq) : "") +
    (warn.length ? `\n\n<b>Check:</b> ${warn.join("; ")}` : "");
} else {
  const step = env.BUILD !== "success" ? "building the data" : "deploying to Cloudflare";
  text = `❌ <b>EDGAR Fetch update FAILED</b>${why} while ${step}.\n` +
    `The site still shows the previous data (built ${day(L.built)} IST).\n` +
    `<a href="${env.RUN_URL}">Open the run log</a>, or rerun it from Actions → Nightly screener build.`;
}
if (env.SITE_URL) text += `\n${env.SITE_URL}`;
if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { console.log(text); process.exit(0); }
const r = await fetch(`${env.TELEGRAM_API || "https://api.telegram.org"}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
});
console.log(r.ok ? "Sent." : `Telegram error ${r.status}: ${await r.text()}`);
