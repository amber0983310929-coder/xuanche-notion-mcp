import { requireSession } from "../../../lib/auth.js";
import { loadWorldSnapshot } from "../../../lib/engine.js";
import { errorResponse, json, requireMethod } from "../../../lib/http.js";
import { summarizeWorldSnapshot } from "../../../lib/world.js";

export async function onRequest({ request, env }) {
  try {
    requireMethod(request, ["GET"]);
    await requireSession(request, env);
    const refresh = new URL(request.url).searchParams.get("refresh") === "1";
    const snapshot = await loadWorldSnapshot(env, { refresh });
    const state = summarizeWorldSnapshot(snapshot);
    return json({
      ok: true,
      state,
      ready: {
        engine: true,
        model: Boolean(env.OPENAI_API_KEY),
      },
      runtime: {
        version: "0.6.0",
        model: env.OPENAI_MODEL || "gpt-5.6-terra",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
