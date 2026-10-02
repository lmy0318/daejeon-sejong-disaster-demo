// Shared phase-two demo state. No external predictions or notifications are sent.
export function classifyOutput(rule, output) {
  if (!rule || rule.status !== '승인') return '사전 승인 필요';
  if (output.anomaly || output.confidence < rule.minConfidence) return '검토 필요';
  return '자동 통과';
}

export function notificationGate(rule, output) {
  if (!['자동 통과', '검토 승인'].includes(output.flag)) return '검토 후 결정';
  if (output.risk < rule.infoThreshold) return '기록만';
  return output.risk >= rule.warningThreshold ? '발송 대기' : '자동 발송';
}

export function validRule(rule) {
  return Boolean(rule.model?.trim() && rule.version?.trim() && rule.thresholdVersion?.trim() && rule.alertVersion?.trim()) &&
    Number.isFinite(rule.minConfidence) && rule.minConfidence >= .5 && rule.minConfidence <= 1 &&
    Number.isFinite(rule.infoThreshold) && rule.infoThreshold >= 0 &&
    Number.isFinite(rule.warningThreshold) && rule.warningThreshold <= 100 && rule.warningThreshold > rule.infoThreshold;
}

export function createAutomation(ctx) {
  const {db,roles,I,esc,badge,notice,head,empty,href,go,modal,toast,save,audit,mapSvg,chart,downloadBlob}=ctx;
  const $=s=>document.querySelector(s), now=()=>new Date().toLocaleString('ko-KR'), route=ctx.getRoute;
  const hazards=['홍수','산불','산사태'];
  const profiles={
    '홍수':{eventId:'EVT-2025-0714-DJ01',name:'갑천 수위·침수 감시',location:'대전 유성구',icon:'wave',color:'blue',model:'FloodPredict-KR',unit:'m',metric:'수위',base:3.62,risk:86,confidence:.96,x:47,y:54,forecast:[['24h 누적 강수','128 mm'],['최대 예측 수위','4.20 m'],['예측 침수면적','4.80 ㎢']],series:[2.6,2.8,3.0,3.3,3.7,4.0,4.2,4.1,3.9,3.8,3.6,3.4]},
    '산불':{eventId:'EVT-2025-0410-DJ05',name:'식장산 산불 확산 감시',location:'대전 동구',icon:'fire',color:'red',model:'FireSpread-KR',unit:'°C',metric:'지표온도',base:48.6,risk:73,confidence:.84,x:74,y:72,forecast:[['예측 확산 속도','1.80 km/h'],['6h 피해 예상','2.40 ㎢'],['진행 방향','북동쪽']],series:[32,34,37,40,44,48,51,54,56,58,59,60]},
    '산사태':{eventId:'EVT-2025-0811-DJ02',name:'장태산 사면 변화 감시',location:'대전 서구',icon:'mountain',color:'amber',model:'SlopeRisk-KR',unit:'mm/h',metric:'사면 변위',base:3.4,risk:81,confidence:.93,x:27,y:76,forecast:[['사면 위험지수','81 / 100'],['누적 강수','112 mm'],['최대 예측 변위','4.10 mm/h']],series:[.7,.8,1.0,1.3,1.8,2.2,2.8,3.1,3.6,4.1,3.9,3.8]}
  };
  let selectedType='전체',sendFilter='전체',reviewTab='rules',streamPlaying=false,streamTimer=null,activeId='';
  const a=db.automation ||= {schema:1,rules:[],drafts:[],outputs:[],notices:[],logs:[],sequence:0,lastReceived:null};
  if(!a.rules.length) {
    a.rules=hazards.map((type,i)=>({id:'RULE-'+(i+1),type,model:profiles[type].model,version:['v3.1.0','v2.2.0','v1.8.0'][i],thresholdVersion:'TH-'+(i+1)+'.2',alertVersion:'AL-'+(i+1)+'.1',infoThreshold:50,warningThreshold:80,minConfidence:.90,status:'승인',approver:'정관리 (시연)',approvedAt:'2026. 9. 29. 09:00',deployedAt:'2026. 9. 29. 09:05',approvalNote:'모델 검증과 임계값·발송 게이트 확인 완료 (시연)'}));
    addOutput('홍수',86,.96,false,true);
    addOutput('산불',73,.84,false,true);
    addOutput('산사태',81,.93,false,true);
    addOutput('홍수',62,.97,false,true);
    addOutput('산사태',95,.98,true,true);
    a.lastReceived=now();save();
  }
  const ruleFor=t=>a.rules.find(r=>r.type===t);
  function log(action,detail,outputId=null,actor='자동 처리',extra={}) {
    a.logs.unshift({id:'LOG-'+Date.now()+'-'+a.logs.length,action,detail,outputId,actor,time:now(),...extra});
    a.logs=a.logs.slice(0,250);save();
  }
  function addOutput(type,risk,confidence,anomaly=false,seed=false) {
    const p=profiles[type],rule=a.rules.find(r=>r.type===type);
    const seq=++a.sequence;
    const output={id:'OUT-'+seq,type,eventId:p.eventId,name:p.name,location:p.location,risk,confidence,anomaly,
      observedAt:now(),generatedAt:now(),validUntil:new Date(Date.now()+24*3600000).toLocaleString('ko-KR'),
      rule:structuredClone(rule),value:Number((p.base+(seq%5-2)*p.base*.015).toFixed(2)),forecast:structuredClone(p.forecast),series:structuredClone(p.series),postReview:null,seed};
    output.flag=classifyOutput(rule,output);
    if(type==='산사태')output.forecast[0][1]=risk+' / 100';
    a.outputs.unshift(output);a.outputs=a.outputs.slice(0,100);
    log(output.flag==='자동 통과'?'신뢰도 자동 통과':'예외 검토 요청',`${type} · 위험지수 ${risk} · 신뢰도 ${Math.round(confidence*100)}%${anomaly?' · 이상치 감지':''} · ${rule.version} / ${rule.thresholdVersion}`,output.id);
    if(output.flag==='자동 통과')dispatch(output);
    return output;
  }
  function dispatch(output) {
    if(a.notices.some(n=>n.outputId===output.id))return;
    const state=notificationGate(output.rule,output);
    if(state==='검토 후 결정')return;
    if(state==='기록만'){log('임계값 미만 · 기록만','정보성 알림 임계값 미만으로 발송하지 않음',output.id);return}
    // Coalesce official warnings for the same event until a human resolves them.
    const open=a.notices.find(n=>n.eventId===output.eventId&&n.state==='발송 대기');
    if(state==='발송 대기'&&open){output.relatedNoticeId=open.id;log('중복 발송 방지','기존 발송 대기 경보 '+open.id+'에 연결',output.id);return}
    const n={id:'NTF-'+output.id,outputId:output.id,eventId:output.eventId,type:output.type,name:state==='발송 대기'?output.type+' 임계 경보':output.type+' 위험도 정보',
      state,impact:state==='발송 대기'?'공식 경보':'정보성',channel:state==='발송 대기'?'담당자·유관기관·주민 (시연)':'내부 관제 스트림',time:now(),approver:null,approvedAt:null,note:''};
    a.notices.unshift(n);a.notices=a.notices.slice(0,100);
    log(state==='발송 대기'?'공식 경보 발송 대기':'정보성 알림 자동 발송',n.name+' · '+n.channel,output.id);
  }
  function tick() {
    const type=hazards[a.sequence%3],p=profiles[type],n=a.sequence+1;
    addOutput(type,Math.max(20,Math.min(98,p.risk+(n%7-3)*3)),n%5===0?.84:.94+(n%3)*.01,n%11===0);
    a.lastReceived=now();save();
    if(route().year==='2'&&route().page==='command'&&!$('#modal').open)ctx.render();
  }
  const sortedOutputs=()=>a.outputs.filter(o=>inScope(o));
  const inScope=o=>ctx.getSession().project.includes('도심')?o.type==='홍수'&&o.location.startsWith('대전'):ctx.getSession().project.includes('하천')?o.type==='홍수':true;
  const selected=()=>a.outputs.find(o=>o.id===route().output)||a.outputs.find(o=>o.id===activeId)||sortedOutputs()[0]||a.outputs[0];
  const url=(page,extra={})=>href(page,extra)+(extra.output?'&output='+encodeURIComponent(extra.output):'')+(extra.section?'&section='+encodeURIComponent(extra.section):'');
  const navigate=(page,extra={})=>{const u=url(page,extra);if(location.hash===u)ctx.render();else location.hash=u};
  const canApprove=()=>route().role==='admin';
  const flagBadge=o=>badge(o.flag,o.flag==='자동 통과'||o.flag==='검토 승인'?'green':o.flag==='반려'?'red':'amber');
  const flow=()=>'';
  function metrics(o,withChart=false) {
    return `<div class="forecast-cards">${o.forecast.map(([k,v])=>`<div><span>${k}</span><strong>${v}</strong></div>`).join('')}</div>${withChart?chart(o.series,profiles[o.type].unit):''}<div class="prediction-meta"><span>관측 ${o.observedAt}</span><span>생성 ${o.generatedAt}</span><span>유효 ${o.validUntil}</span></div>`;
  }
  function outputCard(o,compact=false) {
    return `<button class="output-card ${selected()?.id===o.id?'selected':''}" data-flow="open-output" data-id="${o.id}"><div class="row between">${badge(o.type,profiles[o.type].color)}${flagBadge(o)}</div><h3>${esc(o.name)}</h3><div class="row between"><span>위험지수 <b>${o.risk}</b> / 100</span><span>신뢰도 <b>${Math.round(o.confidence*100)}%</b></span></div>${!compact?`<p>${o.anomaly?'이상치 · 사람 확인 필요':o.flag==='자동 통과'?'승인 규칙에 따라 자동 표출':'경계 신뢰도 · 예외 검토 대기'}</p>`:''}<small>${o.id} · ${o.generatedAt}</small></button>`;
  }
  function command() {
    const outs=sortedOutputs(),latest=selected(),showTypes=hazards.filter(t=>inScope({type:t,location:'대전'}));
    return head('통합 관제 대시보드','상시 감시에서 변화 탐지·예측·경보 판단까지 연결합니다.',badge('시뮬레이션 스트림','blue'))+flow(0)+
      `<div class="command-layout"><div><div class="card"><div class="row between wrap mb"><h2 style="margin:0">${ctx.getSession().project.includes('실증')?'대전·세종 통합 현황':esc(ctx.getSession().project)}</h2><div class="segmented">${['전체',...showTypes].map(t=>`<button data-flow="hazard-filter" data-value="${t}" class="${selectedType===t?'active':''}">${t}</button>`).join('')}</div></div><div class="map-wrap monitoring-map">${mapSvg(ctx.getTime()>=6,{damage:ctx.getTime()>=6})}${showTypes.filter(t=>selectedType==='전체'||selectedType===t).map(t=>{const p=profiles[t],o=outs.find(x=>x.type===t);return `<button class="hazard-pin ${p.color}" data-flow="map-output" data-value="${t}" style="left:${p.x}%;top:${p.y}%" aria-label="${p.name}">${I(p.icon)}<span>${t} <b>${o?.risk||p.risk}</b></span></button>`}).join('')}<div class="map-labels"><span>홍수 · 산불 · 산사태 감시</span><span>2025-07-${String(10+ctx.getTime()).padStart(2,'0')}</span></div><div class="map-attribution">합성 지도 · 관측·예측 시연 데이터</div></div><div class="row mt"><button data-action="play-timeline" aria-label="시계열 재생 또는 정지">${ctx.getPlaying()?'정지':I('play')}</button><input id="timeline-range" type="range" min="0" max="12" value="${ctx.getTime()}" aria-label="관측 시점"><span class="small muted">0.55초 / 프레임</span></div></div><div class="card mt"><div class="row between wrap"><div><h2>실시간 스트림 기반 변화 모니터링</h2><p class="section-subtitle">가상 수신 간격 1.8초 · 외부 센서와 연결되지 않은 시연입니다.</p></div><div class="row"><button data-flow="toggle-stream" class="${streamPlaying?'':'primary'}">${streamPlaying?'스트림 일시정지':'스트림 시작'}</button><button data-flow="next-frame">다음 수신</button></div></div><div class="row between small muted mb"><span>${streamPlaying?'수신 중':'일시정지'} · 최근 수신 ${a.lastReceived}</span><span>누적 ${a.sequence}건</span></div><div class="stream-list">${outs.slice(0,5).map(o=>`<button data-flow="open-output" data-id="${o.id}"><span>${badge(o.type,profiles[o.type].color)} ${o.id}</span><span>${profiles[o.type].metric} <b>${o.value} ${profiles[o.type].unit}</b></span>${flagBadge(o)}</button>`).join('')}</div></div></div><div><div class="card"><div class="row between"><h2>예측 지표 · 향후 24h</h2>${badge('임의 데이터','blue')}</div><div class="forecast-summary">${showTypes.map(t=>{const o=outs.find(x=>x.type===t);return o?`<button data-flow="open-output" data-id="${o.id}"><h3>${I(profiles[t].icon)} ${t}</h3><b>${o.forecast[0][1]}</b><p>${o.forecast[0][0]} · 위험지수 ${o.risk}</p>${flagBadge(o)}</button>`:''}).join('')}</div></div><div class="card mt"><h2>처리 현황</h2><a class="status-link" href="${url('review',{section:'exceptions'})}"><span>예외 검토 대기</span><b>${a.outputs.filter(o=>o.flag==='검토 필요').length}</b></a><a class="status-link" href="${url('alerts')}"><span>공식 경보 발송 대기</span><b>${a.notices.filter(n=>n.state==='발송 대기').length}</b></a><a class="status-link" href="${url('review',{section:'rules'})}"><span>승인된 모델·규칙</span><b>${a.rules.length}</b></a><p class="small muted mt" style="margin-bottom:0">정보성 표출은 자동으로, 공식 경보 발송은 사람 확인 후 처리합니다.</p></div></div></div>`;
  }
  function prediction(e) {
    const candidates=a.outputs.filter(o=>o.type===e.type);const o=candidates.find(o=>o.id===route().output)||candidates[0];
    return flow(2)+`<div class="grid2"><div class="card"><div class="row between"><h2>${e.type} 위험도 · 예측</h2>${badge('임의 예측값','blue')}</div><p class="section-subtitle">${o.name} · ${o.id}</p>${metrics(o,true)}${notice('과거 피해 분석과 별도의 2차 감시 시나리오입니다. 모델 산출과 수치는 시연용이며 실제 예측이 아닙니다.')}</div>${gatePanel(o)}</div>`;
  }
  function gatePanel(o) {
    const n=a.notices.find(n=>n.outputId===o.id)||a.notices.find(n=>n.id===o.relatedNoticeId);
    return `<div class="card"><div class="row between"><h2>자동 산출 판단</h2>${flagBadge(o)}</div><div class="gate-metrics"><div>위험지수<strong>${o.risk}<small> / 100</small></strong></div><div>산출 신뢰도<strong>${Math.round(o.confidence*100)}<small>%</small></strong></div></div><table class="data-table"><tr><td>예측 모델</td><td>${o.rule.model} ${o.rule.version}</td></tr><tr><td>임계값 / 알림 규칙</td><td>${o.rule.thresholdVersion} / ${o.rule.alertVersion}</td></tr><tr><td>자동 통과 기준</td><td>신뢰도 ${Math.round(o.rule.minConfidence*100)}% 이상 · 이상치 없음</td></tr><tr><td>공식 경보 임계값</td><td>위험지수 ${o.rule.warningThreshold} 이상</td></tr><tr><td>사전 승인</td><td>${o.rule.approver}<br>${o.rule.approvedAt}</td></tr><tr><td>이상치</td><td>${o.anomaly?'감지됨 · 검토 필요':'없음'}</td></tr></table><div class="mt">${notice(o.flag==='검토 필요'?'신뢰도 경계 또는 이상치가 감지되어 자동 처리를 보류했습니다. 예외 검토가 완료되면 영향도별 발송 게이트를 적용합니다.':n?.state==='발송 대기'?'신뢰도 검증은 통과했지만 공식 경보는 사람의 발송 승인을 기다립니다.':o.flag==='반려'?'반려된 산출은 자동 표출·발송 대상에서 제외됩니다.':'정보성 위험도는 승인 규칙에 따라 자동 처리됩니다. 사후 검토 기록으로 규칙 보정을 요청할 수 있습니다.',o.flag==='검토 필요'?'warn':'')}</div><div class="row wrap mt"><a href="${url('alerts',{output:o.id})}" class="primary link-button">경보·알림 상태 확인</a><a href="${url('review',{section:o.flag==='검토 필요'?'exceptions':'audit',output:o.id})}">검수 기록</a></div></div>`;
  }
  function risk(existing) {
    const o=selected();return flow(2)+`<div class="card mb"><div class="row between wrap"><div><h2>${o.type} 예측 산출 · ${o.name}</h2><p class="section-subtitle">위험지수 ${o.risk}/100 · ${o.rule.model} ${o.rule.version} · ${o.id}</p></div>${flagBadge(o)}</div>${metrics(o)}<div class="row mt"><a class="primary link-button" href="${url('detail',{id:o.eventId,tab:'prediction',output:o.id})}">예측 상세</a><a href="${url('alerts',{output:o.id})}">임계 경보·알림 확인</a></div></div>`+existing;
  }
  function alerts() {
    let o=selected();
    let outs=sortedOutputs();if(sendFilter==='검토 필요')outs=outs.filter(o=>o.flag==='검토 필요');if(sendFilter==='발송 대기')outs=outs.filter(o=>a.notices.some(n=>n.outputId===o.id&&n.state==='발송 대기'));if(sendFilter==='자동 발송')outs=outs.filter(o=>a.notices.some(n=>n.outputId===o.id&&n.state==='자동 발송'));if(sendFilter==='승인 발송')outs=outs.filter(o=>a.notices.some(n=>n.outputId===o.id&&n.state==='승인 발송'));
    if(sendFilter!=='전체'&&outs.length&&!outs.some(x=>x.id===o.id))o=outs[0];
    const n=a.notices.find(n=>n.outputId===o.id)||a.notices.find(n=>n.id===o.relatedNoticeId);
    return head('예측 · 경보 · 알림','사전 승인 규칙에 따른 자동 처리와 공식 경보 발송 승인을 구분합니다.',badge('발송 시뮬레이션','blue'))+flow(3)+`<div class="filter-bar mb">${['전체','자동 발송','검토 필요','발송 대기','승인 발송'].map(t=>`<button data-flow="notification-filter" data-value="${t}" class="${sendFilter===t?'primary':''}">${t}</button>`).join('')}</div><div class="queue-layout"><div class="output-list">${outs.slice(0,15).map(o=>outputCard(o,true)).join('')||empty('해당 상태가 없습니다','다른 상태를 선택해 보세요.')}</div><div><div class="card"><div class="row between"><div><h2>${o.name}</h2><p class="section-subtitle">${o.id} · ${o.location} · ${o.type}</p></div>${flagBadge(o)}</div>${metrics(o,true)}<h3 class="mt">영향도별 처리 상태</h3><table class="data-table"><tr><th>단계</th><th>정책</th><th>현재 상태</th></tr><tr><td>예측·위험도 표출</td><td>고신뢰도 자동 / 경계·이상치 검토</td><td>${flagBadge(o)}</td></tr><tr><td>정보성 알림</td><td>내부 스트림 자동 전달</td><td>${badge(o.flag==='자동 통과'||o.flag==='검토 승인'?'자동 처리':'처리 보류',o.flag==='자동 통과'?'green':'amber')}</td></tr><tr><td>공식 경보</td><td>임계값 도달 시 사람 발송 승인</td><td>${badge(n?.impact==='공식 경보'?n.state:'발송 대상 아님',n?.state==='발송 대기'?'amber':'')}</td></tr></table>${n?`<div class="notice mt"><div><b>${n.impact} · ${n.state}</b><br>${n.channel}<br>${n.approver?'승인자 '+esc(n.approver)+' · '+n.approvedAt:'생성 '+n.time}${n.note?'<br>의견: '+esc(n.note):''}</div></div>`:''}<div class="row wrap mt">${o.flag==='검토 필요'?`<a class="primary link-button" href="${url('review',{section:'exceptions',output:o.id})}">예외 검토로 이동</a>`:n?.state==='발송 대기'?canApprove()?`<button class="primary" data-flow="approve-send-dialog" data-id="${n.id}">공식 경보 발송 승인</button>`:`<a class="primary link-button" href="${url('login',{role:'admin'})}">운영 관리자 역할로 전환</a>`:''}<a href="${url('detail',{id:o.eventId,tab:'prediction',output:o.id})}">예측 상세</a><a href="${url('risk',{output:o.id})}">위험지도</a></div><p class="small muted mt">실제 SMS·앱 푸시·외부 API는 호출하지 않습니다. 승인과 발송 상태를 시연 이력에 기록합니다.</p></div><div class="card mt"><h3>이 산출의 처리 이력</h3>${logList(a.logs.filter(l=>l.outputId===o.id).slice(0,8))}</div></div></div>`;
  }
  function review() {
    const tab=route().section||reviewTab;
    return head('2차 검수 · 승인 자동화','모델·규칙은 사전 승인하고, 산출은 자동 처리하며 예외와 공식 발송만 사람이 확인합니다.',badge(canApprove()?'운영 관리자':'열람 모드',canApprove()?'green':''))+
      `<div class="automation-principles"><div><b>1. 사전 승인</b><span>모델 · 임계값 · 알림 규칙</span></div><div><b>2. 신뢰도 분기</b><span>자동 통과 / 예외 검토</span></div><div><b>3. 영향도 게이트</b><span>정보 자동 / 공식 경보 승인</span></div><div><b>4. 사후 검토</b><span>감사 로그 · 규칙 보정</span></div></div><nav class="tabs">${[['rules','모델·규칙 관리'],['exceptions','예외 검토 ('+a.outputs.filter(o=>o.flag==='검토 필요').length+')'],['send','발송 승인 ('+a.notices.filter(n=>n.state==='발송 대기').length+')'],['audit','감사·사후 검토']].map(([k,t])=>`<a href="${url('review',{section:k,output:route().output})}" class="${tab===k?'active':''}">${t}</a>`).join('')}</nav>${tab==='rules'?rulesView():tab==='exceptions'?exceptionsView():tab==='send'?sendView():auditView()}`;
  }
  function rulesView() {
    return `<div class="grid3">${a.rules.map(r=>`<div class="card rule-card"><div class="row between"><h2>${r.type}</h2>${badge('승인 · 배포 중','green')}</div><h3>${r.model} ${r.version}</h3><dl><dt>임계값 버전</dt><dd>${r.thresholdVersion}</dd><dt>알림 규칙 버전</dt><dd>${r.alertVersion}</dd><dt>정보 / 공식 경보</dt><dd>${r.infoThreshold} / ${r.warningThreshold}점</dd><dt>자동 통과 신뢰도</dt><dd>${Math.round(r.minConfidence*100)}% 이상</dd><dt>승인자</dt><dd>${esc(r.approver)}</dd><dt>승인 일시</dt><dd>${r.approvedAt}</dd><dt>배포 일시</dt><dd>${r.deployedAt}</dd></dl><p class="small muted">${esc(r.approvalNote)}</p><button data-flow="edit-rule" data-id="${r.id}" ${!['admin','analyst'].includes(route().role)?'disabled':''}>새 버전 승인 요청</button></div>`).join('')}</div><div class="card mt"><h2>배포 전 승인 대기</h2>${a.drafts.filter(d=>d.status==='대기').map(d=>`<div class="rule-draft"><div><h3>${d.type} · ${d.model} ${esc(d.version)}</h3><p>임계 ${esc(d.thresholdVersion)} · 알림 ${esc(d.alertVersion)} · 신뢰도 ${Math.round(d.minConfidence*100)}% · 경보 ${d.warningThreshold}점</p><small>요청자 ${esc(d.requester)} · ${d.requestedAt}</small></div><button class="primary" data-flow="approve-rule-dialog" data-id="${d.id}" ${!canApprove()?'disabled':''}>승인 후 배포</button></div>`).join('')||'<p class="muted">현재 승인 대기 버전이 없습니다. 새 버전을 요청하면 기존 승인 버전은 유지됩니다.</p>'}</div>`;
  }
  function exceptionsView() {
    const pending=a.outputs.filter(o=>o.flag==='검토 필요');const o=pending.find(o=>o.id===route().output)||pending.find(o=>o.id===activeId)||pending[0];
    if(!o)return empty('예외 검토가 모두 완료되었습니다','자동 통과 결과는 개별 사전 검토 없이 표출됩니다. 감사 로그에서 사후 검토할 수 있습니다.',`<a href="${url('review',{section:'audit'})}">감사 로그 보기</a>`);
    return `<div class="queue-layout"><div class="output-list">${pending.slice(0,15).map(o=>`<button class="output-card" data-flow="select-exception" data-id="${o.id}"><h3>${o.name}</h3>${flagBadge(o)}<p>${o.anomaly?'이상치 감지':'신뢰도 경계'} · ${Math.round(o.confidence*100)}%</p><small>${o.id}</small></button>`).join('')}</div><div class="card"><div class="row between"><h2>${o.name}</h2>${flagBadge(o)}</div><p class="section-subtitle">${o.id} · ${o.rule.model} ${o.rule.version}</p>${metrics(o)}<div class="gate-metrics"><div>위험지수<strong>${o.risk}</strong></div><div>신뢰도<strong>${Math.round(o.confidence*100)}%</strong></div></div>${notice(o.anomaly?'이상치 플래그가 감지되어 높은 신뢰도여도 자동 처리를 보류했습니다.':'자동 통과 기준 '+Math.round(o.rule.minConfidence*100)+'%에 미달하여 사람 확인이 필요합니다.','warn')}<div class="field mt"><label for="exception-note">검토 의견 (승인·반려 모두 필수)</label><textarea id="exception-note" placeholder="관측값과 모델 산출을 확인한 내용을 기록하세요."></textarea></div><div class="row wrap"><button class="teal" data-flow="resolve-exception" data-id="${o.id}" data-value="approve" ${!canApprove()?'disabled':''}>검토 승인 · 후속 처리</button><button class="danger" data-flow="resolve-exception" data-id="${o.id}" data-value="reject" ${!canApprove()?'disabled':''}>반려 · 처리 제외</button></div>${!canApprove()?'<p class="small muted mt">운영 관리자 역할에서 예외를 처리할 수 있습니다.</p>':''}<p class="small muted mt">검토 승인은 공식 경보 발송 승인이 아닙니다. 임계값 도달 결과는 별도의 발송 승인 단계로 이어집니다.</p></div></div>`;
  }
  function sendView() {
    return `<div class="card"><h2>공식 경보 발송 게이트</h2>${notice('정보성 알림은 자동 처리되지만, 공식 경보는 사람의 발송 승인이 필요합니다. 모두 시연 처리이며 외부로 전송되지 않습니다.')}<div class="mt">${a.notices.filter(n=>n.state==='발송 대기').map(n=>`<div class="rule-draft"><div><h3>${n.name}</h3><p>${n.outputId} · ${n.channel}</p>${badge('발송 대기','amber')}</div><div class="row"><a href="${url('alerts',{output:n.outputId})}">산출 확인</a><button class="primary" data-flow="approve-send-dialog" data-id="${n.id}" ${!canApprove()?'disabled':''}>발송 승인</button></div></div>`).join('')||'<p class="muted">발송 승인 대기 항목이 없습니다.</p>'}</div></div>`;
  }
  function logList(logs) {return logs.map(l=>`<div class="history-item"><div class="row between"><b>${esc(l.action)}</b>${badge(l.actor==='자동 처리'?'자동':l.actor,'blue')}</div><p>${esc(l.detail)}</p><small>${l.time}${l.outputId?' · '+l.outputId:''}</small></div>`).join('')}
  function auditView() {
    return `<div class="card"><h2>실시간 산출 사후 검토</h2><p class="section-subtitle">자동 처리 결과를 확인하고, 필요한 보정은 새 규칙 버전의 승인으로 이어갑니다.</p>${a.outputs.filter(o=>['자동 통과','검토 승인'].includes(o.flag)).slice(0,12).map(o=>`<div class="rule-draft"><div><h3>${o.name} · ${o.id}</h3><p>${flagBadge(o)} 위험지수 ${o.risk} · ${o.rule.version}</p>${o.postReview?badge(o.postReview.outcome,o.postReview.outcome==='규칙 보정 필요'?'amber':'green'):'<span class="muted small">사후 검토 전</span>'}${o.postReview?`<small>${esc(o.postReview.reviewer)} · ${o.postReview.time} · ${esc(o.postReview.note)}</small>`:''}</div><button data-flow="post-review-dialog" data-id="${o.id}" ${!canApprove()?'disabled':''}>${o.postReview?'검토 기록 확인':'사후 검토'}</button></div>`).join('')}</div><div class="card mt"><h2>자동 처리 · 감사 로그</h2>${logList(a.logs.slice(0,40))}</div>`;
  }
  function history() {return head('자동 처리 · 감사 로그','자동 산출·발송 게이트·사후 검토 및 1차 작업 이력을 함께 확인합니다.')+`<div class="card">${logList(a.logs.slice(0,40))}</div><div class="card mt"><h2>일반 작업 이력</h2>${db.audit.map(l=>`<div class="history-item"><b>${esc(l.type)}</b><p>${esc(l.detail)}</p><small>${esc(l.actor)} · ${l.time}</small></div>`).join('')||'<p class="muted">일반 작업 이력이 없습니다.</p>'}</div>`}
  function reports(existing) {
    return `<div class="report-catalog card mb"><div class="row between wrap"><div><h2>결과 산출물 사례</h2><p class="section-subtitle">완성된 시연 데이터를 선택해 미리보기와 내보내기를 이어가세요.</p></div>${badge('예시 데이터 포함','blue')}</div><div class="grid3">${['홍수','산불','산사태'].map(t=>{const p=profiles[t],e=db.events.find(e=>e.id===p.eventId),r=ctx.result(e);return `<a class="report-sample" href="${url('detail',{id:e.id,tab:'report'})}">${I(p.icon)}<h3>${e.name}</h3><p>${r.area.toFixed(2)} ㎢ · ${r.model} ${r.version}</p>${badge(r.status,r.status==='승인'?'green':'amber')}<span>결과 산출물 미리보기</span></a>`}).join('')}</div></div>`+existing;
  }
  if(!db.reportSamplesV2) {
    for(const type of ['홍수','산불']){const p=profiles[type],e=db.events.find(e=>e.id===p.eventId),r=ctx.result(e);db.jobs.push({id:'SAMPLE-'+type,event:structuredClone(e),result:structuredClone(r),format:type==='홍수'?'PDF':'CSV',options:{performance:true,review:true},layers:{damage:true,aoi:true,legend:true,split:58},actor:'시연 예시',created:'2026. 9. 29. 오전 9:20',readyAt:0,status:'완료',expires:Date.now()+86400000,sample:true})}
    db.reportSamplesV2=true;save();
  }
  function decorate() {
    if(route().page==='detail'){
      const tabs=$('.tabs');if(tabs&&!$('.case-flow')){const bar=document.createElement('nav');bar.className='flow-steps case-flow';bar.innerHTML=`<a href="${href('events')}"><span>01</span>사례 갤러리</a><a href="${href('detail',{tab:'satellite'})}" class="${['satellite','analysis'].includes(route().tab)?'current':''}"><span>02</span>지도 뷰어·피해 정량</a><a href="${href('detail',{tab:'report'})}" class="${route().tab==='report'?'current':''}"><span>03</span>결과 산출물 내보내기</a>`;tabs.before(bar)}
      if(route().tab==='report'){
        const options=$('.report-settings'),e=ctx.getEvent(),r=ctx.result(e);
        if(r?.status!=='승인'&&options){const block=document.createElement('div');block.className='notice mt';block.innerHTML=`<div>현재 결과는 검수 전이므로 공식 결과 산출물 생성은 보류됩니다. 입력된 예시값과 지도는 미리보기에서 확인할 수 있습니다.<br><a href="${href('detail',{id:profiles['홍수'].eventId,tab:'report'})}">승인된 홍수 결과 산출물 예시 열기</a></div>`;options.append(block)}
      }
    }
    // Keep the seeded demo explicit; leave stream control to the visitor.
    if(route().year==='2'){
      const nav=$('.sidebar nav');if(nav&&!nav.querySelector('[data-automation-nav]')&&route().role!=='admin'){const link=document.createElement('a');link.className='nav-item';link.dataset.automationNav='true';link.href=url('review');link.innerHTML=I('shield')+'자동화 · 검수 현황';nav.append(link)}
    }
    if(route().page==='events'){
      const title=$('.page-head h1');if(title)title.textContent='재난 이벤트 · 사례 갤러리';
    }
  }
  document.addEventListener('click',ev=>{
    const b=ev.target.closest('[data-flow]');if(!b||b.disabled)return;
    const action=b.dataset.flow,id=b.dataset.id,value=b.dataset.value;
    if(action==='hazard-filter'){selectedType=value;ctx.render()}
    if(action==='map-output'){const o=sortedOutputs().find(o=>o.type===value);if(o){activeId=o.id;navigate('detail',{id:o.eventId,tab:'prediction',output:o.id})}}
    if(action==='open-output'){activeId=id;navigate('alerts',{output:id})}
    if(action==='notification-filter'){sendFilter=value;ctx.render()}
    if(action==='select-exception'){activeId=id;navigate('review',{section:'exceptions',output:id})}
    if(action==='toggle-stream'){streamPlaying=!streamPlaying;if(streamPlaying){tick();streamTimer=setInterval(tick,1800)}else{clearInterval(streamTimer);streamTimer=null}ctx.render()}
    if(action==='next-frame'){tick();ctx.render()}
    if(action==='edit-rule'){
      if(!['admin','analyst'].includes(route().role))return;
      const r=a.rules.find(r=>r.id===id);
      modal(r.type+' 모델·규칙 새 버전',`<p class="small muted">현재 배포 버전 ${r.version}은 새 버전의 사전 승인이 완료될 때까지 유지됩니다.</p><div class="grid2">${[['model','모델명',r.model],['version','모델 버전',r.version+'-next'],['thresholdVersion','임계값 버전',r.thresholdVersion+'-next'],['alertVersion','알림 규칙 버전',r.alertVersion+'-next'],['minConfidence','자동 통과 신뢰도 (0.5~1)',r.minConfidence],['infoThreshold','정보성 위험 임계값 (0~99)',r.infoThreshold],['warningThreshold','공식 경보 임계값 (1~100)',r.warningThreshold]].map(([k,t,v])=>`<div class="field"><label for="rule-${k}">${t}</label><input id="rule-${k}" value="${esc(v)}" ${['minConfidence','infoThreshold','warningThreshold'].includes(k)?'type="number" step="any"':'maxlength="80"'}></div>`).join('')}</div>`,`<button class="primary" data-flow="submit-rule" data-id="${id}">사전 승인 요청</button>`);
    }
    if(action==='submit-rule'){
      if(!['admin','analyst'].includes(route().role))return;
      const r=a.rules.find(r=>r.id===id),draft={...structuredClone(r),id:'DRAFT-'+Date.now(),ruleId:r.id,status:'대기',requester:roles[route().role].person,requestedAt:now()};
      for(const k of ['model','version','thresholdVersion','alertVersion'])draft[k]=$('#rule-'+k).value.trim();
      for(const k of ['minConfidence','infoThreshold','warningThreshold'])draft[k]=Number($('#rule-'+k).value);
      if(!validRule(draft))return toast('버전명과 임계값을 확인하세요. 공식 경보 기준은 정보성 기준보다 높아야 합니다.');
      if(draft.version===r.version&&draft.thresholdVersion===r.thresholdVersion&&draft.alertVersion===r.alertVersion)return toast('변경된 모델·임계값·알림 규칙 중 하나는 새 버전이 필요합니다.');
      a.drafts.unshift(draft);log('모델·규칙 사전 승인 요청',draft.type+' · '+draft.version,null,roles[route().role].person);$('#modal').close();navigate('review',{section:'rules'});toast('배포 전 승인 대기에 등록했습니다.');
    }
    if(action==='approve-rule-dialog'&&canApprove()){
      const d=a.drafts.find(d=>d.id===id);if(!d||d.status!=='대기')return;
      modal('모델·임계값·알림 규칙 사전 승인',`<h3>${d.model} ${esc(d.version)}</h3><p>임계 ${esc(d.thresholdVersion)} / 알림 ${esc(d.alertVersion)}<br>자동 통과 ${Math.round(d.minConfidence*100)}% · 공식 경보 ${d.warningThreshold}점</p><label for="rule-approval-note">검증·승인 의견 (필수)</label><textarea id="rule-approval-note" placeholder="모델 검증, 임계값 및 발송 게이트 확인 내용을 입력하세요."></textarea>`,`<button class="teal" data-flow="approve-rule" data-id="${id}">사전 승인 후 배포</button>`);
    }
    if(action==='approve-rule'&&canApprove()){
      const d=a.drafts.find(d=>d.id===id),note=$('#rule-approval-note').value.trim();if(!d||d.status!=='대기')return;if(!note)return toast('사전 승인 의견을 입력하세요.');
      const index=a.rules.findIndex(r=>r.id===d.ruleId);a.rules[index]={...structuredClone(d),id:d.ruleId,status:'승인',approver:roles[route().role].person,approvedAt:now(),deployedAt:now(),approvalNote:note};d.status='승인';
      log('사전 승인 · 규칙 배포',d.type+' · '+d.version+' / '+d.thresholdVersion+' / '+d.alertVersion+' · '+note,null,roles[route().role].person);$('#modal').close();ctx.render();toast('승인된 버전으로 다음 산출부터 자동 처리합니다.');
    }
    if(action==='resolve-exception'&&canApprove()){
      const o=a.outputs.find(o=>o.id===id),note=$('#exception-note').value.trim();if(!o||o.flag!=='검토 필요')return;if(!note)return toast('예외 검토 의견을 입력하세요.');
      o.flag=value==='approve'?'검토 승인':'반려';o.review={note,reviewer:roles[route().role].person,time:now()};log(value==='approve'?'예외 검토 승인':'예외 산출 반려',o.type+' · '+note,o.id,roles[route().role].person);if(value==='approve')dispatch(o);ctx.render();toast(value==='approve'?'검토 승인했습니다. 영향도별 후속 게이트를 적용했습니다.':'반려했습니다. 자동 표출·발송 대상에서 제외했습니다.');
    }
    if(action==='approve-send-dialog'&&canApprove()){
      const n=a.notices.find(n=>n.id===id);if(!n||n.state!=='발송 대기')return;
      modal('공식 경보 발송 승인 · 시연',`<h3>${n.name}</h3><p>${n.outputId} · ${n.channel}</p><label for="send-note">발송 확인 의견 (필수)</label><textarea id="send-note" placeholder="발령 대상·영향도·중복 발송 여부 확인 내용을 입력하세요."></textarea>${notice('실제 SMS나 외부 API는 호출하지 않으며 승인 발송 상태만 기록됩니다.')}`,`<button class="teal" data-flow="approve-send" data-id="${id}">사람 확인 완료 · 발송 처리</button>`);
    }
    if(action==='approve-send'&&canApprove()){
      const n=a.notices.find(n=>n.id===id),note=$('#send-note').value.trim();if(!n||n.state!=='발송 대기')return;if(!note)return toast('발송 확인 의견을 입력하세요.');
      n.state='승인 발송';n.approver=roles[route().role].person;n.approvedAt=now();n.note=note;log('공식 경보 승인 발송',n.name+' · '+note,n.outputId,n.approver);$('#modal').close();ctx.render();toast('발송 승인을 시연 이력에 기록했습니다. 실제 전송은 없습니다.');
    }
    if(action==='post-review-dialog'&&canApprove()){
      const o=a.outputs.find(o=>o.id===id);if(o.postReview)return modal('사후 검토 기록',`<h3>${o.postReview.outcome}</h3><p>${esc(o.postReview.note)}</p><p class="small muted">${esc(o.postReview.reviewer)} · ${o.postReview.time}</p>`);
      modal('자동 산출 사후 검토',`<p>${o.id} · ${o.rule.model} ${o.rule.version}</p><div class="field"><label for="post-outcome">검토 결과</label><select id="post-outcome"><option>검토 완료</option><option>규칙 보정 필요</option></select></div><label for="post-note">검토·보정 의견 (필수)</label><textarea id="post-note"></textarea>`,`<button class="primary" data-flow="save-post-review" data-id="${id}">검토 기록 저장</button>`);
    }
    if(action==='save-post-review'&&canApprove()){
      const o=a.outputs.find(o=>o.id===id),note=$('#post-note').value.trim(),outcome=$('#post-outcome').value;if(!note)return toast('사후 검토 의견을 입력하세요.');
      o.postReview={note,outcome,reviewer:roles[route().role].person,time:now()};log('사후 검토 · '+outcome,note,o.id,roles[route().role].person);$('#modal').close();if(outcome==='규칙 보정 필요'){navigate('review',{section:'rules'});toast('보정 필요를 기록했습니다. 새 규칙 버전을 승인 요청하세요.')}else{ctx.render();toast('사후 검토를 완료했습니다.')}
    }
  });
  return {command,prediction,risk,alerts,review,history,reports,decorate};
}
