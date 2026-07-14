import { createRouter } from "./src/router.js";

const router = createRouter();

export default {
  async fetch(request, env, ctx) {
    return router(request, env, ctx);
  },
};
