// Mail (DESIGN.md §28.6): an approving department's mailbox told that a change waits for it. Messages are
// kept in mes.mail_outbox, written in the same transaction as what they tell of, so one exists exactly
// when the event does; a worker sends them (SMTP_URL), tries again a little later each time on a failure,
// and gives up after eight tries, saying why. With no mail server set (development, tests) a message is
// written to the server's log instead, and marked so.
//
//   SMTP_URL   smtp://user:password@host:587 (STARTTLS, required before credentials are sent) or
//              smtps://user:password@host:465 (TLS from the first byte); user and password URL-encoded
//   MAIL_FROM  the sender, "OpenCore MES <mes@plant.example>"
//   PUBLIC_URL where people open the MES (https://mes.plant.example), for the links in a message
//
// The SMTP client is the protocol's few commands on Node's own sockets (EHLO, STARTTLS, AUTH PLAIN, MAIL,
// RCPT, DATA, QUIT): nothing to install, and nothing it does is hidden.
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const TRIES = 8;
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720];

export function parseSmtpUrl(url) {
    const u = new URL(url);
    if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("SMTP_URL is smtp://… or smtps://…");
    const secure = u.protocol === "smtps:";
    return { secure, host: u.hostname, port: Number(u.port) || (secure ? 465 : 587), user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password), name: os.hostname() || "localhost" };
}

// A message as SMTP carries it: plain text, UTF-8, its body in base64 (no line of it can end the DATA).
export function messageOf({ from, to, subject, body, now = new Date(), id = randomUUID() }) {
    const domain = String(from).match(/@([^>\s]+)/)?.[1] ?? "localhost";
    const encoded = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
    const text = Buffer.from(String(body).replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
    return [`From: ${from}`, `To: ${to}`, `Subject: ${encoded}`, `Date: ${now.toUTCString()}`, `Message-ID: <${id}@${domain}>`, "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", text].join("\r\n");
}

// One message to one recipient over SMTP. Throws with the server's words on a refusal.
export async function smtpSend(cfg, { from, to, data }, { timeoutMs = 30_000 } = {}) {
    const address = (s) => String(s).match(/<([^>]+)>/)?.[1] ?? String(s).trim();
    let socket = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
    let buffer = "";
    let waiting = null;
    const take = () => {
        // A reply ends on a line "NNN text" (a "NNN-" line continues it).
        const lines = buffer.split("\r\n");
        for (let i = 0; i < lines.length - 1; i++) if (/^\d{3} /.test(lines[i])) {
            const reply = lines.slice(0, i + 1);
            buffer = lines.slice(i + 1).join("\r\n");
            return { code: Number(reply[i].slice(0, 3)), text: reply.map((l) => l.slice(4)).join("\n") };
        }
        return null;
    };
    const listen = (s) => {
        s.setEncoding("utf8");
        s.on("data", (chunk) => { buffer += chunk; const r = waiting && take(); if (r) { const w = waiting; waiting = null; w.resolve(r); } });
        s.on("error", (e) => { if (waiting) { const w = waiting; waiting = null; w.reject(e); } });
    };
    const reply = () => new Promise((resolve, reject) => {
        const ready = take();
        if (ready) return resolve(ready);
        const timer = setTimeout(() => { waiting = null; reject(new Error(`the mail server did not answer within ${timeoutMs / 1000} s`)); }, timeoutMs);
        waiting = { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } };
    });
    const expect = async (ok, what) => { const r = await reply(); if (!ok.includes(r.code)) throw new Error(`the mail server refused ${what}: ${r.code} ${r.text}`); return r; };
    const send = async (line, ok, what) => { socket.write(`${line}\r\n`); return expect(ok, what); };
    listen(socket);
    try {
        await expect([220], "the connection");
        let ehlo = await send(`EHLO ${cfg.name}`, [250], "EHLO");
        if (!cfg.secure && /(^|\n)STARTTLS/i.test(ehlo.text)) {
            await send("STARTTLS", [220], "STARTTLS");
            socket.removeAllListeners("data");
            socket = await new Promise((resolve, reject) => { const t = tls.connect({ socket, servername: cfg.host }, () => resolve(t)); t.once("error", reject); });
            buffer = "";
            listen(socket);
            ehlo = await send(`EHLO ${cfg.name}`, [250], "EHLO");
            cfg = { ...cfg, tlsNow: true };
        }
        if (cfg.user) {
            // Credentials only over TLS: a server that offers none is not sent them.
            if (!cfg.secure && !cfg.tlsNow) throw new Error("the mail server offers no TLS, so its user and password were not sent: use smtps:// or a server with STARTTLS");
            await send(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`, "utf8").toString("base64")}`, [235], "the sign-in");
        }
        await send(`MAIL FROM:<${address(from)}>`, [250], "the sender");
        await send(`RCPT TO:<${address(to)}>`, [250, 251], `the recipient ${address(to)}`);
        await send("DATA", [354], "the message");
        await send(`${data}\r\n.`, [250], "the message");
        socket.write("QUIT\r\n");
    } finally {
        socket.end();
    }
}

// db: the database; log: { info, error }; send: smtpSend (tests give their own).
export function createMail({ db, log = console, smtpUrl = null, from = null, publicUrl = null, send = smtpSend } = {}) {
    const cfg = smtpUrl ? parseSmtpUrl(smtpUrl) : null;
    const sender = from || "OpenCore MES <mes@localhost>";
    const link = (path) => (publicUrl ? new URL(path, publicUrl).toString() : path);
    // Kept with what it tells of (`q`: the transaction writing that); one message per `key`.
    async function enqueue(q, { key, to, subject, body }) {
        if (!EMAIL.test(String(to ?? ""))) return false;
        await q.query("INSERT INTO mes.mail_outbox (key, to_addr, subject, body) VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING", [key, to, subject, body]);
        return true;
    }
    // The messages due, claimed so that two instances never send one twice (a claim lapses after 10 minutes).
    async function drain() {
        const rows = await db.query(
            `UPDATE mes.mail_outbox SET attempts = attempts + 1, next_at = now() + interval '10 minutes'
             WHERE id IN (SELECT id FROM mes.mail_outbox WHERE state = 'pending' AND next_at <= now() ORDER BY next_at LIMIT 10 FOR UPDATE SKIP LOCKED)
             RETURNING *`);
        for (const m of rows) {
            if (!cfg) {
                log.info?.(`mail (no SMTP_URL set, so written here): to ${m.to_addr} · ${m.subject}\n${m.body}`);
                await db.query("UPDATE mes.mail_outbox SET state = 'logged', sent_at = now(), last_error = NULL WHERE id = $1", [m.id]);
                continue;
            }
            try {
                await send(cfg, { from: sender, to: m.to_addr, data: messageOf({ from: sender, to: m.to_addr, subject: m.subject, body: m.body }) });
                await db.query("UPDATE mes.mail_outbox SET state = 'sent', sent_at = now(), last_error = NULL WHERE id = $1", [m.id]);
            } catch (error) {
                const last = m.attempts >= TRIES;
                const wait = BACKOFF_MIN[Math.min(m.attempts - 1, BACKOFF_MIN.length - 1)];
                await db.query(`UPDATE mes.mail_outbox SET state = $2, next_at = now() + make_interval(mins => $3), last_error = $4 WHERE id = $1`,
                    [m.id, last ? "failed" : "pending", wait, `${last ? `Given up after ${TRIES} tries: ` : ""}${error.message}`]);
                log.error?.(`mail to ${m.to_addr} not sent${last ? " (given up)" : ""}: ${error.message}`);
            }
        }
        return rows.length;
    }
    return { enqueue, drain, link, configured: Boolean(cfg) };
}
