import { z } from "npm:zod@4";

// Reads and writes a Roam Research graph through Roam's backend API
// (https://api.roamresearch.com) to keep a ladder of periodic reviews:
// weekly summaries of the "Activities" block on each daily note, monthly
// rollups of the weeklies, quarterly rollups of the monthlies and a yearly
// rollup of the quarterlies. `collect` gathers the source text and a prompt,
// an LLM model writes the summary, and `publish` writes it back to the graph
// as a heading block ("Week Ending October 2, 2026", "Monthly Rollup
// September 2026", ...) on the daily note of the first Monday after the
// period ends. Rollups find their sources by searching the graph for those
// headings, so hand-written or hand-edited summaries are picked up too.
//
// The API redirects each graph to a peer host; fetch follows the redirect but
// drops the Authorization header on cross-origin hops, so the token is also
// sent as X-Authorization, which is what Roam's own SDK does.

/** Roam backend API host; requests are redirected to a per-graph peer. */
export const API_BASE = "https://api.roamresearch.com";

const KINDS = ["week", "month", "quarter", "year"] as const;
/** Summary period: a week, month, quarter or year. */
export type Kind = typeof KINDS[number];

/** Rollups summarise the next-smaller summary; weeks summarise daily notes. */
const CHILD: Record<Exclude<Kind, "week">, Kind> = {
  month: "week",
  quarter: "month",
  year: "quarter",
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const GlobalArgsSchema = z.object({
  token: z.string().min(1).meta({ sensitive: true }).describe(
    "Roam graph API token (Settings → Graph → API tokens). Needs edit access for publish.",
  ),
  graph: z.string().min(1).describe(
    "Graph name, as in roamresearch.com/#/app/<graph>",
  ),
  section: z.string().min(1).default("Activities").describe(
    "Daily-note block whose children are summarised, matched case-insensitively and ignoring [[ ]], #, ** and a trailing ':' or '::'",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const DailiesArgsSchema = z.object({
  start: IsoDate.describe("First day to read (YYYY-MM-DD)"),
  end: IsoDate.describe("Last day to read, inclusive (YYYY-MM-DD)"),
});
type DailiesArgs = z.infer<typeof DailiesArgsSchema>;

const CollectArgsSchema = z.object({
  kind: z.enum(KINDS).describe("Which summary to prepare"),
  date: z.string().regex(/^(\d{4}-\d{2}-\d{2}|last|current)$/).default("last")
    .describe(
      "A YYYY-MM-DD day inside the period, 'current' for the period containing today, or 'last' for the most recent period that has ended (a week ends on Friday, so on a Friday 'last' is this week)",
    ),
});
type CollectArgs = z.infer<typeof CollectArgsSchema>;

const PublishArgsSchema = z.object({
  kind: z.enum(KINDS).describe("Which summary this is"),
  key: z.string().describe(
    "Period key from collect: YYYY-MM-DD (week-ending Friday), YYYY-MM, YYYY-Qn or YYYY",
  ),
  markdown: z.string().min(1).describe(
    "The summary as a Markdown outline of '- ' bullets, nested with indentation",
  ),
  ifExists: z.enum(["skip", "replace", "fail"]).default("skip").describe(
    "What to do when the graph already has this period's summary: leave it, replace its contents in place, or fail",
  ),
});
type PublishArgs = z.infer<typeof PublishArgsSchema>;

const DaySchema = z.object({
  date: z.string(),
  title: z.string(),
  found: z.boolean(),
  entries: z.string(),
});

const DailiesSchema = z.object({
  section: z.string(),
  start: z.string(),
  end: z.string(),
  days: z.array(DaySchema),
  daysWithEntries: z.number(),
  markdown: z.string(),
  fetchedAt: z.string(),
});

const PeriodFields = {
  kind: z.enum(KINDS),
  key: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  targetDate: z.string(),
};

const SourceSchema = z.object({
  ...PeriodFields,
  sources: z.array(z.string()),
  missing: z.array(z.string()),
  text: z.string(),
  prompt: z.string(),
  collectedAt: z.string(),
});

const SummarySchema = z.object({
  ...PeriodFields,
  action: z.enum(["created", "replaced", "skipped"]),
  pageUid: z.string(),
  blockUid: z.string(),
  markdown: z.string(),
  publishedAt: z.string(),
});

/** A Roam block with its children in order. */
export interface Block {
  uid: string;
  string: string;
  order: number;
  children: Block[];
}

/** A Roam page (or a block pulled as the root of a tree). */
export interface Page {
  uid: string;
  title: string;
  children: Block[];
}

/** A summary period, its heading title and where it is published. */
export interface Period {
  kind: Kind;
  key: string;
  title: string;
  start: string;
  end: string;
  targetDate: string;
}

/** A summary heading block found in the graph. */
export interface Found {
  uid: string;
  string: string;
  pageUid: string;
  pageTitle: string;
  period: Period;
}

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
}

interface Context {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** The fetch signature the client uses; injectable for tests. */
export type Fetch = (input: Request) => Promise<Response>;

// Methods accept these for tests. swamp rejects method inputs that are not in
// the schema, so they cannot be set from the CLI or a workflow.
interface TestHooks {
  _fetch?: Fetch;
  _today?: string;
  _sleep?: (ms: number) => Promise<void>;
}

const SELECTOR =
  "[:block/uid :node/title :block/string {:block/children [:block/uid :block/string :block/order {:block/children ...}]}]";

/** Minimal Roam backend API client. */
export class RoamClient {
  #base = API_BASE;
  constructor(
    private token: string,
    private graph: string,
    private fetchImpl: Fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async #post(path: string, body: unknown): Promise<unknown> {
    for (let attempt = 0;; attempt++) {
      const res = await this.fetchImpl(
        new Request(
          `${this.#base}/api/graph/${encodeURIComponent(this.graph)}/${path}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Authorization": `Bearer ${this.token}`,
              "X-Authorization": `Bearer ${this.token}`,
            },
            body: JSON.stringify(body),
          },
        ),
      );
      // Remember the peer host so later calls skip the redirect.
      if (res.redirected) {
        const m = res.url.match(/^https:\/\/peer-\d+[^/]*/);
        if (m) this.#base = m[0];
      }
      const text = await res.text();
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        await this.sleep(
          retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt,
        );
        continue;
      }
      if (!res.ok) {
        throw new Error(
          `Roam API ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`,
        );
      }
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(
          `Roam API ${path} returned a response that is not JSON: ${
            text.slice(0, 300)
          }`,
        );
      }
    }
  }

  /** Pulls pages or blocks with their whole child trees, keyed by uid. */
  async pullMany(uids: string[]): Promise<Map<string, Page>> {
    const out = new Map<string, Page>();
    if (!uids.length) return out;
    const eids = `[${
      uids.map((u) => `[:block/uid ${JSON.stringify(u)}]`).join(" ")
    }]`;
    const res = await this.#post("pull-many", { eids, selector: SELECTOR }) as {
      result?: unknown[];
    } | null;
    for (const raw of res?.result ?? []) {
      const page = toPage(raw);
      if (page?.uid) out.set(page.uid, page);
    }
    return out;
  }

  /** Blocks whose text contains `needle`, with their page's uid and title. */
  async findBlocks(
    needle: string,
  ): Promise<
    { uid: string; string: string; pageUid: string; pageTitle: string }[]
  > {
    const query = `[:find ?uid ?s ?puid ?title :in $ ?needle :where
      [?b :block/string ?s] [(clojure.string/includes? ?s ?needle)]
      [?b :block/uid ?uid] [?b :block/page ?p]
      [?p :block/uid ?puid] [?p :node/title ?title]]`;
    const res = await this.#post("q", { query, args: [needle] }) as {
      result?: unknown;
    } | null;
    if (!Array.isArray(res?.result)) {
      throw new Error("Roam API q returned no result array");
    }
    return (res.result as string[][]).map((
      [uid, string, pageUid, pageTitle],
    ) => ({
      uid: String(uid),
      string: String(string),
      pageUid: String(pageUid),
      pageTitle: String(pageTitle),
    }));
  }

  write(action: Record<string, unknown>): Promise<unknown> {
    return this.#post("write", action);
  }
}

/** Roam returns EDN-style keys (":block/string"); accept bare keys too. */
function field(o: Record<string, unknown>, ns: string, key: string): unknown {
  return o[`:${ns}/${key}`] ?? o[`${ns}/${key}`] ?? o[key];
}

function toBlock(raw: unknown): Block {
  const o = raw as Record<string, unknown>;
  const kids = (field(o, "block", "children") as unknown[] | undefined) ?? [];
  return {
    uid: String(field(o, "block", "uid") ?? ""),
    string: String(field(o, "block", "string") ?? ""),
    order: Number(field(o, "block", "order") ?? 0),
    children: kids.map(toBlock).sort((a, b) => a.order - b.order),
  };
}

/** Converts a pull result into a page tree, or null when missing. */
export function toPage(raw: unknown): Page | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kids = (field(o, "block", "children") as unknown[] | undefined) ?? [];
  return {
    uid: String(field(o, "block", "uid") ?? ""),
    title: String(
      field(o, "node", "title") ?? field(o, "block", "string") ?? "",
    ),
    children: kids.map(toBlock).sort((a, b) => a.order - b.order),
  };
}

/** "activities", "[[Activities]]", "#activities", "**Activities:**" → "activities". */
export function normalizeHeading(s: string): string {
  return s
    .replace(/\*\*|__|\[\[|\]\]|^#+\s*/g, "")
    .replace(/:+\s*$/, "")
    .trim()
    .toLowerCase();
}

/** Finds the section block, preferring the shallowest match. */
export function findSection(blocks: Block[], section: string): Block | null {
  const want = normalizeHeading(section);
  let level = blocks;
  while (level.length) {
    const hit = level.find((b) => normalizeHeading(b.string) === want);
    if (hit) return hit;
    level = level.flatMap((b) => b.children);
  }
  return null;
}

/** Long pasted code blocks (logs, LLM transcripts) are noise to a summary. */
export function trimCode(s: string, max = 200): string {
  return s.replace(
    /```[\s\S]*?```/g,
    (m) => m.length > max ? "[code block omitted]" : m,
  );
}

/** Renders blocks as a nested Markdown bullet outline. */
export function toMarkdown(blocks: Block[], depth = 0): string {
  return blocks
    .map((b) =>
      `${"  ".repeat(depth)}- ${trimCode(b.string).replace(/\n/g, " ")}\n` +
      toMarkdown(b.children, depth + 1)
    )
    .join("");
}

// ---- Dates. Everything is a calendar day; UTC arithmetic avoids DST. ----

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Adds `n` days to a YYYY-MM-DD date. */
export function addDays(day: string, n: number): string {
  const x = d(day);
  x.setUTCDate(x.getUTCDate() + n);
  return iso(x);
}

/** The Friday on or after `day`. */
export function fridayOnOrAfter(day: string): string {
  return addDays(day, (5 - d(day).getUTCDay() + 7) % 7);
}

/** The first Monday after `day` (never `day` itself). */
export function mondayAfter(day: string): string {
  return addDays(day, (1 - d(day).getUTCDay() + 7) % 7 || 7);
}

/** The local calendar date (the graph's daily notes follow local time). */
export function localToday(): string {
  const n = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

/** YYYY-MM-DD → Roam daily-note uid MM-DD-YYYY. */
export function dailyUid(day: string): string {
  const [y, m, dd] = day.split("-");
  return `${m}-${dd}-${y}`;
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${
    ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[
      n % 10
    ] ?? "th"
  }`;
}

/** YYYY-MM-DD → Roam daily-note title, e.g. "October 2nd, 2026". */
export function dailyTitle(day: string): string {
  const [y, m, dd] = day.split("-").map(Number);
  return `${MONTHS[m - 1]} ${ordinal(dd)}, ${y}`;
}

/** Every YYYY-MM-DD date from start to end, inclusive (at most 400). */
export function datesBetween(start: string, end: string): string[] {
  if (start > end) throw new Error(`start ${start} is after end ${end}`);
  const out: string[] = [];
  for (let x = start; x <= end; x = addDays(x, 1)) out.push(x);
  if (out.length > 400) throw new Error("Date range is longer than 400 days");
  return out;
}

function lastOfMonth(y: number, m: number): string {
  return iso(new Date(Date.UTC(y, m, 0)));
}

/** The period of `kind` that contains `day`. */
export function periodContaining(kind: Kind, day: string): Period {
  const [y, m] = day.split("-").map(Number);
  let p: Omit<Period, "targetDate">;
  if (kind === "week") {
    const end = fridayOnOrAfter(day);
    const [ey, em, ed] = end.split("-").map(Number);
    p = {
      kind,
      key: end,
      title: `Week Ending ${MONTHS[em - 1]} ${ed}, ${ey}`,
      start: addDays(end, -6),
      end,
    };
  } else if (kind === "month") {
    p = {
      kind,
      key: day.slice(0, 7),
      title: `Monthly Rollup ${MONTHS[m - 1]} ${y}`,
      start: `${day.slice(0, 7)}-01`,
      end: lastOfMonth(y, m),
    };
  } else if (kind === "quarter") {
    const q = Math.ceil(m / 3);
    p = {
      kind,
      key: `${y}-Q${q}`,
      title: `Quarterly Rollup Q${q} ${y}`,
      start: `${y}-${String(q * 3 - 2).padStart(2, "0")}-01`,
      end: lastOfMonth(y, q * 3),
    };
  } else {
    p = {
      kind,
      key: String(y),
      title: `Yearly Rollup ${y}`,
      start: `${y}-01-01`,
      end: `${y}-12-31`,
    };
  }
  return { ...p, targetDate: mondayAfter(p.end) };
}

/** Resolves a collect `date` input (a day, 'current' or 'last') to a period. */
export function resolvePeriod(
  kind: Kind,
  date: string,
  today: string,
): Period {
  if (date === "current") return periodContaining(kind, today);
  if (date === "last") {
    const p = periodContaining(kind, today);
    return p.end <= today ? p : periodContaining(kind, addDays(p.start, -1));
  }
  return periodContaining(kind, date);
}

/** Turns a key from `collect` back into its period. */
export function periodFromKey(kind: Kind, key: string): Period {
  const pattern = {
    week: /^\d{4}-\d{2}-\d{2}$/,
    month: /^\d{4}-\d{2}$/,
    quarter: /^\d{4}-Q[1-4]$/,
    year: /^\d{4}$/,
  }[kind];
  if (!pattern.test(key)) throw new Error(`"${key}" is not a ${kind} key`);
  if (kind === "week") {
    if (fridayOnOrAfter(key) !== key) {
      throw new Error(`Week key ${key} is not a Friday`);
    }
    return periodContaining(kind, key);
  }
  if (kind === "month") return periodContaining(kind, `${key}-01`);
  if (kind === "quarter") {
    const q = Number(key.slice(-1));
    return periodContaining(
      kind,
      `${key.slice(0, 4)}-${String(q * 3).padStart(2, "0")}-01`,
    );
  }
  return periodContaining(kind, `${key}-01-01`);
}

/** Parses "2026-09-18", "October 2, 2026" or "[[October 2nd, 2026]]". */
function parseDay(s: string): string | null {
  const t = s.replace(/\[\[|\]\]/g, "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (!m) return null;
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Recognises a summary heading block, written by hand or by `publish`. */
export function parseSummaryHeading(s: string): Period | null {
  const t = s.replace(/\*\*|__|^#+\s*/g, "").replace(/:+\s*$/, "").trim();
  let m = t.match(/^week ending\s+(.+)$/i);
  if (m) {
    const day = parseDay(m[1]);
    return day ? periodContaining("week", day) : null;
  }
  m = t.match(/^monthly rollup\s+([a-z]+)\s+(\d{4})$/i);
  if (m) {
    const mi = MONTHS.findIndex((x) => x.toLowerCase() === m![1].toLowerCase());
    return mi < 0 ? null : periodContaining(
      "month",
      `${m[2]}-${String(mi + 1).padStart(2, "0")}-01`,
    );
  }
  m = t.match(/^quarterly rollup\s+q([1-4])\s+(\d{4})$/i);
  if (m) return periodFromKey("quarter", `${m[2]}-Q${m[1]}`);
  m = t.match(/^yearly rollup\s+(\d{4})$/i);
  if (m) return periodFromKey("year", m[1]);
  return null;
}

const NEEDLE: Record<Kind, string[]> = {
  week: ["Week Ending", "week ending", "Week ending"],
  month: ["Monthly Rollup", "Monthly rollup"],
  quarter: ["Quarterly Rollup", "Quarterly rollup"],
  year: ["Yearly Rollup", "Yearly rollup"],
};

/** Every summary heading of `kind` in the graph. */
export async function findSummaries(
  client: RoamClient,
  kind: Kind,
): Promise<Found[]> {
  const seen = new Map<string, Found>();
  for (const needle of NEEDLE[kind]) {
    for (const b of await client.findBlocks(needle)) {
      const period = parseSummaryHeading(b.string);
      if (period?.kind === kind) seen.set(b.uid, { ...b, period });
    }
  }
  return [...seen.values()];
}

// ---- Prompts. Modelled on the hand-written summaries in the graph. ----

const STYLE = `Output rules:
- Output ONLY a Markdown outline of "- " bullets nested with two-space indentation. No title line, no preamble, no closing remarks, no code fences.
- Write as the author, in past tense with the subject left out ("Built…", "Helped Sam…", "Landed the PR for…").
- Group the work into 3-6 themes unless told otherwise. Each theme is a top-level bullet whose text is the theme name in bold (**…**), with its points as child bullets.
- Give a short description only for the tickets that were the main work (e.g. "PROJ-412 — login fails after password reset"). Collapse tickets that were filed, split out, moved or only touched into one bullet listing just their IDs (e.g. "Filed follow-ups PROJ-431, PROJ-433, PROJ-440").
- Keep people's names as written, and branch/repo names in backticks.
- Merge repeated "continued working on…" entries into one point about the outcome. Lead with results and decisions, not activity.
- Omit URLs. Do not invent anything that is not in the notes.`;

function instructions(p: Period): string {
  const monthName = MONTHS[Number(p.start.slice(5, 7)) - 1];
  switch (p.kind) {
    case "week":
      return `Write a weekly summary for ${p.title} (${p.start} to ${p.end}) from my daily work notes below. Keep it short: 3-4 themes with 2-3 bullets each, 8-14 bullets in total, one sentence per bullet where possible.
End with a top-level bullet "**Overall theme:** …" giving the week's direction in one or two sentences.`;
    case "month":
      return `Write a monthly rollup for ${monthName} ${
        p.start.slice(0, 4)
      } (${p.start} to ${p.end}) from my weekly summaries below. Synthesise across weeks rather than listing them in order; each theme should show how the work progressed over the month.
The last weekly may run past the end of the month and the first may start before it; only include work from those weeks that clearly belongs to ${monthName}.
End with a top-level bullet "${monthName} outcome" with two or three child bullets: where the month moved the work, and what the strongest result was.`;
    case "quarter":
      return `Write a quarterly rollup for ${
        p.title.replace("Quarterly Rollup ", "")
      } (${p.start} to ${p.end}) from my monthly rollups below. Synthesise across months: themes should show the arc of the quarter, not repeat each month.
End with a top-level bullet "${
        p.title.replace("Quarterly Rollup ", "")
      } outcome" with two to four child bullets on what the quarter achieved and what carries into the next one.`;
    case "year":
      return `Write a yearly rollup for ${p.key} from my quarterly rollups below. Synthesise across quarters into the year's major themes and accomplishments, at the level of a year-in-review.
End with a top-level bullet "${p.key} outcome" with three to five child bullets on the year's most significant results and how the focus of the work changed.`;
  }
}

/** The full prompt for a period: instructions, style rules, then the source text. */
export function buildPrompt(p: Period, text: string): string {
  const label = p.kind === "week" ? "Daily notes" : `${
    {
      month: "Weekly summaries",
      quarter: "Monthly rollups",
      year: "Quarterly rollups",
    }[
      p.kind
    ]
  }`;
  return `${instructions(p)}\n\n${STYLE}\n\n# ${label}\n\n${text}`;
}

// ---- Writing outlines back to Roam. ----

/** One block of a parsed Markdown outline. */
export interface OutlineNode {
  string: string;
  children: OutlineNode[];
}

/**
 * Parses a Markdown bullet outline into a block tree. Indentation sets depth;
 * "## Heading" lines become bold top-level blocks and other text lines become
 * blocks at the current depth.
 */
export function parseOutline(markdown: string): OutlineNode[] {
  const root: OutlineNode = { string: "", children: [] };
  const stack: { indent: number; node: OutlineNode }[] = [
    { indent: -1, node: root },
  ];
  for (const raw of markdown.replace(/\r/g, "").split("\n")) {
    if (!raw.trim() || /^\s*```/.test(raw)) continue;
    const indent = raw.match(/^\s*/)![0].replace(/\t/g, "  ").length;
    const heading = raw.match(/^\s*#{1,6}\s+(.+)$/);
    const bullet = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    const text = heading
      ? `**${heading[1].replace(/\*\*/g, "")}**`
      : bullet
      ? bullet[1]
      : raw.trim();
    const level = heading ? -1 : indent;
    while (stack.length > 1 && stack[stack.length - 1].indent >= level) {
      stack.pop();
    }
    const node = { string: text.trim(), children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent: heading ? -0.5 : level, node });
  }
  return root.children;
}

const UID_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";

/** A random 9-character block uid in the alphabet Roam uses. */
export function newUid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return [...bytes].map((b) => UID_CHARS[b % 64]).join("");
}

/** create-block actions for a tree, parents before children. */
export function createActions(
  parentUid: string,
  nodes: OutlineNode[],
): Record<string, unknown>[] {
  return nodes.flatMap((n) => {
    const uid = newUid();
    return [
      {
        action: "create-block",
        location: { "parent-uid": parentUid, order: "last" },
        block: { uid, string: n.string },
      },
      ...createActions(uid, n.children),
    ];
  });
}

async function writeBatched(
  client: RoamClient,
  actions: Record<string, unknown>[],
): Promise<void> {
  for (let i = 0; i < actions.length; i += 100) {
    await client.write({
      action: "batch-actions",
      actions: actions.slice(i, i + 100),
    });
  }
}

async function readDailies(
  client: RoamClient,
  section: string,
  start: string,
  end: string,
) {
  const dates = datesBetween(start, end);
  const pages = await client.pullMany(dates.map(dailyUid));
  return dates.map((date) => {
    const page = pages.get(dailyUid(date));
    const block = page ? findSection(page.children, section) : null;
    return {
      date,
      title: page?.title || dailyTitle(date),
      found: block !== null,
      entries: block ? toMarkdown(block.children) : "",
    };
  });
}

function dailiesText(days: { date: string; title: string; entries: string }[]) {
  return days
    .filter((x) => x.entries.trim())
    .map((x) => `## ${x.title}\n${x.entries}`)
    .join("\n");
}

/** The `@taylor/roam/graph` swamp model type. */
export const model = {
  type: "@taylor/roam/graph",
  version: "2026.10.14.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description: "Declares the license in the manifest; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    dailies: {
      description:
        "Entries under the section block of each daily note in a date range",
      schema: DailiesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    source: {
      description:
        "Source text and prompt for the next summary, from collect (instance 'source')",
      schema: SourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    summary: {
      description:
        "A published summary, one instance per period (summary-week-2026-10-02, summary-month-2026-09, ...)",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    dailies: {
      description:
        "Read the section block (default: Activities) from each daily note between start and end",
      arguments: DailiesArgsSchema,
      execute: async (args: DailiesArgs & TestHooks, context: Context) => {
        const g = context.globalArgs;
        const client = new RoamClient(
          g.token,
          g.graph,
          args._fetch,
          args._sleep,
        );
        context.logger.info("Reading {section} from {start} to {end}", {
          section: g.section,
          start: args.start,
          end: args.end,
        });
        const days = await readDailies(client, g.section, args.start, args.end);
        const withEntries = days.filter((x) => x.entries.trim()).length;
        context.logger.info(
          "Read {n} daily notes, {m} with {section} entries",
          { n: days.length, m: withEntries, section: g.section },
        );
        const handle = await context.writeResource(
          "dailies",
          `dailies-${args.start}-${args.end}`,
          {
            section: g.section,
            start: args.start,
            end: args.end,
            days,
            daysWithEntries: withEntries,
            markdown: dailiesText(days),
            fetchedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    collect: {
      description:
        "Gather the source for a weekly summary (the section block of each daily note) or a monthly/quarterly/yearly rollup (the next-smaller summaries in the graph), plus the prompt to write it",
      arguments: CollectArgsSchema,
      execute: async (args: CollectArgs & TestHooks, context: Context) => {
        const g = context.globalArgs;
        const client = new RoamClient(
          g.token,
          g.graph,
          args._fetch,
          args._sleep,
        );
        const period = resolvePeriod(
          args.kind,
          args.date,
          args._today ?? localToday(),
        );
        context.logger.info("Collecting sources for {title}", {
          title: period.title,
        });
        let text: string;
        let sources: string[];
        let missing: string[] = [];

        if (period.kind === "week") {
          const days = await readDailies(
            client,
            g.section,
            period.start,
            period.end,
          );
          text = dailiesText(days);
          sources = days.filter((x) => x.entries.trim()).map((x) => x.date);
        } else {
          const child = CHILD[period.kind];
          const found = (await findSummaries(client, child)).filter((f) =>
            f.period.start <= period.end && f.period.end >= period.start
          );
          // One summary per child period; prefer the longest if duplicated.
          const blocks = await client.pullMany(found.map((f) => f.uid));
          const byKey = new Map<string, { f: Found; body: string }>();
          for (const f of found) {
            const body = toMarkdown(blocks.get(f.uid)?.children ?? []);
            const prev = byKey.get(f.period.key);
            if (prev) {
              context.logger.warn(
                "Two summaries for {title}: on {a} and {b}; using the longer",
                { title: f.period.title, a: prev.f.pageTitle, b: f.pageTitle },
              );
            }
            if (!prev || body.length > prev.body.length) {
              byKey.set(f.period.key, { f, body });
            }
          }
          const chosen = [...byKey.values()].sort((a, b) =>
            a.f.period.start.localeCompare(b.f.period.start)
          );
          text = chosen
            .map(({ f, body }) =>
              `## ${f.period.title} (${f.period.start} to ${f.period.end})\n${body}`
            )
            .join("\n");
          sources = chosen.map(({ f }) => f.period.key);

          const expected: string[] = [];
          for (
            let x = period.start;
            x <= period.end;
            x = addDays(periodContaining(child, x).end, 1)
          ) {
            const cp = periodContaining(child, x);
            if (cp.end <= (args._today ?? localToday())) expected.push(cp.key);
          }
          missing = expected.filter((k) => !byKey.has(k));
          if (missing.length) {
            context.logger.warn(
              "No {child} summary found for {missing}; the {kind} rollup will not cover them",
              { child, missing: missing.join(", "), kind: period.kind },
            );
          }
        }

        if (!text.trim()) {
          throw new Error(
            period.kind === "week"
              ? `No "${g.section}" entries on the daily notes from ${period.start} to ${period.end}`
              : `No ${
                CHILD[period.kind]
              } summaries found for ${period.title}; publish those first`,
          );
        }
        context.logger.info("Collected {n} sources for {title}", {
          n: sources.length,
          title: period.title,
        });
        const handle = await context.writeResource("source", "source", {
          ...period,
          sources,
          missing,
          text,
          prompt: buildPrompt(period, text),
          collectedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    publish: {
      description:
        "Write a summary to the graph as a heading block on the daily note of the first Monday after the period ends, and store it as data",
      arguments: PublishArgsSchema,
      execute: async (args: PublishArgs & TestHooks, context: Context) => {
        const g = context.globalArgs;
        const client = new RoamClient(
          g.token,
          g.graph,
          args._fetch,
          args._sleep,
        );
        const period = periodFromKey(args.kind, args.key);
        const outline = parseOutline(args.markdown);
        if (!outline.length) throw new Error("The summary has no bullets");
        context.logger.info("Publishing {title} ({n} top-level blocks)", {
          title: period.title,
          n: outline.length,
        });

        const existing = (await findSummaries(client, period.kind)).filter((
          f,
        ) => f.period.key === period.key);
        const targetUid = dailyUid(period.targetDate);
        let action: "created" | "replaced" | "skipped";
        let blockUid: string;
        let pageUid = targetUid;

        if (existing.length && args.ifExists === "fail") {
          throw new Error(
            `${period.title} already exists on ${existing[0].pageTitle}`,
          );
        }
        if (existing.length && args.ifExists === "skip") {
          action = "skipped";
          blockUid = existing[0].uid;
          pageUid = existing[0].pageUid;
          context.logger.warn(
            "{title} already exists on {page}; left it as is (ifExists=skip)",
            { title: period.title, page: existing[0].pageTitle },
          );
        } else if (existing.length) {
          action = "replaced";
          blockUid = existing[0].uid;
          pageUid = existing[0].pageUid;
          const old = (await client.pullMany([blockUid])).get(blockUid);
          try {
            await writeBatched(client, [
              ...(old?.children ?? []).map((c) => ({
                action: "delete-block",
                block: { uid: c.uid },
              })),
              ...createActions(blockUid, outline),
            ]);
          } catch (e) {
            throw new Error(
              `Replacing ${period.title} failed part-way, so it may be incomplete; rerun with ifExists=replace. ${
                (e as Error).message
              }`,
            );
          }
          context.logger.info("Replaced {title} on {page}", {
            title: period.title,
            page: existing[0].pageTitle,
          });
        } else {
          action = "created";
          blockUid = newUid();
          const pages = await client.pullMany([targetUid]);
          try {
            await writeBatched(client, [
              ...(pages.has(targetUid) ? [] : [{
                action: "create-page",
                page: { uid: targetUid, title: dailyTitle(period.targetDate) },
              }]),
              {
                action: "create-block",
                location: { "parent-uid": targetUid, order: "last" },
                block: { uid: blockUid, string: period.title },
              },
              ...createActions(blockUid, outline),
            ]);
          } catch (e) {
            // A half-written heading would make the next run skip this
            // period, so take it out again before failing.
            const removed = await client.write({
              action: "delete-block",
              block: { uid: blockUid },
            }).then(() => true, () => false);
            throw new Error(
              `Writing ${period.title} failed part-way${
                removed
                  ? "; removed the partial summary"
                  : `, and the partial summary (block ${blockUid}) could not be removed; rerun with ifExists=replace`
              }. ${(e as Error).message}`,
            );
          }
          context.logger.info("Wrote {title} to {page}", {
            title: period.title,
            page: dailyTitle(period.targetDate),
          });
        }

        const handle = await context.writeResource(
          "summary",
          `summary-${period.kind}-${period.key}`,
          {
            ...period,
            action,
            pageUid,
            blockUid,
            markdown: args.markdown,
            publishedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
