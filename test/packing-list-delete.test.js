// End-to-end test of deleting a packing list. Runs server.js from a temp folder with an EMPTY database plus its own
// fixtures: the live data/ DB is never used. Run: npm test
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const {spawn,execFileSync}=require('child_process');

const ROOT=path.join(__dirname,'..');
let tmp,proc,base,dbPath,dataDir,logs='';
const db=s=>{const r=execFileSync('sqlite3',['-json',dbPath,s],{encoding:'utf8'}).trim();return r?JSON.parse(r):[]};
const one=s=>db(s)[0],count=s=>Number(one(`SELECT COUNT(*) n FROM ${s}`).n);
const freePort=()=>new Promise((res,rej)=>{const s=net.createServer();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>res(p))})});
async function api(url,opts={}){const r=await fetch(base+url,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});return {status:r.status,body:await r.json().catch(()=>null)}}
const del=(inv,body)=>api('/api/packing-lists/'+encodeURIComponent(inv),{method:'DELETE',body:JSON.stringify(body)});
const backups=()=>fs.readdirSync(dataDir).filter(f=>f.startsWith('pl-brand-before-delete-'));

test.before(async()=>{
  tmp=fs.mkdtempSync(path.join(os.tmpdir(),'plm-delete-'));
  for(const f of ['server.js','index.html','line-qc-parser.js','line-qc-service.js'])fs.copyFileSync(path.join(ROOT,f),path.join(tmp,f));
  fs.symlinkSync(path.join(ROOT,'node_modules'),path.join(tmp,'node_modules'));
  dataDir=path.join(tmp,'data');dbPath=path.join(dataDir,'pl-brand.sqlite');
  const port=await freePort();base=`http://127.0.0.1:${port}`;
  const env={...process.env,PORT:String(port)};delete env.LINE_CHANNEL_SECRET;
  proc=spawn(process.execPath,['server.js'],{cwd:tmp,env,stdio:['ignore','pipe','pipe']});
  proc.stdout.on('data',d=>logs+=d);proc.stderr.on('data',d=>logs+=d);
  const t0=Date.now();
  while(!logs.includes('listening at')){if(Date.now()-t0>20000||proc.exitCode!=null)throw Error('server did not start:\n'+logs);await new Promise(r=>setTimeout(r,100))}
  const n="'2026-10-26T00:00:00.000Z'",pdf=f=>path.join(dataDir,'packing-lists',f);
  fs.writeFileSync(pdf('a.pdf'),'%PDF-1.4 a');fs.writeFileSync(pdf('b.pdf'),'%PDF-1.4 b');
  const items=[['a1','plA',1,'9800001'],['a2','plA',2,'9800002'],['b1','plB',1,'9800001']];
  execFileSync('sqlite3',['-bail',dbPath],{input:`BEGIN;
INSERT INTO packing_lists(id,invoice_no,etd,eta,etr,file_name,file_path,file_sha256,status,created_at,updated_at) VALUES
 ('plA','INV99-DEL001','','','2026-10-30','a.pdf',${JSON.stringify(pdf('a.pdf')).replace(/"/g,"'")},'','REVIEW',${n},${n}),
 ('plB','INV99-KEEP01','','','2026-10-30','b.pdf',${JSON.stringify(pdf('b.pdf')).replace(/"/g,"'")},'','REVIEW',${n},${n}),
 ('plE','INV99-EMPTY1','','','','','','','REVIEW',${n},${n});
${items.map(([id,pl,line,sap])=>`INSERT INTO items(id,packing_list_id,line_no,sap_po,sap_no,description,quantity,uom,bom,brand,production_model,review_status,created_at,updated_at) VALUES('${id}','${pl}',${line},'PO1','${sap}','TEST ITEM ${sap}',100,'PCS','','','','CONFIRMED',${n},${n});`).join('\n')}
INSERT INTO work_orders(id,item_id,wo_no,last_synced_at) VALUES('wa1','a1','WO-A1',${n}),('wb1','b1','WO-B1',${n});
INSERT INTO qc_results(id,packing_list_id,sap_no,result,raw_message,defect_description,quantity,source_message_id,parser_version,received_at,is_current) VALUES
 ('qa1','plA','9800001','ACCEPT','m','',NULL,'line:1','line-qc-v2',${n},1),('qa2','plA','9800002','REJECT','m','',NULL,NULL,'qc-v1',${n},1),('qb1','plB','9800001','ACCEPT','m','',NULL,NULL,'qc-v1',${n},1);
INSERT INTO line_qc_messages(id,line_message_id,line_timestamp,parser_version,result,invoice_no,sap_no,packing_list_id,matched_sap_no,status,review_reasons,qc_result_id,created_at,updated_at) VALUES
 ('m1','1',${n},'line-qc-v2','ACCEPT','INV99-DEL001','9800001','plA','9800001','APPLIED','[]','qa1',${n},${n}),
 ('m2','2',${n},'line-qc-v2','UNKNOWN','INV99-DEL001','9800002','plA','9800002','NEEDS_REVIEW','["UNKNOWN_RESULT"]',NULL,${n},${n}),
 ('m3','3',${n},'line-qc-v2','ACCEPT','INV99-KEEP01','9800001','plB','9800001','APPLIED','[]','qb1',${n},${n});
COMMIT;`});
});

test.after(()=>{try{proc?.kill()}catch{}if(tmp)fs.rmSync(tmp,{recursive:true,force:true})});

test('usage shows what a delete would remove', async()=>{
  const r=await api('/api/packing-lists/INV99-DEL001/usage');
  assert.equal(r.status,200);
  assert.deepEqual(r.body,{invoice_no:'INV99-DEL001',status:'REVIEW',items:2,work_orders:1,qc_results:2,line_qc_messages:2,has_pdf:true});
  assert.equal((await api('/api/packing-lists/INV99-NOPE/usage')).status,404);
});

test('delete needs the exact invoice number typed back', async()=>{
  for(const body of [{},{confirm_invoice:''},{confirm_invoice:'INV99-DEL00'},{confirm_invoice:'INV99-KEEP01'}]){
    const r=await del('INV99-DEL001',body);assert.equal(r.status,400,JSON.stringify(body));assert.match(r.body.error,/Invoice/);
  }
  assert.equal((await del('INV99-NOPE',{confirm_invoice:'INV99-NOPE'})).status,404);
  assert.equal(count('packing_lists'),3);assert.equal(backups().length,0,'no backup when nothing is deleted');
});

test('delete removes the packing list and everything tied to it, nothing else', async()=>{
  const r=await del('INV99-DEL001',{confirm_invoice:' inv99-del001 '});
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual(r.body.deleted,{items:2,work_orders:1,qc_results:2,line_qc_messages:2});assert.equal(r.body.pdf_deleted,true);
  assert.equal(one(`SELECT COUNT(*) n FROM packing_lists WHERE id='plA'`).n,0);
  assert.equal(one(`SELECT COUNT(*) n FROM items WHERE packing_list_id='plA'`).n,0);
  assert.equal(one(`SELECT COUNT(*) n FROM qc_results WHERE packing_list_id='plA'`).n,0);
  assert.equal(one(`SELECT COUNT(*) n FROM work_orders WHERE id='wa1'`).n,0);
  assert.equal(one(`SELECT COUNT(*) n FROM packing_list_qc_tracking WHERE invoice_no='INV99-DEL001'`).n,0);
  assert.ok(!fs.existsSync(path.join(dataDir,'packing-lists','a.pdf')));
  // the other packing list is untouched
  assert.equal(count('items'),1);assert.equal(one(`SELECT wo_no FROM work_orders WHERE item_id='b1'`).wo_no,'WO-B1');
  assert.equal(one(`SELECT result FROM qc_results WHERE id='qb1'`).result,'ACCEPT');assert.ok(fs.existsSync(path.join(dataDir,'packing-lists','b.pdf')));
  assert.deepEqual(one(`SELECT status,packing_list_id,qc_result_id FROM line_qc_messages WHERE id='m3'`),{status:'APPLIED',packing_list_id:'plB',qc_result_id:'qb1'});
});

test('LINE QC messages of the deleted list are kept, unlinked and sent back to review', async()=>{
  const rows=db(`SELECT id,status,packing_list_id,matched_sap_no,qc_result_id,invoice_no,review_reasons FROM line_qc_messages WHERE id IN ('m1','m2') ORDER BY id`);
  for(const m of rows){
    assert.equal(m.status,'NEEDS_REVIEW');assert.equal(m.packing_list_id,null);assert.equal(m.matched_sap_no,null);assert.equal(m.qc_result_id,null);
    assert.equal(m.invoice_no,'INV99-DEL001','parsed invoice stays for the reviewer');assert.ok(JSON.parse(m.review_reasons).includes('PACKING_LIST_DELETED'));
  }
  assert.deepEqual(JSON.parse(rows[1].review_reasons),['UNKNOWN_RESULT','PACKING_LIST_DELETED']);
});

test('a backup is made before deleting, and the delete is audited', ()=>{
  const files=backups();assert.equal(files.length,1);assert.match(files[0],/^pl-brand-before-delete-INV99-DEL001-\d{14}\.sqlite$/);
  const copy=path.join(dataDir,files[0]),r=execFileSync('sqlite3',[copy,`SELECT COUNT(*) FROM packing_lists WHERE id='plA'`],{encoding:'utf8'}).trim();
  assert.equal(r,'1','backup still has the deleted list');
  const a=one(`SELECT * FROM audit_logs WHERE entity='packing_list' AND entity_id='plA' AND action='DELETE'`);
  assert.ok(a);const d=JSON.parse(a.details);assert.equal(d.invoice_no,'INV99-DEL001');assert.equal(d.backup,files[0]);assert.equal(d.items,2);
});

test('a list with no items or PDF can be deleted and disappears from the dashboard', async()=>{
  const r=await del('INV99-EMPTY1',{confirm_invoice:'INV99-EMPTY1'});
  assert.equal(r.status,200);assert.deepEqual(r.body.deleted,{items:0,work_orders:0,qc_results:0,line_qc_messages:0});assert.equal(r.body.pdf_deleted,false);
  assert.equal((await api('/api/packing-lists/INV99-EMPTY1')).status,404);
  const dash=(await api('/api/dashboard')).body;assert.deepEqual([...dash.invoices,...dash.archive].map(x=>x.invoice_no),['INV99-KEEP01']);
});

test('database integrity after deletes', ()=>{
  assert.equal(one('PRAGMA integrity_check').integrity_check,'ok');
  assert.deepEqual(db('PRAGMA foreign_key_check'),[]);
});
