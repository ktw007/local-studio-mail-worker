import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import worker, { type MailEnv } from "../index";
import { htmlMailText } from "../html-text";
import type { ForwardableEmailMessage } from "@cloudflare/workers-types";

test("HTML mail text decodes entities and keeps split codes without scripts, hidden text or URLs", () => {
  const result = htmlMailText('<html><head><style>.x{color:red}</style></head><body><p>你的 ChatGPT 临时验证码</p><div><span>&#49;23</span><b>456</b></div><script>987654</script><div hidden>111111</div><div style="display:none"><b>222222</b></div><img src="https://tracker.invalid/pixel"><a href="https://secret.invalid/token">帮助 &amp; 支持</a></body></html>');
  assert.match(result, /123456/);
  assert.match(result, /帮助 & 支持/);
  assert.doesNotMatch(result, /987654|111111|222222|tracker|secret|<|color:red/);
  assert.equal(htmlMailText('<p>'+"a".repeat(200000)+'</p>', 50).length <= 50, true);
});

test("mail service: authentication, isolation, MIME, duplicate delivery, lifecycle, retention and restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "studio-mail-"));
  const compiled = await build({
    entryPoints: ["index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const token = "test-only-service-token-1234567890123456";
  const options = {
    modules: true,
    script: compiled.outputFiles[0].text,
    compatibilityDate: "2026-07-01",
    d1Databases: { DB: "mail-test" },
    d1Persist: directory,
    bindings: { DOMAIN: "example.com", SERVICE_TOKEN: token },
  };
  let mf = new Miniflare(options);
  const request = async (
    route: string,
    method = "GET",
    input?: unknown,
    authorization = token,
  ) =>
    mf.dispatchFetch("https://mail.test" + route, {
      method,
      headers: { Authorization: `Bearer ${authorization}` },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
  try {
    let db = await mf.getD1Database("DB");
    const schema = await readFile("migrations/0001_init.sql", "utf8");
    for (const sql of schema
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run();
    assert.equal(
      (await request("/v1/health", "GET", undefined, "wrong")).status,
      401,
    );
    const create = async (local: string) => {
      const response = await request("/v1/mailboxes", "POST", {
        local,
        name: local,
      });
      assert.equal(response.status, 201);
      return ((await response.json()) as { id: string }).id;
    };
    const a = await create("alice");
    const b = await create("bob");
    assert.equal(
      (await request("/v1/mailboxes", "POST", { local: "alice" })).status,
      409,
    );
    assert.equal(
      (await request("/v1/mailboxes", "POST", { local: "bad@elsewhere" }))
        .status,
      400,
    );
    assert.equal(
      (await request("/v1/mailboxes", "POST", { local: "x".repeat(9000) }))
        .status,
      400,
    );
    let env: MailEnv = {
      DB: db as unknown as MailEnv["DB"],
      DOMAIN: "example.com",
      SERVICE_TOKEN: token,
    };
    const deliver = async (to: string, raw: string) => {
      let rejected = "";
      await worker.email(
        {
          to,
          from: "sender@example.org",
          rawSize: Buffer.byteLength(raw),
          raw: new Response(raw).body!,
          setReject: (reason: string) => {
            rejected = reason;
          },
        } as unknown as ForwardableEmailMessage,
        env,
      );
      return rejected;
    };
    const raw =
      "From: sender@example.org\r\nTo: alice@example.com\r\nSubject: =?UTF-8?B?6aqM6K+B56CB?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
      Buffer.from("验证码 123456\n<script>do not execute</script>").toString(
        "base64",
      );
    assert.equal(
      await deliver("unknown@example.com", raw),
      "Mailbox unavailable",
    );
    assert.equal(await deliver("alice@example.com", raw), "");
    assert.equal(await deliver("alice@example.com", raw), "");
    const list = async (id: string) =>
      (await (await request(`/v1/mailboxes/${id}/messages`)).json()) as {
        id: string;
      }[];
    assert.equal((await list(a)).length, 1);
    assert.equal((await list(b)).length, 0);
    const id = (await list(a))[0].id;
    const detail = (await (await request(`/v1/messages/${id}`)).json()) as {
      subject: string;
      body: string;
    };
    assert.equal(detail.subject, "验证码");
    assert.match(detail.body, /123456/);
    const htmlRaw = 'From: sender@example.org\r\nTo: bob@example.com\r\nSubject: HTML verification\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from('<p>你的 ChatGPT 临时验证码</p><div><b>654</b><span>321</span></div><script>111111</script><img src="https://tracker.invalid/pixel">').toString('base64');
    assert.equal(await deliver("bob@example.com", htmlRaw), "");
    const htmlId = (await list(b))[0].id;
    const htmlDetail = await (await request(`/v1/messages/${htmlId}`)).json() as { body: string };
    assert.match(htmlDetail.body, /654321/);
    assert.doesNotMatch(htmlDetail.body, /111111|tracker|仅包含 HTML|<script/);
    for (const status of ["disabled", "deleted"]) {
      assert.equal(
        (await request(`/v1/mailboxes/${a}`, "PATCH", { name: "A", status }))
          .status,
        200,
      );
      assert.equal(
        await deliver("alice@example.com", raw + "different"),
        "Mailbox unavailable",
      );
    }
    await request(`/v1/mailboxes/${a}`, "PATCH", {
      name: "A",
      status: "active",
      environment_id: "browser-a",
    });
    assert.equal(await deliver("alice@example.com", raw), "");
    assert.match(
      await deliver("bob@example.com", "x".repeat(512 * 1024 + 1)),
      /exceeds/,
    );
    await mf.dispose();
    mf = new Miniflare(options);
    db = await mf.getD1Database("DB");
    env = { ...env, DB: db as unknown as MailEnv["DB"] };
    assert.equal((await list(a)).length, 1);
    await db
      .prepare("UPDATE messages SET received_at=?")
      .bind("2020-01-01T00:00:00.000Z")
      .run();
    await worker.scheduled({}, env);
    assert.equal((await list(a)).length, 0);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
