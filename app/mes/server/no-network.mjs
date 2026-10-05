// The script runner and its workers have no use for a network: they reach a record or another system
// only by asking their web process (rules.js). Node's permission model (24) has no switch for it, so
// each of them takes its own network functions away as it starts. This is the second line, behind the
// script's context (script-worker.mjs), which hands a script nothing of this realm; the third, where
// the deployment has it, is a network namespace of the runner's own (rules.js SCRIPT_RUNNER_WRAP).
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";

const none = () => { throw Object.assign(new Error("the script runner has no network"), { code: "ERR_NO_NETWORK" }); };
net.Socket.prototype.connect = none;
net.Server.prototype.listen = none;
net.connect = net.createConnection = none;
tls.connect = none;
dgram.Socket.prototype.bind = dgram.Socket.prototype.send = dgram.Socket.prototype.connect = none;
dgram.createSocket = none;
http.request = http.get = https.request = https.get = none;
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveNs", "resolveTxt", "resolveSrv", "reverse"]) {
    if (typeof dns[name] === "function") dns[name] = none;
    if (typeof dns.promises?.[name] === "function") dns.promises[name] = none;
}
for (const name of ["fetch", "WebSocket", "EventSource"]) { try { globalThis[name] = undefined; } catch { /* not there */ } }
