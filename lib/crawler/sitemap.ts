import * as cheerio from "cheerio";

import { CRAWLER_CONFIG, HEADERS } from "./constants";
import { getRandomUserAgent } from "./utils";

export class SitemapService {
  public async fetchQuestionUrls(): Promise<string[]> {
    console.log("Fetching sitemap index...");

    try {
      const sitemapUrls = await this.fetchSitemapLocations(
        CRAWLER_CONFIG.sitemapIndexUrl,
      );

      const questionSitemaps = sitemapUrls.filter((url) =>
        url.includes("dwqa-question-sitemap"),
      );
      console.log(`Found ${questionSitemaps.length} question sitemaps`);

      const urlCollections = await Promise.allSettled(
        questionSitemaps.map((url) => this.fetchUrlsFromSitemap(url)),
      );

      const allQuestionUrls: string[] = [];
      for (const result of urlCollections) {
        if (result.status === "fulfilled") {
          allQuestionUrls.push(...result.value);
        }
      }

      console.log(`Total question URLs found: ${allQuestionUrls.length}`);
      return allQuestionUrls;
    } catch (error) {
      console.error("Critical error in SitemapService:", error);
      throw error;
    }
  }

  private async fetchSitemapLocations(url: string): Promise<string[]> {
    const $ = await this.fetchAndParseXml(url);
    const locs: string[] = [];
    $("sitemap loc").each((_, el) => {
      locs.push($(el).text());
    });
    return locs;
  }

  private async fetchUrlsFromSitemap(url: string): Promise<string[]> {
    try {
      console.log(`Fetching: ${url}`);
      const $ = await this.fetchAndParseXml(url);
      const urls: string[] = [];
      $("url loc").each((_, el) => {
        const loc = $(el).text();
        if (loc.includes("/question/")) {
          urls.push(loc);
        }
      });
      return urls;
    } catch (e) {
      console.error(`Failed to fetch sub-sitemap ${url}`);
      return [];
    }
  }

  private async fetchAndParseXml(url: string): Promise<cheerio.CheerioAPI> {
    const response = await fetch(url, {
      headers: {
        ...HEADERS,
        "User-Agent": getRandomUserAgent(),
        Accept: "application/xml",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} - ${response.statusText}`);
    }

    const xml = await response.text();
    return cheerio.load(xml, { xmlMode: true });
  }
}
