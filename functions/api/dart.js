// Cloudflare Pages Function
// /api/dart?type=company&name=삼성전자   → 종목명으로 corp_code 검색
// /api/dart?type=list&corp_code=00126380&bgn_de=...&end_de=...&pblntf_ty=A&page_no=1
//
// API 키는 Cloudflare 환경변수 DART_API_KEY 에서 읽음

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const params = url.searchParams;
  const type = params.get('type');

  const KEY = env.DART_API_KEY;
  if (!KEY) {
    return json({ status: 'error', message: 'DART_API_KEY 환경변수가 설정되지 않았습니다.' }, 500);
  }

  try {
    if (type === 'company') {
      // 종목명 → corp_code 검색
      const name = (params.get('name') || '').trim();
      if (!name) return json({ status: 'error', message: '종목명이 비었습니다.' }, 400);

      const corps = await getCorpList(KEY);
      if (corps.error) return json({ status: 'error', message: corps.error }, 502);

      // 이름 매칭: 정확 일치 우선, 그다음 포함, 상장사(stock_code 있음) 우선
      const lower = name.toLowerCase();
      let matches = corps.list.filter(c => c.corp_name && c.corp_name.toLowerCase() === lower);
      if (matches.length === 0) {
        matches = corps.list.filter(c => c.corp_name && c.corp_name.toLowerCase().includes(lower));
      }
      if (matches.length === 0) {
        return json({ status: '013', message: `"${name}" 법인을 찾을 수 없습니다.`, corp_list: [] }, 200);
      }
      // 상장사 우선 정렬
      matches.sort((a, b) => (b.stock_code ? 1 : 0) - (a.stock_code ? 1 : 0));
      const top = matches.slice(0, 10).map(c => ({
        corp_code: c.corp_code,
        corp_name: c.corp_name,
        stock_code: c.stock_code || ''
      }));
      return json({ status: '000', message: '정상', corp_list: top }, 200);

    } else if (type === 'list') {
      const corp = params.get('corp_code') || '';
      const bgn = params.get('bgn_de') || '';
      const end = params.get('end_de') || '';
      const ty = params.get('pblntf_ty') || '';
      const page = params.get('page_no') || '1';
      let q = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${KEY}&corp_code=${corp}&page_no=${page}&page_count=100`;
      if (bgn) q += `&bgn_de=${bgn}&end_de=${end}`;
      if (ty) q += `&pblntf_ty=${ty}`;

      const res = await fetch(q, { redirect: 'manual' });
      const data = await res.json();
      return json(data, 200);

    } else {
      return json({ status: 'error', message: '알 수 없는 요청 타입입니다.' }, 400);
    }
  } catch (e) {
    return json({ status: 'error', message: 'DART 호출 실패: ' + e.message }, 502);
  }
}

// 전체 기업 고유번호 목록 (corpCode.xml → ZIP → XML 파싱)
// Cloudflare Cache API로 캐싱하여 매번 다운로드 방지
let MEM_CACHE = null;

async function getCorpList(key) {
  if (MEM_CACHE) return MEM_CACHE;

  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${key}`;
  const res = await fetch(url, { redirect: 'manual' });

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json') || ct.includes('html')) {
    const t = await res.text();
    return { error: 'corpCode 조회 실패 (키 권한/형식 확인): ' + t.slice(0, 120) };
  }

  const zipBuf = await res.arrayBuffer();
  let xmlText;
  try {
    xmlText = await unzipSingleFile(zipBuf);
  } catch (e) {
    return { error: 'ZIP 해제 실패: ' + e.message };
  }

  const list = parseCorpXml(xmlText);
  MEM_CACHE = { list };
  return MEM_CACHE;
}

// ZIP에서 첫 번째 파일을 꺼내 텍스트로 반환 (deflate raw 가정)
async function unzipSingleFile(buf) {
  const dv = new DataView(buf);
  // Local file header signature: 0x04034b50 (PK\x03\x04)
  if (dv.getUint32(0, true) !== 0x04034b50) {
    throw new Error('ZIP 시그니처 불일치');
  }
  const compMethod = dv.getUint16(8, true);       // 0=stored, 8=deflate
  const compSize = dv.getUint32(18, true);
  const fnLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const dataStart = 30 + fnLen + extraLen;
  const compData = buf.slice(dataStart, dataStart + compSize);

  if (compMethod === 0) {
    return new TextDecoder('utf-8').decode(compData);
  }
  // deflate-raw 해제 (Cloudflare Workers 내장 DecompressionStream)
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(compData).body.pipeThrough(ds);
  const out = await new Response(stream).arrayBuffer();
  return new TextDecoder('utf-8').decode(out);
}

// CORPCODE.xml 파싱: <list><corp_code>..</corp_code><corp_name>..</corp_name><stock_code>..</stock_code>..</list>
function parseCorpXml(xml) {
  const result = [];
  const re = /<list>([\s\S]*?)<\/list>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const code = pick(block, 'corp_code');
    const name = pick(block, 'corp_name');
    const stock = pick(block, 'stock_code');
    if (code && name) {
      result.push({ corp_code: code, corp_name: name, stock_code: stock });
    }
  }
  return result;
}

function pick(block, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
  return m ? m[1].trim() : '';
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
