import { createRouter } from "./src/router.js";
export { WorldArchiveResetWorkflow } from "./src/archive-reset-workflow.js";

const router = createRouter();

export default {
  async fetch(request, env, ctx) {
    return router(request, env, ctx);
  },
};
