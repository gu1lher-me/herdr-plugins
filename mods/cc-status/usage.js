// Plan usage for Claude Code and Codex, as Bettr reads it, plus Claude's extra-usage credits when they're on.
// Claude: the usage endpoint /usage uses, with Claude Code's own login from the macOS Keychain. The token is
// only read, never refreshed (refreshing would sign Claude Code out) and never stored.
// Codex: the limits Codex saves in its newest session log.

import { exec, home } from "herdr";

export const USAGE_EVERY = 3 * 60_000;
const MAX_WAIT = 15 * 60_000;

const label = (minutes) => ({ 300: "5-hour", 10080: "Weekly" })[minutes] ?? (minutes ? `${Math.round(minutes / 60)}h` : "Limit");
const clamp = (n) => Math.max(0, Math.min(100, Number(n)));
const ms = (v) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : v ? Date.parse(v) : null);

async function claudeToken() {
  const r = await exec("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5000 });
  if (r.code !== 0) throw new Error("Claude Code login not found in the Keychain");
  const oauth = JSON.parse(r.stdout).claudeAiOauth ?? {};
  if (!oauth.accessToken || (oauth.expiresAt ?? 0) <= Date.now()) throw new Error("Claude Code login has expired; open Claude Code to renew it");
  return oauth.accessToken;
}

// Extra usage: a plan's pay-as-you-go credits, used after its limits. A bar only when it's on and has a monthly
// limit; otherwise (no such plan, switched off, no limit, odd numbers) null, and the view is as before. Only the two
// amounts, the currency and whether the limit is reached are kept; nothing else from the response.
const SYMBOL = { USD: "$", EUR: "€", GBP: "£", BRL: "R$", CAD: "CA$", AUD: "A$", JPY: "¥", INR: "₹" };
function money(minor, exponent, currency) {
  const digits = Number.isInteger(exponent) && exponent >= 0 && exponent <= 4 ? exponent : 2;
  const [whole, cents] = (Number(minor) / 10 ** digits).toFixed(digits).split(".");
  const amount = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (cents ? `.${cents}` : "");
  const code = String(currency ?? "").toUpperCase();
  return SYMBOL[code] ? `${SYMBOL[code]}${amount}` : `${amount}${code ? ` ${code}` : ""}`;
}

export function extraUsage(u) {
  const e = u?.extra_usage, s = u?.spend;
  if (!e && !s) return null;
  if (e && (e.is_enabled === false || e.user_disabled === true)) return null;
  if (s && s.enabled === false) return null;
  let used, limit, exponent, currency;
  if (Number.isFinite(Number(s?.used?.amount_minor)) && Number.isFinite(Number(s?.limit?.amount_minor))) {
    used = Number(s.used.amount_minor); limit = Number(s.limit.amount_minor);
    exponent = s.used.exponent ?? s.limit.exponent ?? 2; currency = s.used.currency ?? s.limit.currency;
  } else if (e?.is_enabled === true && Number.isFinite(Number(e.used_credits)) && Number.isFinite(Number(e.monthly_limit))) {
    used = Number(e.used_credits); limit = Number(e.monthly_limit); exponent = e.decimal_places ?? 2; currency = e.currency;
  } else return null;
  if (!(limit > 0) || used < 0) return null;
  const reached = e?.spend_limit_reached === true || used >= limit;
  return {
    label: "Extra usage", used: clamp((used / limit) * 100), resetsAt: null, alert: reached,
    detail: reached ? `Limit reached: ${money(used, exponent, currency)} of ${money(limit, exponent, currency)}`
      : `${money(used, exponent, currency)} of ${money(limit, exponent, currency)} monthly limit`,
  };
}

// extra: also the Extra usage bar (settings usage.extra), when the plan has it on.
export async function claudeUsage({ extra = true } = {}) {
  const token = await claudeToken();
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "herdr-command-center" },
  });
  if (!res.ok) {
    const e = new Error(`usage endpoint answered ${res.status}`);
    e.retryAfter = Number(res.headers?.get?.("retry-after")) || 0;
    throw e;
  }
  const u = await res.json();
  const windows = [["5-hour", u.five_hour], ["Weekly", u.seven_day]]
    .filter(([, w]) => w && Number.isFinite(Number(w.utilization)))
    .map(([name, w]) => ({ label: name, used: clamp(w.utilization), resetsAt: ms(w.resets_at) }));
  const credits = extra ? extraUsage(u) : null;
  return credits ? [...windows, credits] : windows;
}

// The newest rate-limit record in the newest Codex session of the past week; null when there's none.
export async function codexUsage() {
  const dir = `${home()}/.codex/sessions`;
  const script = 'f=$(find "$1" -name "*.jsonl" -type f -mtime -8 -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -1); [ -n "$f" ] && tail -c 4000000 "$f" | grep \'"rate_limits"\' | tail -1';
  const r = await exec("sh", ["-c", script, "sh", dir], { timeout: 10_000 }).catch(() => null);
  const line = r?.stdout.trim();
  if (!line) return null;
  const limits = JSON.parse(line).payload?.rate_limits;
  if (!limits) return null;
  return [limits.primary, limits.secondary].filter(Boolean)
    .map((w) => ({ label: label(w.window_minutes), used: clamp(w.used_percent), resetsAt: ms(w.resets_at) }));
}

// Next Claude request after a failure: 3, 6, 12, then 15 minutes, or longer if the server asks.
export const backoff = (failures, retryAfter = 0) => Math.max(Math.min(USAGE_EVERY * 2 ** Math.max(failures - 1, 0), MAX_WAIT), Math.min(retryAfter, 3600) * 1000);
