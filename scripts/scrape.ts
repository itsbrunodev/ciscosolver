import { CrawlerEngine } from "@/lib/crawler";
import { SitemapService } from "@/lib/crawler/sitemap";
import { QuestionDatabase } from "@/lib/database/question";

const db = new QuestionDatabase("data/questions.db");

const sitemapService = new SitemapService();

console.log("Fetching URLs from sitemap...");
const sitemapUrls = await sitemapService
  .fetchQuestionUrls()
  .then((urls) => [...new Set(urls)]);

console.log("Checking existing records in database...");
const existingUrls = db.getAllUrls();

const urlsToScrape = sitemapUrls.filter((url) => !existingUrls.has(url));

console.log(`Total URLs in sitemap: ${sitemapUrls.length}`);
console.log(`Already in database:  ${existingUrls.size}`);
console.log(`Remaining to scrape:  ${urlsToScrape.length}`);

if (urlsToScrape.length === 0) {
  console.log("Everything is already up to date! Nothing to scrape.");
  db.close();
  process.exit(0);
}

const startDate = performance.now();

const engine = new CrawlerEngine(db);
await engine.run(urlsToScrape);

const crawlTime = ((performance.now() - startDate) / 1000).toFixed(2);
console.log(`\nCrawl finished in ${crawlTime}s.`);

db.close();
