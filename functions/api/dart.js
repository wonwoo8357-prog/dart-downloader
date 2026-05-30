// Cloudflare Pages Function
// /api/dart?type=company&name=삼성전자   → 종목명으로 corp_code 검색
// /api/dart?type=list&corp_code=00126380&bgn_de=...&end_de=...&pblntf_ty=A&page_no=1
//
// API 키는 Cloudflare 환경변수 DART_API_KEY 에서 읽음
// 외부 라이브러리 없이 동작 (ZIP은 Local File Header를 스캔해 deflate-raw로 해제)

export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);
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

      const corps = await getCorpList(KEY);
      if (corps.error) return json({ status: 'error', message: corps.error }, 502);

      const lower = name.toLowerCase();
      let matches = corps.list.filter(c => c.corp_name && c.corp_name.toLowerCase() === lower);
      if (matches.length === 0) {
        matches = corps.list.filter(c => c.corp_name && c.corp_name.toLowerCase().includes(lower));
      }
      if (matches.length === 0) {
        return json({ status: '013', message: `"${name}" 법인을 찾을 수 없습니다.`, corp_list: [] }, 200);
      }
      matches.sort((a, b) => (b.stock_code ? 1 : 0) - (a.stock_code ? 1 : 0));
      const top = matches.slice(0, 10).map(c => ({
        corp_code: c.corp_code, corp_name: c.corp_name, stock_code: c.stock_code || ''
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
    xmlText = await unzipFirstFile(zipBuf);
  } catch (e) {
    return { error: 'ZIP 해제 실패: ' + e.message };
  }

  const list = parseCorpXml(xmlText);
  if (list.length === 0) return { error: '기업 목록 파싱 결과가 비었습니다.' };
  MEM_CACHE = { list };
  return MEM_CACHE;
}

// ZIP의 Local File Header(PK\x03\x04)를 직접 스캔하여 첫 파일을 deflate-raw로 해제.
// data descriptor(크기 0) 케이스를 대비해, 압축 크기가 0이면 다음 헤더/중앙디렉토리까지를 데이터로 간주.
async function unzipFirstFile(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);

  // 첫 Local File Header 확인
  if (dv.getUint32(0, true) !== 0x04034b50) {
    throw new Error('ZIP 시그니처 불일치');
  }

  const method = dv.getUint16(8, true);     // 8 = deflate, 0 = stored
  let compSize = dv.getUint32(18, true);
  const fnLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  const dataStart = 30 + fnLen + extraLen;

  // 압축 크기가 헤더에 없으면(streaming), 다음 PK 시그니처 전까지를 데이터로 추정
  if (compSize === 0) {
    let end = u8.length;
    for (let i = dataStart; i < u8.length - 3; i++) {
      // 다음 local header(PK\x03\x04) 또는 중앙 디렉토리(PK\x01\x02) 또는 data descriptor(PK\x07\x08)
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b &&
          ((u8[i + 2] === 0x03 && u8[i + 3] === 0x04) ||
           (u8[i + 2] === 0x01 && u8[i + 3] === 0x02) ||
           (u8[i + 2] === 0x07 && u8[i + 3] === 0x08))) {
        end = i;
        break;
      }
    }
    compSize = end - dataStart;
  }

  const compData = u8.slice(dataStart, dataStart + compSize);

  if (method === 0) {
    return new TextDecoder('utf-8').decode(compData);
  }

  // deflate-raw 해제 (Workers 내장)
  const ds = new DecompressionStream('deflate-raw');
  const out = await new Response(new Blob([compData]).stream().pipeThrough(ds)).arrayBuffer();
  return new TextDecoder('utf-8').decode(out);
}

function parseCorpXml(xml) {
  const result = [];
  const re = /<list>([\s\S]*?)<\/list>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const code = pick(block, 'corp_code');
    const name = pick(block, 'corp_name');
    const stock = pick(block, 'stock_code');
    if (code && name) result.push({ corp_code: code, corp_name: name, stock_code: stock });
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
