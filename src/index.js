export default {
  async fetch(request, env) {

    return new Response(JSON.stringify({
      status: "ok",
      message: "Notion MCP Ready",
      token: !!env.NOTION_TOKEN,
      version: env.NOTION_VERSION
    }), {
      headers: {
        "content-type": "application/json"
      }
    });

  }
}
