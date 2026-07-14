const NOTION_API = "https://api.notion.com/v1";

async function notion(path, env) {
  const res = await fetch(`${NOTION_API}${path}`, {
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": env.NOTION_VERSION,
      "Content-Type": "application/json"
    }
  });

  return await res.json();
}

async function readBlocks(blockId, env, output = []) {

  const data = await notion(
    `/blocks/${blockId}/children?page_size=100`,
    env
  );

  if (!data.results) return output;

  for (const block of data.results) {

    if (block.type === "paragraph") {
      const text = block.paragraph.rich_text
        .map(t => t.plain_text)
        .join("");

      if (text) output.push(text);
    }

    if (block.type === "heading_1") {
      output.push("\n# " + block.heading_1.rich_text.map(t => t.plain_text).join(""));
    }

    if (block.type === "heading_2") {
      output.push("\n## " + block.heading_2.rich_text.map(t => t.plain_text).join(""));
    }

    if (block.type === "heading_3") {
      output.push("\n### " + block.heading_3.rich_text.map(t => t.plain_text).join(""));
    }

    if (block.type === "callout") {
      output.push(
        block.callout.rich_text
          .map(t => t.plain_text)
          .join("")
      );
    }

    if (block.has_children) {
      await readBlocks(block.id, env, output);
    }

  }

  return output;
}

export default {

  async fetch(request, env) {

    const text = await readBlocks(
      env.HOME_PAGE_ID,
      env
    );

    return new Response(
      text.join("\n"),
      {
        headers: {
          "Content-Type": "text/plain;charset=UTF-8"
        }
      }
    );

  }

}
