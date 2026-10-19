/**
 * Notion API 中継（CORSプロキシ） for Cloudflare Workers
 * - リクエストをそのまま https://api.notion.com に転送し、CORSヘッダーを付けて返すだけ。
 * - トークン等は一切保存・記録しません。
 * - 環境変数 ALLOWED_ORIGINS に許可するオリジンをカンマ区切りで設定してください。
 *     例: https://yourname.github.io
 *   未設定の場合はすべてのオリジンを許可します（非推奨）。
 */
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const allowOrigin = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : '');
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin || 'null',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Notion-Version, Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (!allowOrigin) return new Response('Origin not allowed', { status: 403, headers: cors });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/v1/')) return new Response('Not found', { status: 404, headers: cors });

    const headers = new Headers();
    for (const h of ['authorization', 'notion-version', 'content-type']) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const res = await fetch('https://api.notion.com' + url.pathname + url.search, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
    });
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
