// Mail (§28.6): a message as SMTP carries it, sent to a mail server (here one the test runs), never a
// password over a connection that is not encrypted, and the outbox's tries.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { messageOf, smtpSend, parseSmtpUrl, createMail } from "../server/mail.js";

// A mail server that takes one message: what it was told, and whether it offers STARTTLS.
function fakeSmtp({ starttls = false } = {}) {
    const got = { lines: [], data: "" };
    const server = net.createServer((s) => {
        s.setEncoding("utf8");
        let inData = false;
        let buf = "";
        s.write("220 fake ESMTP\r\n");
        s.on("data", (chunk) => {
            buf += chunk;
            if (inData) {
                const end = buf.indexOf("\r\n.\r\n");
                if (end < 0) return;
                got.data = buf.slice(0, end);
                buf = buf.slice(end + 5);
                inData = false;
                s.write("250 queued\r\n");
            }
            let i;
            while (!inData && (i = buf.indexOf("\r\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 2);
                got.lines.push(line);
                if (/^EHLO/.test(line)) s.write(`250-fake\r\n${starttls ? "250-STARTTLS\r\n" : ""}250 8BITMIME\r\n`);
                else if (/^(MAIL|RCPT)/.test(line)) s.write("250 ok\r\n");
                else if (line === "DATA") { inData = true; s.write("354 go on\r\n"); }
                else if (line === "QUIT") { s.write("221 bye\r\n"); s.end(); }
                else s.write("502 no\r\n");
            }
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ got, port: server.address().port, close: () => server.close() })));
}

test("a message: its headers, a subject that is not ASCII encoded, its body in base64 that reads back", () => {
    const m = messageOf({ from: "OpenCore MES <mes@plant.example>", to: "eng@plant.example", subject: "To approve: Product µ-1", body: "Line one\nLine two" });
    assert.match(m, /^From: OpenCore MES <mes@plant\.example>\r\nTo: eng@plant\.example\r\nSubject: =\?UTF-8\?B\?/);
    assert.match(m, /Message-ID: <[0-9a-f-]+@plant\.example>/);
    const body = m.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    assert.equal(Buffer.from(body, "base64").toString("utf8"), "Line one\r\nLine two");
});

test("sent to a mail server: sender, recipient and message, as SMTP says", async () => {
    const srv = await fakeSmtp();
    try {
        await smtpSend({ ...parseSmtpUrl(`smtp://127.0.0.1:${srv.port}`) }, { from: "MES <mes@plant.example>", to: "eng@plant.example", data: messageOf({ from: "mes@plant.example", to: "eng@plant.example", subject: "Hi", body: "Body" }) }, { timeoutMs: 3000 });
        assert.ok(srv.got.lines.includes("MAIL FROM:<mes@plant.example>"));
        assert.ok(srv.got.lines.includes("RCPT TO:<eng@plant.example>"));
        assert.match(srv.got.data, /Subject: Hi/);
    } finally { srv.close(); }
});

test("a user and password are never sent over a connection that is not encrypted", async () => {
    const srv = await fakeSmtp({ starttls: false });
    try {
        await assert.rejects(smtpSend(parseSmtpUrl(`smtp://me:secret@127.0.0.1:${srv.port}`), { from: "a@b.c", to: "d@e.f", data: "x" }, { timeoutMs: 3000 }), /offers no TLS, so its user and password were not sent/);
        assert.ok(!srv.got.lines.some((l) => /^AUTH/.test(l)));
    } finally { srv.close(); }
});

test("the outbox: with no mail server it writes the message to the log; a failure is tried again later, then given up", async () => {
    const rows = [];
    const db = {
        async query(sql, params) {
            if (/^INSERT/.test(sql)) { if (!rows.some((r) => r.key === params[0])) rows.push({ id: String(rows.length + 1), key: params[0], to_addr: params[1], subject: params[2], body: params[3], state: "pending", attempts: 0 }); return []; }
            if (/^UPDATE mes\.mail_outbox SET attempts/.test(sql)) { const due = rows.filter((r) => r.state === "pending"); for (const r of due) r.attempts++; return due.map((r) => ({ ...r })); }
            const r = rows.find((x) => x.id === params[0]);
            if (/state = 'logged'/.test(sql)) r.state = "logged";
            else if (/state = 'sent'/.test(sql)) r.state = "sent";
            else { r.state = params[1]; r.last_error = params[3]; }
            return [];
        },
    };
    const said = [];
    const logged = createMail({ db, log: { info: (m) => said.push(m), error: () => {} } });
    assert.equal(await logged.enqueue(db, { key: "k1", to: "not an address", subject: "s", body: "b" }), false);
    await logged.enqueue(db, { key: "k1", to: "eng@plant.example", subject: "s", body: "b" });
    await logged.enqueue(db, { key: "k1", to: "eng@plant.example", subject: "s", body: "b" });
    await logged.drain();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "logged");
    assert.match(said[0], /no SMTP_URL set.*eng@plant\.example/);
    const failing = createMail({ db, smtpUrl: "smtp://127.0.0.1:1", log: { error: () => {} }, send: async () => { throw new Error("connection refused"); } });
    await failing.enqueue(db, { key: "k2", to: "q@plant.example", subject: "s", body: "b" });
    await failing.drain();
    assert.equal(rows[1].state, "pending");
    assert.match(rows[1].last_error, /connection refused/);
    for (let i = 0; i < 8; i++) await failing.drain();
    assert.equal(rows[1].state, "failed");
    assert.match(rows[1].last_error, /Given up after 8 tries/);
});
