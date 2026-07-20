import { requireSession } from "../../../lib/auth.js";
import { commitWorldTurn, loadWorldSnapshot } from "../../../lib/engine.js";
import { GatewayError, errorResponse, readJson, requireMethod, requireSameOrigin } from "../../../lib/http.js";
import { generateTurnStream, normalizeLength, normalizeStyle } from "../../../lib/openai.js";
import { buildModelWorldContext } from "../../../lib/world.js";

export async function onRequest(context) {
  const { request, env } = context;
  try {
    requireMethod(request, ["POST"]);
    requireSameOrigin(request);
    await requireSession(request, env);
    const body = validateTurnRequest(await readJson(request));
    const snapshot = await loadWorldSnapshot(env);
    const worldContext = buildModelWorldContext(snapshot);
    assertFreshClientState(body, worldContext.state);

    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    let writable = true;
    const send = async (event, data) => {
      if (!writable) return;
      try {
        await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        writable = false;
      }
    };

    const task = (async () => {
      const startedAt = Date.now();
      let checkpoint;
      try {
        await send("meta", {
          actionKey: body.actionKey,
          worldId: worldContext.state.worldId,
          simTick: worldContext.state.simTick,
          revision: worldContext.state.revision,
        });
        const generated = await generateTurnStream({
          env,
          worldContext,
          playerAction: body.action,
          style: body.style,
          length: body.length,
          onNarrative: (text) => send("delta", { text }),
        });
        checkpoint = {
          expectedWorldId: worldContext.state.worldId,
          expectedSimTick: worldContext.state.simTick,
          expectedRevision: worldContext.state.revision,
          actionKey: body.actionKey,
          playerAction: body.action,
          ...generated,
        };
        await send("checkpoint", { checkpoint });

        try {
          const committed = await commitWorldTurn(env, checkpoint);
          await send("committed", {
            ...committed,
            narrative: generated.narrative,
            summary: generated.summary,
            mainline: generated.mainline,
            visibleResult: generated.visibleResult,
            visibleCost: generated.visibleCost,
            situation: generated.situation,
            choices: generated.choices,
            facts: generated.facts,
            playerState: committed.playerState || generated.playerState,
          });
          console.log("xuanche_pwa_turn_complete", {
            actionKey: body.actionKey,
            worldId: committed.worldId,
            simTick: committed.simTick,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          await send("save_error", {
            error: error instanceof GatewayError ? error.message : "敘事已生成，但存檔尚未完成。",
            status: error?.status || 500,
            retryable: true,
          });
        }
      } catch (error) {
        console.error("xuanche_pwa_turn_failed", {
          actionKey: body.actionKey,
          message: error?.message || String(error),
          checkpointCreated: Boolean(checkpoint),
        });
        await send("error", {
          error: error instanceof GatewayError ? error.message : "本回合生成失敗，世界狀態未變更。",
          status: error?.status || 500,
        });
      } finally {
        await send("done", { actionKey: body.actionKey });
        try {
          await writer.close();
        } catch {
          // The client may have navigated away.  The submitted action still
          // finishes and commits under waitUntil so a reload can reconcile it.
        }
      }
    })();
    if (typeof context.waitUntil === "function") context.waitUntil(task);

    return new Response(stream.readable, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function validateTurnRequest(input = {}) {
  const action = typeof input.action === "string" ? input.action.trim() : "";
  if (!action || action.length > 800) throw new GatewayError(400, "行動內容需為 1–800 字。");
  const actionKey = typeof input.actionKey === "string" ? input.actionKey.trim() : "";
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(actionKey)) throw new GatewayError(400, "actionKey 格式不正確。");
  if (typeof input.expectedWorldId !== "string" || !input.expectedWorldId.trim()) {
    throw new GatewayError(400, "缺少 expectedWorldId。");
  }
  if (!Number.isInteger(input.expectedSimTick) || !Number.isInteger(input.expectedRevision)) {
    throw new GatewayError(400, "缺少有效的世界 tick 或 revision。");
  }
  return {
    action,
    actionKey,
    expectedWorldId: input.expectedWorldId.trim(),
    expectedSimTick: input.expectedSimTick,
    expectedRevision: input.expectedRevision,
    style: normalizeStyle(input.style),
    length: normalizeLength(input.length),
  };
}

function assertFreshClientState(input, state) {
  if (
    input.expectedWorldId !== state.worldId ||
    input.expectedSimTick !== state.simTick ||
    input.expectedRevision !== state.revision
  ) {
    throw new GatewayError(409, "世界已由另一個回合更新，請重新載入後再行動。", {
      expected: {
        worldId: input.expectedWorldId,
        simTick: input.expectedSimTick,
        revision: input.expectedRevision,
      },
      actual: state,
    });
  }
}
