import { requireSession } from "../../../lib/auth.js";
import { initializeGameWorld } from "../../../lib/engine.js";
import { errorResponse, json, readJson, requireMethod, requireSameOrigin } from "../../../lib/http.js";
import { validateInitializationRequest } from "../../../lib/world-management.js";

export async function onRequest({ request, env }) {
  try {
    requireMethod(request, ["POST"]);
    requireSameOrigin(request);
    await requireSession(request, env);
    const initialization = validateInitializationRequest(await readJson(request, 24_000));
    const data = await initializeGameWorld(env, {
      saveKey: initialization.saveKey,
      character: initialization.character,
      opening: initialization.opening,
    });
    return json({ ok: true, mode: initialization.mode, data });
  } catch (error) {
    return errorResponse(error);
  }
}
