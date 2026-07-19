import {
  authConfiguration,
  clearSessionCookie,
  createOwnerSession,
  requireSession,
} from "../../lib/auth.js";
import { errorResponse, json, readJson, requireMethod, requireSameOrigin } from "../../lib/http.js";

export async function onRequest({ request, env }) {
  try {
    requireMethod(request, ["GET", "POST", "DELETE"]);
    if (request.method === "GET") {
      try {
        const session = await requireSession(request, env);
        return json({ ok: true, authenticated: true, session, configuration: authConfiguration(env) });
      } catch (error) {
        if (error?.status !== 401) throw error;
        return json({ ok: true, authenticated: false, configuration: authConfiguration(env) });
      }
    }

    requireSameOrigin(request);
    if (request.method === "DELETE") {
      return json({ ok: true, authenticated: false }, 200, { "set-cookie": clearSessionCookie() });
    }

    const body = await readJson(request, 8_000);
    const session = await createOwnerSession(body.passphrase, env);
    return json(
      { ok: true, authenticated: true, expiresAt: session.expiresAt },
      200,
      { "set-cookie": session.cookie },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
