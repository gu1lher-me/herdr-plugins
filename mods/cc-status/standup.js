// Standup draft ("What did you accomplish?"): local facts (commits, PRs, task summaries) gathered here,
// Jira and your own Slack messages read by one headless Sonnet run, which writes the text.

import { exec, readTextFile, shared, home, appHome } from "herdr";
import { jiraTool, siteStep } from "./jira.js";

export const STANDUP_TIMEOUT = 420_000;
export const STANDUP_TOOLS = [
  "ToolSearch",
  jiraTool("searchJiraIssuesUsingJql"), jiraTool("getJiraIssue"), jiraTool("getAccessibleAtlassianResources"),
  "mcp__claude_ai_Slack__slack_search_public_and_private", "mcp__claude_ai_Slack__slack_read_thread", "mcp__claude_ai_Slack__slack_read_user_profile",
];

const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;

// The day's Jira work: issues of mine updated that day, and any whose status I changed. (Jira Cloud has no
// "commented by" in plain JQL; the run reads comments from these.) Checked against Jira Cloud's JQL parser.
export function standupJql(win) {
  const from = win.date, to = ymd(new Date(win.to + 1));
  return `(assignee = currentUser() AND updated >= "${from}" AND updated < "${to}") OR status CHANGED BY currentUser() DURING ("${from}", "${to}")`;
}
export const STANDUP_SCHEMA = JSON.stringify({ type: "object", required: ["text", "error"], properties: { text: { type: "string" }, error: { type: "string" } } });

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Before the cut-over hour (default 18:00): the previous working day (Friday on Monday). From it: today.
export function windowFor(now = new Date(), cutover = 18) {
  const d = new Date(now);
  if (d.getHours() < cutover) {
    d.setDate(d.getDate() - 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  }
  const from = new Date(d); from.setHours(0, 0, 0, 0);
  const to = new Date(d); to.setHours(23, 59, 59, 999);
  return { key: ymd(d), date: ymd(d), label: DAY[d.getDay()], from: from.getTime(), to: to.getTime() };
}

// The latest scheduled time at or before now, in this Mac's time zone: { id: "2026-11-11@23", at }.
// hours: settings' standup.times; weekdaysOnly skips Saturday and Sunday.
export function standupSlot(now = new Date(), hours = [23], weekdaysOnly = true) {
  for (let back = 0; back < 4; back++) {
    const d = new Date(now);
    d.setDate(d.getDate() - back);
    if (weekdaysOnly && (d.getDay() === 0 || d.getDay() === 6)) continue;
    for (const h of [...hours].sort((a, b) => b - a)) {
      d.setHours(h, 0, 0, 0);
      if (d <= now) return { id: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}@${h}`, at: d.getTime() };
    }
  }
  return null;
}

async function repos() {
  const roots = shared("cc.settings")?.roots ?? [];
  const found = new Set();
  for (const dir of [...roots, `${home()}/.herdr/worktrees`]) {
    const r = await exec("find", [dir, "-maxdepth", "3", "-name", ".git", "-not", "-path", "*/node_modules/*"], { timeout: 15_000 }).catch(() => null);
    for (const line of (r?.stdout ?? "").split("\n").filter(Boolean)) found.add(line.replace(/\/\.git$/, ""));
  }
  return [...found];
}

// Commits, PRs and task summaries from the window, as plain lines for the prompt.
export async function gatherLocal(win) {
  const since = new Date(win.from).toISOString(), until = new Date(win.to).toISOString();
  const commits = [], tasks = [];
  const seen = new Set();
  for (const repo of await repos()) {
    const email = (await exec("git", ["config", "user.email"], { cwd: repo }).catch(() => null))?.stdout.trim();
    if (email) {
      const r = await exec("git", ["log", "--all", `--author=${email}`, `--since=${since}`, `--until=${until}`, "--no-merges", "--pretty=%h %s", "-n", "25"], { cwd: repo, timeout: 15_000 }).catch(() => null);
      for (const line of (r?.stdout ?? "").split("\n").filter(Boolean)) {
        const subject = line.slice(line.indexOf(" ") + 1);
        if (!seen.has(`${repo}|${subject}`)) { seen.add(`${repo}|${subject}`); commits.push(`${repo.split("/").pop()}: ${subject}`); }
      }
    }
    const list = await exec("find", [`${repo}/.agents/tasks/.summary`, "-name", "*.json", "-newermt", since], { timeout: 10_000 }).catch(() => null);
    for (const file of (list?.stdout ?? "").split("\n").filter(Boolean)) {
      let s = null;
      try { s = JSON.parse(await readTextFile(file)); } catch { continue; }
      if (!s?.updatedAt || s.updatedAt < win.from || s.updatedAt > win.to + 6 * 3600_000) continue;
      const done = (s.steps ?? []).filter((x) => x.state === "done").map((x) => x.text).slice(0, 5);
      tasks.push(`${s.title}: ${s.goal}${done.length ? ` Done: ${done.join("; ")}` : ""}${s.notDone?.length ? ` Open: ${s.notDone.slice(0, 2).join("; ")}` : ""}`);
    }
  }
  const prs = [];
  const r = await exec("gh", ["search", "prs", "--author=@me", `--updated=${win.date}..${win.date}`, "--json", "number,title,url,repository,state,isDraft", "--limit", "30"], { timeout: 20_000 }).catch(() => null);
  try {
    for (const p of JSON.parse(r?.stdout || "[]")) prs.push(`${p.repository?.name ?? ""} #${p.number} ${p.title} (${p.isDraft ? "draft" : p.state.toLowerCase()}) ${p.url}`);
  } catch { /* gh missing or not logged in: the draft goes without PRs */ }
  // Slack asks closed that day: ticked by you, or resolved because you replied. Skipped ones aren't in the log.
  let slack = [];
  try {
    const state = JSON.parse(await readTextFile(`${appHome()}/data/cc-slack/state.json`) ?? "{}");
    slack = (state.handled ?? []).filter((h) => h.at >= win.from && h.at <= win.to)
      .map((h) => `${h.from} (${h.channel}) asked: "${h.text}" (${h.by === "sweep" ? "I replied in Slack" : "I marked it done"})`);
  } catch { /* no Slack state yet */ }
  return { commits: commits.slice(0, 80), prs, tasks: tasks.slice(0, 20), slack: slack.slice(0, 20) };
}

// jira: settings' jira, with the site the last fetch found when settings has none. Off: the run skips Jira.
export function standupPrompt(win, local, jira = {}) {
  const list = (title, xs) => `${title}:\n${xs.length ? xs.map((x) => `- ${x}`).join("\n") : "(none)"}`;
  const jiraStep = jira.enabled === false ? "1. Jira: skip it." : `1. Jira: ${siteStep(jira.site)} Call searchJiraIssuesUsingJql with jql ${JSON.stringify(standupJql(win))}, fields ["summary","status","comment"] and responseContentFormat "markdown". Use what I moved and what I commented that day. Read only.`;
  return `Write my standup answer to "What did you accomplish?" for ${win.label}, ${win.date}. Nobody reads a chat; your answer is the JSON.
Load the Jira and Slack tools with ToolSearch, then:
${jiraStep}
2. Slack: messages I sent in that window (from:me), for work that didn't leave a commit: reviews, debugging help, decisions. Read only.

What I did locally that day:
${list("Commits", local.commits)}

${list("Pull requests I opened or updated", local.prs)}

${list("Agent task summaries", local.tasks)}

${list("Slack asks I handled", local.slack)}

Write 3 to 7 bullets, one line each, outcome first, grouped by ticket or project where it helps. Name Jira keys and PR numbers.
Merge the agent summaries with the commits instead of repeating them. Skip trivia (formatting, typo fixes, merges).
A Slack ask earns a bullet only when it was real work (a review, a fix, a decision, an unblock); fold it into the matching
project bullet when there is one, and leave out acknowledgements and quick answers.
Plain, direct sentences: no filler, no "successfully", no hype. If something is blocked, end with one line starting "Blocked:".
text: just the bullets, each starting with "- ".
Never post, comment or change anything. If the tools fail, still write from the local facts and put one short reason in error.`;
}

// The draft as bullets you can edit, remove, reorder and ask about; text is what Copy puts on the clipboard.
let seq = 0;
const newId = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;
export const toBullets = (text) => (text ?? "").split("\n")
  .map((l) => l.replace(/^\s*[-*•]\s+/, "").trim()).filter(Boolean).map((t) => ({ id: newId(), text: t }));
export const toText = (bullets) => (bullets ?? []).map((b) => `- ${b.text}`).join("\n");

// Keeps the last 10 versions for Undo.
export function remember(state) {
  state.history = [...(state.history ?? []), (state.bullets ?? []).map((b) => ({ ...b }))].slice(-10);
}

export function applyEdit(state, a) {
  if (a.op === "undo") {
    const prev = state.history?.pop();
    if (prev) state.bullets = prev;
    return;
  }
  remember(state);
  const b = state.bullets ?? [];
  const i = b.findIndex((x) => x.id === a.id);
  if (a.op === "set" && i >= 0) { if (a.text.trim()) b[i].text = a.text.trim(); else b.splice(i, 1); }
  if (a.op === "remove" && i >= 0) b.splice(i, 1);
  if (a.op === "add" && a.text?.trim()) b.push({ id: newId(), text: a.text.trim() });
  if (a.op === "move") {
    const to = b.findIndex((x) => x.id === a.to);
    if (i >= 0 && to >= 0 && i !== to) b.splice(to, 0, ...b.splice(i, 1));
  }
  state.bullets = b;
  state.edited = true;
}

export const ASK_SCHEMA = JSON.stringify({ type: "object", required: ["bullets"], properties: { bullets: { type: "array", items: { type: "string" } } } });

// One bullet (id) or the whole draft, changed as asked; returns bullets without leading dashes.
export function askPrompt(state, instruction, id) {
  const list = (state.bullets ?? []).map((b, n) => `${n + 1}. ${b.text}`).join("\n");
  const n = (state.bullets ?? []).findIndex((b) => b.id === id);
  const style = "One line each, outcome first, plain direct sentences, no filler or hype. Keep Jira keys and PR numbers.";
  return n >= 0
    ? `My standup draft for ${state.label} ("What did you accomplish?"):\n${list}\n\nChange only bullet ${n + 1}: ${instruction}\n${style}\nReturn bullets: the new text for bullet ${n + 1} alone (two items if I asked to split it, none if I asked to drop it). No leading dash.`
    : `My standup draft for ${state.label} ("What did you accomplish?"):\n${list}\n\nChange it: ${instruction}\n${style}\nKeep bullets my request doesn't touch word for word, in their order. Return the whole list as bullets, no leading dash.`;
}

// Bullets after an ask: the whole list, or the asked bullet replaced by what came back.
export function applyAsk(state, id, out) {
  remember(state);
  const fresh = out.map((t) => ({ id: newId(), text: t.replace(/^\s*[-*•]\s+/, "").trim() })).filter((b) => b.text);
  const i = (state.bullets ?? []).findIndex((b) => b.id === id);
  if (id && i >= 0) state.bullets.splice(i, 1, ...fresh);
  else state.bullets = fresh;
  state.edited = true;
}
