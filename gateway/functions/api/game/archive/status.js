import { requireSession } from "../../../../lib/auth.js";
import { getWorldArchiveStatus } from "../../../../lib/engine.js";
import { errorResponse, json, requireMethod } from "../../../../lib/http.js";
import { validateArchiveRequest } from "../../../../lib/world-management.js";

export async function onRequest({ request, env }) {
  try {
    requireMethod(request, ["GET"]);
    await requireSession(request, env);
    const url = new URL(request.url);
    const operation = validateArchiveRequest({
      mode: url.searchParams.get("mode"),
      expectedWorldId: url.searchParams.get("expectedWorldId"),
      operationKey: url.searchParams.get("operationKey"),
    });
    const status = await getWorldArchiveStatus(env, operation);
    return json({ ok: true, mode: operation.mode, status });
  } catch (error) {
    return errorResponse(error);
  }
}
