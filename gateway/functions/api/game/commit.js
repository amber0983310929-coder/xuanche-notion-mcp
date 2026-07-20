import { requireSession } from "../../../lib/auth.js";
import { commitWorldTurn } from "../../../lib/engine.js";
import { errorResponse, json, readJson, requireMethod, requireSameOrigin } from "../../../lib/http.js";

export async function onRequest({ request, env }) {
  try {
    requireMethod(request, ["POST"]);
    requireSameOrigin(request);
    await requireSession(request, env);
    const body = await readJson(request);
    const checkpoint = body?.checkpoint;
    if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
      return json({ ok: false, error: "缺少可重試的存檔檢查點。" }, 400);
    }
    const data = await commitWorldTurn(env, checkpoint);
    return json({ ok: true, data });
  } catch (error) {
    return errorResponse(error);
  }
}
