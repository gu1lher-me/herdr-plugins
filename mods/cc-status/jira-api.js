// Jira Cloud's REST API with an API token: free, and no Claude run. Used whenever settings' jira.keychain names a
// Keychain item (an Atlassian API token with scopes, app Jira: read:jira-work, write:jira-work for Move to In
// Progress, read:jira-user; your Atlassian email as the account) and jira.site is set; otherwise cc-status falls back
// to the Atlassian connector (jira.js). Tokens with scopes only work through api.atlassian.com/ex/jira/<cloud id>,
// and the cloud id comes from the site's public tenant_info. The token is read per use and sent only to
// api.atlassian.com. No Herdr imports: run and fetch are passed in, so this can be tested with plain Node.

import { readKeychain, basicAuth, query } from "./keychain.js";
import { toIssue, DEFAULT_JQL } from "./jira.js";
import { adfToMarkdown } from "./adf.js";

const LIST_FIELDS = "summary,status,priority,issuetype,description,project";
const MAX_PAGES = 4;

export function jiraApiClient({ run, fetch, keychain = "herdr-jira" }) {
  const clouds = {};
  let me = null, meFor = null;

  async function cloudOf(site) {
    if (!clouds[site]) {
      const res = await fetch(`https://${site}/_edge/tenant_info`);
      if (!res.ok) throw new Error(`couldn't find the Jira site ${site} (${res.status})`);
      clouds[site] = (await res.json()).cloudId;
    }
    return clouds[site];
  }

  // Everything one fetch, move or read needs, with the token read once. null: no token or no site, so the
  // connector does it instead.
  async function session(site) {
    if (!site) return null;
    const auth = await readKeychain(run, keychain);
    if (!auth) return null;
    const base = `https://api.atlassian.com/ex/jira/${await cloudOf(site)}/rest/api/3`;
    async function call(method, path, params, body) {
      const qs = query(params);
      const res = await fetch(`${base}${path}${qs ? `?${qs}` : ""}`, {
        method, headers: { Authorization: basicAuth(auth), Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        let detail = "";
        try { const e = await res.json(); detail = [...(e.errorMessages ?? []), ...Object.values(e.errors ?? {})].join("; "); } catch { /* no body */ }
        throw new Error(res.status === 401 ? "Jira refused the token (401): check it in the Keychain"
          : res.status === 403 ? `the Jira token is missing a scope (403)${detail ? `: ${detail}` : ""}`
          : `Jira answered ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      return res.status === 204 ? null : res.json();
    }
    if (meFor !== site) { me = await call("GET", "/myself", { fields: "accountId,displayName" }); meFor = site; }
    const browse = (key) => `https://${site}/browse/${key}`;

    // Issues for a JQL query, up to MAX_PAGES pages of 100, in the shape every cc-* mod reads.
    async function search(jql, fields = LIST_FIELDS) {
      const nodes = [];
      let token = null, last = true;
      for (let page = 0; page < MAX_PAGES; page++) {
        const d = await call("GET", "/search/jql", { jql, fields, maxResults: 100, ...(token ? { nextPageToken: token } : {}) });
        nodes.push(...(d.issues ?? []));
        token = d.nextPageToken;
        last = d.isLast !== false && !token;
        if (last) break;
      }
      return { nodes, partial: !last };
    }

    return {
      me,
      async issues(jql) {
        const { nodes, partial } = await search(jql || DEFAULT_JQL);
        const issues = nodes.map((n) => toIssue({ key: n.key, webUrl: browse(n.key), fields: { ...n.fields, description: adfToMarkdown(n.fields?.description) } }, site));
        return { issues, site, partial };
      },
      // The whole issue for Start from issue: { description, comments: [{ author: { name }, createdAt, body }], partial }.
      async issue(key) {
        const d = await call("GET", `/issue/${encodeURIComponent(key)}`, { fields: "summary,description,comment" });
        const thread = d.fields?.comment ?? {};
        const comments = (thread.comments ?? [])
          .map((c) => ({ author: { name: c.author?.displayName }, createdAt: c.created, body: adfToMarkdown(c.body) }))
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        return { description: adfToMarkdown(d.fields?.description), comments, partial: Number(thread.total ?? 0) > comments.length };
      },
      // The transition to the status named In Progress, else the first one into the In Progress category.
      async moveToStarted(key) {
        const { transitions = [] } = await call("GET", `/issue/${encodeURIComponent(key)}/transitions`);
        const pick = transitions.find((t) => /^in progress$/i.test(t.to?.name ?? t.name ?? ""))
          ?? transitions.find((t) => t.to?.statusCategory?.key === "indeterminate");
        if (!pick) return { ok: false, said: `${key} has no transition to In Progress` };
        await call("POST", `/issue/${encodeURIComponent(key)}/transitions`, {}, { transition: { id: pick.id } });
        return { ok: true, said: `${key} is now ${pick.to?.name ?? "In Progress"}` };
      },
      // The standup's Jira facts: one line per issue the JQL finds, with your own comments from the window.
      async dayWork(jql, from, to) {
        const { nodes } = await search(jql, "summary,status,comment");
        return nodes.map((n) => {
          const f = n.fields ?? {};
          const mine = (f.comment?.comments ?? []).filter((c) => c.author?.accountId === me?.accountId && Date.parse(c.created) >= from && Date.parse(c.created) <= to)
            .map((c) => adfToMarkdown(c.body).replace(/\s+/g, " ").slice(0, 300));
          return `${n.key} ${f.summary ?? ""} (now ${f.status?.name ?? "?"})${mine.length ? `; my comments that day: ${mine.join(" / ")}` : ""}`;
        });
      },
    };
  }

  return { session };
}
