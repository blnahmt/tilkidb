import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConnUrl, unknownHostKey } from "./connUrl.ts";

test("unknown SSH host key errors are recognised, others are not", () => {
  assert.deepEqual(unknownHostKey("HOSTKEY_UNKNOWN|bastion.example.com:2222|SHA256:abc+/123"), { host: "bastion.example.com:2222", fingerprint: "SHA256:abc+/123" });
  assert.equal(unknownHostKey("SSH: the server rejected the password"), null);
});

test("postgres URL with user, password, port and database", () => {
  assert.deepEqual(parseConnUrl("postgres://app:s%40cret@db.internal:6432/crm"), {
    engine: "postgres", host: "db.internal", port: 6432, user: "app", password: "s@cret", database: "crm",
  });
});

test("mysql and mariadb get the MySQL engine and default port", () => {
  assert.deepEqual(parseConnUrl("mariadb://root@10.0.0.5/shop"), { engine: "mysql", host: "10.0.0.5", port: 3306, user: "root", database: "shop" });
});

test("postgresql:// without user or database", () => {
  assert.deepEqual(parseConnUrl("postgresql://localhost"), { engine: "postgres", host: "localhost", port: 5432 });
});

test("sqlite URL becomes a file path", () => {
  assert.deepEqual(parseConnUrl("sqlite://C:/data/app.sqlite"), { engine: "sqlite", file: "C:/data/app.sqlite" });
  assert.deepEqual(parseConnUrl("sqlite:///C:/data/app.sqlite"), { engine: "sqlite", file: "C:/data/app.sqlite" });
  assert.deepEqual(parseConnUrl("sqlite:///home/me/app.db"), { engine: "sqlite", file: "/home/me/app.db" });
});

test("anything else is not a connection URL", () => {
  assert.equal(parseConnUrl("https://example.com"), null);
  assert.equal(parseConnUrl("localhost:5432"), null);
});
