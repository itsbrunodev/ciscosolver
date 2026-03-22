import { createFactory } from "hono/factory";

const factory = createFactory();

/**
 * CORS response header used in Chrome (v104+) to permit public websites to send requests to private network devices or local services.
 */
export const pnaMiddleware = factory.createMiddleware(async (c, next) => {
  await next();

  c.header("Access-Control-Allow-Private-Network", "true");
});
