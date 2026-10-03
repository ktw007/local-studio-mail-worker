import PostalMime from "postal-mime";
import type {
  D1Database,
  ForwardableEmailMessage,
} from "@cloudflare/workers-types";

export interface MailEnv {
  DB: D1Database;
  DOMAIN: string;
  SERVICE_TOKEN: string;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const digest = async (input: BufferSource) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", input)))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.length > max)
    throw new Error("参数格式不正确");
  return value.trim();
};
async function authorized(request: Request, env: MailEnv) {
  if (!env.SERVICE_TOKEN || env.SERVICE_TOKEN.length < 32) return false;
  const supplied = request.headers.get("Authorization") ?? "";
  if (supplied.length > 256) return false;
  const encode = new TextEncoder();
  return (
    (await digest(encode.encode(supplied))) ===
    (await digest(encode.encode(`Bearer ${env.SERVICE_TOKEN}`)))
  );
}
async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await bounded(request.body, 8192);
  const value = JSON.parse(new TextDecoder().decode(raw));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("参数格式不正确");
  return value;
}
async function bounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("内容过大");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}
export default {
  async fetch(request: Request, env: MailEnv): Promise<Response> {
    if (!(await authorized(request, env)))
      return json({ error: "访问凭据无效" }, 401);
    const url = new URL(request.url);
    const method = request.method;
    try {
      if (url.pathname === "/v1/health" && method === "GET") {
        await env.DB.prepare("SELECT id FROM mailboxes LIMIT 1").all();
        return json({ version: 1, domain: env.DOMAIN });
      }
      if (url.pathname === "/v1/mailboxes") {
        if (method === "GET")
          return json(
            (
              await env.DB.prepare(
                "SELECT * FROM mailboxes ORDER BY created_at DESC LIMIT 1000",
              ).all()
            ).results,
          );
        if (method === "POST") {
          const input = await body(request);
          const local = text(input.local, 64).toLowerCase();
          if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(local))
            return json(
              { error: "邮箱前缀只能使用字母、数字和中间的点、横线、下划线" },
              400,
            );
          const name = text(input.name ?? "", 100);
          const id = crypto.randomUUID();
          const result = await env.DB.prepare(
            "INSERT INTO mailboxes (id,address,name,created_at) VALUES (?,?,?,?) ON CONFLICT(address) DO NOTHING",
          )
            .bind(id, `${local}@${env.DOMAIN}`, name, new Date().toISOString())
            .run();
          return result.meta.changes
            ? json({ id }, 201)
            : json({ error: "地址已存在，请在列表或回收站查找" }, 409);
        }
      }
      const mailbox = url.pathname.match(/^\/v1\/mailboxes\/([a-f0-9-]{36})$/);
      if (mailbox && method === "PATCH") {
        const input = await body(request);
        const name = text(input.name, 100);
        const environment = text(input.environment_id ?? "", 100);
        const status = text(input.status, 10);
        if (!["active", "disabled", "deleted"].includes(status))
          return json({ error: "邮箱状态无效" }, 400);
        const result = await env.DB.prepare(
          "UPDATE mailboxes SET name=?,environment_id=?,status=? WHERE id=?",
        )
          .bind(name, environment, status, mailbox[1])
          .run();
        return result.meta.changes
          ? json({ ok: true })
          : json({ error: "邮箱不存在" }, 404);
      }
      const messages = url.pathname.match(
        /^\/v1\/mailboxes\/([a-f0-9-]{36})\/messages$/,
      );
      if (messages && method === "GET") {
        const before = url.searchParams.get("before") ?? "9999";
        return json(
          (
            await env.DB.prepare(
              "SELECT id,sender,subject,received_at,read_at FROM messages WHERE mailbox_id=? AND received_at < ? ORDER BY received_at DESC,id DESC LIMIT 100",
            )
              .bind(messages[1], before)
              .all()
          ).results,
        );
      }
      const message = url.pathname.match(/^\/v1\/messages\/([a-f0-9-]{36})$/);
      if (message && method === "GET") {
        const row = await env.DB.prepare("SELECT * FROM messages WHERE id=?")
          .bind(message[1])
          .first();
        return row ? json(row) : json({ error: "邮件不存在或已过期" }, 404);
      }
      if (message && method === "PATCH") {
        const result = await env.DB.prepare(
          "UPDATE messages SET read_at=COALESCE(read_at,?) WHERE id=?",
        )
          .bind(new Date().toISOString(), message[1])
          .run();
        return result.meta.changes
          ? json({ ok: true })
          : json({ error: "邮件不存在" }, 404);
      }
      return json({ error: "接口不存在" }, 404);
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof Error &&
          ["参数格式不正确", "内容过大"].includes(error.message))
      )
        return json({ error: "请求内容无效或过大" }, 400);
      return json({ error: "邮箱服务暂时不可用，请稍后重试" }, 503);
    }
  },
  async email(message: ForwardableEmailMessage, env: MailEnv) {
    if (message.rawSize > 512 * 1024) {
      message.setReject("Message exceeds 512 KiB");
      return;
    }
    const mailbox = await env.DB.prepare(
      "SELECT id FROM mailboxes WHERE address=? AND status='active'",
    )
      .bind(message.to.toLowerCase())
      .first<{ id: string }>();
    if (!mailbox) {
      message.setReject("Mailbox unavailable");
      return;
    }
    let raw: Uint8Array;
    try {
      raw = await bounded(
        message.raw as unknown as ReadableStream<Uint8Array>,
        512 * 1024,
      );
    } catch {
      message.setReject("Message exceeds 512 KiB");
      return;
    }
    let parsed;
    try {
      parsed = await PostalMime.parse(raw);
    } catch {
      message.setReject("Invalid MIME message");
      return;
    }
    // Never render HTML or load remote images. Attachments are deliberately not stored.
    const content =
      parsed.text ||
      (parsed.html ? "[此邮件仅包含 HTML，首版不显示 HTML 正文]" : "");
    // Database failures propagate so the provider can retry; never acknowledge a lost message.
    const inserted = await env.DB.prepare(
      "INSERT INTO messages (id,mailbox_id,fingerprint,sender,subject,body,received_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM mailboxes WHERE id=? AND status='active') ON CONFLICT(mailbox_id,fingerprint) DO NOTHING",
    )
      .bind(
        crypto.randomUUID(),
        mailbox.id,
        await digest(raw as BufferSource),
        message.from.slice(0, 320),
        (parsed.subject ?? "").slice(0, 1000),
        content.slice(0, 100000),
        new Date().toISOString(),
        mailbox.id,
      )
      .run();
    if (
      !inserted.meta.changes &&
      !(await env.DB.prepare(
        "SELECT id FROM mailboxes WHERE id=? AND status='active'",
      )
        .bind(mailbox.id)
        .first())
    )
      message.setReject("Mailbox unavailable");
  },
  async scheduled(_event: unknown, env: MailEnv) {
    await env.DB.prepare("DELETE FROM messages WHERE received_at < ?")
      .bind(new Date(Date.now() - 30 * 86400000).toISOString())
      .run();
  },
};
