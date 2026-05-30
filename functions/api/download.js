// Cloudflare Pages Function
// /api/download?rcept_no=20190401004781
// DART 원문(document.xml)을 ZIP binary로 받아서 그대로 사용자에게 전달

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const rcept = url.searchParams.get('rcept_no');
  const filename = url.searchParams.get('fn') || rcept;

  const KEY = env.DART_API_KEY;
  if (!KEY) {
    return new Response('DART_API_KEY 미설정', { status: 500 });
  }
  if (!rcept) {
    return new Response('rcept_no 누락', { status: 400 });
  }

  const target = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${KEY}&rcept_no=${rcept}`;

  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });

    // DART는 에러 시 JSON, 정상 시 ZIP binary 반환
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const errText = await res.text();
      return new Response(errText, {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const buf = await res.arrayBuffer();
    const safeName = encodeURIComponent(filename).replace(/[^a-zA-Z0-9_.-]/g, '_');

    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${rcept}.zip"; filename*=UTF-8''${safeName}.zip`,
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (e) {
    return new Response('다운로드 실패: ' + e.message, { status: 502 });
  }
}
