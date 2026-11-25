// Bitbucket Cloud pull requests and builds, for repos whose origin is on bitbucket.org: the same shapes cc-status
// publishes for GitHub (shared "cc.github"), so the Board, Inbox, Jira and Tasks panels need no changes.
// Auth: an Atlassian API token with Bitbucket scopes (read:user, read:repository, read:pullrequest, read:pipeline),
// kept in the macOS Keychain under settings' bitbucket.keychain, with your Atlassian email as the account. It's read
// for each refresh, sent only to api.bitbucket.org, and never stored or published.
// No Herdr imports: run (exec-like: (cmd, args, opts) => { code, stdout, stderr }) and fetch are passed in.

const API = "https://api.bitbucket.org/2.0";
const FAILED = new Set(["FAILED", "STOPPED"]);

// { workspace, repo } for a bitbucket.org remote (ssh, ssh.bitbucket.org, or https with or without a user), else null.
export function bitbucketRemote(url) {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(?:ssh\.)?bitbucket\.org[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(String(url ?? "").trim());
  return m ? { workspace: m[1], repo: m[2] } : null;
}

// Base64 by hand: the mod runtime may have no btoa, Buffer or TextEncoder. Emails and API tokens are ASCII.
function base64(s) {
  const bytes = [...String(s)].map((c) => c.charCodeAt(0) & 255), abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + (i + 1 < bytes.length ? abc[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? abc[n & 63] : "=");
  }
  return out;
}

const query = (params) => Object.entries(params).flatMap(([k, v]) => [].concat(v).map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`)).join("&");

// A PR's checks, as ciState does for GitHub: { ci: none|pending|pass|fail, failed: [{ name, url }] }.
export function buildState(statuses) {
  if (!statuses?.length) return { ci: "none", failed: [] };
  const failed = statuses.filter((s) => FAILED.has(s.state)).map((s) => ({ name: s.name || s.key || "build", url: s.url || null }));
  const pending = statuses.some((s) => s.state === "INPROGRESS");
  return { ci: failed.length ? "fail" : pending ? "pending" : "pass", failed };
}

// GitHub's reviewDecision words, which the panels show: changes requested wins, then any approval.
export function reviewState(participants) {
  const reviewers = (participants ?? []).filter((p) => p.role === "REVIEWER" || p.approved || p.state);
  if (reviewers.some((p) => p.state === "changes_requested")) return "CHANGES_REQUESTED";
  if (reviewers.some((p) => p.approved || p.state === "approved")) return "APPROVED";
  return reviewers.length ? "REVIEW_REQUIRED" : "";
}

export function bitbucketClient({ run, fetch, keychain = "herdr-bitbucket" }) {
  let me = null;

  // The Keychain item's account (your email) and its secret. null: no item, so Bitbucket stays quiet.
  async function credentials() {
    const item = await run("/usr/bin/security", ["find-generic-password", "-s", keychain], { timeout: 5000 }).catch(() => null);
    if (item?.code !== 0) return null;
    const user = /"acct"<blob>="([^"]*)"/.exec(item.stdout)?.[1];
    const secret = await run("/usr/bin/security", ["find-generic-password", "-s", keychain, "-w"], { timeout: 5000 }).catch(() => null);
    const token = secret?.code === 0 ? secret.stdout.replace(/\n$/, "") : "";
    return user && token ? { user, token } : null;
  }

  async function get(auth, path, params = {}) {
    const qs = query(params);
    const res = await fetch(`${API}${path}${qs ? `?${qs}` : ""}`, { headers: { Authorization: `Basic ${base64(`${auth.user}:${auth.token}`)}`, Accept: "application/json" } });
    if (!res.ok) {
      const e = new Error(res.status === 401 ? "Bitbucket refused the token (401): check it in the Keychain"
        : res.status === 403 ? "the Bitbucket token is missing a scope (403)" : `Bitbucket answered ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  // Everything a refresh needs, with the token read once. null when there's no token.
  async function session() {
    const auth = await credentials();
    if (!auth) return null;
    me ??= await get(auth, "/user", { fields: "uuid,display_name,username" });
    const repoPath = (r) => `/repositories/${encodeURIComponent(r.workspace)}/${encodeURIComponent(r.repo)}`;
    return {
      me,
      // The open PR for a branch, with its build state and review decision; null when there's none.
      async pr(remote, branch) {
        const list = await get(auth, `${repoPath(remote)}/pullrequests`, {
          q: `source.branch.name="${branch.replace(/["\\]/g, "")}" AND state="OPEN"`,
          fields: "values.id,values.title,values.draft,values.links.html.href,values.source.commit.hash,values.participants.role,values.participants.approved,values.participants.state",
        });
        const p = list.values?.[0];
        if (!p) return null;
        const hash = p.source?.commit?.hash;
        const statuses = hash ? (await get(auth, `${repoPath(remote)}/commit/${hash}/statuses`, { pagelen: 100, fields: "values.key,values.name,values.state,values.url" })).values : [];
        return { number: p.id, title: p.title, url: p.links?.html?.href ?? "", draft: Boolean(p.draft), review: reviewState(p.participants), ...buildState(statuses) };
      },
      // Open PRs in a repo where you're a reviewer and haven't approved or asked for changes yet.
      async reviews(remote) {
        const list = await get(auth, `${repoPath(remote)}/pullrequests`, {
          q: `reviewers.uuid="${me.uuid}" AND state="OPEN"`, pagelen: 20,
          fields: "values.id,values.title,values.links.html.href,values.author.display_name,values.participants.user.uuid,values.participants.approved,values.participants.state",
        });
        return (list.values ?? [])
          .filter((p) => !(p.participants ?? []).some((x) => x.user?.uuid === me.uuid && (x.approved || x.state)))
          .map((p) => ({ number: p.id, title: p.title, url: p.links?.html?.href ?? "", repo: `${remote.workspace}/${remote.repo}`, author: p.author?.display_name ?? "" }));
      },
      // Your PRs in a repo updated between two times, for the standup: "repo #id title (state) url".
      async mine(remote, from, to) {
        const list = await get(auth, `${repoPath(remote)}/pullrequests`, {
          q: `author.uuid="${me.uuid}" AND updated_on >= ${new Date(from).toISOString()} AND updated_on <= ${new Date(to).toISOString()}`,
          state: ["OPEN", "MERGED", "DECLINED"], pagelen: 30, fields: "values.id,values.title,values.state,values.draft,values.links.html.href",
        });
        return (list.values ?? []).map((p) => `${remote.repo} #${p.id} ${p.title} (${p.draft ? "draft" : p.state.toLowerCase()}) ${p.links?.html?.href ?? ""}`);
      },
    };
  }

  return { session };
}
