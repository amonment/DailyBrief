import Parser from "rss-parser";
import type { RawArticle, SourceDef } from "./types";

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (compatible; DailyBriefBot/1.0; +https://github.com/)",
  },
});

const DEFAULT_TECH_KEYWORDS = [
  "PEMFC",
  "PEMWE",
  "LBM",
  "proton exchange membrane",
  "polymer electrolyte membrane",
  "fuel cell",
  "fuel cells",
  "electrolyzer",
  "electrolyser",
  "electrolysis",
  "electrochemistry",
  "electrochemical",
  "fluid mechanics",
  "fluid dynamics",
  "lattice Boltzmann",
  "lattice-Boltzmann",
  "multiscale",
  "multi-scale",
  "cross-scale",
  "跨尺度",
  "电化学",
  "流体力学",
];

const ROLE_RE =
  /\b(phd\s+(position|student(ship)?|candidate|researcher|opportunit(y|ies))|doctoral\s+(candidate|researcher|student|position)|postdoc\s+(position|opportunit(y|ies))|postdoctoral\s+(researcher|position|fellow|associate)|research\s+fellow|research\s+associate|open\s+position(s)?|vacanc(y|ies)|hiring|job\s+(opportunit(y|ies)|opening(s)?|posting(s)?))\b/i;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function matchesDomainKeyword(text: string, keywords: string[]): boolean {
  const haystack = text.toLowerCase();
  const regularKeywords = keywords.filter((keyword) => keyword.toUpperCase() !== "LBM");
  if (regularKeywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
    return true;
  }
  return /\bLBM\b/.test(text) && /\b(lattice|boltzmann)\b/i.test(text);
}

function quote(term: string): string {
  return /\s/.test(term) ? `"${term}"` : term;
}

function buildGoogleNewsUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

function buildScienceCareersUrl(keyword: string): string {
  return `https://jobs.sciencecareers.org/jobsrss/?keywords=${encodeURIComponent(keyword)}`;
}

function focusedKeywords(keywords: string[]): string[] {
  const preferred = [
    "PEMFC",
    "PEMWE",
    "fuel cell",
    "electrolyzer",
    "electrolysis",
    "electrochemistry",
    "fluid mechanics",
    "lattice Boltzmann",
    "multiscale",
    "multi-scale",
  ];
  return preferred.filter((keyword) =>
    keywords.some((sourceKeyword) => sourceKeyword.toLowerCase() === keyword.toLowerCase()),
  );
}

function buildGoogleQueries(keywords: string[]): string[] {
  const focused = [
    "PEMFC",
    "PEMWE",
    "fuel cell",
    "electrolyzer",
    "electrolysis",
    "electrochemistry",
    "fluid mechanics",
    "lattice Boltzmann",
    "multiscale",
    "multi-scale",
  ];
  const keywordExpr = `(${focused.map(quote).join(" OR ")})`;
  return [
    `("PhD position" OR "PhD studentship" OR "doctoral candidate" OR "doctoral researcher") ${keywordExpr} when:90d`,
    `(postdoc OR postdoctoral OR "research fellow" OR "research associate") ${keywordExpr} when:90d`,
    `(hiring OR vacancy OR job OR scientist OR engineer) (${keywords
      .slice(0, 12)
      .map(quote)
      .join(" OR ")}) when:90d`,
  ];
}

function canonicalKey(url: string, title: string): string {
  const cleanTitle = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
  return `${url.replace(/[?#].*$/, "")}::${cleanTitle}`;
}

export async function fetchResearchJobs(source: SourceDef): Promise<RawArticle[]> {
  const keywords = source.keywords?.length ? source.keywords : DEFAULT_TECH_KEYWORDS;
  const googleQueries = buildGoogleQueries(keywords);
  const scienceCareersUrls = focusedKeywords(keywords).map(buildScienceCareersUrl);
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const out: RawArticle[] = [];

  const feeds = [
    ...scienceCareersUrls,
    ...googleQueries.map(buildGoogleNewsUrl),
  ];

  for (const feedUrl of feeds) {
    const feed = await parser.parseURL(feedUrl);
    for (const item of feed.items ?? []) {
      const title = (item.title ?? "").trim();
      const url = (item.link ?? "").trim();
      const excerpt = stripHtml(item.contentSnippet ?? item.content ?? "").slice(0, 300);
      const publishedAt = item.isoDate ? new Date(item.isoDate) : undefined;
      const text = `${title} ${excerpt}`;

      if (!title || !url) continue;
      if (publishedAt && publishedAt.getTime() < cutoff) continue;
      if (!ROLE_RE.test(text)) continue;
      if (!matchesDomainKeyword(text, keywords)) continue;

      const key = canonicalKey(url, title);
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        sourceId: source.id,
        title,
        url,
        excerpt,
        publishedAt,
        category: source.category,
      });
    }
  }

  return out
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, 20);
}
