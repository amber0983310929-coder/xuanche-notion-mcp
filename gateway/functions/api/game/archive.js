import { requireSession } from "../../../lib/auth.js";
import { startWorldArchive } from "../../../lib/engine.js";
import { errorResponse, json, readJson, requireMethod, requireSameOrigin } from "../../../lib/http.js";
import { validateArchiveRequest } from "../../../lib/world-management.js";

export async function onRequest({ request, env }) {
  try {
    requireMethod(request, ["POST"]);
    requireSameOrigin(request);
    await requireSession(request, env);
    const operation = validateArchiveRequest(await readJson(request, 8_000), { requireTypedConfirmation: true });
    const status = await startWorldArchive(env, {
      confirmation: "ARCHIVE_AND_RESET",
      expectedWorldId: operation.expectedWorldId,
      operationKey: operation.operationKey,
    });
    return json({ ok: true, mode: operation.mode, status }, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
