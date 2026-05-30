// Cloudflare Pages Function
// /api/dart?type=company&name=삼성전자   → 종목명으로 corp_code 검색 (정적 corps.json 사용)
// /api/dart?type=list&corp_code=00126380&bgn_de=...&end_de=...&pblntf_ty=A&page_no=1
//
// API 키는 Cloudflare 환경변수 DART_API_KEY 에서 읽음
// corps.json: [[corp_name, corp_code, stock_code], ...] 형식의 전체 기업 목록 (사이트 루트에 포함)

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const params = url.searchParams;
  const type = params.get('type');

  const KEY = env.DART_API_KEY;
  if (!KEY) {
    return json({ status: 'error', message: 'DART_API_KEY 환경변수가 설정되지 않았습니다.' }, 500);
  }

  try {
    if (type === 'company') {
      const name = (params.get('name') || '').trim();
      if (!name) return json({ status: 'error', message: '종목명이 비었습니다.' }, 400);

      // 같은 사이트의 정적 corps.json 읽기
      const origin = url.origin;
      const res = await fetch(`${origin}/corps.json`);
      if (!res.ok) {
        return json({ status: 'error', message: 'corps.json 로드 실패 (' + res.status + ')' }, 502);
      }
      const rows = await res.json(); // [[name, code, stock], ...]

      const lower = name.toLowerCase();
      let matches = rows.filter(r => r[0] && r[0].toLowerCase() === lower);
      if (matches.length === 0) {
        matches = rows.filter(r => r[0] && r[0].toLowerCase().includes(lower));
      }
      if (matches.length === 0) {
        return json({ status: '013', message: `"${name}" 법인을 찾을 수 없습니다.`, corp_list: [] }, 200);
      }
      // 상장사(stock_code 있음) 우선
      matches.sort((a, b) => (b[2] ? 1 : 0) - (a[2] ? 1 : 0));
      const top = matches.slice(0, 10).map(r => ({
        corp_code: r[1], corp_name: r[0], stock_code: r[2] || ''
      }));
      return json({ status: '000', message: '정상', corp_list: top }, 200);

    } else if (type === 'list') {
      const corp = params.get('corp_code') || '';
      const bgn = params.get('bgn_de') || '';
      const end = params.get('end_de') || '';
      const ty = params.get('pblntf_ty') || '';
      const page = params.get('page_no') || '1';
      // 파라미터 순서: corp_code → 날짜 → 유형 → 페이지 (DART 정상 동작 순서)
      let q = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${KEY}&corp_code=${corp}`;
      if (bgn) q += `&bgn_de=${bgn}&end_de=${end}`;
      if (ty) q += `&pblntf_ty=${ty}`;
      q += `&page_no=${page}&page_count=100`;

      const res = await fetch(q, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });
      const text = await res.text();
      if (!text || text.trim() === '') {
        return json({ status: 'error', message: 'DART list 응답이 비었습니다. (corp_code=' + corp + ')' }, 502);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return json({ status: 'error', message: 'DART list 응답이 JSON이 아님: ' + text.slice(0, 150) }, 502);
      }
      return json(data, 200);

    } else {
      return json({ status: 'error', message: '알 수 없는 요청 타입입니다.' }, 400);
    }
  } catch (e) {
    return json({ status: 'error', message: 'DART 호출 실패: ' + e.message }, 502);
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}
