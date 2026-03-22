export const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/120.0",
] as const;

export const HEADERS = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "max-age=0",
  DNT: "1",
  Connection: "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

export const CRAWLER_CONFIG = {
  maxConcurrency: 35,
  minConcurrency: 15,
  maxRequestsPerMinute: 3000,
  requestHandlerTimeoutSecs: 120,
  maxRequestRetries: 3,
  sitemapIndexUrl: "https://itexamanswers.net/sitemap_index.xml",
  baseDomainGlob: "https://itexamanswers.net/**",
  excludeGlobs: [
    /\.(pdf|jpg|jpeg|png|gif|svg|css|js|zip|rar|xml|ico)$/i,
    /wp-login\.php/i,
    /wp-admin/i,
    /wp-content/i,
    /wp-json/i,
    /xmlrpc\.php/i,
    /\/feed\//i,
    /\/comments\//i,
    /trackback/i,
  ],
};
