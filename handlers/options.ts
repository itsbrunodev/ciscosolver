import { createFactory } from "hono/factory";

const factory = createFactory();

export const optionsHandlers = factory.createHandlers(async (c) => {
  c.status(204);
  return c.text("");
});
