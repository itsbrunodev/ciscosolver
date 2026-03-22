import { cors } from "hono/cors";
import { createFactory } from "hono/factory";

const factory = createFactory();

export const corsMiddleware = factory.createMiddleware(
  cors({
    origin: (origin) => {
      if (!origin || origin.startsWith("chrome-extension://")) {
        return origin;
      }
      if (origin.includes("itsbruno.dev")) {
        return origin;
      }
      return origin;
    },
    allowMethods: ["POST", "GET", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);
