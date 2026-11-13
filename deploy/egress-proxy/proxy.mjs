// Outbound gate for the web app. The web container has no internet route of its own;
// it reaches out only through here, and only to the hosts listed in ALLOW_HOSTS on port 443.
// HTTPS stays end to end (CONNECT tunnel): this proxy never sees request contents.
import http from "node:http";
import net from "node:net";

const allow = new Set((process.env.ALLOW_HOSTS ?? "api.anthropic.com").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
const port = Number(process.env.PORT ?? 3128);

export function allowed(target) {
  const m = /^([a-z0-9.-]+):(\d+)$/i.exec(target ?? "");
  return !!m && m[2] === "443" && allow.has(m[1].toLowerCase());
}

const server = http.createServer((_req, res) => { res.writeHead(405).end(); });
server.on("connect", (req, client, head) => {
  if (!allowed(req.url)) {
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "egress.refused", target: req.url }));
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const [host] = req.url.split(":");
  const upstream = net.connect(443, host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  const close = () => { upstream.destroy(); client.destroy(); };
  upstream.on("error", close); client.on("error", close);
});
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  server.listen(port, () => console.log(JSON.stringify({ event: "egress.ready", port, allow: [...allow] })));
}
export { server };
