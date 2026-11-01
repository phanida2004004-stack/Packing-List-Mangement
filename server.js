const express=require('express');
const multer=require('multer');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {execFileSync}=require('child_process');
const {PDFParse}=require('pdf-parse');

const ROOT=__dirname, DATA=path.join(ROOT,'data'), FILES=path.join(DATA,'packing-lists'), DB=path.join(DATA,'pl-brand.sqlite');
fs.mkdirSync(FILES,{recursive:true});
const app=express(); app.use(express.json({limit:'5mb'}));
const upload=multer({dest:path.join(DATA,'tmp'),limits:{fileSize:35*1024*1024},fileFilter:(req,file,cb)=>{const n=file.originalname.toLowerCase();cb(null,file.mimetype==='application/pdf'||n.endsWith('.pdf')||file.mimetype==='text/csv'||n.endsWith('.csv')||n.endsWith('.xlsx'))}});
function sql(statement){return execFileSync('sqlite3',['-json',DB,statement],{encoding:'utf8',maxBuffer:64*1024*1024}).trim()}
function q(v){return "'"+String(v??'').replace(/'/g,"''")+"'"}
function query(statement){let r=sql(statement);return r?JSON.parse(r):[]}
function run(statement){sql(statement)}
function runScript(statement){execFileSync('sqlite3',['-bail',DB],{input:statement,encoding:'utf8',maxBuffer:64*1024*1024})} // large scripts via stdin (argv is size-limited)
run(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS packing_lists(id TEXT PRIMARY KEY,invoice_no TEXT NOT NULL UNIQUE,etd TEXT,eta TEXT,etr TEXT,file_name TEXT,file_path TEXT,file_sha256 TEXT,status TEXT NOT NULL DEFAULT 'REVIEW',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,packing_list_id TEXT NOT NULL REFERENCES packing_lists(id),line_no INTEGER NOT NULL,sap_po TEXT,sap_no TEXT NOT NULL,description TEXT NOT NULL,quantity REAL NOT NULL DEFAULT 0,uom TEXT,bom TEXT,brand TEXT,production_model TEXT,review_status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(packing_list_id,line_no));
CREATE TABLE IF NOT EXISTS qc_results(id TEXT PRIMARY KEY,packing_list_id TEXT NOT NULL REFERENCES packing_lists(id),sap_no TEXT NOT NULL,result TEXT NOT NULL,raw_message TEXT NOT NULL,defect_description TEXT,quantity REAL,source_message_id TEXT UNIQUE,parser_version TEXT NOT NULL,received_at TEXT NOT NULL,is_current INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sap_sync_batches(id TEXT PRIMARY KEY,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL,row_count INTEGER NOT NULL DEFAULT 0,error TEXT);
CREATE TABLE IF NOT EXISTS work_orders(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),wo_no TEXT,last_synced_at TEXT NOT NULL,UNIQUE(item_id));
CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY,entity TEXT NOT NULL,entity_id TEXT NOT NULL,action TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS brand_aliases(brand_name TEXT PRIMARY KEY COLLATE NOCASE,abbreviation TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS master_import_batches(id TEXT PRIMARY KEY,source_name TEXT NOT NULL,created_at TEXT NOT NULL,bom_rows INTEGER NOT NULL,model_rows INTEGER NOT NULL,alias_rows INTEGER NOT NULL,alias_conflicts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS master_brand_aliases(batch_id TEXT NOT NULL REFERENCES master_import_batches(id),brand_name TEXT NOT NULL COLLATE NOCASE,abbreviation TEXT NOT NULL,PRIMARY KEY(batch_id,brand_name));
CREATE TABLE IF NOT EXISTS active_master_import(id INTEGER PRIMARY KEY CHECK(id=1),batch_id TEXT NOT NULL REFERENCES master_import_batches(id));
CREATE TABLE IF NOT EXISTS sap_bom_data(batch_id TEXT NOT NULL REFERENCES master_import_batches(id),source_row INTEGER NOT NULL,bom_id TEXT,bom_description TEXT,input_product TEXT,input_product_description TEXT,status TEXT,input_quantity REAL,output_quantity REAL,PRIMARY KEY(batch_id,source_row));
CREATE TABLE IF NOT EXISTS production_model_data(batch_id TEXT NOT NULL REFERENCES master_import_batches(id),source_row INTEGER NOT NULL,model_id TEXT,model_description TEXT,product_id TEXT,product_description TEXT,planning_consistency TEXT,execution_consistency TEXT,planning_enabled TEXT,site TEXT,planning_area_id TEXT,PRIMARY KEY(batch_id,source_row));
CREATE INDEX IF NOT EXISTS idx_items_sap ON items(sap_no);
CREATE INDEX IF NOT EXISTS idx_qc_invoice_sap ON qc_results(packing_list_id,sap_no,received_at);
CREATE TABLE IF NOT EXISTS packing_list_qc_tracking(invoice_no TEXT NOT NULL,sap_no TEXT NOT NULL,description TEXT NOT NULL,qty INTEGER NOT NULL DEFAULT 0,etr_date DATE,qc_status TEXT NOT NULL DEFAULT 'PENDING',updated_at DATETIME NOT NULL,PRIMARY KEY(invoice_no,sap_no));
CREATE INDEX IF NOT EXISTS idx_pl_qc_status ON packing_list_qc_tracking(qc_status);
CREATE INDEX IF NOT EXISTS idx_pl_qc_etr ON packing_list_qc_tracking(etr_date);
`);
if(!query('PRAGMA table_info(qc_results)').some(c=>c.name==='quantity'))run('ALTER TABLE qc_results ADD COLUMN quantity REAL');
run(`CREATE TABLE IF NOT EXISTS sap_production_orders(production_order_id TEXT PRIMARY KEY,status TEXT,output_product_id TEXT NOT NULL,sap_no TEXT NOT NULL,product_description TEXT,release_due_date TEXT,planned_qty REAL,planned_qty_unit TEXT,fulfilled_qty REAL,fulfilled_qty_unit TEXT,open_qty REAL,open_qty_unit TEXT,created_on TEXT,requested_end TEXT,created_by TEXT,canceled TEXT,is_canceled INTEGER NOT NULL DEFAULT 0,raw_json TEXT NOT NULL,row_hash TEXT NOT NULL,first_imported_at TEXT NOT NULL,last_imported_at TEXT NOT NULL,last_batch_id TEXT);
CREATE INDEX IF NOT EXISTS idx_spo_sap ON sap_production_orders(sap_no);`);
{const cols=query('PRAGMA table_info(sap_sync_batches)').map(c=>c.name);for(const c of ['source_name TEXT','inserted_count INTEGER','updated_count INTEGER','error_count INTEGER','linked_count INTEGER'])if(!cols.includes(c.split(' ')[0]))run(`ALTER TABLE sap_sync_batches ADD COLUMN ${c}`)}
const now=()=>new Date().toISOString();
function audit(entity,id,action,details={}){run(`INSERT INTO audit_logs VALUES(${q(crypto.randomUUID())},${q(entity)},${q(id)},${q(action)},${q(JSON.stringify(details))},${q(now())})`)}
function invoiceRow(inv){return query(`SELECT * FROM packing_lists WHERE invoice_no=${q(inv)}`)[0]}
function listItems(plid){return query(`SELECT i.*,COALESCE(w.wo_no,'') AS wo_no,q.result AS qc_result FROM items i LEFT JOIN work_orders w ON w.item_id=i.id LEFT JOIN qc_results q ON q.packing_list_id=i.packing_list_id AND q.sap_no=i.sap_no AND q.is_current=1 WHERE i.packing_list_id=${q(plid)} ORDER BY i.line_no`)}
let brandCache=null,masterDescriptions=null,masterBatchCache=null,masterProductInfo=null,masterBomInfo=null,customOverridesCache=null;
function getCustomOverrides(){
  if(!customOverridesCache){
    run(`CREATE TABLE IF NOT EXISTS custom_master_overrides(
      sap_no TEXT PRIMARY KEY,
      bom_id TEXT,
      has_bom INTEGER NOT NULL DEFAULT 1,
      brand TEXT,
      model_ids TEXT,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );`);
    const rows=query(`SELECT * FROM custom_master_overrides`);
    customOverridesCache=new Map();
    for(const r of rows){
      let models=[];
      try{models=JSON.parse(r.model_ids||'[]')}catch{models=[]}
      const entry={
        sap_no:r.sap_no,
        bom_id:r.bom_id||'',
        has_bom:Number(r.has_bom)===1,
        brand:r.brand||'',
        model_ids:Array.isArray(models)?models:[]
      };
      customOverridesCache.set(String(r.sap_no).trim(),entry);
      customOverridesCache.set(canonicalSap(r.sap_no),entry);
    }
  }
  return customOverridesCache;
}
function invalidateCustomOverrides(){customOverridesCache=null;}
function getCustomOverrideForSap(sapNo){
  const overrides=getCustomOverrides(),sap=String(sapNo||'').trim();
  return overrides.get(sap)||overrides.get(canonicalSap(sap))||null;
}
const standardProductionModels=[
  {key:'INS',model_id:'INS',name:'Inspection_Assembly (2,000 ea:12 Man)'},
  {key:'CTN',model_id:'CTN',name:'STK+CTN_CHANGE CODE (120,000 ea.:1 MAN)'},
  {key:'DIR',model_id:'DIR',name:'DIRECT (120,000 ea.:1 man)'}
];
function getBrandCache(){if(!brandCache){const batch=query('SELECT batch_id FROM active_master_import WHERE id=1')[0]?.batch_id||'',legacy=query('SELECT brand_name,abbreviation FROM brand_aliases'),current=batch?query(`SELECT brand_name,abbreviation FROM master_brand_aliases WHERE batch_id=${q(batch)}`):[],source=current.length?current:legacy,byName=new Map(source.map(x=>[x.brand_name.toLowerCase(),x.abbreviation])),rows=[...byName].map(([brand_name,abbreviation])=>({brand_name,abbreviation}));brandCache=rows;brandCache.byName=byName;brandCache.byCode=new Map(rows.map(x=>[x.abbreviation.toLowerCase(),x.abbreviation]));const escape=x=>x.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&');const names=[...new Set(rows.map(x=>x.brand_name).filter(Boolean))].sort((a,b)=>b.length-a.length);brandCache.redactPattern=names.length?new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escape).join('|')})(?![\\p{L}\\p{N}])`,'giu'):null}return brandCache}
function getMasterDescriptions(){if(!masterDescriptions){masterBatchCache=query('SELECT batch_id FROM active_master_import WHERE id=1')[0]?.batch_id||'';masterDescriptions=new Map();if(masterBatchCache){for(const r of query(`SELECT product_id AS id,product_description AS description FROM production_model_data WHERE batch_id=${q(masterBatchCache)} AND product_id<>'' AND product_description<>'' UNION ALL SELECT input_product AS id,input_product_description AS description FROM sap_bom_data WHERE batch_id=${q(masterBatchCache)} AND input_product<>'' AND input_product_description<>''`))if(!masterDescriptions.has(r.id))masterDescriptions.set(r.id,r.description)}}return masterDescriptions}
function getMasterProductInfo(){if(!masterProductInfo){masterBatchCache=query('SELECT batch_id FROM active_master_import WHERE id=1')[0]?.batch_id||'';masterProductInfo=new Map();if(masterBatchCache){for(const r of query(`SELECT product_id,product_description,model_id,model_description,planning_consistency,execution_consistency,planning_enabled FROM production_model_data WHERE batch_id=${q(masterBatchCache)} AND product_id<>''`)){const x=masterProductInfo.get(r.product_id)||{product_description:r.product_description||'',model_ids:[],model_details:[]};if(r.model_id&&!x.model_ids.includes(r.model_id))x.model_ids.push(r.model_id);if(r.model_id&&!x.model_details.some(m=>m.model_id===r.model_id))x.model_details.push({model_id:r.model_id,model_description:r.model_description||'',planning_consistency:r.planning_consistency||'',execution_consistency:r.execution_consistency||'',planning_enabled:r.planning_enabled||''});if(!x.product_description&&r.product_description)x.product_description=r.product_description;masterProductInfo.set(r.product_id,x)}}}return masterProductInfo}
function canonicalSap(value){return String(value||'').trim().replace(/-1$/i,'')}
function getMasterProductForSap(sapNo){const products=getMasterProductInfo(),sap=String(sapNo||'').trim();return products.get(`${canonicalSap(sap)}-1`)||products.get(sap)||{}}
function getMasterBomInfo(){if(!masterBomInfo){masterBatchCache=query('SELECT batch_id FROM active_master_import WHERE id=1')[0]?.batch_id||'';masterBomInfo={parents:new Map(),components:new Map(),children:new Map(),descriptions:new Map()};if(masterBatchCache){for(const r of query(`SELECT bom_id,bom_description,input_product FROM sap_bom_data WHERE batch_id=${q(masterBatchCache)}`)){const bom=String(r.bom_id||'').trim(),product=String(r.input_product||'').trim(),description=String(r.bom_description||'').trim();if(bom){if(description&&!masterBomInfo.descriptions.has(bom))masterBomInfo.descriptions.set(bom,description);const parentKey=canonicalSap(bom),parents=masterBomInfo.parents.get(parentKey)||[];if(!parents.includes(bom))parents.push(bom);masterBomInfo.parents.set(parentKey,parents);const children=masterBomInfo.children.get(bom)||[];if(product&&!children.includes(product))children.push(product);masterBomInfo.children.set(bom,children);if(product){const componentKey=canonicalSap(product),usedBy=masterBomInfo.components.get(componentKey)||[];if(!usedBy.includes(bom))usedBy.push(bom);masterBomInfo.components.set(componentKey,usedBy)}}}}}return masterBomInfo}
function bomBrandForSap(sapNo){const override=getCustomOverrideForSap(sapNo);if(override&&override.brand){return {brand:override.brand,status:'MATCHED',evidence:[{bom_id:override.bom_id||`${sapNo}-1`,brand:override.brand,has_description:true,is_generic:false,source:'Manual Override'}]}}const bom=getMasterBomInfo(),key=canonicalSap(sapNo),own=bom.parents.get(key)||[],parents=own.length?own:(bom.components.get(key)||[]);if(!parents.length)return {brand:'',status:'NO_BOM_SOURCE',evidence:[]};const aliases=getBrandCache(),genericNames=new Set(['COMMON','ICT','CM']),evidence=[...new Set(parents)].map(bomId=>{const description=bom.descriptions.get(bomId)||'',comma=description.indexOf(','),prefix=(comma>=0?description.slice(0,comma):description).trim(),generic=genericNames.has(prefix.toUpperCase()),brand=prefix&&!generic?(aliases.byName.get(prefix.toLowerCase())||aliases.byCode.get(prefix.toLowerCase())||''):'';return {bom_id:bomId,brand,has_description:!!description,generic_label:generic?prefix.toUpperCase():'',is_generic:generic}});const brands=[...new Set(evidence.map(x=>x.brand).filter(Boolean))],genericLabels=[...new Set(evidence.map(x=>x.generic_label).filter(Boolean))],unmatched=evidence.some(x=>!x.brand&&!x.is_generic||!x.has_description);if(genericLabels.length){if(brands.length||genericLabels.length>1||unmatched)return {brand:'',status:'CONFLICT',evidence};return {brand:genericLabels[0],status:'GENERIC_BOM',evidence}}if(brands.length>1||(brands.length===1&&unmatched))return {brand:'',status:'CONFLICT',evidence};if(brands.length===1)return {brand:brands[0],status:'MATCHED',evidence};if(evidence.some(x=>x.has_description))return {brand:'รอตั้งรหัส',status:'NEEDS_ALIAS',evidence};return {brand:'',status:'NO_DESCRIPTION',evidence}}
function resolveBomBrands(items){const direct=items.map(x=>bomBrandForSap(x.sap_no)),brandsByPo=new Map(),uncertainByPo=new Set();const poKey=x=>{const po=String(x.sap_po||'').trim().toUpperCase();return po?`${x.packing_list_id||'__invoice__'}|${po}`:''};for(let i=0;i<items.length;i++){const key=poKey(items[i]);if(!key)continue;const state=direct[i];if(state.status==='MATCHED'){const set=brandsByPo.get(key)||new Set();set.add(state.brand);brandsByPo.set(key,set)}else if(['CONFLICT','NEEDS_ALIAS'].includes(state.status)){uncertainByPo.add(key)}}return direct.map((state,i)=>{if(state.status!=='GENERIC_BOM')return state;const key=poKey(items[i]);if(!key)return state;const brands=[...(brandsByPo.get(key)||[])];if(brands.length>1||brands.length===1&&uncertainByPo.has(key))return {...state,brand:'',status:'CONFLICT'};if(brands.length===1)return {...state,brand:brands[0],status:'INHERITED_SAP_PO',evidence:[...state.evidence,{brand:brands[0],source:'SAP PO',sap_po:items[i].sap_po}]};return state})}
function safeItems(items){const brands=resolveBomBrands(items);return items.map((item,index)=>safeItem(item,brands[index]))}
function safeCandidates(items){const brands=resolveBomBrands(items);return items.map((item,index)=>publicCandidate(item,brands[index]))}

function masterRecordExists(sapNo){if(getCustomOverrideForSap(sapNo))return true;const key=canonicalSap(sapNo),bom=getMasterBomInfo();return Object.keys(getMasterProductForSap(sapNo)).length>0||bom.parents.has(key)||bom.components.has(key)}
function bomStatus(sapNo){const override=getCustomOverrideForSap(sapNo);if(override){if(override.has_bom){const bomId=override.bom_id||`${sapNo}-1`;return {bom_status:'HAS_OWN_BOM',has_own_bom:true,component_of:[],bom_ids:[bomId],bom_components:[]}}else{return {bom_status:'NO_BOM',has_own_bom:false,component_of:[],bom_ids:[],bom_components:[]}}}const key=canonicalSap(sapNo),bom=getMasterBomInfo(),master=masterRecordExists(sapNo),own=bom.parents.get(key)||[],usedBy=bom.components.get(key)||[];return {bom_status:own.length?'HAS_OWN_BOM':usedBy.length?'COMPONENT':master?'NO_BOM':'MASTER_NOT_FOUND',has_own_bom:own.length>0,component_of:usedBy,bom_ids:own,bom_components:[...new Set(own.flatMap(id=>bom.children.get(id)||[]))]}}
function displayProductDescription(description,sapNo){const d=String(description||'');if(!d)return '';const comma=d.indexOf(','),prefix=comma<0?'':d.slice(0,comma).trim(),alias=getBrandCache().byName.get(prefix.toLowerCase())||getBrandCache().byCode.get(prefix.toLowerCase())||'';const safe=redactKnownBrands(d);if(comma<0)return safe;const safePrefix=alias||'[ไม่แสดงชื่อแบรนด์]';return safePrefix+redactKnownBrands(d.slice(comma))}
function masterDescription(sapNo){return getMasterProductForSap(sapNo).product_description||''}
function brandInfo(description,sapNo='',brand=bomBrandForSap(sapNo)){const d=String(description||'');return {display_description:d,display_brand:brand.brand,brand_status:brand.status,brand_evidence:brand.evidence}}
function safeItem(item,brandOverride){const override=getCustomOverrideForSap(item.sap_no),{description,brand,...rest}=item,info=brandInfo(description,item.sap_no,brandOverride||bomBrandForSap(item.sap_no));let master=getMasterProductForSap(item.sap_no);const bom=bomStatus(item.sap_no),known=masterRecordExists(item.sap_no);if(override&&Array.isArray(override.model_ids)){const stdMap={'INS':'Inspection_Assembly (2,000 ea:12 Man)','CTN':'STK+CTN_CHANGE CODE (120,000 ea.:1 MAN)','DIR':'DIRECT (120,000 ea.:1 man)'};const details=override.model_ids.map(id=>{const match=(master.model_details||[]).find(m=>m.model_id===id||m.model_id?.toUpperCase().includes(id));return {model_id:id,model_description:match?.model_description||stdMap[id]||id,planning_consistency:match?.planning_consistency||'Consistent',execution_consistency:match?.execution_consistency||'Consistent',planning_enabled:match?.planning_enabled||'Yes'}});master={...master,model_ids:override.model_ids,model_details:details}}return {...rest,...info,product_description:displayProductDescription(masterDescription(item.sap_no),item.sap_no),model_ids:master.model_ids||[],model_details:master.model_details||[],model_status:master.model_ids?.length?'FOUND':known?'NO_MODEL':'MASTER_NOT_FOUND',...bom,has_custom_override:!!override,custom_override:override||null}}
function publicCandidate(item,brandOverride){const safe=safeItem(item,brandOverride);return {...item,...safe,description:safe.display_description,brand:safe.display_brand}}
function brandAliasFor(name){return query(`SELECT abbreviation FROM brand_aliases WHERE lower(trim(brand_name))=lower(${q(name)}) LIMIT 1`)[0]?.abbreviation||''}
function redactKnownBrands(text){const aliases=getBrandCache();return aliases.redactPattern?String(text||'').replace(aliases.redactPattern,match=>aliases.byName.get(match.toLowerCase())||match):String(text||'')}
function invoiceSummary(r){const {file_name,file_path,file_sha256,...publicRow}=r,rawItems=listItems(r.id),items=safeItems(rawItems),total=items.length,opened=items.filter(x=>x.wo_no).length,qcWait=items.filter(x=>!x.qc_result||x.qc_result==='PENDING').length;const status=total&&opened===total?'เปิดครบ':opened?'เปิดบางส่วน':'ยังไม่เปิด WO';return {...publicRow,total_items:total,opened_items:opened,qc_wait:qcWait,wo_status:status,items}}
function refreshArchive(plid){const row=query(`SELECT COUNT(*) total,SUM(CASE WHEN w.wo_no IS NOT NULL AND w.wo_no<>'' THEN 1 ELSE 0 END) opened FROM items i LEFT JOIN work_orders w ON w.item_id=i.id WHERE i.packing_list_id=${q(plid)}`)[0];if(row.total>0&&Number(row.total)===Number(row.opened)){run(`UPDATE packing_lists SET status='ARCHIVED',updated_at=${q(now())} WHERE id=${q(plid)}`)}else{run(`UPDATE packing_lists SET status='CONFIRMED',updated_at=${q(now())} WHERE id=${q(plid)} AND status='ARCHIVED'`)}}
function calculateSla(etrDateStr,qcStatus='PENDING',currentDate=new Date()){
  if(qcStatus!=='PENDING'){
    return {severity:'NORMAL',status_code:'RESOLVED',business_days_overdue:0,badge_text:qcStatus==='ACCEPT'?'✓ ผ่าน (ACCEPT)':'✕ ไม่ผ่าน (REJECT)',badge_color:qcStatus==='ACCEPT'?'green':'red',is_alert:false};
  }
  if(!etrDateStr)return {severity:'NORMAL',status_code:'NO_ETR',business_days_overdue:0,badge_text:'ไม่มี ETR',badge_color:'gray',is_alert:false};
  const parts=String(etrDateStr).trim().split('-');
  if(parts.length!==3)return {severity:'NORMAL',status_code:'INVALID_ETR',business_days_overdue:0,badge_text:'ETR ไม่ถูกต้อง',badge_color:'gray',is_alert:false};
  const [y,m,d]=parts.map(Number);
  const etr=new Date(y,m-1,d);etr.setHours(0,0,0,0);
  const cur=new Date(currentDate);
  const today=new Date(cur.getFullYear(),cur.getMonth(),cur.getDate());
  if(today<=etr){
    return {severity:'NORMAL',status_code:'NORMAL',business_days_overdue:0,badge_text:today.getTime()===etr.getTime()?'🟢 ถึงกำหนดวันนี้':'🟢 ยังไม่ถึงกำหนด',badge_color:'green',is_alert:false};
  }
  let businessDays=0;
  let iter=new Date(etr);
  iter.setDate(iter.getDate()+1);
  while(iter<=today){
    const day=iter.getDay();
    if(day!==0&&day!==6)businessDays++;
    iter.setDate(iter.getDate()+1);
  }
  if(businessDays<=0){
    return {severity:'NORMAL',status_code:'NORMAL',business_days_overdue:0,badge_text:'🟢 อยู่ในกรอบ 1 วันทำการ',badge_color:'green',is_alert:false};
  }else if(businessDays===1){
    return {severity:'WARNING',status_code:'WARNING',business_days_overdue:1,badge_text:'🟡 ครบกำหนด 1 วันทำการพอดีวันนี้',badge_color:'amber',is_alert:true};
  }else{
    return {severity:'CRITICAL_OVERDUE',status_code:'CRITICAL_OVERDUE',business_days_overdue:businessDays,badge_text:`🔴 เกินกำหนด ${businessDays} วันทำการ`,badge_color:'red',is_alert:true};
  }
}
function syncQcTracking(){
  run(`CREATE TABLE IF NOT EXISTS packing_list_qc_tracking(invoice_no TEXT NOT NULL,sap_no TEXT NOT NULL,description TEXT NOT NULL,qty INTEGER NOT NULL DEFAULT 0,etr_date DATE,qc_status TEXT NOT NULL DEFAULT 'PENDING',updated_at DATETIME NOT NULL,PRIMARY KEY(invoice_no,sap_no));
CREATE INDEX IF NOT EXISTS idx_pl_qc_status ON packing_list_qc_tracking(qc_status);
CREATE INDEX IF NOT EXISTS idx_pl_qc_etr ON packing_list_qc_tracking(etr_date);`);
  const rawRows=query(`SELECT p.invoice_no,i.sap_no,MIN(i.description) AS description,CAST(SUM(i.quantity) AS INTEGER) AS qty,p.etr AS etr_date,COALESCE(q.result,'PENDING') AS qc_status,COALESCE(MAX(q.received_at),MAX(i.updated_at)) AS updated_at FROM items i JOIN packing_lists p ON p.id=i.packing_list_id LEFT JOIN qc_results q ON q.packing_list_id=i.packing_list_id AND q.sap_no=i.sap_no AND q.is_current=1 GROUP BY p.invoice_no,i.sap_no`);
  const statements=['BEGIN IMMEDIATE;'];
  statements.push(`DELETE FROM packing_list_qc_tracking WHERE invoice_no NOT IN (SELECT invoice_no FROM packing_lists);`);
  for(const r of rawRows){
    const safeDesc=redactKnownBrands(r.description||'');
    statements.push(`INSERT INTO packing_list_qc_tracking(invoice_no,sap_no,description,qty,etr_date,qc_status,updated_at) VALUES(${q(r.invoice_no)},${q(r.sap_no)},${q(safeDesc)},${Number(r.qty)||0},NULLIF(${q(r.etr_date||'')},''),${q(r.qc_status||'PENDING')},${q(r.updated_at||now())}) ON CONFLICT(invoice_no,sap_no) DO UPDATE SET description=excluded.description,qty=excluded.qty,etr_date=excluded.etr_date,qc_status=excluded.qc_status,updated_at=excluded.updated_at;`);
  }
  statements.push('COMMIT;');
  try{run(statements.join('\n'))}catch(e){try{run('ROLLBACK;')}catch{}}
}
function getSlaTrackingData(currentDate=new Date()){
  syncQcTracking();
  const rows=query(`SELECT invoice_no,sap_no,description,qty,COALESCE(etr_date,'') AS etr_date,qc_status,updated_at FROM packing_list_qc_tracking`);
  const enriched=rows.map(r=>({
    ...r,
    description:redactKnownBrands(r.description||''),
    sla:calculateSla(r.etr_date,r.qc_status,currentDate)
  }));
  const rank={'CRITICAL_OVERDUE':1,'WARNING':2,'NORMAL':3};
  enriched.sort((a,b)=>{
    const aPending=a.qc_status==='PENDING',bPending=b.qc_status==='PENDING';
    if(aPending&&!bPending)return -1;
    if(!aPending&&bPending)return 1;
    if(aPending&&bPending){
      const ra=rank[a.sla.severity]||4,rb=rank[b.sla.severity]||4;
      if(ra!==rb)return ra-rb;
      if(a.sla.severity==='CRITICAL_OVERDUE')return b.sla.business_days_overdue-a.sla.business_days_overdue;
      if(a.etr_date&&b.etr_date)return a.etr_date.localeCompare(b.etr_date);
      return (b.etr_date||'').localeCompare(a.etr_date||'');
    }
    return (b.updated_at||'').localeCompare(a.updated_at||'');
  });
  const pendingItems=enriched.filter(x=>x.qc_status==='PENDING');
  const criticalCount=pendingItems.filter(x=>x.sla.severity==='CRITICAL_OVERDUE').length;
  const warningCount=pendingItems.filter(x=>x.sla.severity==='WARNING').length;
  const normalCount=pendingItems.filter(x=>x.sla.severity==='NORMAL').length;
  const resolvedCount=enriched.filter(x=>x.qc_status!=='PENDING').length;
  return {
    items:enriched,
    summary:{
      total_items:enriched.length,
      total_pending:pendingItems.length,
      critical_overdue_count:criticalCount,
      warning_count:warningCount,
      normal_count:normalCount,
      resolved_count:resolvedCount,
      checked_at:now()
    }
  };
}
function runDailySlaCheck(){
  const result=getSlaTrackingData();
  if(result.summary.critical_overdue_count>0||result.summary.warning_count>0){
    audit('sla_check','daily_cron','CHECK_COMPLETED',{critical_overdue:result.summary.critical_overdue_count,warning:result.summary.warning_count,total_pending:result.summary.total_pending,checked_at:now()});
    console.log(`[SLA Alert] Daily check: ${result.summary.critical_overdue_count} critical overdue, ${result.summary.warning_count} warning, ${result.summary.total_pending} pending.`);
  }
  return result;
}
function classify(text){const lines=String(text||'').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g,' ').replace(/\r/g,'\n').split('\n').map(x=>x.trim()).filter(Boolean);const summary=(lines.at(-1)||'').toUpperCase();const reject=/\bREJECT\b|ขอ\s*ทำการ\s*REJECT/i.test(summary),accept=/\bACCEPT\s+LOT\b|\bACC\.?\s*LOT\b|ผล\s*ผ่าน|อยู่ใน\s*RB\s*ACCEPT/i.test(summary);return reject&&accept?'NEEDS_REVIEW':reject?'REJECT':accept?'ACCEPT':'PENDING'}
function extractFields(text){let t=String(text||'');let invoice=(t.match(/(?:INVOICE\s*(?:NO\.?)?\s*[:#-]?\s*)([A-Z0-9-]+)/i)||[])[1];let sap=(t.match(/(?:SAP\s*(?:NO\.?)?\s*[:#-]?\s*)(\d{5,})/i)||[])[1];let qty=(t.match(/(?:จำนวน|QTY)\s*[:#-]?\s*([\d,.]+)/i)||[])[1];let defect=(t.match(/(?:อาการ(?:ของเสีย)?|DEFECT)\s*[:#-]?\s*([^\n]+)/i)||[])[1];return {invoice,sap,quantity:qty?Number(qty.replaceAll(',','')):null,defect}}
function ocrPdfPage(file,pageIndex){return execFileSync('swift',[path.join(ROOT,'ocr.swift'),file,String(pageIndex)],{encoding:'utf8',timeout:120000,maxBuffer:15*1024*1024}).trim()}
async function parsePdf(file){
  const parser=new PDFParse({data:fs.readFileSync(file)});let text='',methods=[];
  try{
    const extracted=await parser.getText();
    const pages=extracted.pages?.length?extracted.pages:[{num:1,text:extracted.text||''}];
    const out=[];
    for(let i=0;i<pages.length;i++){
      let pageText=pages[i].text||'';
      const found=parsePackingRows(pageText);
      if(pageText.replace(/\s/g,'').length<30||found.length===0){
        try{const scanned=ocrPdfPage(file,i);if(scanned&&parsePackingRows(scanned).length>found.length){pageText=scanned;methods.push(`OCR หน้า ${i+1}`)}}catch{}
      }
      out.push(pageText);
    }
    text=out.join('\n');if(!methods.length)methods.push('PDF text layer');else if(out.some(x=>x.trim()))methods.unshift('PDF text layer');
    return {text,method:methods.join(' + ')||'PDF text layer'};
  }finally{await parser.destroy()}
}
function parsePackingRows(text){
  const lines=String(text||'').replace(/\r/g,'\n').split('\n').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean),starts=[];
  const isSap=x=>/^\d{6,10}$/.test(x||'');
  for(let li=0;li<lines.length;li++){
    const parts=lines[li].split(' ');let sapIndex=-1;
    for(let j=2;j<Math.min(parts.length,5);j++)if(isSap(parts[j])&&(j===3||(j===4&&/^\d{4}$/.test(parts[j-1]||''))||(j===2&&(/^7\d{3}$/.test(parts[1]||'')||/^REPLACEMENT$/i.test(parts[1]||''))))){sapIndex=j;break}
    if(sapIndex>=0&&!/ITEM\s+NO|SAP\s+PO|SAP\s+NO|DESCRIPTION|TOTAL\s+QTY|PACKING\s+LIST|INVOICE\s+NO/i.test(lines[li]))starts.push({line:li,parts,sapIndex});
  }
  const numeric=x=>/^[\d,]+(?:\.\d+)?$/.test(x||'');
  const found=[];
  for(let n=0;n<starts.length;n++){
    const st=starts[n],end=n+1<starts.length?starts[n+1].line:lines.length;
    const sap=st.parts[st.sapIndex],prior=st.parts[st.sapIndex-1]||'',po=/^REPLACEMENT$/i.test(prior)?'':prior;let accumulated=st.parts.slice(st.sapIndex+1).join(' '),parsed=null;
    const tryTail=value=>{
      const t=value.trim().split(' ');let k=0;for(let j=t.length-1;j>=0&&numeric(t[j])&&k<6;j--)k++;
      if(k<2||!t.slice(0,t.length-k).join(' ').trim())return null;
      const desc=t.slice(0,t.length-k).join(' ').trim();return {desc,quantity:Number(t[t.length-k].replaceAll(',',''))||0};
    };
    parsed=tryTail(accumulated);
    for(let li=st.line+1;!parsed&&li<end&&li<=st.line+3;li++){accumulated+=' '+lines[li];parsed=tryTail(accumulated)}
    if(!parsed)continue;
    const itemNo=st.parts[0]||'';
    found.push({line_no:found.length+1,item_no:itemNo,pi_no:st.parts.slice(1,st.sapIndex-1).concat(/^REPLACEMENT$/i.test(prior)?[prior]:[]).join(' '),sap_po:po,sap_no:sap,description:parsed.desc.slice(0,500),quantity:parsed.quantity,uom:'PCS',bom:'',brand:'',production_model:'',review_status:'NEEDS_REVIEW'});
  }
  return found;
}
app.use('/api',(_,res,next)=>{res.setHeader('Cache-Control','no-store');next()});
app.get('/api/health',(_,res)=>res.json({ok:true,storage:'sqlite',database:DB}));
app.get('/api/dashboard',(_,res)=>{const all=query(`SELECT * FROM packing_lists WHERE status<>'ARCHIVED' ORDER BY created_at DESC`),archived=query(`SELECT * FROM packing_lists WHERE status='ARCHIVED' ORDER BY updated_at DESC`),rows=all.map(invoiceSummary),archive=archived.map(invoiceSummary),items=rows.flatMap(x=>x.items);const slaData=getSlaTrackingData();res.json({invoices:rows,archive,kpi:{packing_lists:rows.length+archive.length,required_wo:items.length,opened_wo:items.filter(i=>i.wo_no).length,unopened_wo:items.filter(i=>!i.wo_no).length,qc_wait:items.filter(i=>!i.qc_result||i.qc_result==='PENDING').length},sla_summary:slaData.summary,latest_sync:query('SELECT finished_at,status,row_count FROM sap_sync_batches ORDER BY started_at DESC LIMIT 1')[0]||null})});
app.post('/api/packing-lists/import',upload.single('pdf'),async(req,res)=>{if(!req.file)return res.status(400).json({error:'กรุณาเลือกไฟล์ PDF'});let savedPath;try{let parsed;try{parsed=await parsePdf(req.file.path)}catch(e){parsed={text:'',method:'OCR unavailable',ocr_error:e.message}}const rawText=parsed.text||'';const invoice=(req.body.invoice_no||'').trim()||((rawText.match(/(?:INVOICE\s*(?:NO\.?)?\s*[:#-]?\s*)([A-Z0-9-]+)/i)||[])[1]||'').trim();if(!invoice){fs.unlinkSync(req.file.path);return res.status(422).json({error:'ยังอ่าน Invoice No. ไม่ได้ กรุณากรอกเลข Invoice ก่อนนำเข้า',text_found:!!rawText,ocr:parsed.method})}const existing=invoiceRow(invoice);const id=existing?.id||crypto.randomUUID(),timestamp=now(),hash=crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');const filename=path.basename(req.file.originalname).replace(/[^\p{L}\p{N}._ -]/gu,'_');savedPath=path.join(FILES,`${id}.pdf`);fs.renameSync(req.file.path,savedPath);const dates=['etd','eta','etr'].map(k=>q(req.body[k]||existing?.[k]||''));if(existing){run(`UPDATE packing_lists SET etd=NULLIF(${dates[0]},''),eta=NULLIF(${dates[1]},''),etr=NULLIF(${dates[2]},''),file_name=${q(filename)},file_path=${q(savedPath)},file_sha256=${q(hash)},updated_at=${q(timestamp)} WHERE id=${q(id)}`);audit('packing_list',id,'REUPLOAD',{invoice,retained_tracking:true})}else{run(`INSERT INTO packing_lists(id,invoice_no,etd,eta,etr,file_name,file_path,file_sha256,status,created_at,updated_at) VALUES(${q(id)},${q(invoice)},NULLIF(${dates[0]},''),NULLIF(${dates[1]},''),NULLIF(${dates[2]},''),${q(filename)},${q(savedPath)},${q(hash)},'REVIEW',${q(timestamp)},${q(timestamp)})`);audit('packing_list',id,'IMPORT',{invoice,filename})}const candidates=safeCandidates(parsePackingRows(rawText));res.json({id,invoice_no:invoice,text_found:!!rawText,ocr:parsed.method,candidates,items:[],text_preview:redactKnownBrands(rawText).slice(0,40000),message:`${parsed.method}: พบรายการ ${candidates.length} แถว (ชื่อแบรนด์จริงถูกซ่อน) กรุณาตรวจรายการและเทียบ PDF ก่อนยืนยัน`})}catch(e){if(req.file?.path&&fs.existsSync(req.file.path))fs.unlinkSync(req.file.path);res.status(500).json({error:'นำเข้า PDF ไม่สำเร็จ: '+e.message})}});
app.get('/api/packing-lists/:invoice', (req,res)=>{let r=invoiceRow(req.params.invoice);if(!r)return res.status(404).json({error:'ไม่พบ Invoice'});res.json(invoiceSummary(r))});
app.get('/api/packing-lists/:invoice/scan',async(req,res)=>{let r=invoiceRow(req.params.invoice);if(!r||!fs.existsSync(r.file_path))return res.status(404).json({error:'ไม่พบ Invoice หรือไฟล์ PDF'});try{const parsed=await parsePdf(r.file_path),text=parsed.text||'',suggested=(text.match(/INVOICE\s*NO\.?\s*[:#-]?\s*([A-Z0-9-]+)/i)||[])[1]||'';let current=r.invoice_no;if(suggested&&suggested!==current&&listItems(r.id).length===0&&!invoiceRow(suggested)){run(`UPDATE packing_lists SET invoice_no=${q(suggested)},updated_at=${q(now())} WHERE id=${q(r.id)}`);audit('packing_list',r.id,'CORRECT_INVOICE_FROM_PDF',{from:current,to:suggested});current=suggested}const candidates=safeCandidates(parsePackingRows(text));res.json({invoice_no:current,source_invoice:suggested,ocr:parsed.method,candidates,text_preview:redactKnownBrands(text).slice(0,40000),message:`อ่านด้วย ${parsed.method}; ตรวจพบ ${candidates.length} รายการ กรุณาตรวจเทียบต้นฉบับ`})}catch(e){res.status(500).json({error:'อ่าน PDF ไม่สำเร็จ: '+e.message})}});
app.get('/api/packing-lists/:invoice/pdf',(req,res)=>{let r=invoiceRow(req.params.invoice);if(!r||!fs.existsSync(r.file_path))return res.status(404).json({error:'ไม่พบไฟล์ PDF'});res.type('application/pdf').sendFile(r.file_path)});
app.put('/api/packing-lists/:invoice', (req,res)=>{let r=invoiceRow(req.params.invoice);if(!r)return res.status(404).json({error:'ไม่พบ Invoice'});const {etd,eta,etr}=req.body;run(`UPDATE packing_lists SET etd=${q(etd||'')},eta=${q(eta||'')},etr=${q(etr||'')},updated_at=${q(now())} WHERE id=${q(r.id)}`);audit('packing_list',r.id,'UPDATE_DATES',{etd,eta,etr});syncQcTracking();res.json(invoiceSummary(invoiceRow(req.params.invoice))) });
app.put('/api/packing-lists/:invoice/items', (req,res)=>{
  const r=invoiceRow(req.params.invoice);
  if(!r)return res.status(404).json({error:'ไม่พบ Invoice'});
  if(!Array.isArray(req.body.items))return res.status(400).json({error:'items ต้องเป็น array'});
  const old=listItems(r.id),stamp=now(),keyed=new Map(old.map(x=>[`${x.sap_no}|${x.line_no}`,x]));
  try{
    const seenLines=new Set(),statements=[`BEGIN IMMEDIATE;`,`DELETE FROM work_orders WHERE item_id IN (SELECT id FROM items WHERE packing_list_id=${q(r.id)});`,`DELETE FROM items WHERE packing_list_id=${q(r.id)};`];
    req.body.items.forEach((x,i)=>{
      if(!x.sap_no||!x.description)throw Error('แต่ละรายการต้องมี SAP No. และ Description');
      const line=Number(x.line_no)||i+1;if(seenLines.has(line))throw Error(`เลขบรรทัดซ้ำ: ${line}`);seenLines.add(line);
      const prior=keyed.get(`${x.sap_no}|${line}`),iid=prior?.id||crypto.randomUUID(),safe=brandInfo(x.description,x.sap_no),brand=safe.display_brand==='รอตั้งรหัส'?'':safe.display_brand;
      statements.push(`INSERT INTO items(id,packing_list_id,line_no,sap_po,sap_no,description,quantity,uom,bom,brand,production_model,review_status,created_at,updated_at) VALUES(${q(iid)},${q(r.id)},${line},${q(x.sap_po)},${q(x.sap_no)},${q(safe.display_description)},${Number(x.quantity)||0},${q(x.uom)},${q(x.bom)},${q(brand)},${q(x.production_model)},${q(x.review_status||'CONFIRMED')},${q(prior?.created_at||stamp)},${q(stamp)});`);
      if(prior?.wo_no)statements.push(`INSERT INTO work_orders(id,item_id,wo_no,last_synced_at) VALUES(${q(crypto.randomUUID())},${q(iid)},${q(prior.wo_no)},${q(stamp)});`);
    });
    statements.push('COMMIT;');run(statements.join('\n'));refreshArchive(r.id);audit('packing_list',r.id,'CONFIRM_ITEMS',{count:req.body.items.length});syncQcTracking();res.json(invoiceSummary(invoiceRow(req.params.invoice)));
  }catch(e){try{run(`ROLLBACK;`)}catch{}res.status(400).json({error:e.message})}
});
app.get('/api/packing-lists/:invoice/items', (req,res)=>{let r=invoiceRow(req.params.invoice);if(!r)return res.status(404).json({error:'ไม่พบ Invoice'});res.json(safeItems(listItems(r.id)))});
app.get('/api/brand-bom/invoices',(_,res)=>{const invoices=query(`SELECT * FROM packing_lists ORDER BY created_at DESC`).map(p=>{const items=safeItems(listItems(p.id)),brands=[...new Set(items.map(x=>x.display_brand).filter(x=>x&&x!=='รอตั้งรหัส'))],models=[...new Set(items.flatMap(x=>x.model_ids||[]))];const sapIds=[...new Set(items.map(x=>x.sap_no))],missingSap=new Set(items.filter(x=>x.bom_status==='MASTER_NOT_FOUND').map(x=>x.sap_no));return {invoice_no:p.invoice_no,etd:p.etd,eta:p.eta,etr:p.etr,total_items:items.length,brands,model_ids:models,model_count:models.length,model_matched_sap:new Set(items.filter(x=>x.model_ids?.length).map(x=>x.sap_no)).size,model_missing_sap:new Set(items.filter(x=>!x.model_ids?.length).map(x=>x.sap_no)).size,brand_missing_sap:new Set(items.filter(x=>!x.display_brand||x.display_brand==='รอตั้งรหัส').map(x=>x.sap_no)).size,bom_yes:items.filter(x=>x.has_own_bom).length,bom_component:items.filter(x=>x.component_of?.length).length,bom_no:items.filter(x=>x.bom_status==='NO_BOM').length,master_missing:items.filter(x=>x.bom_status==='MASTER_NOT_FOUND').length,master_missing_sap:missingSap.size,master_matched_sap:sapIds.length-missingSap.size,unique_sap:sapIds.length,items}});res.json(invoices)});
app.get('/api/search',(req,res)=>{const term=String(req.query.q||'').trim();if(!term)return res.json([]);const like=q('%'+term+'%'),items=query(`SELECT 'Packing List' kind,i.sap_no,i.description,i.bom,i.brand,i.production_model,p.invoice_no,'' bom_id,'' bom_description,'' model_id FROM items i JOIN packing_lists p ON p.id=i.packing_list_id WHERE i.sap_no LIKE ${like} OR i.description LIKE ${like} OR i.bom LIKE ${like} OR i.brand LIKE ${like} OR i.production_model LIKE ${like} ORDER BY p.invoice_no DESC LIMIT 100`),active=query('SELECT batch_id FROM active_master_import WHERE id=1')[0]?.batch_id||'';let bom=[],models=[];if(active){bom=query(`SELECT 'BoM' kind,input_product sap_no,input_product_description description,'' bom,${q('')} brand,'' production_model,'' invoice_no,bom_id,bom_description,'' model_id FROM sap_bom_data WHERE batch_id=${q(active)} AND (input_product LIKE ${like} OR input_product_description LIKE ${like} OR bom_id LIKE ${like} OR bom_description LIKE ${like}) LIMIT 100`);models=query(`SELECT 'Production Model' kind,product_id sap_no,product_description description,'' bom,'' brand,model_id production_model,'' invoice_no,'' bom_id,'' bom_description,model_id FROM production_model_data WHERE batch_id=${q(active)} AND (product_id LIKE ${like} OR product_description LIKE ${like} OR model_id LIKE ${like} OR model_description LIKE ${like}) LIMIT 100`)}res.json([...items,...bom,...models].slice(0,150).map(x=>({...safeItem(x),kind:x.kind,bom_id:x.bom_id,bom_description:redactKnownBrands(x.bom_description||''),model_id:x.model_id}))) });
app.get('/api/tracking', (req,res)=>{const inv=String(req.query.invoice||'');const where=inv?`WHERE p.invoice_no=${q(inv)}`:'';const rows=query(`SELECT p.id packing_list_id,p.invoice_no,p.etd,p.eta,p.etr,i.id item_id,i.sap_po,i.sap_no,i.description,i.quantity,i.bom,i.brand,i.production_model,COALESCE(w.wo_no,'') wo_no,spo.status wo_status,COALESCE(q.result,'PENDING') qc_result,q.received_at FROM items i JOIN packing_lists p ON p.id=i.packing_list_id LEFT JOIN work_orders w ON w.item_id=i.id LEFT JOIN sap_production_orders spo ON spo.production_order_id=w.wo_no LEFT JOIN qc_results q ON q.packing_list_id=i.packing_list_id AND q.sap_no=i.sap_no AND q.is_current=1 ${where} ORDER BY p.invoice_no DESC,i.line_no`);res.json(safeItems(rows))});
app.get('/api/qc/latest',(req,res)=>{const limit=Math.max(1,Math.min(500,Number(req.query.limit)||200));const rows=query(`SELECT q.id,p.invoice_no AS lot,q.sap_no,COALESCE(MIN(i.description),'') AS description,p.etr,COALESCE(q.quantity,SUM(i.quantity),0) AS quantity,q.result,q.received_at FROM qc_results q JOIN packing_lists p ON p.id=q.packing_list_id JOIN items i ON i.packing_list_id=q.packing_list_id AND i.sap_no=q.sap_no WHERE q.is_current=1 AND q.result IN ('ACCEPT','REJECT') GROUP BY q.id ORDER BY q.received_at DESC,q.id DESC LIMIT ${limit}`);res.json(rows)});
app.post('/api/qc/messages', (req,res)=>{const {text,source_message_id}=req.body||{};if(!text)return res.status(400).json({error:'ต้องมีข้อความ QC'});const fields=extractFields(text),result=classify(text);if(!fields.invoice||!fields.sap)return res.status(422).json({error:'ระบุ Invoice No. และ SAP No. ไม่ครบ',parsed:fields,result,needs_review:true});const p=invoiceRow(fields.invoice);if(!p)return res.status(422).json({error:'ไม่พบ Invoice ที่ระบุ',parsed:fields,result,needs_review:true});const item=query(`SELECT id FROM items WHERE packing_list_id=${q(p.id)} AND sap_no=${q(fields.sap)} LIMIT 1`)[0];if(!item)return res.status(422).json({error:'ไม่พบ SAP No. ใน Invoice นี้',parsed:fields,result,needs_review:true});if(result==='NEEDS_REVIEW')return res.status(422).json({error:'พบผล ACCEPT และ REJECT ในข้อความสรุปเดียวกัน',parsed:fields,result,needs_review:true});run(`UPDATE qc_results SET is_current=0 WHERE packing_list_id=${q(p.id)} AND sap_no=${q(fields.sap)}`);const rid=crypto.randomUUID();run(`INSERT INTO qc_results(id,packing_list_id,sap_no,result,raw_message,defect_description,quantity,source_message_id,parser_version,received_at,is_current) VALUES(${q(rid)},${q(p.id)},${q(fields.sap)},${q(result)},${q(redactKnownBrands(text))},${q(redactKnownBrands(fields.defect||''))},${fields.quantity==null?'NULL':Number(fields.quantity)||0},${source_message_id?q(source_message_id):'NULL'},'qc-v1',${q(now())},1)`);audit('qc_result',rid,'INGEST',{invoice:fields.invoice,sap_no:fields.sap,result});syncQcTracking();res.json({id:rid,invoice_no:fields.invoice,sap_no:fields.sap,result,parsed:fields})});
app.get('/api/qc-sla/items',(_,res)=>{res.json(getSlaTrackingData())});
app.post('/api/qc-sla/quick-action',(req,res)=>{
  const {invoice_no,sap_no,result}=req.body||{};
  if(!invoice_no||!sap_no)return res.status(400).json({error:'ต้องระบุ invoice_no และ sap_no'});
  if(!['ACCEPT','REJECT'].includes(result))return res.status(400).json({error:'result ต้องเป็น ACCEPT หรือ REJECT'});
  const p=invoiceRow(invoice_no);
  if(!p)return res.status(404).json({error:'ไม่พบ Invoice: '+invoice_no});
  const timestamp=now();
  const rid=crypto.randomUUID();
  run(`BEGIN IMMEDIATE;
    UPDATE qc_results SET is_current=0 WHERE packing_list_id=${q(p.id)} AND sap_no=${q(sap_no)};
    INSERT INTO qc_results(id,packing_list_id,sap_no,result,raw_message,defect_description,quantity,source_message_id,parser_version,received_at,is_current) VALUES(${q(rid)},${q(p.id)},${q(sap_no)},${q(result)},${q('Quick Action: '+result)},NULL,NULL,NULL,'quick-action',${q(timestamp)},1);
    UPDATE items SET updated_at=${q(timestamp)} WHERE packing_list_id=${q(p.id)} AND sap_no=${q(sap_no)};
    UPDATE packing_list_qc_tracking SET qc_status=${q(result)}, updated_at=${q(timestamp)} WHERE invoice_no=${q(invoice_no)} AND sap_no=${q(sap_no)};
  COMMIT;`);
  refreshArchive(p.id);
  audit('qc_sla_tracking',`${invoice_no}:${sap_no}`,'QUICK_ACTION',{result,invoice_no,sap_no});
  const data=getSlaTrackingData();
  const updatedItem=data.items.find(x=>x.invoice_no===invoice_no&&x.sap_no===sap_no);
  res.json({ok:true,item:updatedItem,summary:data.summary,message:`บันทึกผล QC ${result} เรียบร้อยแล้ว`});
});
app.get('/api/qc/rules',(_,res)=>res.json({accept:['ACCEPT LOT','Accept Lot','ACC.LOT /ผลผ่าน','ACCEPT LOT/ผลผ่าน','อยู่ใน RB ACCEPT'],reject:['Reject','REJECT','ขอทำการ Reject'],summary:'last non-empty line',precedence:'ambiguous result => review'}));
function parseCsv(text){let rows=[],row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){let c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++}else if(c==='"')quoted=false;else cell+=c}else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell=''}else if(c==='\n'){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell=''}else cell+=c}if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row)}const headers=(rows.shift()||[]).map(x=>x.trim().toLowerCase().replace(/[ _-]+/g,''));return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(headers.map((h,i)=>[h,(r[i]||'').trim()]))) }
app.get('/api/brand-aliases/status',(_,res)=>res.json({count:getBrandCache().length,display_policy:'abbreviations only'}));
app.get('/api/brand-aliases/options',(_,res)=>{
  const cache=getBrandCache();
  const unique=new Map();
  for(const r of cache){
    if(r.abbreviation&&!unique.has(r.abbreviation)){
      unique.set(r.abbreviation,r.brand_name||r.abbreviation);
    }
  }
  const options=Array.from(unique.entries())
    .map(([abbreviation,brand_name])=>({abbreviation,brand_name}))
    .sort((a,b)=>a.abbreviation.localeCompare(b.abbreviation));
  res.json(options);
});
app.post('/api/brand-bom/update-item',(req,res)=>{
  const {sap_no,has_bom,bom_id,brand,model_ids,invoice_no}=req.body||{};
  if(!sap_no)return res.status(400).json({error:'ต้องระบุรหัส SAP No.'});
  const cleanSap=String(sap_no).trim();
  const canonSap=canonicalSap(cleanSap);
  const cleanHasBom=has_bom===false||has_bom===0||has_bom==='false'?0:1;
  const cleanBomId=cleanHasBom?String(bom_id||`${cleanSap}-1`).trim():'';
  const cleanBrand=String(brand||'').trim();
  const models=Array.isArray(model_ids)?model_ids.map(m=>String(m).trim()).filter(Boolean):[];
  const modelsJson=JSON.stringify(models);
  const timestamp=now();

  run(`BEGIN IMMEDIATE;
    INSERT INTO custom_master_overrides(sap_no,bom_id,has_bom,brand,model_ids,created_at,updated_at)
    VALUES(${q(cleanSap)},${q(cleanBomId)},${cleanHasBom},${q(cleanBrand)},${q(modelsJson)},${q(timestamp)},${q(timestamp)})
    ON CONFLICT(sap_no) DO UPDATE SET
      bom_id=excluded.bom_id,
      has_bom=excluded.has_bom,
      brand=excluded.brand,
      model_ids=excluded.model_ids,
      updated_at=excluded.updated_at;

    UPDATE items
    SET brand=${q(cleanBrand)},
        bom=${q(cleanBomId)},
        production_model=${q(models.join(', '))},
        updated_at=${q(timestamp)}
    WHERE sap_no=${q(cleanSap)} OR sap_no=${q(canonSap)} OR sap_no=${q(`${canonSap}-1`)};
  COMMIT;`);

  invalidateCustomOverrides();
  audit('custom_master_overrides',cleanSap,'UPDATE_ITEM',{sap_no:cleanSap,has_bom:cleanHasBom,bom_id:cleanBomId,brand:cleanBrand,model_ids:models,invoice_no:invoice_no||''});
  const sampleItem=safeItem({sap_no:cleanSap,description:''});
  res.json({ok:true,message:`อัปเดตข้อมูล Brand & BOM สำหรับ SAP No. ${cleanSap} เรียบร้อยแล้ว`,item:sampleItem});
});
app.post('/api/brand-aliases/import-csv',upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'กรุณาเลือก CSV'});try{const rows=parseCsv(fs.readFileSync(req.file.path,'utf8').replace(/^\uFEFF/,'')),active=query('SELECT batch_id FROM active_master_import WHERE id=1')[0]?.batch_id||'';let inserted=0,updated=0,unchanged=0,conflicts=0,invalid=0;for(const row of rows){const name=row.brandname||row.blandname||row.fullbrandname||row.customername||'',abbr=row.abbreviation||row.brandabbreviation||row.shortname||row.alias||'';if(!name||!abbr){invalid++;continue}if(active){const old=query(`SELECT abbreviation FROM master_brand_aliases WHERE batch_id=${q(active)} AND lower(trim(brand_name))=lower(${q(name)}) LIMIT 1`)[0];if(old?.abbreviation===abbr){unchanged++;continue}run(`INSERT INTO master_brand_aliases(batch_id,brand_name,abbreviation) VALUES(${q(active)},${q(name)},${q(abbr)}) ON CONFLICT(batch_id,brand_name) DO UPDATE SET abbreviation=excluded.abbreviation`);if(old)updated++;else inserted++;continue}const old=query(`SELECT abbreviation FROM brand_aliases WHERE lower(trim(brand_name))=lower(${q(name)}) LIMIT 1`)[0];if(old){if(old.abbreviation===abbr)unchanged++;else conflicts++;continue}run(`INSERT INTO brand_aliases(brand_name,abbreviation,created_at,updated_at) VALUES(${q(name)},${q(abbr)},${q(now())},${q(now())})`);inserted++}brandCache=null;fs.unlinkSync(req.file.path);audit('brand_aliases','local','IMPORT_CSV',{inserted,updated,unchanged,conflicts,invalid});res.json({inserted,updated,unchanged,conflicts,invalid,total:getBrandCache().length})}catch(e){if(fs.existsSync(req.file.path))fs.unlinkSync(req.file.path);res.status(400).json({error:'อ่าน Brand Name CSV ไม่สำเร็จ: '+e.message})}});
app.post('/api/master-data/import-xlsx', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({error:'กรุณาเลือกไฟล์ Excel .xlsx'});
  try {
    const raw=execFileSync('python3',[path.join(ROOT,'read_master_xlsx.py'),req.file.path],{encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});
    const sheets=JSON.parse(raw);
    const findSheet=n=>Object.entries(sheets).find(([k])=>k.toLowerCase()===n.toLowerCase())?.[1]||[];
    const bomRows=findSheet('BoM'), modelRows=findSheet('Production Model'), aliasRows=findSheet('Bland Name');
    if (!bomRows.length||!modelRows.length||!aliasRows.length) throw Error('ต้องมีชีต BoM, Production Model และ Bland Name');
    const norm=v=>String(v||'').toLowerCase().replace(/[\s()_-]+/g,'');
    const bomHeaders=bomRows[0].map(norm),modelHeaders=modelRows[0].map(norm);
    if(bomHeaders[0]!=='bomid'||bomHeaders[1]!=='bomdescription'||bomHeaders[2]!=='inputproduct'||bomHeaders[4]!=='status'||bomHeaders[5]!=='inputquantity'||bomHeaders[6]!=='outputquantity')throw Error('หัวตารางชีต BoM ไม่ตรงกับเทมเพลต');
    if(modelHeaders[0]!=='productionmodelid'||modelHeaders[1]!=='productionmodeldescription'||modelHeaders[2]!=='productid'||modelHeaders[3]!=='productdescription')throw Error('หัวตารางชีต Production Model ไม่ตรงกับเทมเพลต');
    const headers=aliasRows[0].map(norm);
    const brandIdx=headers.findIndex(x=>['brand','brandname','blandname'].includes(x));
    const abbrIdx=headers.findIndex(x=>x.includes('ตัวย่อ')||x.includes('abbreviation')||x==='alias');
    if (brandIdx<0||abbrIdx<0) throw Error('ชีต Bland Name ต้องมีคอลัมน์ Brand และ Brand (ตัวย่อ)');
    const rawAliases=aliasRows.slice(1).map(r=>({name:String(r[brandIdx]||'').trim(),abbr:String(r[abbrIdx]||'').trim()})).filter(x=>x.name&&x.abbr);const aliasMap=new Map(),conflictingAliasKeys=new Set();for(const a of rawAliases){const k=a.name.toLowerCase();if(conflictingAliasKeys.has(k))continue;const old=aliasMap.get(k);if(!old)aliasMap.set(k,a);else if(old.abbr!==a.abbr){conflictingAliasKeys.add(k);aliasMap.delete(k)}}const inputAliasConflicts=conflictingAliasKeys.size,aliases=[...aliasMap.values()];
    let currentBomId='';
    const bom=bomRows.slice(1).map((r,i)=>{const sourceBomId=String(r[0]||'').trim(),inputProduct=String(r[2]||'').trim();if(sourceBomId)currentBomId=sourceBomId;return {row:i+2,bomId:sourceBomId|| (inputProduct?currentBomId:''),bomDescription:String(r[1]||''),inputProduct,productDescription:String(r[3]||''),status:String(r[4]||''),inputQty:Number(r[5])||0,outputQty:Number(r[6])||0}}).filter(x=>x.bomId||x.inputProduct);
    const model=modelRows.slice(1).map((r,i)=>({row:i+2,modelId:String(r[0]||''),modelDescription:String(r[1]||''),productId:String(r[2]||'').trim(),productDescription:String(r[3]||''),planning:String(r[4]||''),execution:String(r[5]||''),enabled:String(r[6]||''),site:String(r[7]||''),planningArea:String(r[8]||'')})).filter(x=>(x.modelId||x.productId)&&norm(x.modelId)!=='productionmodelid'&&norm(x.productId)!=='productid');
    if (!aliases.length||(!bom.length&&!model.length)) throw Error('ไม่พบข้อมูลที่พร้อมนำเข้า');
    const plSap=[...new Set(query('SELECT sap_no FROM items').map(x=>String(x.sap_no||'').trim()).filter(Boolean))],parentKeys=new Set(bom.map(x=>canonicalSap(x.bomId)).filter(Boolean)),componentKeys=new Set(bom.map(x=>canonicalSap(x.inputProduct)).filter(Boolean)),modelKeys=new Set(model.map(x=>canonicalSap(x.productId)).filter(Boolean));
    const matchSummary={pl_sap_total:plSap.length,master_matched:0,bom_parent:0,bom_component:0,model:0};
    for(const sap of plSap){const key=canonicalSap(sap),parent=parentKeys.has(key),component=componentKeys.has(key),hasModel=modelKeys.has(key);if(parent||component||hasModel)matchSummary.master_matched++;if(parent)matchSummary.bom_parent++;if(component)matchSummary.bom_component++;if(hasModel)matchSummary.model++;}
    const conflicts=[], toAdd=aliases;
    const id=crypto.randomUUID(), created=now();
    run(`INSERT INTO master_import_batches(id,source_name,created_at,bom_rows,model_rows,alias_rows,alias_conflicts) VALUES(${q(id)},'local workbook',${q(created)},${bom.length},${model.length},${aliases.length},${conflicts.length+inputAliasConflicts})`);
    const insertChunks=(records,makeSql)=>{
      for(let start=0;start<records.length;start+=150){
        const statements=records.slice(start,start+150).map(makeSql);
        run('BEGIN IMMEDIATE;\n'+statements.join('\n')+'\nCOMMIT;');
      }
    };
    insertChunks(toAdd,a=>`INSERT INTO master_brand_aliases(batch_id,brand_name,abbreviation) VALUES(${q(id)},${q(a.name)},${q(a.abbr)});`);
    insertChunks(bom,x=>`INSERT INTO sap_bom_data(batch_id,source_row,bom_id,bom_description,input_product,input_product_description,status,input_quantity,output_quantity) VALUES(${q(id)},${x.row},${q(x.bomId)},${q(x.bomDescription)},${q(x.inputProduct)},${q(x.productDescription)},${q(x.status)},${x.inputQty},${x.outputQty});`);
    insertChunks(model,x=>`INSERT INTO production_model_data(batch_id,source_row,model_id,model_description,product_id,product_description,planning_consistency,execution_consistency,planning_enabled,site,planning_area_id) VALUES(${q(id)},${x.row},${q(x.modelId)},${q(x.modelDescription)},${q(x.productId)},${q(x.productDescription)},${q(x.planning)},${q(x.execution)},${q(x.enabled)},${q(x.site)},${q(x.planningArea)});`);
    run(`INSERT INTO active_master_import(id,batch_id) VALUES(1,${q(id)}) ON CONFLICT(id) DO UPDATE SET batch_id=excluded.batch_id`);brandCache=null;masterDescriptions=null;masterBatchCache=null;masterProductInfo=null;masterBomInfo=null;
    audit('master_data',id,'IMPORT_WORKBOOK',{bom_rows:bom.length,model_rows:model.length,alias_rows:aliases.length,alias_conflicts:conflicts.length+inputAliasConflicts});
    fs.unlinkSync(req.file.path);
    res.json({batch_id:id,bom_rows:bom.length,model_rows:model.length,alias_rows:aliases.length,aliases_added:toAdd.length,alias_conflicts:conflicts.length+inputAliasConflicts,match_summary:matchSummary,created_at:created});
  } catch(e) {
    if(fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({error:'นำเข้า Master Data ไม่สำเร็จ กรุณาตรวจรูปแบบชีตและข้อมูลซ้ำ โดยชื่อแบรนด์จริงจะไม่แสดงในข้อความผิดพลาด'});
  }
});
app.get('/api/master-data/status',(_,res)=>res.json(query(`SELECT b.created_at,b.bom_rows,b.model_rows,b.alias_rows,b.alias_conflicts FROM active_master_import a JOIN master_import_batches b ON b.id=a.batch_id WHERE a.id=1`)[0]||{bom_rows:0,model_rows:0,alias_rows:query('SELECT COUNT(*) n FROM brand_aliases')[0]?.n||0}));
app.post('/api/sap/import-csv',upload.single('file'),(req,res)=>{if(!req.file)return res.status(400).json({error:'กรุณาเลือก CSV'});const batch=crypto.randomUUID(),started=now();run(`INSERT INTO sap_sync_batches(id,started_at,status) VALUES(${q(batch)},${q(started)},'RUNNING')`);try{let records=parseCsv(fs.readFileSync(req.file.path,'utf8').replace(/^\uFEFF/,''));let count=0,unmatched=[];for(const row of records){let invoice=row.invoiceno||row.invoice||row.invoiceid||'',sap=row.sapno||row.material||row.materialno||row.sapmaterial||'',wo=row.wono||row.workorder||row.orderno||'';if(!invoice||!sap||!wo)continue;const p=invoiceRow(invoice);const i=p&&query(`SELECT id FROM items WHERE packing_list_id=${q(p.id)} AND sap_no=${q(sap)} ORDER BY line_no LIMIT 1`)[0];if(!i){unmatched.push({invoice,sap,wo});continue}run(`INSERT INTO work_orders(id,item_id,wo_no,last_synced_at) VALUES(${q(crypto.randomUUID())},${q(i.id)},${q(wo)},${q(now())}) ON CONFLICT(item_id) DO UPDATE SET wo_no=excluded.wo_no,last_synced_at=excluded.last_synced_at`);refreshArchive(p.id);count++}run(`UPDATE sap_sync_batches SET finished_at=${q(now())},status='SUCCESS',row_count=${count} WHERE id=${q(batch)}`);audit('sap_sync',batch,'CSV_IMPORT',{count,unmatched:unmatched.length});fs.unlinkSync(req.file.path);res.json({batch_id:batch,updated:count,unmatched,finished_at:now()})}catch(e){run(`UPDATE sap_sync_batches SET finished_at=${q(now())},status='FAILED',error=${q(e.message)} WHERE id=${q(batch)}`);if(fs.existsSync(req.file.path))fs.unlinkSync(req.file.path);res.status(400).json({error:'อ่าน CSV ไม่สำเร็จ: '+e.message})}});
const WO_XLSX_COLUMNS={status:'Production Order Status',production_order_id:'Production Order ID',output_product_id:'Output Product ID',product_description:'Output Product Description',release_due_date:'Production Order Release Due Date',planned_qty:'Planned Quantity',planned_qty_unit:'Planned Quantity (Unit)',fulfilled_qty:'Fulfilled Quantity',fulfilled_qty_unit:'Fulfilled Quantity (Unit)',open_qty:'Open Quantity',open_qty_unit:'Open Quantity (Unit)',created_on:'Created On',requested_end:'Requested End',created_by:'Created By',canceled:'Canceled'};
const WO_XLSX_REQUIRED=['production_order_id','output_product_id','status'],WO_DATE_FIELDS=['release_due_date','created_on','requested_end'],WO_NUMBER_FIELDS=['planned_qty','fulfilled_qty','open_qty'],WO_CLOSED_STATUSES=['finished','closed','canceled','cancelled'];
const headerKey=s=>String(s??'').toLowerCase().replace(/[^a-z0-9]+/g,'');
function excelDate(v){if(v===''||v==null)return null;if(typeof v==='number'){if(!(v>0&&v<2958466))throw Error('วันที่ไม่ถูกต้อง');return new Date(Math.round((v-25569)*86400)*1000).toISOString().slice(0,19)}const s=String(v).trim();let m;if((m=s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)))return `${m[1]}-${m[2]}-${m[3]}T${m[4]||'00'}:${m[5]||'00'}:${m[6]||'00'}`;if((m=s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/))&&+m[2]<=12&&+m[1]<=31)return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}T${(m[4]||'0').padStart(2,'0')}:${m[5]||'00'}:${m[6]||'00'}`;throw Error(`วันที่ไม่ถูกต้อง "${s}"`)}
function excelNumber(v){if(v===''||v==null)return null;const n=typeof v==='number'?v:Number(String(v).replace(/,/g,'').trim());if(!Number.isFinite(n))throw Error(`ตัวเลขไม่ถูกต้อง "${v}"`);return n}
function findWoSheet(sheets){for(const [name,rows] of Object.entries(sheets))for(let r=0;r<Math.min(rows.length,30);r++){const keys=rows[r].map(headerKey);if(keys.includes(headerKey(WO_XLSX_COLUMNS.production_order_id))&&keys.includes(headerKey(WO_XLSX_COLUMNS.output_product_id))){const cols={};for(const [f,h] of Object.entries(WO_XLSX_COLUMNS)){const i=keys.indexOf(headerKey(h));if(i>=0)cols[f]=i}return {name,headerRow:r,header:rows[r],cols,data:rows.slice(r+1)}}}return null}
function parseWoRow(row,sheet){const out={},raw={};sheet.header.forEach((h,i)=>{if(String(h).trim())raw[String(h).trim()]=row[i]??''});for(const [f,i] of Object.entries(sheet.cols)){let v=row[i]??'';try{out[f]=WO_DATE_FIELDS.includes(f)?excelDate(v):WO_NUMBER_FIELDS.includes(f)?excelNumber(v):String(v).trim()}catch(e){throw Error(`${WO_XLSX_COLUMNS[f]}: ${e.message}`)}}if(!out.production_order_id)throw Error('ไม่มี Production Order ID');if(!out.output_product_id)throw Error('ไม่มี Output Product ID');out.sap_no=canonicalSap(out.output_product_id);out.is_canceled=/^(yes|y|true|x|1)$/i.test(out.canceled||'')||/^cancel+ed$/i.test(out.status||'')?1:0;out.raw_json=JSON.stringify(raw);out.row_hash=crypto.createHash('sha256').update(JSON.stringify([...Object.keys(WO_XLSX_COLUMNS).map(f=>out[f]??null),out.raw_json])).digest('hex');return out}
// Link only when exactly one item waits for a WO and exactly one active, unused order exists for that SAP No.
function autoLinkWorkOrders(batch){const waiting=query(`SELECT i.id,i.sap_no,i.packing_list_id,p.invoice_no FROM items i JOIN packing_lists p ON p.id=i.packing_list_id LEFT JOIN work_orders w ON w.item_id=i.id WHERE COALESCE(w.wo_no,'')=''`),active=query(`SELECT production_order_id,sap_no,status FROM sap_production_orders WHERE is_canceled=0 AND lower(COALESCE(status,'')) NOT IN (${WO_CLOSED_STATUSES.map(q).join(',')}) AND production_order_id NOT IN (SELECT wo_no FROM work_orders WHERE COALESCE(wo_no,'')<>'')`),group=(rows,key)=>rows.reduce((m,x)=>m.set(canonicalSap(x[key]),[...(m.get(canonicalSap(x[key]))||[]),x]),new Map()),bySap=group(active,'sap_no'),linked=[],ambiguous=[],stamp=now();for(const [sap,items] of group(waiting,'sap_no')){const cands=bySap.get(sap)||[];if(!cands.length)continue;if(items.length!==1||cands.length!==1){ambiguous.push({sap_no:sap,waiting_items:items.map(x=>x.invoice_no),candidate_wo:cands.map(x=>x.production_order_id)});continue}const item=items[0],wo=cands[0].production_order_id;run(`INSERT INTO work_orders(id,item_id,wo_no,last_synced_at) VALUES(${q(crypto.randomUUID())},${q(item.id)},${q(wo)},${q(stamp)}) ON CONFLICT(item_id) DO UPDATE SET wo_no=excluded.wo_no,last_synced_at=excluded.last_synced_at WHERE COALESCE(work_orders.wo_no,'')=''`);audit('work_order',item.id,'AUTO_LINK',{batch,wo_no:wo,invoice_no:item.invoice_no,sap_no:item.sap_no});linked.push({invoice_no:item.invoice_no,sap_no:item.sap_no,wo_no:wo,packing_list_id:item.packing_list_id})}for(const plid of new Set(linked.map(x=>x.packing_list_id)))refreshArchive(plid);return {linked:linked.map(({packing_list_id,...x})=>x),ambiguous}}
app.post('/api/sap/import-xlsx',upload.single('file'),(req,res)=>{
  if(!req.file)return res.status(400).json({error:'กรุณาเลือกไฟล์ Excel .xlsx'});
  const cleanup=()=>{if(fs.existsSync(req.file.path))fs.unlinkSync(req.file.path)};
  if(!req.file.originalname.toLowerCase().endsWith('.xlsx')||fs.readFileSync(req.file.path).subarray(0,2).toString()!=='PK'){cleanup();return res.status(400).json({error:'ไฟล์ต้องเป็น Excel .xlsx เท่านั้น'})}
  const batch=crypto.randomUUID(),source=req.file.originalname;run(`INSERT INTO sap_sync_batches(id,started_at,status,source_name) VALUES(${q(batch)},${q(now())},'RUNNING',${q(source)})`);
  try{
    let sheets;try{sheets=JSON.parse(execFileSync('python3',[path.join(ROOT,'read_master_xlsx.py'),req.file.path],{encoding:'utf8',timeout:120000,maxBuffer:64*1024*1024}))}catch{throw Error('อ่านไฟล์ Excel ไม่สำเร็จ ไฟล์อาจเสียหายหรือไม่ใช่ .xlsx')}
    const sheet=findWoSheet(sheets);if(!sheet)throw Error(`ไม่พบหัวคอลัมน์ ${WO_XLSX_REQUIRED.map(f=>WO_XLSX_COLUMNS[f]).join(', ')}`);
    const missingRequired=WO_XLSX_REQUIRED.filter(f=>!(f in sheet.cols));if(missingRequired.length)throw Error('ขาดคอลัมน์ที่จำเป็น: '+missingRequired.map(f=>WO_XLSX_COLUMNS[f]).join(', '));
    const warnings=Object.keys(WO_XLSX_COLUMNS).filter(f=>!(f in sheet.cols)).map(f=>`ไม่พบคอลัมน์ ${WO_XLSX_COLUMNS[f]} (จะบันทึกเป็นค่าว่าง)`);
    const existing=new Map(query('SELECT production_order_id,row_hash FROM sap_production_orders').map(x=>[x.production_order_id,x.row_hash])),seen=new Set(),errors=[],statements=['BEGIN IMMEDIATE;'],stamp=now();let total=0,inserted=0,updated=0,unchanged=0;
    sheet.data.forEach((row,n)=>{if(!row.some(v=>String(v??'').trim()))return;total++;let r;try{r=parseWoRow(row,sheet);if(seen.has(r.production_order_id))throw Error(`Production Order ID ${r.production_order_id} ซ้ำในไฟล์`)}catch(e){errors.push({row:n+1,production_order_id:String(row[sheet.cols.production_order_id]??''),error:e.message});return}seen.add(r.production_order_id);
      const prior=existing.get(r.production_order_id);if(prior===r.row_hash){unchanged++;return}prior===undefined?inserted++:updated++;const f=Object.keys(WO_XLSX_COLUMNS).concat(['sap_no','is_canceled','raw_json','row_hash']),val=k=>r[k]==null?'NULL':typeof r[k]==='number'?r[k]:q(r[k]);
      statements.push(`INSERT INTO sap_production_orders(${f.join(',')},first_imported_at,last_imported_at,last_batch_id) VALUES(${f.map(val).join(',')},${q(stamp)},${q(stamp)},${q(batch)}) ON CONFLICT(production_order_id) DO UPDATE SET ${f.filter(k=>k!=='production_order_id').map(k=>`${k}=excluded.${k}`).join(',')},last_imported_at=excluded.last_imported_at,last_batch_id=excluded.last_batch_id;`)});
    if(!seen.size)throw Error('ไม่พบข้อมูล Work Order ที่ถูกต้องในไฟล์'+(errors.length?` (ผิดพลาด ${errors.length} แถว)`:''));
    statements.push('COMMIT;');runScript(statements.join('\n'));
    const {linked,ambiguous}=autoLinkWorkOrders(batch);
    run(`UPDATE sap_sync_batches SET finished_at=${q(now())},status='SUCCESS',row_count=${total},inserted_count=${inserted},updated_count=${updated},error_count=${errors.length},linked_count=${linked.length} WHERE id=${q(batch)}`);
    audit('sap_sync',batch,'XLSX_IMPORT',{source,sheet:sheet.name,total,inserted,updated,unchanged,errors:errors.length,linked:linked.length,ambiguous:ambiguous.length});cleanup();
    res.json({batch_id:batch,source_name:source,sheet:sheet.name,total_rows:total,inserted,updated,unchanged,error_count:errors.length,errors:errors.slice(0,200),warnings,linked,ambiguous,finished_at:now()});
  }catch(e){run(`UPDATE sap_sync_batches SET finished_at=${q(now())},status='FAILED',error=${q(e.message)} WHERE id=${q(batch)}`);cleanup();res.status(400).json({error:'นำเข้า Excel ไม่สำเร็จ: '+e.message})}
});
app.post('/api/line/webhook', (req,res)=>{const events=req.body?.events||[];res.status(202).json({accepted:true,events_received:events.length,detail:'Webhook endpoint available; configure LINE channel signature and credentials before production use'})});
// LINE QC integration (line-qc-service.js). .env is read into lineEnv, not process.env, so its PORT never moves this app.
const lineEnv={};require('dotenv').config({path:path.join(ROOT,'.env'),processEnv:lineEnv,quiet:true});const lineVar=k=>process.env[k]||lineEnv[k]||'';
const {createLineQcService,createLineWebhookApp}=require('./line-qc-service.js');
const lineQc=createLineQcService({query,runScript,q,now,redact:redactKnownBrands,canonicalSap,afterQcChange:syncQcTracking});lineQc.ensureSchema();
const lineQcRoute=fn=>(req,res)=>{try{res.json(fn(req))}catch(e){res.status(e.status||500).json({error:e.status?e.message:'ดำเนินการข้อความ LINE ไม่สำเร็จ: '+e.message,...(e.extra||{})})}};
app.get('/api/line-qc/summary',lineQcRoute(()=>lineQc.summary()));
app.get('/api/line-qc/messages',lineQcRoute(req=>lineQc.listMessages({status:req.query.status,limit:req.query.limit})));
app.post('/api/line-qc/messages/:id/resolve',lineQcRoute(req=>lineQc.resolveMessage(req.params.id,req.body||{})));
// Delete a packing list for good. The invoice number must be typed back; the DB is backed up first; one transaction removes
// items, WO links, QC results and SLA rows (LINE QC messages are kept, unlinked, back to review); the PDF goes last.
function packingListUsage(r){const c=s=>Number(query(`SELECT COUNT(*) n FROM ${s}`)[0]?.n||0),id=q(r.id);return {items:c(`items WHERE packing_list_id=${id}`),work_orders:c(`work_orders WHERE item_id IN (SELECT id FROM items WHERE packing_list_id=${id})`),qc_results:c(`qc_results WHERE packing_list_id=${id}`),line_qc_messages:lineQc.countLinkedToPackingList(r.id)}}
const hasPdf=r=>!!r.file_path&&fs.existsSync(r.file_path);
app.get('/api/packing-lists/:invoice/usage',(req,res)=>{const r=invoiceRow(req.params.invoice);if(!r)return res.status(404).json({error:'ไม่พบ Invoice'});res.json({invoice_no:r.invoice_no,status:r.status,...packingListUsage(r),has_pdf:hasPdf(r)})});
app.delete('/api/packing-lists/:invoice',(req,res)=>{
  const r=invoiceRow(req.params.invoice);if(!r)return res.status(404).json({error:'ไม่พบ Invoice'});
  const typed=String(req.body?.confirm_invoice||'').trim().toUpperCase();
  if(!typed||typed!==String(r.invoice_no).trim().toUpperCase())return res.status(400).json({error:'กรุณาพิมพ์เลข Invoice ให้ตรงเพื่อยืนยันการลบ'});
  const usage=packingListUsage(r),stamp=now(),backup=`pl-brand-before-delete-${String(r.invoice_no).replace(/[^A-Za-z0-9_-]/g,'_')}-${stamp.replace(/\D/g,'').slice(0,14)}.sqlite`;
  try{execFileSync('sqlite3',[DB,`.backup '${path.join(DATA,backup).replace(/'/g,"''")}'`],{encoding:'utf8'})}catch(e){return res.status(500).json({error:'สำรองฐานข้อมูลไม่สำเร็จ จึงยังไม่ได้ลบ: '+String(e.message).split('\n')[0]})}
  const id=q(r.id),details={invoice_no:r.invoice_no,status:r.status,...usage,backup};
  try{runScript(`BEGIN IMMEDIATE;
${lineQc.detachPackingListSql(r.id)}
DELETE FROM work_orders WHERE item_id IN (SELECT id FROM items WHERE packing_list_id=${id});
DELETE FROM qc_results WHERE packing_list_id=${id};
DELETE FROM items WHERE packing_list_id=${id};
DELETE FROM packing_list_qc_tracking WHERE invoice_no=${q(r.invoice_no)};
DELETE FROM packing_lists WHERE id=${id};
INSERT INTO audit_logs(id,entity,entity_id,action,details,created_at) VALUES(${q(crypto.randomUUID())},'packing_list',${id},'DELETE',${q(JSON.stringify(details))},${q(stamp)});
COMMIT;`)}catch(e){return res.status(500).json({error:'ลบ Packing List ไม่สำเร็จ ข้อมูลยังอยู่ครบ: '+String(e.message).split('\n')[0]})}
  let pdfDeleted=false;
  try{const f=r.file_path&&fs.realpathSync(r.file_path);if(f&&f.startsWith(fs.realpathSync(FILES)+path.sep)&&!query(`SELECT 1 FROM packing_lists WHERE file_path=${q(r.file_path)}`).length){fs.unlinkSync(f);pdfDeleted=true}}catch{}
  syncQcTracking();
  res.json({ok:true,invoice_no:r.invoice_no,deleted:usage,pdf_deleted:pdfDeleted,backup});
});
app.use(express.static(ROOT,{index:'index.html'}));
const PORT=Number(process.env.PORT||8765);
syncQcTracking();
setInterval(runDailySlaCheck, 60*60*1000);
app.listen(PORT,'127.0.0.1',()=>console.log(`Packing List Management listening at http://127.0.0.1:${PORT}`));
// Dedicated LINE webhook listener (separate port; expose only this one through a tunnel). Failure never stops the main app.
{const secret=lineVar('LINE_CHANNEL_SECRET'),groupId=lineVar('LINE_QC_GROUP_ID'),port=Number(lineVar('LINE_WEBHOOK_PORT')||8766);if(!secret)console.log('[LINE QC] webhook disabled: LINE_CHANNEL_SECRET is not set');else if(port===PORT)console.log('[LINE QC] webhook disabled: LINE_WEBHOOK_PORT must differ from PORT');else createLineWebhookApp({secret,groupId,service:lineQc}).listen(port,'127.0.0.1',err=>err?console.error('[LINE QC] webhook listener failed:',err.code||err.message):console.log(`[LINE QC] webhook listening at http://127.0.0.1:${port}/line/webhook${groupId?'':' (LINE_QC_GROUP_ID not set: group messages are ignored)'}`))}
