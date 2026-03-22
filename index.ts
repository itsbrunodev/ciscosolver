import { Hono } from "hono";

import { SolverService } from "@/lib/solver";

import { healthHandlers } from "./handlers/health";
import { optionsHandlers } from "./handlers/options";
import { solveHandlers } from "./handlers/solve";
import { corsMiddleware, pnaMiddleware } from "@/handlers/middlewares";

const app = new Hono();

SolverService.getInstance().init().catch(console.error);

app.use("/*", corsMiddleware);
app.use("/*", pnaMiddleware);

app.options("/*", ...optionsHandlers);

app.get("/", (c) => c.json({ status: "ok", worker: 0 }));
app.post("/solve", ...solveHandlers);
app.get("/health", ...healthHandlers);

export default {
  port: 6767,
  fetch: app.fetch,
};
