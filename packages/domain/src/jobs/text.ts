/** Small text helpers shared by the job readers. No network, no state. */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", bull: "•" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML to readable text: block tags become line breaks, list items become "- " lines. */
export function htmlToText(html: string): string {
  let s = decodeEntities(html); // feeds often double-encode their HTML
  s = s.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/?(p|div|ul|ol|h[1-6]|section|article|tr|table|header|footer)[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter((l, i, a) => l || (i > 0 && a[i - 1])).join("\n").trim();
}

export const STOPWORDS = new Set(("a an and the of for to in on at by with from or as is are be we you your our their this that will who what " +
  "into across within about than more most other per via").split(" "));

export function words(s: string): string[] {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9+#.\s/-]/g, " ")
    .split(/[\s/]+/).map((w) => w.replace(/^[.-]+|[.-]+$/g, "")).filter((w) => w && !STOPWORDS.has(w));
}

export function containsPhrase(haystack: string, phrase: string): boolean {
  const esc = phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, "i").test(haystack.toLowerCase());
}
