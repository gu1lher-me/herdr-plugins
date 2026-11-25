// API tokens kept in the macOS Keychain: a generic-password item whose account is your Atlassian email and whose
// secret is the token. Read when needed, never stored or published. No Herdr imports: run (exec-like:
// (cmd, args, opts) => { code, stdout, stderr }) is passed in.

// { user, token } from the item named service, or null when there's none.
export async function readKeychain(run, service) {
  const item = await run("/usr/bin/security", ["find-generic-password", "-s", service], { timeout: 5000 }).catch(() => null);
  if (item?.code !== 0) return null;
  const user = /"acct"<blob>="([^"]*)"/.exec(item.stdout)?.[1];
  const secret = await run("/usr/bin/security", ["find-generic-password", "-s", service, "-w"], { timeout: 5000 }).catch(() => null);
  const token = secret?.code === 0 ? secret.stdout.replace(/\n$/, "") : "";
  return user && token ? { user, token } : null;
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

export const basicAuth = ({ user, token }) => `Basic ${base64(`${user}:${token}`)}`;

export const query = (params) => Object.entries(params ?? {})
  .flatMap(([k, v]) => [].concat(v).map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(x)}`)).join("&");
