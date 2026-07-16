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

const BROAD_SEARCH_TERMS = [
  "energy",
  "hydrogen",
  "renewable energy",
  "chemical engineering",
  "mechanical engineering",
  "materials science",
  "computational science",
  "computational modeling",
  "scientific computing",
  "AI for science",
  "machine learning",
  "fluid dynamics",
  "CFD",
  "thermal",
  "heat transfer",
  "porous media",
  "membrane",
  "transport phenomena",
  "simulation",
  "modeling",
  "modelling",
  "electrochemistry",
  "catalysis",
  "fuel cell",
  "battery",
];

const ROLE_RE =
  /\b(phd\s+(position|student(ship)?|candidate|researcher|fellow(ship)?|opportunit(y|ies))|doctoral\s+(candidate|researcher|student|position|fellow(ship)?)|postdoc\s+(position|fellow(ship)?|opportunit(y|ies))|postdoctoral\s+(researcher|position|fellow|associate|fellowship)|research\s+fellow|research\s+associate|junior\s+research\s+fellow|research\s+scientist|research\s+engineer|scientist\s+(position|role)|faculty\s+position|tenure-track|assistant\s+professor|associate\s+professor|professor\s+position)\b/i;

const NOISE_RE =
  /\b(award|recognition|symposium|conference|webinar|workshop|defen[cs]e|developed|says|said|opinion|scholarship results?|exam|admit card)\b/i;

const BIOMED_NOISE_RE =
  /\b(cancer|tumou?r|oncology|immunology|microbiome|mucosal|hepatic|neuroscience|brain|clinical|patient|disease|genomics|bioinformatics)\b/i;

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function matchingKeywords(text: string, keywords: string[]): string[] {
  const haystack = text.toLowerCase();
  const regularKeywords = keywords.filter((keyword) => keyword.toUpperCase() !== "LBM");
  const matches = regularKeywords.filter((keyword) =>
    haystack.includes(keyword.toLowerCase()),
  );
  if (/\bLBM\b/.test(text) && /\b(lattice|boltzmann)\b/i.test(text)) {
    matches.push("LBM");
  }
  return [...new Set(matches)];
}

function scoreArticle(text: string, keywords: string[]): number {
  const priorityMatches = matchingKeywords(text, keywords).length;
  const broadMatches = matchingKeywords(text, BROAD_SEARCH_TERMS).length;
  return priorityMatches * 5 + broadMatches;
}

function matchesBroadDomain(text: string, keywords: string[]): boolean {
  return (
    matchingKeywords(text, keywords).length > 0 ||
    matchingKeywords(text, BROAD_SEARCH_TERMS).length > 0
  );
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
  const priority = [
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
  const configured = priority.filter((keyword) =>
    keywords.some((sourceKeyword) => sourceKeyword.toLowerCase() === keyword.toLowerCase()),
  );
  return [...new Set([...configured, ...BROAD_SEARCH_TERMS])];
}

function buildGoogleQueries(keywords: string[]): string[] {
  const priority = [
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
  const priorityExpr = `(${priority.map(quote).join(" OR ")})`;
  const broadExpr = `(${BROAD_SEARCH_TERMS.map(quote).join(" OR ")})`;
  return [
    `("PhD position" OR "PhD studentship" OR "doctoral candidate" OR "doctoral researcher") ${broadExpr} when:90d`,
    `(postdoc OR postdoctoral OR "research fellow" OR "research associate") ${broadExpr} when:90d`,
    `("PhD position" OR postdoc OR postdoctoral OR "research fellow") ${priorityExpr} when:180d`,
    `(hiring OR vacancy OR "open position" OR "job opening") ("university" OR "institute" OR "company" OR "startup") ${broadExpr} when:90d`,
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
  const out: { article: RawArticle; score: number }[] = [];

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
      if (NOISE_RE.test(text)) continue;
      if (BIOMED_NOISE_RE.test(text)) continue;
      if (!matchesBroadDomain(text, keywords)) continue;

      const key = canonicalKey(url, title);
      if (seen.has(key)) continue;
      seen.add(key);

      const matches = matchingKeywords(text, keywords);
      const score = scoreArticle(text, keywords);
      out.push({
        score,
        article: {
          sourceId: source.id,
          title,
          url,
          excerpt,
          publishedAt,
          category: source.category,
          meta: matches.length > 0 ? `关键词：${matches.slice(0, 4).join(" / ")}` : "广域招聘线索",
        },
      });
    }
  }

  return out
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.article.publishedAt?.getTime() ?? 0) -
          (a.article.publishedAt?.getTime() ?? 0),
    )
    .map((item) => item.article)
    .slice(0, 20);
}
