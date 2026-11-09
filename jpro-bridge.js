/* J-PRO 고객 포털 ↔ EK 플랫폼 연결
 * ─────────────────────────────────────────────────────────────
 * index.html 맨 아래 <script src="jpro-bridge.js"></script> 한 줄로 붙는다. (이 줄을 지우면 연결이 끊김)
 *  1) 포털에서 들어온 샘플의뢰·발주(노션 메모에 'J-PRO(' 표시)를 실시간 서버(SSOT)로 가져와 샘플·발주 탭에 띄운다.
 *     A/S는 원래 노션 기준이라 별도 처리 없이 기존 동기화로 들어온다.
 *  2) 고객 문의(💬 J-PRO 소통기록, 작성=고객, 확인 안 함)와 가입 대기 계정을 화면 왼쪽 아래 버튼으로 알리고,
 *     버튼을 누르면 답변·확인 처리를 여기서 바로 할 수 있다.
 * 기존 기능은 건드리지 않는다. EK 플랫폼의 노션 함수(notionCall, nCreate, nUpdate)와 가져오기 함수(_ekImportNotionRows)만 쓴다.
 */
(function(){
  'use strict';
  var MSG_DB  = '7ca0d97e78b64790ba802b7e2c0544f5';   // 💬 J-PRO 소통기록
  var ACCT_DB = '3bf01c81f1b542228a829b6b37dfa218';   // 🔐 J-PRO 계정
  var ACCT_URL = 'https://www.notion.so/' + ACCT_DB;
  var POLL_MS = 3 * 60 * 1000;
  var state = { msgs: [], pending: 0, open: false, busy: false };

  function ready(){
    return typeof notionCfg !== 'undefined' && notionCfg && notionCfg.workerUrl &&
      typeof window._ekImportNotionRows === 'function' && typeof notionCall === 'function' && typeof nCreate === 'function';
  }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function txt(p, k){ var v = p && p.properties && p.properties[k]; if (!v) return ''; var a = v.title || v.rich_text || []; return a.map(function(x){ return x.plain_text || ''; }).join(''); }
  function sel(p, k){ var v = p && p.properties && p.properties[k]; return (v && v.select && v.select.name) || ''; }
  function rt(s){ return { rich_text: [{ text: { content: String(s || '').slice(0, 1900) } }] }; }

  // 1) 접수 가져오기 — 최근 45일 안에 포털로 들어온 건만 조회 (이미 있는 건은 건너뜀)
  async function importOrders(){
    var since = new Date(Date.now() - 45 * 864e5).toISOString();
    var filter = { and: [ { property: '메모', rich_text: { contains: 'J-PRO(' } }, { timestamp: 'created_time', created_time: { on_or_after: since } } ] };
    var n = 0;
    try { n += (await window._ekImportNotionRows('sample', { filter: filter })) || 0; } catch (e) { console.warn('[J-PRO] 샘플 가져오기', e && e.message); }
    try { n += (await window._ekImportNotionRows('order',  { filter: filter })) || 0; } catch (e) { console.warn('[J-PRO] 발주 가져오기', e && e.message); }
    if (n){
      try { renderTab(); } catch (_) {}
      try { updateBadges(); } catch (_) {}
      try { showToast('🧾 J-PRO로 새 접수 ' + n + '건이 들어왔습니다', 'var(--grn)', 4000); } catch (_) {}
    }
  }

  // 2) 문의·가입 대기
  async function loadInbox(){
    var r = await notionCall('POST', '/databases/' + MSG_DB + '/query', {
      page_size: 100, filter: { and: [ { property: '작성', select: { equals: '고객' } }, { property: '확인', checkbox: { equals: false } } ] },
      sorts: [ { timestamp: 'created_time', direction: 'ascending' } ] }, { bypassCircuit: true });
    state.msgs = ((r && r.results) || []).filter(function(p){ return !p.archived && !p.in_trash; });
    var a = await notionCall('POST', '/databases/' + ACCT_DB + '/query', { page_size: 100, filter: { property: '상태', select: { equals: '승인 대기' } } }, { bypassCircuit: true });
    state.pending = ((a && a.results) || []).filter(function(p){ return !p.archived; }).length;
    paint();
  }

  function paint(){
    var n = state.msgs.length, btn = document.getElementById('jproInboxBtn');
    if (!n && !state.pending){ if (btn) btn.remove(); closePanel(); return; }
    if (!btn){
      btn = document.createElement('button'); btn.id = 'jproInboxBtn'; btn.type = 'button';
      btn.style.cssText = 'position:fixed;left:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:9000;border:0;border-radius:999px;padding:10px 16px;font-weight:700;font-size:13px;cursor:pointer;background:#f15a24;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.18)';
      btn.addEventListener('click', function(){ state.open ? closePanel() : openPanel(); });
      document.body.appendChild(btn);
    }
    btn.textContent = '💬 J-PRO' + (n ? ' 문의 ' + n : '') + (state.pending ? ' · 가입 대기 ' + state.pending : '');
    if (state.open) openPanel();
  }
  function closePanel(){ state.open = false; var p = document.getElementById('jproInbox'); if (p) p.remove(); }
  function openPanel(){
    state.open = true;
    var p = document.getElementById('jproInbox');
    if (!p){
      p = document.createElement('div'); p.id = 'jproInbox';
      p.style.cssText = 'position:fixed;left:16px;bottom:calc(64px + env(safe-area-inset-bottom,0px));z-index:9000;width:min(440px,calc(100vw - 32px));max-height:70vh;overflow:auto;background:var(--bg,#fff);color:var(--t1,#111);border:1px solid var(--bd,#ddd);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.2);padding:14px;font-size:13px';
      document.body.appendChild(p);
      p.addEventListener('click', onPanelClick);
    }
    var rows = state.msgs.map(function(m){
      var d = String(m.created_time || '').slice(5, 16).replace('T', ' ');
      return '<div data-id="' + m.id + '" style="border-top:1px solid var(--bd,#eee);padding:10px 0;display:flex;flex-direction:column;gap:6px">'
        + '<div><b>' + esc(txt(m, '이니셜')) + '</b> · ' + esc(sel(m, '대상')) + ' <span style="font-family:monospace">' + esc(txt(m, '대상번호')) + '</span> <span style="color:#888">' + esc(d) + ' · ' + esc(txt(m, '작성자')) + '</span></div>'
        + '<div style="white-space:pre-wrap">' + esc(txt(m, '내용')) + '</div>'
        + photoLinks(txt(m, '사진JSON'))
        + '<textarea rows="2" placeholder="답변 (고객 화면 소통 기록에 바로 보입니다)" style="width:100%;box-sizing:border-box;border:1px solid var(--bd,#ccc);border-radius:8px;padding:6px 8px;font:inherit;background:transparent;color:inherit"></textarea>'
        + '<div style="display:flex;gap:6px;justify-content:flex-end"><button type="button" data-act="ok" style="' + btnCss(false) + '">확인만</button><button type="button" data-act="reply" style="' + btnCss(true) + '">답변 보내기</button></div></div>';
    }).join('');
    p.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:15px">J-PRO 고객 문의</b><span style="margin-left:auto"></span><button type="button" data-act="close" style="' + btnCss(false) + '">닫기</button></div>'
      + (state.pending ? '<div style="margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(241,90,36,.1)">가입 대기 ' + state.pending + '명 · <a href="' + ACCT_URL + '" target="_blank" rel="noopener">계정 DB에서 승인</a> (이니셜 넣고 상태를 "승인"으로)</div>' : '')
      + (rows || '<div style="padding:12px 0;color:#888">새 문의가 없습니다.</div>');
  }
  function btnCss(pri){ return 'border:1px solid ' + (pri ? '#f15a24' : 'var(--bd,#ccc)') + ';background:' + (pri ? '#f15a24' : 'transparent') + ';color:' + (pri ? '#fff' : 'inherit') + ';border-radius:8px;padding:5px 10px;font-weight:600;cursor:pointer;font-size:12px'; }
  function photoLinks(s){
    try { var a = JSON.parse(s || '[]'); if (!a.length) return ''; return '<div>' + a.map(function(f){ return '<a href="' + esc(f.url) + '" target="_blank" rel="noopener">📎 ' + esc(f.name || '사진') + '</a>'; }).join(' ') + '</div>'; } catch (_) { return ''; }
  }
  async function onPanelClick(e){
    var b = e.target.closest('button'); if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'close'){ closePanel(); return; }
    var row = b.closest('[data-id]'); if (!row || state.busy) return;
    var m = state.msgs.find(function(x){ return x.id === row.getAttribute('data-id'); }); if (!m) return;
    var reply = (row.querySelector('textarea').value || '').trim();
    if (act === 'reply' && !reply){ row.querySelector('textarea').focus(); return; }
    state.busy = true; b.disabled = true; b.textContent = '보내는 중…';
    try {
      if (act === 'reply'){
        var r = await nCreate(MSG_DB, { '내용': { title: [{ text: { content: reply.slice(0, 1900) } }] }, '이니셜': rt(txt(m, '이니셜')), '대상': { select: { name: sel(m, '대상') || '샘플' } },
          '대상번호': rt(txt(m, '대상번호')), '작성': { select: { name: 'EK' } }, '작성자': rt('EK'), '확인': { checkbox: true } });
        if (!r) throw new Error('답변을 저장하지 못했습니다');
      }
      var u = await notionCall('PATCH', '/pages/' + m.id, { properties: { '확인': { checkbox: true } } }, { bypassCircuit: true });
      if (!u) throw new Error('확인 표시를 저장하지 못했습니다');
      state.msgs = state.msgs.filter(function(x){ return x.id !== m.id; });
      try { showToast(act === 'reply' ? '답변을 보냈습니다' : '확인했습니다', 'var(--grn)', 2000); } catch (_) {}
      paint();
    } catch (err){
      try { showToast('⚠ ' + (err.message || '처리하지 못했습니다'), 'var(--red)', 4000); } catch (_) {}
      b.disabled = false; b.textContent = act === 'reply' ? '답변 보내기' : '확인만';
    } finally { state.busy = false; }
  }

  async function tick(){
    if (!ready()) return;
    try { await importOrders(); } catch (e) { console.warn('[J-PRO]', e && e.message); }
    try { await loadInbox(); } catch (e) { console.warn('[J-PRO] 문의', e && e.message); }
  }
  setTimeout(tick, 12000);
  setInterval(function(){ if (!document.hidden) tick(); }, POLL_MS);
  window.jproSyncNow = tick;   // 콘솔에서 바로 가져오기: jproSyncNow()
})();

/* ── 🏭 J-PRO 공장 화면 → EK 플랫폼 ─────────────────────────────
 * 공장이 /factory 에서 올린 것 두 가지를 왼쪽 아래 「🏭 공장」 버튼으로 알린다.
 *  1) 출고 명세서(🏭 공장 출고 신고 DB, 반영 안 됨)
 *     · 「입출고 등록」 → 입출고 창을 중국 입고로 채워 엶 (서류 사진 첨부, 재고 반영 체크는 끔)
 *     · 「발주 입고현황」 → 발주 창을 열고 품목별 입고 기록을 넣어 둠 → 확인 후 저장하면 재고 반영
 *     · 「반영 완료」 → 공장 화면에 'EK 입고 완료'로 바뀜
 *  2) 공장 출고일 회신(발주·샘플의 공장출고일변경이력 마지막 값이 공장출고일과 다름)
 *     · 「반영」 → 발주/샘플 창의 공장 출고일 칸에 넣어 둠 → 저장
 *     · 「그대로」 → 회신을 확인한 것으로 표시
 * 저장은 모두 플랫폼 창의 저장 버튼으로 (실시간 서버가 기준이므로 노션에 직접 쓰지 않음)
 */
(function(){
  'use strict';
  var SHIP_DB = '084073b76d334df5b2a9309d420a9c4e', ORD_DB = '97ff79daa2c04b309df42a7a1a2c7b89', SMP_DB = 'dad8448577d74ea8bbbcb52f4419be3b';
  var st = { reps: [], dates: [], open: false, busy: false };
  function ok(){ return typeof notionCfg !== 'undefined' && notionCfg && notionCfg.workerUrl && typeof notionCall === 'function'; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function txt(p, k){ var v = p && p.properties && p.properties[k]; if (!v) return ''; return (v.title || v.rich_text || []).map(function(x){ return x.plain_text || ''; }).join(''); }
  function dt(p, k){ var v = p && p.properties && p.properties[k]; return (v && v.date && v.date.start || '').slice(0, 10); }
  function js(s, d){ try { return JSON.parse(String(s || '').replace(/^JSON::/, '')); } catch (_) { return d; } }
  function md(d){ return d ? Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10)) : '—'; }
  function today(){ return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
  function chunks(s){ var o = []; for (var i = 0; i < s.length && o.length < 90; i += 1900) o.push({ text: { content: s.slice(i, i + 1900) } }); return o.length ? o : [{ text: { content: '' } }]; }
  function nid(x){ return String(x || '').replace(/-/g, ''); }
  function findLocal(kind, pid, no){
    var arr = kind === 's' ? (typeof samples !== 'undefined' ? samples : []) : (typeof orders !== 'undefined' ? orders : []);
    return arr.find(function(x){ return x && nid(x._notionId) === nid(pid); }) || (no && kind !== 's' ? arr.find(function(x){ return x && x.no === no; }) : null) || null;
  }
  async function q(db, filter, sorts){
    var r = await notionCall('POST', '/databases/' + db + '/query', { page_size: 100, filter: filter, sorts: sorts }, { bypassCircuit: true });
    return ((r && r.results) || []).filter(function(p){ return !p.archived && !p.in_trash; });
  }
  async function load(){
    st.reps = await q(SHIP_DB, { property: '반영', checkbox: { equals: false } }, [{ property: '출고일', direction: 'ascending' }]);
    var f = { property: '공장출고일변경이력', rich_text: { is_not_empty: true } };
    var rows = (await q(ORD_DB, f)).map(function(p){ return { kind: 'o', p: p }; }).concat((await q(SMP_DB, f)).map(function(p){ return { kind: 's', p: p }; }));
    st.dates = rows.map(function(r){
      var h = js(txt(r.p, '공장출고일변경이력'), []) || [], last = h[h.length - 1];
      if (!last || last.ek || last.to === dt(r.p, '공장출고일')) return null;
      return { kind: r.kind, pid: r.p.id, no: r.kind === 's' ? txt(r.p, '샘플명') : txt(r.p, '발주번호'), fac: txt(r.p, '공장'), cur: dt(r.p, '공장출고일'), last: last, hist: h };
    }).filter(Boolean);
    paint();
  }
  function css(pri){ return 'border:1px solid ' + (pri ? '#0f766e' : 'var(--bd,#ccc)') + ';background:' + (pri ? '#0f766e' : 'transparent') + ';color:' + (pri ? '#fff' : 'inherit') + ';border-radius:8px;padding:5px 10px;font-weight:600;cursor:pointer;font-size:12px'; }
  function paint(){
    var n = st.reps.length + st.dates.length, btn = document.getElementById('jproFacBtn');
    if (!n){ if (btn) btn.remove(); close(); return; }
    if (!btn){
      btn = document.createElement('button'); btn.id = 'jproFacBtn'; btn.type = 'button';
      btn.style.cssText = 'position:fixed;left:16px;bottom:calc(64px + env(safe-area-inset-bottom,0px));z-index:9000;border:0;border-radius:999px;padding:10px 16px;font-weight:700;font-size:13px;cursor:pointer;background:#0f766e;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.18)';
      btn.addEventListener('click', function(){ st.open ? close() : open(); });
      document.body.appendChild(btn);
    }
    btn.textContent = '🏭 공장' + (st.reps.length ? ' 출고 ' + st.reps.length : '') + (st.dates.length ? ' · 출고일 회신 ' + st.dates.length : '');
    if (st.open) open();
  }
  function close(){ st.open = false; var p = document.getElementById('jproFac'); if (p) p.remove(); }
  function open(){
    st.open = true;
    var ib = document.getElementById('jproInbox'); if (ib) ib.remove();
    var p = document.getElementById('jproFac');
    if (!p){
      p = document.createElement('div'); p.id = 'jproFac';
      p.style.cssText = 'position:fixed;left:16px;bottom:calc(112px + env(safe-area-inset-bottom,0px));z-index:9001;width:min(480px,calc(100vw - 32px));max-height:70vh;overflow:auto;background:var(--bg,#fff);color:var(--t1,#111);border:1px solid var(--bd,#ddd);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.2);padding:14px;font-size:13px';
      document.body.appendChild(p); p.addEventListener('click', onClick);
    }
    var reps = st.reps.map(function(r){
      var items = js(txt(r, '품목JSON'), []) || [], docs = js(txt(r, '서류JSON'), []) || [], by = {};
      items.forEach(function(it){ (by[it.no] = by[it.no] || []).push(it); });
      var total = items.reduce(function(a, x){ return a + (+x.qty || 0); }, 0);
      return '<div data-rep="' + r.id + '" style="border-top:1px solid var(--bd,#eee);padding:10px 0;display:flex;flex-direction:column;gap:6px">'
        + '<div><b>' + esc(txt(r, '공장')) + ' · ' + md(dt(r, '출고일')) + ' 출고</b> · ' + total + '개 <span style="color:#888">' + esc(txt(r, '작성자')) + '</span></div>'
        + Object.keys(by).map(function(no){ var its = by[no], kind = its[0].kind;
            return '<div style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1"><b>' + esc(no) + '</b> ' + its.map(function(it){ return esc(it.name || it.code) + (it.size ? ' ' + esc(it.size) : '') + ' <b>' + it.qty + '</b>'; }).join(', ') + '</div>'
              + '<button type="button" data-act="rcv" data-no="' + esc(no) + '" style="' + css(false) + '">' + (kind === 's' ? '샘플 열기' : '발주 입고현황') + '</button></div>'; }).join('')
        + (txt(r, '메모') ? '<div style="color:#666">' + esc(txt(r, '메모')) + '</div>' : '')
        + (docs.length ? '<div>' + docs.map(function(f){ return '<a href="' + esc(f.url) + '" target="_blank" rel="noopener">📎 ' + esc(f.name || '서류') + '</a>'; }).join(' ') + '</div>' : '')
        + '<div style="display:flex;gap:6px;justify-content:flex-end"><button type="button" data-act="io" style="' + css(false) + '">입출고 등록</button><button type="button" data-act="done" style="' + css(true) + '">반영 완료</button></div></div>';
    }).join('');
    var dates = st.dates.map(function(d, i){
      return '<div data-date="' + i + '" style="border-top:1px solid var(--bd,#eee);padding:10px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:200px">'
        + '<b>' + (d.kind === 's' ? '샘플 ' : '') + esc(d.no) + '</b> <span style="color:#888">' + esc(d.fac) + '</span><br>공장 출고일 ' + md(d.cur) + ' → <b>' + md(d.last.to) + '</b>' + (d.last.reason ? ' · ' + esc(d.last.reason) : '') + ' <span style="color:#888">(' + md(String(d.last.at || '').slice(0, 10)) + ' 회신)</span></div>'
        + '<button type="button" data-act="keep" style="' + css(false) + '">그대로</button><button type="button" data-act="apply" style="' + css(true) + '">반영</button></div>';
    }).join('');
    p.innerHTML = '<div style="display:flex;align-items:center;gap:8px"><b style="font-size:15px">🏭 공장에서 온 것</b><span style="margin-left:auto"></span><button type="button" data-act="close" style="' + css(false) + '">닫기</button></div>'
      + (reps ? '<div style="margin-top:8px;font-weight:700">출고 명세서</div>' + reps : '')
      + (dates ? '<div style="margin-top:12px;font-weight:700">출고일 회신</div>' + dates : '');
  }
  function toast(m, c){ try { showToast(m, c || 'var(--grn)', 3500); } catch (_) {} }
  function set(id, v){ var el = document.getElementById(id); if (el){ el.value = v; el.style.outline = '2px solid #0f766e'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } }
  // 발주 창 열고 입고 기록 넣기
  function openOrderRcv(rep, no){
    var items = (js(txt(rep, '품목JSON'), []) || []).filter(function(it){ return it.no === no; });
    if (!items.length) return;
    var kind = items[0].kind, o = findLocal(kind, items[0].pid, no);
    if (!o){ toast('⚠ 플랫폼에서 ' + no + ' 를 찾지 못했습니다. 새로고침 후 다시 해 주세요', 'var(--red)'); return; }
    close();
    if (kind === 's'){ openSmpModal(o.id); toast('샘플 ' + (o.name || '') + ' — 상태를 바꾼 뒤 저장해 주세요'); return; }
    openOrdModal(o.id);
    var date = today(), memo = 'J-PRO 공장 출고 ' + md(dt(rep, '출고일')), put = 0, miss = [];
    items.forEach(function(it){
      var row = ordRowsBuf[it.i] && (ordRowsBuf[it.i].itemCode || '') === (it.code || '') ? ordRowsBuf[it.i]
        : ordRowsBuf.find(function(r){ return (r.itemCode || '') === (it.code || '') && String(r.size || '') === String(it.size || ''); })
        || ordRowsBuf.find(function(r){ return it.code && r.itemCode === it.code; });
      if (!row){ miss.push(it.name || it.code); return; }
      row.rcvHistory = row.rcvHistory || [];
      if (row.rcvHistory.some(function(h){ return h && h.note === memo && +h.qty === +it.qty; })) return;   // 두 번 누름 방지
      row.rcvHistory.push({ date: date, qty: +it.qty, note: memo }); row._expanded = true; put++;
    });
    try { renderOrdRows(); } catch (_) {}
    toast('입고 기록 ' + put + '줄을 넣었습니다' + (miss.length ? ' · 못 찾은 품목: ' + miss.join(', ') : '') + ' — 날짜·수량 확인 후 저장', miss.length ? 'var(--org)' : 'var(--grn)');
  }
  // 입출고 창(중국 입고) 채워서 열기
  function openIo(rep){
    var items = js(txt(rep, '품목JSON'), []) || [], docs = js(txt(rep, '서류JSON'), []) || [];
    close(); openIoModal(null);
    set('io_date', today()); set('io_kind', '입고'); set('io_flow', '중국→한국'); set('io_vendor', txt(rep, '공장'));
    set('io_qty', items.reduce(function(a, x){ return a + (+x.qty || 0); }, 0));
    set('io_items', items.map(function(it){ return it.no + ' ' + (it.name || it.code) + (it.size ? ' ' + it.size : '') + ' ' + it.qty; }).join(', '));
    set('io_memo', 'J-PRO 공장 출고 신고 ' + md(dt(rep, '출고일')) + (txt(rep, '메모') ? ' · ' + txt(rep, '메모') : ''));
    var cb = document.getElementById('io_applyStock'); if (cb) cb.checked = false;
    try { _ioPhotoBuf = docs.map(function(f){ return { name: f.name, url: f.url, type: f.type || '' }; }); _renderIoPhotoGrid(); } catch (_) {}
    toast('중국 입고로 채웠습니다 — 확인 후 등록 (재고는 발주 입고현황으로 반영)');
  }
  async function onClick(e){
    var b = e.target.closest('button'); if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'close'){ close(); return; }
    var rw = b.closest('[data-rep]'), dw = b.closest('[data-date]');
    var rep = rw && st.reps.find(function(x){ return x.id === rw.getAttribute('data-rep'); });
    if (act === 'rcv' && rep){ openOrderRcv(rep, b.getAttribute('data-no')); return; }
    if (act === 'io' && rep){ openIo(rep); return; }
    if (st.busy) return;
    if (act === 'done' && rep){
      st.busy = true; b.disabled = true;
      try { var u = await notionCall('PATCH', '/pages/' + rep.id, { properties: { '반영': { checkbox: true }, '반영일': { date: { start: today() } } } }, { bypassCircuit: true });
        if (!u) throw new Error('저장 실패'); st.reps = st.reps.filter(function(x){ return x.id !== rep.id; }); toast('반영 완료 — 공장 화면에 입고 완료로 보입니다'); paint(); }
      catch (err){ toast('⚠ ' + err.message, 'var(--red)'); b.disabled = false; } finally { st.busy = false; }
      return;
    }
    var d = dw && st.dates[+dw.getAttribute('data-date')]; if (!d) return;
    if (act === 'apply'){
      var o = findLocal(d.kind, d.pid, d.no);
      if (!o){ toast('⚠ 플랫폼에서 ' + d.no + ' 를 찾지 못했습니다', 'var(--red)'); return; }
      close();
      if (d.kind === 's'){ openSmpModal(o.id); set('s_factShip', d.last.to); } else { openOrdModal(o.id); set('o_factShip', d.last.to); }
      toast('공장 출고일을 ' + md(d.last.to) + '로 넣었습니다 — 저장하면 반영');
      return;
    }
    if (act === 'keep'){
      st.busy = true; b.disabled = true;
      try { d.hist[d.hist.length - 1].ek = 'kept@' + today();
        var r = await notionCall('PATCH', '/pages/' + d.pid, { properties: { '공장출고일변경이력': { rich_text: chunks(JSON.stringify(d.hist)) } } }, { bypassCircuit: true });
        if (!r) throw new Error('저장 실패'); st.dates = st.dates.filter(function(x){ return x !== d; }); paint(); }
      catch (err){ toast('⚠ ' + err.message, 'var(--red)'); b.disabled = false; } finally { st.busy = false; }
    }
  }
  async function tick(){ if (!ok()) return; try { await load(); } catch (e) { console.warn('[J-PRO 공장]', e && e.message); } }
  setTimeout(tick, 15000);
  setInterval(function(){ if (!document.hidden) tick(); }, 3 * 60 * 1000);
  window.jproFactoryNow = tick;
})();
