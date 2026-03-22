import {
  CheerioCrawler,
  type CheerioCrawlingContext,
  Configuration,
} from "crawlee";

import type { QuestionDatabase } from "../database/question";
import { parseQuestions } from "../parser";
import { CRAWLER_CONFIG } from "./constants";
import { getRandomUserAgent } from "./utils";

export class CrawlerEngine {
  private db: QuestionDatabase;

  constructor(db: QuestionDatabase) {
    this.db = db;
  }

  public async run(urls: string[]) {
    const config = new Configuration({
      persistStorage: false,
      purgeOnStart: true,
    });

    const crawler = new CheerioCrawler(
      {
        maxConcurrency: CRAWLER_CONFIG.maxConcurrency,
        minConcurrency: CRAWLER_CONFIG.minConcurrency,
        maxRequestsPerMinute: CRAWLER_CONFIG.maxRequestsPerMinute,
        requestHandlerTimeoutSecs: CRAWLER_CONFIG.requestHandlerTimeoutSecs,
        maxRequestRetries: CRAWLER_CONFIG.maxRequestRetries,
        useSessionPool: true,
        preNavigationHooks: [this.handlePreNavigation],
        failedRequestHandler: this.handleFailure,
        requestHandler: (ctx) => this.handleRequest(ctx),
      },
      config,
    );

    await crawler.run(urls);
  }

  private handlePreNavigation = async (
    ctx: CheerioCrawlingContext,
    gotOptions: any,
  ) => {
    gotOptions.http2 = false;
    gotOptions.https = {
      rejectUnauthorized: false,
      ciphers: undefined,
    };
    gotOptions.headers = {
      ...gotOptions.headers,
      "User-Agent": getRandomUserAgent(),
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    };

    if (ctx.request.retryCount > 0) {
      const delayMs = 2 ** ctx.request.retryCount * 1000 + Math.random() * 1000;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  };

  private handleRequest = async ({
    $,
    body,
    request,
    log,
  }: CheerioCrawlingContext) => {
    log.info(`Processing: ${request.url}`);

    try {
      const questions = await parseQuestions(body as string, request.url);

      if (questions.length > 0) {
        await this.db.saveBatch(questions, request.url);
        log.info(`Saved ${questions.length} questions from ${request.url}`);
      } else {
        log.warning(`Recaptcha or Empty? Title: ${$("title").text().trim()}`);
      }
    } catch (error) {
      log.error(`Error parsing ${request.url}:`, { error });
      throw error;
    }
  };

  private handleFailure = ({ request, log, error }: any) => {
    log.error(
      `❌ FATAL: Request ${request.url} failed after ${request.retryCount} retries.`,
      { error: error?.message },
    );
  };
}
