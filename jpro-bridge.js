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
