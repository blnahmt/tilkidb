/** The Rust side reports an untrusted SSH host as "HOSTKEY_UNKNOWN|host:port|SHA256:…" (tunnel.rs). */
export function unknownHostKey(err: string): { host: string; fingerprint: string } | null {
  const m = /^HOSTKEY_UNKNOWN\|(.+)\|(SHA256:\S+)$/.exec(err);
  return m && { host: m[1], fingerprint: m[2] };
}

// Parse a pasted connection URL (postgres://user:pass@host:5432/db) into form fields.
import type { ConnConfig, Engine } from "./api.ts";

export type UrlFields = Partial<Pick<ConnConfig, "engine" | "host" | "port" | "database" | "user" | "file">> & { password?: string };

const RE = /^(postgres(?:ql)?|mysql|mariadb):\/\/(?:([^:@/]+)(?::([^@]*))?@)?([^:/?]*)(?::(\d+))?(?:\/([^?]*))?/i;

export function parseConnUrl(url: string): UrlFields | null {
  const lite = /^sqlite:\/\/(.+)$/i.exec(url.trim());
  // everything after sqlite:// is the path; "sqlite:///C:/x" → "C:/x" (a drive letter isn't host:port)
  if (lite) return { engine: "sqlite", file: decodeURIComponent(lite[1]).replace(/^\/(?=[a-z]:)/i, "") };
  const m = RE.exec(url.trim());
  if (!m) return null;
  const [, scheme, user, password, host, port, db] = m;
  const engine: Engine = /^(my|maria)/i.test(scheme) ? "mysql" : "postgres";
  const out: UrlFields = { engine, host: host || "localhost", port: port ? Number(port) : engine === "mysql" ? 3306 : 5432 };
  if (user) out.user = decodeURIComponent(user);
  if (password !== undefined) out.password = decodeURIComponent(password);
  if (db) out.database = decodeURIComponent(db);
  return out;
}
