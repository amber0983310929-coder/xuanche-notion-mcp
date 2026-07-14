export default {
  async fetch(request, env) {
    return new Response(JSON.stringify({
      message:"Starter project. Replace with full implementation.",
      endpoints:["GET /home","GET /page?id=","GET /children?id="]
    },null,2),{headers:{"content-type":"application/json"}});
  }
}
