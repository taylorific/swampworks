// Reading a Slidev deck's markdown: slides by heading, the code blocks on a
// slide, and every `swamp ...` command the deck shows.

/** A fenced code block on a slide. */
export interface CodeBlock {
  /** The fence's language, lowercased; "" when it has none. */
  lang: string;
  /** 1-based line of the first line inside the fence. */
  line: number;
  code: string;
}

/** One slide: its heading line and its source lines. */
export interface Slide {
  heading: string;
  /** 1-based line of the heading. */
  line: number;
  lines: string[];
}

/** A `swamp ...` command found in the deck. */
export interface DeckCommand {
  text: string;
  /** 1-based source line. */
  line: number;
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)/;
const SHELL_LANGS = new Set([
  "",
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
  "text",
  "powershell",
  "ps1",
]);

/**
 * Finds the slide whose `# ` heading starts with `heading`, and returns its
 * lines up to the next slide separator. Throws when no slide matches, naming
 * the heading, so a renamed slide is reported instead of silently skipped.
 */
export function findSlide(md: string, heading: string): Slide {
  const lines = md.split("\n");
  const start = lines.findIndex((l) =>
    l.startsWith("# ") && l.slice(2).trim().startsWith(heading)
  );
  if (start < 0) throw new Error(`No slide titled "# ${heading}"`);
  let end = start + 1;
  let inFence = false;
  for (; end < lines.length; end++) {
    if (FENCE.test(lines[end])) inFence = !inFence;
    if (!inFence && lines[end] === "---") break;
  }
  return {
    heading: lines[start].slice(2).trim(),
    line: start + 1,
    lines: lines.slice(start, end),
  };
}

/** The fenced code blocks on a slide, in order. */
export function codeBlocks(slide: Slide): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let open:
    | { fence: string; lang: string; line: number; body: string[] }
    | null = null;
  slide.lines.forEach((l, i) => {
    const m = l.match(FENCE);
    if (!open && m) {
      open = { fence: m[1], lang: m[2].toLowerCase(), line: i + 2, body: [] };
    } else if (open && l.trim().startsWith(open.fence)) {
      blocks.push({
        lang: open.lang,
        line: slide.line + open.line - 1,
        code: open.body.join("\n"),
      });
      open = null;
    } else if (open) {
      open.body.push(l);
    }
  });
  return blocks;
}

/** The first code block in `langs` on a slide, or throws naming the slide. */
export function block(slide: Slide, langs: string[], nth = 0): CodeBlock {
  const found = codeBlocks(slide).filter((b) => langs.includes(b.lang))[nth];
  if (!found) {
    throw new Error(
      `Slide "${slide.heading}" (line ${slide.line}) has no ${
        langs.join("/")
      } code block #${nth + 1}`,
    );
  }
  return found;
}

/**
 * Splits a shell line into words. Quotes group words and are removed;
 * `<placeholder words>` and `[optional words]` stay one word, with their
 * brackets, so callers can recognize them.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" || c === '"') {
      const end = line.indexOf(c, i + 1);
      const stop = end < 0 ? line.length : end;
      cur += line.slice(i + 1, stop);
      has = true;
      i = stop;
    } else if ((c === "<" || c === "[") && !has) {
      const close = c === "<" ? ">" : "]";
      const end = line.indexOf(close, i + 1);
      const stop = end < 0 ? line.length - 1 : end;
      cur += line.slice(i, stop + 1);
      has = true;
      i = stop;
    } else if (/\s/.test(c)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words;
}

/**
 * Splits a shell line at unquoted `&&`, `||`, `|` and `;`, dropping an
 * unquoted `# comment`.
 */
export function shellSegments(line: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
      cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      break;
    } else if (c === "|" || c === ";" || (c === "&" && line[i + 1] === "&")) {
      segs.push(cur);
      cur = "";
      if (line[i + 1] === c) i++;
    } else {
      cur += c;
    }
  }
  segs.push(cur);
  return segs.map((s) => s.trim()).filter((s) => s.length > 0);
}

const SWAMP = /^swamp(\s|$)/;

/**
 * Every `swamp ...` command in the deck: in shell and text code blocks (with
 * `\` continuations joined, prompts and comments removed, pipelines split),
 * and in inline code spans in prose, tables and speaker notes.
 */
export function extractCommands(md: string): DeckCommand[] {
  const lines = md.split("\n");
  const out: DeckCommand[] = [];
  let fence: { marker: string; shell: boolean } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(FENCE);
    if (!fence && m) {
      fence = { marker: m[1], shell: SHELL_LANGS.has(m[2].toLowerCase()) };
      continue;
    }
    if (fence && l.trim().startsWith(fence.marker)) {
      fence = null;
      continue;
    }
    if (fence) {
      if (!fence.shell) continue;
      const start = i;
      let logical = l;
      while (logical.trimEnd().endsWith("\\") && i + 1 < lines.length) {
        logical = logical.trimEnd().slice(0, -1).trimEnd() + " " +
          lines[++i].trim();
      }
      logical = logical.replace(/^\s*(\$|PS>|>)\s+/, "");
      for (const seg of shellSegments(logical)) {
        if (SWAMP.test(seg)) out.push({ text: seg, line: start + 1 });
      }
      continue;
    }
    for (const span of l.matchAll(/(?<!`)`([^`]+)`(?!`)/g)) {
      const text = span[1].trim();
      if (SWAMP.test(text)) out.push({ text, line: i + 1 });
    }
  }
  return out;
}
