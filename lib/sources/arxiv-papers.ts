import Parser from "rss-parser";
import { curlFetch } from "./curl-fetch";
import type { RawArticle } from "./types";

const AI_TERMS = [
  "machine learning",
  "deep learning",
  "artificial intelligence",
  "neural",
  "transformer",
  "diffusion model",
  "foundation model",
];

type ArxivItem = {
  title?: string;
  link?: string;
  content?: string;
  contentSnippet?: string;
  summary?: string;
  isoDate?: string;
  pubDate?: string;
  categories?: string[];
};

const parser = new Parser<Record<string, unknown>, ArxivItem>({
  timeout: 20_000,
});

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function compact(value: string): string {
  return normalize(value).replace(/[\s-]+/g, "");
}

function matches(value: string, keyword: string): boolean {
  const text = normalize(value);
  const term = normalize(keyword);
  return text.includes(term) || compact(text).includes(compact(term));
}

function keywordQuery(keyword: string): string {
  const tokens = normalize(keyword).split(/[\s]+/).filter(Boolean);
  if (tokens.length === 1) return `all:${tokens[0]}`;
  return `(${tokens.map((token) => `all:${token}`).join(" AND ")})`;
}

function buildQueryUrl(baseUrl: string, keywords: string[], limit: number): string {
  const keywordClause = keywords.map(keywordQuery).join(" OR ");
  const aiClause = AI_TERMS.map(keywordQuery).join(" OR ");
  const params = new URLSearchParams({
    search_query: `(${keywordClause}) AND (${aiClause})`,
    start: "0",
    max_results: String(Math.max(limit * 4, 80)),
    sortBy: "submittedDate",
    sortOrder: "descending",
  });
  return `${baseUrl}?${params.toString()}`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function arxivId(url: string): string {
  return url.match(/arxiv\.org\/(?:abs|pdf)\/([^?#/]+)/i)?.[1]?.replace(/v\d+$/i, "") ?? url;
}

/**
 * Fetch recent cross-scale AI papers directly from arXiv.
 *
 * arXiv supplies discovery while the existing Hugging Face source supplies
 * popularity signals. Results are filtered again locally because the arXiv
 * boolean query intentionally casts a slightly wider net for phrase variants.
 */
export async function fetchArxivPapers(
  sourceId: string,
  baseUrl: string,
  keywords: string[] = [],
  limit = 20,
  lookbackDays = 8,
): Promise<RawArticle[]> {
  if (keywords.length === 0) return [];

  const xml = await curlFetch(buildQueryUrl(baseUrl, keywords, limit), {
    "User-Agent": "DailyBriefBot/1.0 (academic paper tracker)",
    Accept: "application/atom+xml, application/xml",
  });
  const feed = await parser.parseString(xml);
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  const ranked = (feed.items ?? [])
    .map((item) => {
      const title = (item.title ?? "").replace(/\s+/g, " ").trim();
      const excerpt = stripHtml(
        item.summary ?? item.contentSnippet ?? item.content ?? "",
      ).slice(0, 1200);
      const url = (item.link ?? "").trim();
      const dateValue = item.isoDate ?? item.pubDate;
      const parsedDate = dateValue ? new Date(dateValue) : undefined;
      const publishedAt =
        parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate : undefined;
      const titleMatches = keywords.filter((keyword) => matches(title, keyword));
      const bodyMatches = keywords.filter((keyword) => matches(excerpt, keyword));
      const matched = [...new Set([...titleMatches, ...bodyMatches])];
      const hasAiSignal = AI_TERMS.some((term) => matches(`${title} ${excerpt}`, term));
      const ageHours = publishedAt
        ? Math.max(0, (Date.now() - publishedAt.getTime()) / 3_600_000)
        : lookbackDays * 24;
      const score = titleMatches.length * 5 + bodyMatches.length * 2 + Math.max(0, 4 - ageHours / 48);
      return { title, excerpt, url, publishedAt, matched, hasAiSignal, score };
    })
    .filter(
      (paper) =>
        paper.title &&
        paper.url &&
        paper.matched.length > 0 &&
        paper.hasAiSignal,
    )
    .filter((paper) => !paper.publishedAt || paper.publishedAt.getTime() >= cutoff)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    );

  const seen = new Set<string>();
  const results: RawArticle[] = [];
  for (const paper of ranked) {
    const id = arxivId(paper.url);
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      sourceId,
      title: paper.title,
      url: paper.url,
      excerpt: paper.excerpt.slice(0, 500),
      publishedAt: paper.publishedAt,
      meta: `arXiv · ${paper.matched.slice(0, 3).join(", ")}`,
      category: "tech",
    });
    if (results.length >= limit) break;
  }
  return results;
}
