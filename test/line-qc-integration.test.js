// End-to-end test of the LINE QC flow with simulated, signed LINE webhook events.
// Runs server.js from a temp folder with an EMPTY database plus its own fixtures: the live data/ DB is never used,
// and nothing leaves localhost. Run: npm test
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),crypto=require('crypto');
const {spawn,execFileSync}=require('child_process');

const ROOT=path.join(__dirname,'..');
const SECRET='test-channel-secret-not-real',GROUP='Ctestgroup000000000000000000000001',OTHER_GROUP='Cothergroup00000000000000000000002';
const USER_ID='U'+'f'.repeat(32),REPLY_TOKEN='r'.repeat(32);
const LEGACY_TS='2026-10-27T00:00:00.000Z';

let tmp,proc,base,hookBase,dbPath,logs='';
const db=s=>{const r=execFileSync('sqlite3',['-json',dbPath,s],{encoding:'utf8'}).trim();return r?JSON.parse(r):[]};
const one=s=>db(s)[0];
const freePort=()=>new Promise((res,rej)=>{const s=net.createServer();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p))})});
const sign=body=>crypto.createHmac('sha256',SECRET).update(body).digest('base64');
async function hook(events,{signature,raw,pathName='/line/webhook'}={}){
  const body=raw??JSON.stringify({destination:'Ubot',events});
  const r=await fetch(hookBase+pathName,{method:'POST',headers:{'content-type':'application/json','x-line-signature':signature===undefined?sign(body):signature},body});
  return {status:r.status,body:await r.json().catch(()=>null)};
}
async function api(url,opts={}){const r=await fetch(base+url,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});return {status:r.status,body:await r.json().catch(()=>null)}}
const resolve=(id,payload)=>api(`/api/line-qc/messages/${id}/resolve`,{method:'POST',body:JSON.stringify(payload)});

let seq=0;
function textEvent(text,{mentions=[],group=GROUP,id,ts=Date.now(),redelivery=false,sourceType='group'}={}){
  id=id||String(700000000000+(++seq));
  let from=0;const mentionees=mentions.map(n=>{const index=text.indexOf(n,from);from=index+n.length;return {index,length:n.length,type:'user',userId:USER_ID}});
  return {type:'message',mode:'active',timestamp:ts,webhookEventId:'01TEST'+id,deliveryContext:{isRedelivery:redelivery},replyToken:REPLY_TOKEN,
    source:sourceType==='group'?{type:'group',groupId:group,userId:USER_ID}:{type:sourceType,userId:USER_ID},
    message:{type:'text',id,quoteToken:'qt',text,...(mentionees.length?{mention:{mentionees}}:{})}};
}
const qcText=(sap,inv,summary)=>`${sap} TEST PRODUCT,C/B\n\n${inv}\n\nของเข้าวันที่ 12/10/2026 ยอด 1,000 ชิ้น สุ่ม 80 ชิ้น\n\nMinor= ขนแปรงประกอบไม่สุด 4 ชิ้น 5% *ACCEPT15 ชิ้น* Reject 9ชิ้น แยกชิ้นงานออก\n\nMinor = คราบสกปรก 3 ชิ้น 0.47% Reject แก้ไขทำความสะอาด\n\n${summary}`;
const msgRow=lineId=>one(`SELECT * FROM line_qc_messages WHERE line_message_id='${lineId}'`);
const current=(inv,sap)=>db(`SELECT q.* FROM qc_results q JOIN packing_lists p ON p.id=q.packing_list_id WHERE p.invoice_no='${inv}' AND q.sap_no='${sap}' AND q.is_current=1`);
const qcCount=()=>Number(one('SELECT COUNT(*) n FROM qc_results').n);

test.before(async()=>{
  tmp=fs.mkdtempSync(path.join(os.tmpdir(),'plm-line-qc-'));
  for(const f of ['server.js','index.html','line-qc-parser.js','line-qc-service.js'])fs.copyFileSync(path.join(ROOT,f),path.join(tmp,f));
  fs.symlinkSync(path.join(ROOT,'node_modules'),path.join(tmp,'node_modules'));
  dbPath=path.join(tmp,'data','pl-brand.sqlite');
  const [port,hookPort]=[await freePort(),await freePort()];
  base=`http://127.0.0.1:${port}`;hookBase=`http://127.0.0.1:${hookPort}`;
  proc=spawn(process.execPath,['server.js'],{cwd:tmp,env:{...process.env,PORT:String(port),LINE_WEBHOOK_PORT:String(hookPort),LINE_CHANNEL_SECRET:SECRET,LINE_QC_GROUP_ID:GROUP},stdio:['ignore','pipe','pipe']});
  proc.stdout.on('data',d=>logs+=d);proc.stderr.on('data',d=>logs+=d);
  const t0=Date.now();
  while(!(logs.includes('listening at') && logs.includes('[LINE QC] webhook listening'))){
    if(Date.now()-t0>20000||proc.exitCode!=null)throw Error('server did not start:\n'+logs);
    await new Promise(r=>setTimeout(r,100));
  }
  // Fixtures (written after the server created the schema).
  const n="'2026-10-26T00:00:00.000Z'";
  const items=[['i1','pl1',1,'9900001'],['i2','pl1',2,'9900002'],['i3a','pl1',3,'9900003'],['i3b','pl1',4,'9900003-1'],['i4','pl1',5,'9900004'],['i5','pl1',6,'9900005'],['i6','pl1',7,'9900006'],['i7','pl1',8,'9900007'],['i8','pl1',9,'9900008'],['j1','pl2',1,'9900001']];
  execFileSync('sqlite3',['-bail',dbPath],{input:`BEGIN;
INSERT INTO packing_lists(id,invoice_no,etd,eta,etr,file_name,file_path,file_sha256,status,created_at,updated_at) VALUES('pl1','INV99-TST001','','','2026-10-30','','','','REVIEW',${n},${n}),('pl2','INV99-TST002','','','','','','','REVIEW',${n},${n});
${items.map(([id,pl,line,sap])=>`INSERT INTO items(id,packing_list_id,line_no,sap_po,sap_no,description,quantity,uom,bom,brand,production_model,review_status,created_at,updated_at) VALUES('${id}','${pl}',${line},'PO1','${sap}','TEST ITEM ${sap}',100,'PCS','','','','CONFIRMED',${n},${n});`).join('\n')}
INSERT INTO qc_results(id,packing_list_id,sap_no,result,raw_message,defect_description,quantity,source_message_id,parser_version,received_at,is_current) VALUES
 ('legacy-accept','pl1','9900002','ACCEPT','legacy','',NULL,NULL,'qc-v1','${LEGACY_TS}',1),
 ('legacy-pending','pl1','9900005','PENDING','legacy','',NULL,NULL,'qc-v1','${LEGACY_TS}',1);
COMMIT;`});
});

test.after(()=>{try{proc?.kill()}catch{}if(tmp)fs.rmSync(tmp,{recursive:true,force:true})});

test('webhook port serves only the webhook', async()=>{
  for(const p of ['/','/index.html','/api/health','/api/dashboard','/api/line-qc/messages','/api/qc/rules']){const r=await fetch(hookBase+p);assert.equal(r.status,404,p)}
  const r=await fetch(hookBase+'/api/qc/messages',{method:'POST',headers:{'content-type':'application/json'},body:'{"text":"x"}'});assert.equal(r.status,404);
  assert.equal((await fetch(hookBase+'/line/health')).status,200);
});

test('signature is verified on the exact raw body', async()=>{
  const ev=[textEvent(qcText('9900001','INV99-TST001','ACCEPT LOT'))],body=JSON.stringify({destination:'Ubot',events:ev});
  assert.equal((await hook(ev,{signature:''})).status,401,'missing');
  assert.equal((await hook(ev,{signature:'abc'})).status,401,'garbage');
  assert.equal((await hook(ev,{signature:crypto.createHmac('sha256','wrong-secret').update(body).digest('base64')})).status,401,'wrong secret');
  assert.equal((await hook(ev,{raw:body.replace('{','{ '),signature:sign(body)})).status,401,'body changed after signing');
  assert.equal((await hook(ev,{raw:JSON.stringify({destination:'Ubot',events:ev},null,2)})).status,200,'any formatting is fine when signed as sent');
  assert.equal(Number(one('SELECT COUNT(*) n FROM line_qc_messages').n),1,'only the correctly signed request was stored');
  assert.equal((await hook([],{raw:'not json'})).status,400,'signed but invalid JSON');
  assert.equal((await hook([])).status,200,'LINE console "Verify" (no events)');
  assert.equal((await hook([],{pathName:'/api/line/webhook'})).status,200,'alias path');
});

test('only the configured group is accepted', async()=>{
  const before=Number(one('SELECT COUNT(*) n FROM line_qc_messages').n),text=qcText('9900006','INV99-TST001','ACCEPT LOT');
  const r=await hook([textEvent(text,{group:OTHER_GROUP}),textEvent(text,{sourceType:'user'}),textEvent(text,{sourceType:'room'})]);
  assert.equal(r.status,200);assert.deepEqual(r.body.events,{IGNORED_SOURCE:3});
  assert.equal(Number(one('SELECT COUNT(*) n FROM line_qc_messages').n),before);assert.equal(current('INV99-TST001','9900006').length,0);
});

let appliedId,appliedTs;
test('safe ACCEPT is applied automatically (sample format with mention metadata)', async()=>{
  // 9900001 was applied by the signature test; check that row
  const row=one(`SELECT * FROM line_qc_messages WHERE sap_no='9900001' AND status='APPLIED'`);
  assert.ok(row);appliedId=row.line_message_id;appliedTs=row.line_timestamp;
  const ev=textEvent(qcText('9900006','INV99-TST001','*ACCEPT LOT* @T. Vacation 16-19 @dpployz'),{mentions:['@T. Vacation 16-19','@dpployz']});
  const r=await hook([ev]);assert.deepEqual(r.body.events,{APPLIED:1});
  const m=msgRow(ev.message.id),cur=current('INV99-TST001','9900006');
  assert.equal(m.status,'APPLIED');assert.equal(m.result,'ACCEPT');assert.equal(m.matched_sap_no,'9900006');
  assert.deepEqual(JSON.parse(m.mentions_json),[{display_text:'@T. Vacation 16-19',type:'user'},{display_text:'@dpployz',type:'user'}]);
  assert.equal(cur.length,1);assert.equal(cur[0].result,'ACCEPT');assert.equal(cur[0].source_message_id,'line:'+ev.message.id);assert.equal(cur[0].id,m.qc_result_id);
  assert.equal(cur[0].quantity,1000);assert.equal(cur[0].received_at,new Date(ev.timestamp).toISOString());assert.equal(cur[0].parser_version,'line-qc-v2');
  const sla=(await api('/api/qc-sla/items')).body.items.find(x=>x.invoice_no==='INV99-TST001'&&x.sap_no==='9900006');
  assert.equal(sla.qc_status,'ACCEPT');assert.equal(sla.sla.status_code,'RESOLVED');
  const tr=(await api('/api/tracking?invoice=INV99-TST001')).body.find(x=>x.sap_no==='9900006');assert.equal(tr.qc_result,'ACCEPT');
  assert.ok(db(`SELECT 1 FROM audit_logs WHERE entity='line_qc_message' AND action='LINE_APPLIED'`).length>=2);
});

// Real LINE payload shape (captured 2026-11-01; ids/tokens fake): markAsReadToken + quoteToken, mentionees with isSelf.
// Offsets here are Unicode code points after an astral emoji, the reading that differs from JS UTF-16 indexes.
test('real payload shape: Thai text, emoji, several mentions at the end (code-point offsets) is applied', async()=>{
  const text=qcText('9900007','INV99-TST001','😀 ACCEPT LOT\n@tantannus ✨ @น้องเมย์ 💕 QC.2 @PCM12_Parn'),names=['@tantannus ✨','@น้องเมย์ 💕 QC.2','@PCM12_Parn'];
  let from=0;const mentionees=names.map(n=>{const at=text.indexOf(n,from);from=at+n.length;return {index:[...text.slice(0,at)].length,length:[...n].length,userId:USER_ID,type:'user',isSelf:false}});
  assert.notEqual(mentionees[0].index,text.indexOf(names[0]),'offsets really differ from UTF-16');
  const ev=textEvent(text);ev.message={type:'text',id:ev.message.id,quoteToken:'q'.repeat(20),markAsReadToken:'m'.repeat(20),text,mention:{mentionees}};
  const r=await hook([ev]);assert.deepEqual(r.body.events,{APPLIED:1});
  const m=msgRow(ev.message.id),cur=current('INV99-TST001','9900007');
  assert.equal(m.status,'APPLIED');assert.equal(m.result,'ACCEPT');assert.deepEqual(JSON.parse(m.mentions_json).map(x=>x.display_text),names);
  assert.equal(cur.length,1);assert.equal(cur[0].result,'ACCEPT');assert.equal(cur[0].source_message_id,'line:'+ev.message.id);
  const row=JSON.stringify(m);for(const secret of [USER_ID,'q'.repeat(20),'m'.repeat(20),GROUP])assert.ok(!row.includes(secret));
});

// Real mention-picker payload (captured 2026-11-01 16:23 +07): text as received with SAP/invoice swapped for fixtures,
// one mentionee at the end (UTF-16 index/length), followed by a space. The mention is removed and "จึงขอทำการ Reject ค่ะ"
// (one allowed polite word) is applied. A later plain "Reject" for the same item only confirms it.
test('real mention-picker payload: mention removed, "Reject ค่ะ" is applied, repeat confirms', async()=>{
  const body="9900008 ICT,EMPTY PLASTIC,NATURAL,D12*H12.8,PLUG\nLOT INV99-TST001\nของเข้าวันที่ 12/10/2026 ยอด  20,686  ชิ้น สุ่ม 315  ชิ้น \nMinor=  สีไม่ตรง std.267  ชิ้น 84.76%  ` *ACCEPT`*\nMinor= พลาสติกยื่น 32 ชิ้น 10.1% ` `REJECT`\nMinor=คราบสกปรก  9  ชิ้น 2.85% `REJECT`  \nMinor= จุดสี  7 ชิ้น 2.22% *ACCEPT`* \nDefect เกินเกณฑ์การยอมรับ จึงขอทำการ Reject ค่ะ ";
  const picker=b=>{const ev=textEvent(`${b}@PLM QC Test `,{mentions:['@PLM QC Test']});ev.message={...ev.message,markAsReadToken:'m'.repeat(20)};ev.message.mention.mentionees[0].isSelf=false;return ev};
  const polite=picker(body);assert.deepEqual(polite.message.mention.mentionees.map(m=>[m.index,m.length]),[[348,12]],'same offsets as the captured payload');
  assert.deepEqual((await hook([polite])).body.events,{APPLIED:1});
  const m=msgRow(polite.message.id);
  assert.equal(m.result,'REJECT');assert.equal(m.result_reason,'FINAL_SUMMARY');assert.deepEqual(JSON.parse(m.review_reasons),[]);
  assert.deepEqual(JSON.parse(m.mentions_json),[{display_text:'@PLM QC Test',type:'user'}]);assert.deepEqual(JSON.parse(m.parsed_json).mention_warnings,[]);
  const cur=current('INV99-TST001','9900008');assert.equal(cur.length,1);assert.equal(cur[0].result,'REJECT');assert.equal(cur[0].source_message_id,'line:'+polite.message.id);
  const plain=picker(body.replace('Reject ค่ะ ','Reject '));
  assert.deepEqual((await hook([plain])).body.events,{CONFIRMED_EXISTING:1});
  assert.equal(current('INV99-TST001','9900008')[0].id,cur[0].id,'result untouched');
  for(const row of [msgRow(polite.message.id),msgRow(plain.message.id)]){const s=JSON.stringify(row);for(const secret of [USER_ID,'m'.repeat(20),GROUP])assert.ok(!s.includes(secret))}
});

test('safe REJECT replaces only a legacy PENDING row, which is kept', async()=>{
  const ev=textEvent(qcText('9900005','INV99-TST001','พบขนแปรงไม่สุดเกิน AQL จึงขอทำการ Reject'));
  assert.deepEqual((await hook([ev])).body.events,{APPLIED:1});
  const cur=current('INV99-TST001','9900005');assert.equal(cur.length,1);assert.equal(cur[0].result,'REJECT');
  assert.equal(one(`SELECT is_current FROM qc_results WHERE id='legacy-pending'`).is_current,0,'legacy row kept, not current');
});

test('duplicates and redeliveries are processed once', async()=>{
  const ev=textEvent(qcText('9900006','INV99-TST001','ACCEPT LOT'),{id:appliedId});
  const before=qcCount(),rows=Number(one('SELECT COUNT(*) n FROM line_qc_messages').n);
  assert.deepEqual((await hook([{...ev,deliveryContext:{isRedelivery:true}}])).body.events,{DUPLICATE:1});
  const fresh=textEvent('สวัสดีค่ะ');assert.deepEqual((await hook([fresh,fresh])).body.events,{IGNORED:1,DUPLICATE:1},'same id twice in one request');
  assert.equal(qcCount(),before);assert.equal(Number(one('SELECT COUNT(*) n FROM line_qc_messages').n),rows+1);
});

test('same result as the current one is linked, nothing written', async()=>{
  const before=qcCount(),ev=textEvent(qcText('9900002','INV99-TST001','ACC.LOT / ผลผ่าน'));
  assert.deepEqual((await hook([ev])).body.events,{CONFIRMED_EXISTING:1});
  assert.equal(qcCount(),before);assert.equal(msgRow(ev.message.id).qc_result_id,'legacy-accept');
});

let conflictId,olderId,unknownId,noInvoiceId,notFoundId;
test('conflicting results never overwrite: newer and older both go to review', async()=>{
  const before=qcCount();
  const newer=textEvent(qcText('9900002','INV99-TST001','จึงขอทำการ Reject'));
  const older=textEvent(qcText('9900001','INV99-TST001','จึงขอทำการ Reject'),{ts:Date.parse(appliedTs)-60000});
  assert.deepEqual((await hook([newer,older])).body.events,{NEEDS_REVIEW:2});
  const a=msgRow(newer.message.id),b=msgRow(older.message.id);conflictId=a.id;olderId=b.id;
  assert.deepEqual(JSON.parse(a.review_reasons),['RESULT_CHANGED']);assert.equal(a.previous_result,'ACCEPT');
  assert.deepEqual(JSON.parse(b.review_reasons),['OLDER_THAN_CURRENT','RESULT_CHANGED']);
  assert.equal(qcCount(),before);
  assert.equal(current('INV99-TST001','9900002')[0].id,'legacy-accept');assert.equal(current('INV99-TST001','9900001')[0].result,'ACCEPT');
});

test('UNKNOWN, missing or ambiguous data go to review with reasons', async()=>{
  const before=qcCount();
  const cases=[
    [qcText('9900004','INV99-TST001','ACCEPT LOT ขอบคุณค่ะ'),['UNKNOWN_RESULT']],
    [qcText('9900004','INV99-TST001','ACCEPT LOT\nขอบคุณค่ะ'),['UNKNOWN_RESULT']],
    [qcText('9900004','INV99-TST001','*ACCEPT LOT* @T. Vacation 16-19'),['UNKNOWN_RESULT']], // @ without metadata
    [qcText('9900004','INV99-TST001','ACCEPT LOT / จึงขอทำการ Reject'),['UNKNOWN_RESULT']],
    [qcText('9900001','INV99-NOPE01','ACCEPT LOT'),['INVOICE_NOT_FOUND']],
    [qcText('9900099','INV99-TST001','ACCEPT LOT'),['SAP_NOT_IN_INVOICE']],
    [qcText('9900003','INV99-TST001','ACCEPT LOT'),['SAP_AMBIGUOUS']],
    [qcText('9900001/9900004','INV99-TST001','ACCEPT LOT'),['MULTIPLE_SAP']],
    [qcText('9900001','INV99-TST001 INV99-TST002','ACCEPT LOT'),['MULTIPLE_INVOICE']],
    [qcText('9900001','','ACCEPT LOT'),['NO_INVOICE']], // 9900001 is in two invoices: never guessed
    [qcText('9900004','INV99-NOPE01','ACCEPT LOT ขอบคุณค่ะ'),['UNKNOWN_RESULT','INVOICE_NOT_FOUND']]
  ];
  const evs=cases.map(([t])=>textEvent(t));
  assert.deepEqual((await hook(evs)).body.events,{NEEDS_REVIEW:cases.length});
  cases.forEach(([,reasons],i)=>assert.deepEqual(JSON.parse(msgRow(evs[i].message.id).review_reasons),reasons,cases[i][0].split('\n').pop()));
  unknownId=msgRow(evs[0].message.id).id;notFoundId=msgRow(evs[4].message.id).id;noInvoiceId=msgRow(evs[9].message.id).id;
  assert.equal(qcCount(),before);assert.equal(current('INV99-TST001','9900004').length,0);
});

test('non-QC chatter and non-text events store no content', async()=>{
  const chat=textEvent('พรุ่งนี้ประชุม 10 โมงนะคะ @dpployz',{mentions:['@dpployz']});
  const r=await hook([chat,{type:'message',timestamp:Date.now(),source:{type:'group',groupId:GROUP,userId:USER_ID},message:{type:'sticker',id:'s1'}},{type:'join',timestamp:Date.now(),source:{type:'group',groupId:GROUP}}]);
  assert.deepEqual(r.body.events,{IGNORED:1,IGNORED_EVENT:2});
  const m=msgRow(chat.message.id);assert.equal(m.status,'IGNORED');assert.equal(m.text_redacted,'');assert.equal(m.mentions_json,'[]');
  assert.ok(!(await api('/api/line-qc/messages?status=ALL')).body.some(x=>x.id===m.id));
});

test('review API: list and summary', async()=>{
  const list=(await api('/api/line-qc/messages')).body;
  assert.ok(list.length>=13);assert.ok(list.every(x=>x.status==='NEEDS_REVIEW'));
  const c=list.find(x=>x.id===conflictId);assert.equal(c.current_result,'ACCEPT');assert.equal(c.matched_invoice_no,'INV99-TST001');assert.ok(Array.isArray(c.review_reasons));assert.ok(c.parsed.defects.length===2);
  assert.equal(c.mentions_json,undefined);
  const s=(await api('/api/line-qc/summary')).body;assert.equal(s.NEEDS_REVIEW,list.length);assert.ok(s.APPLIED>=3);
  assert.equal((await api('/api/line-qc/messages?status=bogus')).status,400);
});

test('review API: validation', async()=>{
  assert.equal((await resolve('nope',{action:'DISMISS'})).status,404);
  assert.equal((await resolve(unknownId,{action:'DELETE'})).status,400);
  assert.equal((await resolve(unknownId,{action:'APPLY',result:'UNKNOWN'})).status,400);
  let r=await resolve(unknownId,{action:'APPLY',result:'ACCEPT',sap_no:'9900099'});assert.equal(r.status,422);assert.match(r.body.error,/ไม่พบ SAP No/);
  r=await resolve(unknownId,{action:'APPLY',result:'ACCEPT',sap_no:'9900003'});assert.equal(r.status,422);assert.match(r.body.error,/หลายรายการ/);
  r=await resolve(unknownId,{action:'APPLY',result:'ACCEPT',invoice_no:'INV99-NOPE01'});assert.equal(r.status,422);
  assert.equal(current('INV99-TST001','9900004').length,0);
});

test('review API: apply, dismiss, confirm-before-replace', async()=>{
  let r=await resolve(unknownId,{action:'APPLY',result:'ACCEPT',note:'ตรวจกับ QC แล้ว'});
  assert.equal(r.status,200);assert.equal(r.body.status,'RESOLVED');assert.equal(r.body.review_action,'APPLY');
  const c4=current('INV99-TST001','9900004');assert.equal(c4.length,1);assert.equal(c4[0].result,'ACCEPT');assert.match(c4[0].source_message_id,/^line-review:/);
  assert.equal((await resolve(unknownId,{action:'DISMISS'})).status,409,'already handled');

  r=await resolve(notFoundId,{action:'DISMISS',note:'Invoice ผิด'});assert.equal(r.body.status,'DISMISSED');

  r=await resolve(noInvoiceId,{action:'APPLY',result:'ACCEPT',invoice_no:'INV99-TST002'});assert.equal(r.body.status,'RESOLVED');
  assert.equal(current('INV99-TST002','9900001')[0].result,'ACCEPT');assert.equal(current('INV99-TST001','9900001')[0].result,'ACCEPT');

  const before=qcCount();
  r=await resolve(conflictId,{action:'APPLY',result:'REJECT'});
  assert.equal(r.status,409);assert.equal(r.body.needs_confirm,true);assert.equal(r.body.current_result,'ACCEPT');
  assert.equal(qcCount(),before);assert.equal(current('INV99-TST001','9900002')[0].id,'legacy-accept');
  r=await resolve(conflictId,{action:'APPLY',result:'REJECT',confirm_replace:'true'});assert.equal(r.status,409,'confirm must be boolean true');
  r=await resolve(conflictId,{action:'APPLY',result:'REJECT',confirm_replace:true});
  assert.equal(r.status,200);assert.equal(r.body.review_action,'REPLACE');assert.equal(r.body.previous_result,'ACCEPT');
  const c2=current('INV99-TST001','9900002');assert.equal(c2.length,1);assert.equal(c2[0].result,'REJECT');
  assert.deepEqual(one(`SELECT result,is_current FROM qc_results WHERE id='legacy-accept'`),{result:'ACCEPT',is_current:0},'old result preserved');
  const a=JSON.parse(one(`SELECT details FROM audit_logs WHERE action='LINE_REVIEW_REPLACE'`).details);
  assert.equal(a.previous_result,'ACCEPT');assert.equal(a.previous_qc_result_id,'legacy-accept');assert.equal(a.result,'REJECT');

  r=await resolve(olderId,{action:'APPLY',result:'ACCEPT'});assert.equal(r.body.review_action,'CONFIRM_EXISTING','choosing the current result writes nothing');
});

test('unsend flags the message and keeps the QC result', async()=>{
  const cur=current('INV99-TST001','9900006')[0],ev=one(`SELECT line_message_id FROM line_qc_messages WHERE qc_result_id='${cur.id}'`).line_message_id;
  const un={type:'unsend',mode:'active',timestamp:Date.now(),source:{type:'group',groupId:GROUP,userId:USER_ID},unsend:{messageId:ev}};
  assert.deepEqual((await hook([un])).body.events,{UNSENT:1});
  const m=msgRow(ev);assert.equal(m.status,'NEEDS_REVIEW');assert.ok(JSON.parse(m.review_reasons).includes('MESSAGE_UNSENT'));assert.ok(m.unsent_at);
  assert.equal(current('INV99-TST001','9900006')[0].id,cur.id,'result untouched');
  assert.deepEqual((await hook([un])).body.events,{DUPLICATE:1});
  assert.deepEqual((await hook([{...un,unsend:{messageId:'999'}}])).body.events,{UNSEND_UNKNOWN:1});
  const r=await resolve(m.id,{action:'DISMISS',note:'ผลยังถูกต้อง'});assert.equal(r.body.status,'DISMISSED');
});

test('legacy behaviour is unchanged', async()=>{
  const sample=qcText('9900006','INV99-TST001','ACCEPT LOT');
  let r=await api('/api/qc/messages',{method:'POST',body:JSON.stringify({text:sample})});
  assert.equal(r.status,422);assert.equal(r.body.error,'ระบุ Invoice No. และ SAP No. ไม่ครบ');
  r=await api('/api/qc/rules');assert.deepEqual(r.body,{accept:['ACCEPT LOT','Accept Lot','ACC.LOT /ผลผ่าน','ACCEPT LOT/ผลผ่าน','อยู่ใน RB ACCEPT'],reject:['Reject','REJECT','ขอทำการ Reject'],summary:'last non-empty line',precedence:'ambiguous result => review'});
  r=await api('/api/line/webhook',{method:'POST',body:JSON.stringify({events:[{}]})});assert.equal(r.status,202);assert.equal(r.body.events_received,1);
  for(const u of ['/api/health','/api/dashboard','/api/qc/latest','/api/brand-bom/invoices','/api/packing-lists/INV99-TST001'])assert.equal((await api(u)).status,200,u);
  assert.equal((await fetch(base+'/')).status,200);
});

test('database integrity and privacy', ()=>{
  assert.equal(one('PRAGMA integrity_check').integrity_check,'ok');
  assert.deepEqual(db('PRAGMA foreign_key_check'),[]);
  assert.equal(Number(one('SELECT COUNT(*) n FROM packing_lists').n),2);assert.equal(Number(one('SELECT COUNT(*) n FROM items').n),10);
  assert.equal(Number(one(`SELECT COUNT(*) n FROM (SELECT packing_list_id,sap_no FROM qc_results WHERE is_current=1 AND result IN ('ACCEPT','REJECT') GROUP BY 1,2 HAVING COUNT(*)>1)`).n),0,'one decided current result per item');
  const dump=execFileSync('sqlite3',[dbPath,'.dump'],{encoding:'utf8',maxBuffer:64*1024*1024});
  for(const secret of [USER_ID,GROUP,REPLY_TOKEN,SECRET,'quoteToken'])assert.ok(!dump.includes(secret),'must not be stored: '+secret.slice(0,6));
  assert.ok(!logs.includes(SECRET),'secret not logged');
});
