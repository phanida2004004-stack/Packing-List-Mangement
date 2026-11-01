// LINE QC integration: stores QC messages from the LINE QC group, matches them to packing-list items without
// guessing, applies only safe ACCEPT/REJECT results, and supports manual review. Also builds the dedicated webhook
// app (separate port, the only thing a tunnel may expose). DB helpers are injected from server.js.
'use strict';
const crypto=require('crypto');
const express=require('express');
const {parseQcMessage,decideQcAction,PARSER_VERSION}=require('./line-qc-parser.js');

// New table only. Existing tables are read, and qc_results/audit_logs get rows the same way server.js writes them.
// Stored: brand-redacted text, mention display text + type, parse output, decision. Not stored: sender/mentioned
// user IDs, group ID, reply tokens. IGNORED (non-QC chatter) rows keep only the message id for duplicate protection.
const SCHEMA=`CREATE TABLE IF NOT EXISTS line_qc_messages(
  id TEXT PRIMARY KEY,
  line_message_id TEXT NOT NULL UNIQUE,
  webhook_event_id TEXT,
  is_redelivery INTEGER NOT NULL DEFAULT 0,
  line_timestamp TEXT NOT NULL,
  text_redacted TEXT NOT NULL DEFAULT '',
  mentions_json TEXT NOT NULL DEFAULT '[]',
  parsed_json TEXT NOT NULL DEFAULT '{}',
  parser_version TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('ACCEPT','REJECT','UNKNOWN')),
  result_reason TEXT,
  invoice_no TEXT,
  sap_no TEXT,
  packing_list_id TEXT REFERENCES packing_lists(id),
  matched_sap_no TEXT,
  status TEXT NOT NULL CHECK(status IN ('APPLIED','CONFIRMED_EXISTING','NEEDS_REVIEW','RESOLVED','DISMISSED','IGNORED')),
  review_reasons TEXT NOT NULL DEFAULT '[]',
  previous_result TEXT,
  qc_result_id TEXT,
  unsent_at TEXT,
  reviewed_at TEXT,
  review_action TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_line_qc_status ON line_qc_messages(status,line_timestamp);`;

const STATUSES=['APPLIED','CONFIRMED_EXISTING','NEEDS_REVIEW','RESOLVED','DISMISSED','IGNORED'];
const DECIDED=new Set(['ACCEPT','REJECT']);
const QC_HINT_RE=/ACCEPT|REJECT|ACC ?\. ?LOT|ผล ?ผ่าน/i;

function verifyLineSignature(rawBody,signature,secret){
  if(!secret||typeof signature!=='string'||!signature||!Buffer.isBuffer(rawBody))return false;
  const expected=Buffer.from(crypto.createHmac('sha256',secret).update(rawBody).digest('base64')),received=Buffer.from(signature);
  return expected.length===received.length&&crypto.timingSafeEqual(expected,received);
}

function createLineQcService({query,runScript,q,now,redact=s=>String(s??''),canonicalSap,afterQcChange=()=>{}}){
  const uuid=()=>crypto.randomUUID(),json=v=>q(JSON.stringify(v)),nul=v=>v==null||v===''?'NULL':q(v);
  const fail=(status,error,extra={})=>Object.assign(new Error(error),{status,extra});
  const auditSql=(id,action,details)=>`INSERT INTO audit_logs(id,entity,entity_id,action,details,created_at) VALUES(${q(uuid())},'line_qc_message',${q(id)},${q(action)},${json(details)},${q(now())});`;
  const decidedCurrentSql=(plid,sap)=>`SELECT 1 FROM qc_results WHERE packing_list_id=${q(plid)} AND sap_no=${q(sap)} AND is_current=1 AND result IN ('ACCEPT','REJECT')`;
  // Aborts the whole script (sqlite3 -bail, no COMMIT reached) when cond is false.
  const assertSql=cond=>`CREATE TEMP TABLE IF NOT EXISTS _line_qc_assert(ok INTEGER NOT NULL CHECK(ok=1));INSERT INTO _line_qc_assert SELECT (${cond});`;
  const defectText=defects=>(defects||[]).map(d=>`${d.level}: ${d.detail}`).join('\n').slice(0,2000);

  function ensureSchema(){runScript(SCHEMA)}

  function currentResult(plid,sap){return query(`SELECT id,result,received_at FROM qc_results WHERE packing_list_id=${q(plid)} AND sap_no=${q(sap)} AND is_current=1 ORDER BY (result IN ('ACCEPT','REJECT')) DESC,received_at DESC LIMIT 1`)[0]||null}

  // Exact and unambiguous only: one packing list for the invoice, one distinct items.sap_no for the canonical SAP.
  function lookup(invoiceNo,sapNo){
    const out={invoiceFound:false,sapInInvoice:false,reasons:[],packingList:null,itemSap:null,current:null};
    if(!invoiceNo)return out;
    const pls=query(`SELECT id,invoice_no FROM packing_lists WHERE UPPER(TRIM(invoice_no))=${q(String(invoiceNo).trim().toUpperCase())}`);
    if(pls.length>1){out.reasons.push('INVOICE_AMBIGUOUS');return out}
    if(!pls.length)return out;
    out.invoiceFound=true;out.packingList=pls[0];
    if(!sapNo)return out;
    const key=canonicalSap(sapNo),saps=[...new Set(query(`SELECT DISTINCT sap_no FROM items WHERE packing_list_id=${q(pls[0].id)}`).map(r=>r.sap_no).filter(s=>canonicalSap(s)===key))];
    if(saps.length>1){out.reasons.push('SAP_AMBIGUOUS');return out}
    if(!saps.length)return out;
    out.sapInInvoice=true;out.itemSap=saps[0];out.current=currentResult(pls[0].id,saps[0]);
    return out;
  }

  // Inserts a new current qc_results row only if no ACCEPT/REJECT is current for (plid, sap) at that moment.
  // Older non-decided current rows (legacy PENDING) are kept but marked not current, like server.js does.
  function applySql({rid,plid,sap,result,rawMessage,defects,quantity,sourceId,parserVersion,receivedAt}){
    const guard=`NOT EXISTS(${decidedCurrentSql(plid,sap)})`;
    return `UPDATE qc_results SET is_current=0 WHERE packing_list_id=${q(plid)} AND sap_no=${q(sap)} AND is_current=1 AND ${guard};
INSERT INTO qc_results(id,packing_list_id,sap_no,result,raw_message,defect_description,quantity,source_message_id,parser_version,received_at,is_current) SELECT ${q(rid)},${q(plid)},${q(sap)},${q(result)},${q(rawMessage)},${q(defects)},${quantity==null?'NULL':Number(quantity)||0},${q(sourceId)},${q(parserVersion)},${q(receivedAt)},1 WHERE ${guard};`;
  }

  function messageInsertSql(m){
    const p=m.parsed,store=m.status!=='IGNORED';
    const parsedPublic=store?{invoices:p.invoices,sap_nos:p.sap_nos,received_qty:p.received_qty,sample_qty:p.sample_qty,receipt_date:p.receipt_date,defects:p.defects.map(d=>({...d,detail:redact(d.detail)})),issues:p.issues,mention_warnings:p.mention_warnings,summary_line:redact(p.summary_line)}:{issues:p.issues};
    return `INSERT INTO line_qc_messages(id,line_message_id,webhook_event_id,is_redelivery,line_timestamp,text_redacted,mentions_json,parsed_json,parser_version,result,result_reason,invoice_no,sap_no,packing_list_id,matched_sap_no,status,review_reasons,previous_result,qc_result_id,created_at,updated_at) VALUES(${q(m.id)},${q(m.lineId)},${nul(m.eventId)},${m.redelivery?1:0},${q(m.ts)},${q(store?redact(m.text):'')},${json(store?p.mentions:[])},${json(parsedPublic)},${q(p.parser_version)},${q(p.result)},${q(p.result_reason)},${nul(store?p.invoice_no:null)},${nul(store?p.sap_no:null)},${nul(m.match?.packingList?.id)},${nul(m.match?.itemSap)},${q(m.status)},${json(m.reasons||[])},${nul(m.previous)},${nul(m.qcResultId)},${q(m.stamp)},${q(m.stamp)});`;
  }

  const isDuplicate=lineId=>query(`SELECT 1 FROM line_qc_messages WHERE line_message_id=${q(lineId)}`).length>0;

  function processMessage(ev){
    const msg=ev.message,lineId=String(msg?.id||'');
    if(!lineId)return 'IGNORED_EVENT';
    if(isDuplicate(lineId))return 'DUPLICATE';
    const text=String(msg.text||'').slice(0,10000),parsed=parseQcMessage(text,msg.mention),stamp=now(),id=uuid();
    const ts=Number.isFinite(ev.timestamp)?new Date(ev.timestamp).toISOString():stamp;
    const base={id,lineId,eventId:ev.webhookEventId,redelivery:!!ev.deliveryContext?.isRedelivery,ts,text,parsed,stamp};
    if(!parsed.invoices.length&&!parsed.sap_nos.length&&!QC_HINT_RE.test(parsed.clean_text)){
      try{runScript(messageInsertSql({...base,status:'IGNORED'}))}catch(e){if(isDuplicate(lineId))return 'DUPLICATE';throw e}
      return 'IGNORED';
    }
    const match=lookup(parsed.invoice_no,parsed.sap_no);
    const decision=parsed.auto_matchable&&match.reasons.length?{action:'NEEDS_REVIEW',reasons:match.reasons}
      :decideQcAction(parsed,{invoiceFound:match.invoiceFound,sapInInvoice:match.sapInInvoice,current:match.current,messageTime:ts});
    const previous=match.current&&DECIDED.has(match.current.result)?match.current.result:null;
    const status={APPLY:'APPLIED',CONFIRM_EXISTING:'CONFIRMED_EXISTING'}[decision.action]||'NEEDS_REVIEW';
    if(status==='NEEDS_REVIEW'){ // also show what the lookup found, so the reviewer sees every problem at once
      const extra=[...match.reasons];
      if(parsed.invoice_no&&!match.invoiceFound&&!match.reasons.length)extra.push('INVOICE_NOT_FOUND');
      if(match.invoiceFound&&parsed.sap_no&&!match.sapInInvoice&&!match.reasons.length)extra.push('SAP_NOT_IN_INVOICE');
      if(previous&&DECIDED.has(parsed.result)&&previous!==parsed.result)extra.push('RESULT_CHANGED');
      decision.reasons=[...new Set([...decision.reasons,...extra])];
    }
    const rid=decision.action==='APPLY'?uuid():null,qcResultId=rid||(decision.action==='CONFIRM_EXISTING'?match.current.id:null);
    const sql=['BEGIN IMMEDIATE;',messageInsertSql({...base,status,reasons:decision.reasons,match,previous,qcResultId})];
    if(rid){
      sql.push(applySql({rid,plid:match.packingList.id,sap:match.itemSap,result:parsed.result,rawMessage:redact(parsed.clean_text),defects:redact(defectText(parsed.defects)),quantity:parsed.received_qty,sourceId:'line:'+lineId,parserVersion:PARSER_VERSION,receivedAt:ts}));
      sql.push(`UPDATE line_qc_messages SET status='NEEDS_REVIEW',qc_result_id=NULL,review_reasons='["CURRENT_RESULT_APPEARED"]' WHERE id=${q(id)} AND NOT EXISTS(SELECT 1 FROM qc_results WHERE id=${q(rid)});`);
    }
    sql.push(auditSql(id,'LINE_'+status,{invoice_no:parsed.invoice_no,sap_no:parsed.sap_no,result:parsed.result,reasons:decision.reasons,qc_result_id:qcResultId,previous_result:previous}),'COMMIT;');
    try{runScript(sql.join('\n'))}catch(e){if(isDuplicate(lineId))return 'DUPLICATE';throw e}
    if(rid)afterQcChange();
    return rid?query(`SELECT status FROM line_qc_messages WHERE id=${q(id)}`)[0]?.status||status:status;
  }

  // The sender took the message back: keep everything (results are never removed automatically) but flag it,
  // and send an already-used message back to review so a person decides what to do.
  function processUnsend(ev){
    const lineId=String(ev.unsend?.messageId||''),row=lineId&&query(`SELECT id,status,review_reasons,unsent_at FROM line_qc_messages WHERE line_message_id=${q(lineId)}`)[0];
    if(!row)return 'UNSEND_UNKNOWN';
    if(row.unsent_at)return 'DUPLICATE';
    const stamp=now(),reasons=[...new Set([...JSON.parse(row.review_reasons||'[]'),'MESSAGE_UNSENT'])],flip=['APPLIED','CONFIRMED_EXISTING','RESOLVED'].includes(row.status);
    runScript(`BEGIN IMMEDIATE;UPDATE line_qc_messages SET unsent_at=${q(stamp)},review_reasons=${json(reasons)}${flip?",status='NEEDS_REVIEW'":''},updated_at=${q(stamp)} WHERE id=${q(row.id)} AND unsent_at IS NULL;${auditSql(row.id,'LINE_UNSENT',{previous_status:row.status})}COMMIT;`);
    return 'UNSENT';
  }

  // A packing list is being deleted (SQL runs inside the caller's transaction, before qc_results are removed): keep its
  // messages, drop every link to it, and send used ones back to review with reason PACKING_LIST_DELETED.
  const linkedWhere=plid=>`(packing_list_id=${q(plid)} OR qc_result_id IN (SELECT id FROM qc_results WHERE packing_list_id=${q(plid)}))`;
  const countLinkedToPackingList=plid=>Number(query(`SELECT COUNT(*) n FROM line_qc_messages WHERE ${linkedWhere(plid)}`)[0]?.n||0);
  function detachPackingListSql(plid){
    const stamp=now();
    return `INSERT INTO audit_logs(id,entity,entity_id,action,details,created_at) SELECT lower(hex(randomblob(16))),'line_qc_message',id,'LINE_PACKING_LIST_DELETED',json_object('previous_status',status),${q(stamp)} FROM line_qc_messages WHERE ${linkedWhere(plid)};
UPDATE line_qc_messages SET status=CASE WHEN status IN ('APPLIED','CONFIRMED_EXISTING','RESOLVED') THEN 'NEEDS_REVIEW' ELSE status END,review_reasons=CASE WHEN EXISTS(SELECT 1 FROM json_each(review_reasons) WHERE value='PACKING_LIST_DELETED') THEN review_reasons ELSE json_insert(review_reasons,'$[#]','PACKING_LIST_DELETED') END,packing_list_id=NULL,matched_sap_no=NULL,qc_result_id=NULL,updated_at=${q(stamp)} WHERE ${linkedWhere(plid)};`;
  }

  function handleWebhook(body,{groupId,log}={}){
    const counts={},add=k=>{counts[k]=(counts[k]||0)+1};
    for(const ev of Array.isArray(body?.events)?body.events:[]){
      const src=ev?.source;
      if(src?.type!=='group'||!groupId||src.groupId!==groupId){
        if(!groupId&&src?.type==='group'&&log)log(`[LINE QC] ignored event from group ${src.groupId} (set LINE_QC_GROUP_ID to accept this group)`);
        add('IGNORED_SOURCE');continue;
      }
      if(ev.type==='message'&&ev.message?.type==='text')add(processMessage(ev));
      else if(ev.type==='unsend')add(processUnsend(ev));
      else add('IGNORED_EVENT');
    }
    return counts;
  }

  function selectMessages(where,limit){
    return query(`SELECT m.id,m.line_timestamp,m.text_redacted,m.mentions_json,m.parsed_json,m.parser_version,m.result,m.result_reason,m.invoice_no,m.sap_no,m.matched_sap_no,p.invoice_no AS matched_invoice_no,m.status,m.review_reasons,m.previous_result,m.qc_result_id,m.is_redelivery,m.unsent_at,m.reviewed_at,m.review_action,m.review_note,m.created_at,m.updated_at,
(SELECT r.result FROM qc_results r WHERE r.packing_list_id=m.packing_list_id AND r.sap_no=m.matched_sap_no AND r.is_current=1 ORDER BY (r.result IN ('ACCEPT','REJECT')) DESC,r.received_at DESC LIMIT 1) AS current_result
FROM line_qc_messages m LEFT JOIN packing_lists p ON p.id=m.packing_list_id WHERE ${where} ORDER BY m.line_timestamp DESC,m.created_at DESC LIMIT ${limit}`)
      .map(({mentions_json,parsed_json,review_reasons,...r})=>({...r,mentions:JSON.parse(mentions_json||'[]'),parsed:JSON.parse(parsed_json||'{}'),review_reasons:JSON.parse(review_reasons||'[]')}));
  }
  function listMessages({status,limit}={}){
    const s=String(status||'NEEDS_REVIEW').toUpperCase(),n=Math.max(1,Math.min(500,Number(limit)||100));
    if(s!=='ALL'&&!STATUSES.includes(s))throw fail(400,'สถานะไม่ถูกต้อง');
    return selectMessages(s==='ALL'?`m.status<>'IGNORED'`:`m.status=${q(s)}`,n);
  }
  const getMessage=id=>selectMessages(`m.id=${q(id)}`,1)[0];
  function summary(){const out=Object.fromEntries(STATUSES.map(s=>[s,0]));for(const r of query(`SELECT status,COUNT(*) n FROM line_qc_messages GROUP BY status`))out[r.status]=Number(r.n);return out}

  // Manual review. APPLY never silently replaces a different ACCEPT/REJECT: it needs confirm_replace, keeps the
  // old row (is_current=0) and audits the change.
  function resolveMessage(id,{action,invoice_no,sap_no,result,confirm_replace,note}={}){
    const row=query(`SELECT * FROM line_qc_messages WHERE id=${q(id)}`)[0];
    if(!row)throw fail(404,'ไม่พบข้อความ LINE นี้');
    if(row.status!=='NEEDS_REVIEW')throw fail(409,'ข้อความนี้ไม่ได้อยู่ในสถานะรอตรวจ');
    const stamp=now(),noteSql=nul(String(note||'').trim().slice(0,500)),guardStatus=`WHERE id=${q(id)} AND status='NEEDS_REVIEW'`;
    if(action==='DISMISS'){
      runScript(`BEGIN IMMEDIATE;UPDATE line_qc_messages SET status='DISMISSED',review_action='DISMISS',review_note=${noteSql},reviewed_at=${q(stamp)},updated_at=${q(stamp)} ${guardStatus};${auditSql(id,'LINE_REVIEW_DISMISS',{})}COMMIT;`);
      return getMessage(id);
    }
    if(action!=='APPLY')throw fail(400,'action ต้องเป็น APPLY หรือ DISMISS');
    if(!DECIDED.has(result))throw fail(400,'result ต้องเป็น ACCEPT หรือ REJECT');
    const inv=String(invoice_no||row.invoice_no||'').trim(),sap=String(sap_no||row.sap_no||'').trim();
    if(!inv||!sap)throw fail(400,'ต้องระบุ Invoice No. และ SAP No.');
    const m=lookup(inv,sap);
    if(m.reasons.includes('INVOICE_AMBIGUOUS'))throw fail(422,'พบ Invoice นี้มากกว่า 1 รายการ');
    if(!m.invoiceFound)throw fail(422,'ไม่พบ Invoice ที่ระบุ');
    if(m.reasons.includes('SAP_AMBIGUOUS'))throw fail(422,'SAP No. นี้ตรงกับหลายรายการใน Invoice นี้');
    if(!m.sapInInvoice)throw fail(422,'ไม่พบ SAP No. ใน Invoice นี้');
    const plid=m.packingList.id,cur=m.current&&DECIDED.has(m.current.result)?m.current:null;
    const resolvedSql=(qcId,reviewAction)=>`UPDATE line_qc_messages SET status='RESOLVED',review_action=${q(reviewAction)},review_note=${noteSql},reviewed_at=${q(stamp)},updated_at=${q(stamp)},packing_list_id=${q(plid)},matched_sap_no=${q(m.itemSap)},qc_result_id=${q(qcId)},previous_result=${nul(cur?.result)} ${guardStatus};`;
    const details={invoice_no:m.packingList.invoice_no,sap_no:m.itemSap,result};
    if(cur&&cur.result===result){
      runScript(`BEGIN IMMEDIATE;${resolvedSql(cur.id,'CONFIRM_EXISTING')}${auditSql(id,'LINE_REVIEW_CONFIRM_EXISTING',{...details,qc_result_id:cur.id})}COMMIT;`);
      return getMessage(id);
    }
    if(cur&&confirm_replace!==true)throw fail(409,`มีผล QC เดิมเป็น ${cur.result} อยู่แล้ว ต้องยืนยันก่อนแทนที่`,{needs_confirm:true,current_result:cur.result,current_received_at:cur.received_at});
    const rid=uuid(),parsed=JSON.parse(row.parsed_json||'{}'),sql=['BEGIN IMMEDIATE;'];
    if(cur)sql.push(`UPDATE qc_results SET is_current=0 WHERE id=${q(cur.id)} AND is_current=1;`);
    sql.push(applySql({rid,plid,sap:m.itemSap,result,rawMessage:row.text_redacted,defects:defectText(parsed.defects),quantity:parsed.received_qty??null,sourceId:'line-review:'+rid,parserVersion:PARSER_VERSION+'+review',receivedAt:row.line_timestamp}));
    sql.push(assertSql(`EXISTS(SELECT 1 FROM qc_results WHERE id=${q(rid)})`),resolvedSql(rid,cur?'REPLACE':'APPLY'));
    sql.push(auditSql(id,cur?'LINE_REVIEW_REPLACE':'LINE_REVIEW_APPLY',{...details,qc_result_id:rid,previous_result:cur?.result||null,previous_qc_result_id:cur?.id||null}),'COMMIT;');
    try{runScript(sql.join('\n'))}catch(e){throw fail(409,'ผล QC ถูกเปลี่ยนระหว่างดำเนินการ กรุณาโหลดใหม่แล้วลองอีกครั้ง')}
    afterQcChange();
    return getMessage(id);
  }

  return {ensureSchema,handleWebhook,listMessages,getMessage,summary,resolveMessage,lookup,countLinkedToPackingList,detachPackingListSql};
}

// Dedicated webhook app: one POST route, raw body for the signature, nothing else from the main API.
function createLineWebhookApp({secret,groupId,service,log=console}){
  const app=express();app.disable('x-powered-by');
  app.post(['/line/webhook','/api/line/webhook'],express.raw({type:()=>true,limit:'1mb'}),(req,res)=>{
    const raw=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
    if(!verifyLineSignature(raw,req.get('x-line-signature'),secret))return res.status(401).json({error:'invalid signature'});
    let body;try{body=JSON.parse(raw.toString('utf8'))}catch{return res.status(400).json({error:'invalid body'})}
    try{res.json({ok:true,events:service.handleWebhook(body,{groupId,log:m=>log.log(m)})})}
    catch(e){log.error('[LINE QC] webhook processing failed:',String(e?.message||e).split('\n')[0].slice(0,200));res.status(500).json({error:'processing failed'})}
  });
  app.get('/line/health',(_,res)=>res.json({ok:true}));
  app.use((_,res)=>res.status(404).json({error:'not found'}));
  app.use((err,_req,res,_next)=>res.status(err.status===413?413:400).json({error:'bad request'}));
  return app;
}

module.exports={SCHEMA,verifyLineSignature,createLineQcService,createLineWebhookApp};
