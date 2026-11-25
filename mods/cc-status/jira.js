// Jira through the claude.ai Atlassian connector, in a headless claude run: on settings' schedule (jira.everyMin,
// jira.hours), or when asked (cc.jira.request). The model only calls the search tool; the issues are read from that
// tool's own result in the run's stream-json output, so the panels show Jira's data rather than the model's retelling,
// and text inside an issue can't change the list. No Herdr imports here, so it can be tested with plain Node.

// The claude.ai connector's name. Its tools are mcp__claude_ai_<name>__*; reconnecting the connector (say, from its
// deprecated v1 endpoint to v2) can change the name, so it lives here and nowhere else.
export const JIRA_CONNECTOR = "Atlassian";
const T = `mcp__claude_ai_${JIRA_CONNECTOR.replace(/\W/g, "_")}__`;
export const jiraTool = (name) => `${T}${name}`;

export const JIRA_TIMEOUT = 240_000;
export const JIRA_READ = ["ToolSearch", `${T}searchJiraIssuesUsingJql`, `${T}getAccessibleAtlassianResources`];
export const JIRA_WRITE = ["ToolSearch", `${T}getTransitionsForJiraIssue`, `${T}transitionJiraIssue`, `${T}getAccessibleAtlassianResources`];
export const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC";
const FIELDS = ["summary", "status", "priority", "issuetype", "description", "project", "updated"];
const MAX_PAGES = 4;

// "Site" is the Jira host (you.atlassian.net). Empty: the run finds it, and cc-status saves what it found.
export const siteStep = (site) => site
  ? `Use cloudId "${site}".`
  : `First load getAccessibleAtlassianResources with ToolSearch too, call it, and use the url host of the site whose scopes include read:jira-work as cloudId.`;

export function searchPrompt({ site, jql }) {
  return `You run one headless Jira fetch. Nobody reads your reply except a program.
Load the Jira search tool with ToolSearch first (query "jira search jql"). ${siteStep(site)}
Call searchJiraIssuesUsingJql with jql ${JSON.stringify(jql || DEFAULT_JQL)}, fields ${JSON.stringify(FIELDS)}, maxResults 100 and responseContentFormat "markdown".
While the result's pageInfo.hasNextPage is true, call it again with nextPageToken set to pageInfo.endCursor, at most ${MAX_PAGES} calls in all.
Read only: never create, change, transition or comment on anything. Don't summarize the issues.
Then reply with exactly one line: "done"; or "not connected" when no Jira tools are available or they say I need to sign in; or "error: " and one short reason.`;
}

export function movePrompt({ site, identifier }) {
  return `Move Jira issue ${identifier} to In Progress. Load the Jira transition tools with ToolSearch first. ${siteStep(site)}
Get the issue's transitions. Pick the one whose target status is named "In Progress"; if there is none, the first whose target status category is In Progress (key "indeterminate"). Apply it with transitionJiraIssue, setting no fields.
Change nothing else: no comments, no fields, no other issue. If no transition fits, change nothing and say so. Reply with one short sentence.`;
}

// The named tool's results in a stream-json run: how many calls succeeded, those that were JSON (parsed), and the
// run's final result line. A call counts as failed when flagged is_error or when its text says it failed.
export function toolResults(stdout, tool) {
  const names = new Map(), results = [];
  let ok = 0, final = null;
  for (const line of String(stdout ?? "").split("\n")) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type === "result") final = o;
    for (const c of Array.isArray(o?.message?.content) ? o.message.content : []) {
      if (c?.type === "tool_use") names.set(c.id, c.name);
      if (c?.type !== "tool_result" || c.is_error || !String(names.get(c.tool_use_id) ?? "").endsWith(`__${tool}`)) continue;
      const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((x) => x?.text ?? "").join("");
      let data = null;
      try { data = JSON.parse(text); } catch { /* not JSON: an empty success or a message */ }
      if (data?.error || data?.errorMessages?.length || /^\s*(error|failed)\b/i.test(data === null ? text : "")) continue;
      ok++;
      if (data !== null) results.push(data);
    }
  }
  return { ok, results, final };
}

// Jira's priority as the panels rank it: 1 highest to 4 lowest, 0 none. Names vary by site ("3. Medium"), so words first.
function priorityRank(p) {
  const name = String(p?.name ?? "").toLowerCase();
  if (/highest|blocker|critical|urgent/.test(name)) return 1;
  if (/high|major/.test(name)) return 2;
  if (/medium|normal/.test(name)) return 3;
  if (/low|minor|trivial/.test(name)) return 4;
  const n = Number(/^\s*p?(\d)/.exec(name)?.[1] ?? p?.id);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 4) : 0;
}

// One issue in the shape every cc-* mod reads (the one the Linear version used): stateType is backlog, unstarted
// or started, from Jira's status category, with a status named like "Backlog" kept apart so it can be told from Todo.
export function toIssue(node, site) {
  const f = node?.fields ?? {};
  const state = String(f.status?.name ?? "");
  const category = f.status?.statusCategory?.key;
  return {
    identifier: String(node.key),
    title: String(f.summary ?? ""),
    state,
    stateType: /backlog/i.test(state) ? "backlog" : category === "indeterminate" ? "started" : category === "done" ? "completed" : "unstarted",
    priority: priorityRank(f.priority),
    url: node.webUrl || (site ? `https://${site}/browse/${node.key}` : ""),
    description: String(f.description ?? "").slice(0, 600),
    project: String(f.project?.name ?? ""),
    type: String(f.issuetype?.name ?? ""),
  };
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return ""; } };

// A search run's outcome: { issues, site } on success, { notConnected: true }, or { error }.
export function readSearch(stdout, stderr = "") {
  const { results, final } = toolResults(stdout, "searchJiraIssuesUsingJql");
  const pages = results.map((r) => r?.issues).filter((p) => Array.isArray(p?.nodes));
  const said = String(final?.result ?? "").trim();
  if (pages.length) {
    const nodes = pages.flatMap((p) => p.nodes).filter((n) => n?.key);
    const site = hostOf(nodes[0]?.webUrl ?? pages[0].webUrl ?? "");
    const seen = new Map();
    for (const n of nodes) if (!seen.has(n.key)) seen.set(n.key, toIssue(n, site));
    const partial = Boolean(pages.at(-1).pageInfo?.hasNextPage);
    return { issues: [...seen.values()], site, partial, cost: final?.total_cost_usd ?? null };
  }
  if (/^not connected/i.test(said)) return { notConnected: true };
  // "done" with no usable search result means the tool failed and the model didn't say so.
  const reason = (/^done\.?$/i.test(said) ? "" : said.replace(/^error:\s*/i, "")) || String(stderr).trim()
    || (final ? "the Jira search returned no usable result" : "no result from claude");
  return { error: reason.split("\n")[0].slice(0, 160) };
}

// A move run succeeded when transitionJiraIssue answered without an error; the model's reply is only the reason.
export function readMove(stdout) {
  const { ok, final } = toolResults(stdout, "transitionJiraIssue");
  return { ok: ok > 0, said: String(final?.result ?? "").trim() };
}
