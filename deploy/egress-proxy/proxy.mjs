// Outbound gate. The web app and the worker have no internet route of their own; they
// reach out only through here. HTTPS stays end to end (CONNECT tunnel): this gate never
// sees what is sent, only which host on port 443.
//   ALLOW_HOSTS=api.anthropic.com          only these hosts (the web app's gate)
//   ALLOW_HOSTS=*                          any public host (the worker's gate, for job boards and careers pages),
//                                          but never a private, loopback or link-local address (no reaching into the home network)
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";

const allowList = (process.env.ALLOW_HOSTS ?? "api.anthropic.com").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const anyPublic = allowList.includes("*");
const allow = new Set(allowList.filter((h) => h !== "*"));
const port = Number(process.env.PORT ?? 3128);

export function allowed(target, opts = { anyPublic, allow }) {
  const m = /^([a-z0-9.-]+):(\d+)$/i.exec(target ?? "");
  if (!m || m[2] !== "443") return false;
  const host = m[1].toLowerCase();
  if (net.isIP(host)) return false;            // names only: an address could point anywhere
  if (opts.anyPublic) return host.includes(".") && !/\.(local|internal|lan|home|arpa|localhost)$/.test(host) && host !== "localhost";
  return opts.allow.has(host);
}

/** Private, loopback, link-local, carrier-grade NAT, multicast and reserved ranges, v4 and v6. */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

const log = (event, extra) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...extra }));

const server = http.createServer((_req, res) => { res.writeHead(405).end(); });
server.on("connect", async (req, client, head) => {
  const refuse = (why) => { log("egress.refused", { target: req.url, why }); client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); };
  if (!allowed(req.url)) return refuse("not allowed");
  const [host] = req.url.split(":");
  let addr;
  try {
    const all = await dns.lookup(host, { all: true });
    if (!all.length || all.some((a) => isPrivateAddress(a.address))) return refuse("private address");
    addr = all[0].address;
  } catch { return refuse("no such host"); }
  const upstream = net.connect(443, addr, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  const close = () => { upstream.destroy(); client.destroy(); };
  upstream.on("error", close); client.on("error", close);
});
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  server.listen(port, () => log("egress.ready", { port, allow: anyPublic ? ["any public host"] : [...allow] }));
}
export { server };
