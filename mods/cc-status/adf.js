// Atlassian Document Format (the rich text Jira's REST API v3 returns for descriptions and comments) as Markdown,
// for the panels and an agent's first message. Unknown nodes keep their text; attachments become "[attachment]".

const INLINE = new Set(["text", "hardBreak", "inlineCard", "mention", "emoji", "status", "date", "inlineExtension", "placeholder"]);

export function adfToMarkdown(doc) {
  if (!doc) return "";
  if (typeof doc === "string") return doc;
  return block(doc, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function marks(text, ms) {
  let s = text;
  for (const m of ms ?? []) {
    if (m.type === "code") s = `\`${s}\``;
    else if (m.type === "strong") s = `**${s}**`;
    else if (m.type === "em") s = `*${s}*`;
    else if (m.type === "strike") s = `~~${s}~~`;
    else if (m.type === "link" && m.attrs?.href && s !== m.attrs.href) s = `[${s}](${m.attrs.href})`;
  }
  return s;
}

function inlineNode(n) {
  switch (n?.type) {
    case "text": return marks(n.text ?? "", n.marks);
    case "hardBreak": return "\n";
    case "inlineCard": return n.attrs?.url ?? "";
    case "mention": return n.attrs?.text || "@someone";
    case "emoji": return n.attrs?.text || n.attrs?.shortName || "";
    case "status": return n.attrs?.text ? `[${n.attrs.text}]` : "";
    case "date": return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : "";
    default: return n?.content ? inline(n.content) : n?.text ?? "";
  }
}

const inline = (nodes) => (nodes ?? []).map(inlineNode).join("");

function listItem(li, indent, bullet) {
  const parts = (li.content ?? []).map((c) => (c.type === "bulletList" || c.type === "orderedList")
    ? block(c, `${indent}  `)
    : block(c, "").replace(/\n/g, `\n${indent}  `));
  return `${indent}${bullet} ${parts.join("\n")}`;
}

function block(n, indent) {
  const kids = () => (n.content ?? []).map((c) => block(c, indent)).filter(Boolean).join("\n\n");
  switch (n?.type) {
    case "doc": return kids();
    case "paragraph": return indent + inline(n.content).replace(/\n/g, `\n${indent}`);
    case "heading": return `${"#".repeat(Math.min(Math.max(n.attrs?.level ?? 2, 1), 6))} ${inline(n.content)}`;
    case "bulletList": return (n.content ?? []).map((li) => listItem(li, indent, "-")).join("\n");
    case "orderedList": return (n.content ?? []).map((li, i) => listItem(li, indent, `${(n.attrs?.order ?? 1) + i}.`)).join("\n");
    case "taskList": return (n.content ?? []).map((t) => `${indent}- [${t.attrs?.state === "DONE" ? "x" : " "}] ${inline(t.content)}`).join("\n");
    case "codeBlock": return `\`\`\`${n.attrs?.language ?? ""}\n${(n.content ?? []).map((t) => t.text ?? "").join("")}\n\`\`\``;
    case "blockquote": return kids().split("\n").map((l) => `> ${l}`).join("\n");
    case "rule": return "---";
    case "blockCard": case "embedCard": return n.attrs?.url ?? "";
    case "mediaSingle": case "mediaGroup": case "media": return "[attachment]";
    case "panel": case "expand": case "nestedExpand": return (n.attrs?.title ? `**${n.attrs.title}**\n\n` : "") + kids();
    case "table": {
      const rows = (n.content ?? []).map((row) => `| ${(row.content ?? []).map((cell) => (cell.content ?? []).map((c) => block(c, "")).join(" ").replace(/\n+/g, " ").replace(/\|/g, "\\|")).join(" | ")} |`);
      const width = (n.content?.[0]?.content ?? []).length;
      return rows.length ? [rows[0], `|${" --- |".repeat(width)}`, ...rows.slice(1)].join("\n") : "";
    }
    default:
      if (!n?.content) return inlineNode(n);
      return n.content.every((c) => INLINE.has(c.type)) ? indent + inline(n.content) : kids();
  }
}
