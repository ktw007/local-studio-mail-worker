import { Parser } from "htmlparser2";

// Parse as text only. Never execute HTML, fetch images, or include link targets.
export function htmlMailText(html: string, limit = 100000): string {
  const blocked = new Set(["head", "script", "style", "template", "svg", "noscript"]);
  const blocks = new Set(["p", "div", "br", "tr", "td", "th", "li", "h1", "h2", "h3", "table", "section", "article"]);
  const ignored: boolean[] = [];
  const parts: string[] = [];
  let length = 0;
  const append = (value: string) => {
    if (length >= limit) return;
    const chunk = value.slice(0, limit - length);
    parts.push(chunk);
    length += chunk.length;
  };
  const parser = new Parser({
    onopentag(name, attributes) {
      const skip = Boolean(ignored.at(-1)) || blocked.has(name) ||
        "hidden" in attributes || attributes["aria-hidden"] === "true" ||
        /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attributes.style ?? "");
      ignored.push(skip);
      if (!skip && blocks.has(name)) append("\n");
    },
    ontext(value) { if (!ignored.at(-1)) append(value); },
    onclosetag(name) {
      const skip = ignored.pop();
      if (!skip && blocks.has(name)) append("\n");
    },
  }, { decodeEntities: true });
  parser.end(html);
  return parts.join("").replace(/[\t \u00a0]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}
