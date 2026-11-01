// Pure parser for QC result messages received from the LINE QC group.
// No DB, network or env access: everything here is deterministic on (text, mention).
// Used only by the LINE integration; the manual QC page keeps classify()/extractFields() in server.js.
'use strict';

const PARSER_VERSION='line-qc-v2'; // v2: one polite word may end the final summary

// LINE mention metadata: message.mention.mentionees[] = {index,length,type:'user'|'all',userId?,isSelf?}.
// LINE's docs do not say whether index/length count UTF-16 units or code points (they differ only after an astral
// character such as most emoji), so both readings are tried: UTF-16 if every mentionee is valid under it, else code
// points if every mentionee is valid under that; a reading is never mixed. Valid = starts with '@', no line break,
// no overlap. If neither reading fits all, only UTF-16 ranges that are valid on their own are removed; the rest stay
// in place and are reported, never guessed. userId is deliberately dropped (privacy).
function stripMentions(text,mention){
  const raw=String(text??''),warnings=[];
  const list=Array.isArray(mention?.mentionees)?mention.mentionees:[];
  const entries=list.map(m=>({index:m?.index,length:m?.length,type:m?.type==='all'?'all':'user'}))
    .filter(m=>{const ok=Number.isInteger(m.index)&&Number.isInteger(m.length)&&m.index>=0&&m.length>0;if(!ok)warnings.push('MENTION_OUT_OF_RANGE');return ok});
  const cpOffsets=[0];for(const ch of raw)cpOffsets.push(cpOffsets[cpOffsets.length-1]+ch.length);
  const toUtf16=(m,unit)=>unit==='utf16'?{start:m.index,end:m.index+m.length,type:m.type}:{start:cpOffsets[m.index],end:cpOffsets[m.index+m.length],type:m.type};
  const inRange=(m,unit)=>m.index+m.length<=(unit==='utf16'?raw.length:cpOffsets.length-1);
  const textOk=r=>{const piece=raw.slice(r.start,r.end);return piece.startsWith('@')&&!/[\r\n]/.test(piece)};
  const allValid=unit=>{
    if(!entries.length||!entries.every(m=>inRange(m,unit)))return null;
    const rs=entries.map(m=>toUtf16(m,unit)).sort((a,b)=>a.start-b.start);
    return rs.every((r,i)=>textOk(r)&&(!i||r.start>=rs[i-1].end))?rs:null;
  };
  let ranges=allValid('utf16')||allValid('cp'),partial=false;
  if(!ranges){
    partial=true;
    ranges=entries.filter(m=>{const ok=inRange(m,'utf16');if(!ok)warnings.push('MENTION_OUT_OF_RANGE');return ok}).map(m=>toUtf16(m,'utf16')).sort((a,b)=>a.start-b.start);
  }
  let out='',cursor=0;const mentions=[];
  for(const r of ranges){
    if(partial&&r.start<cursor){warnings.push('MENTION_OVERLAP');continue}
    if(partial&&!textOk(r)){warnings.push('MENTION_TEXT_MISMATCH');continue}
    out+=raw.slice(cursor,r.start);cursor=r.end;
    mentions.push({display_text:raw.slice(r.start,r.end),type:r.type});
  }
  out+=raw.slice(cursor);
  return {text:out,mentions,warnings:[...new Set(warnings)]};
}

// NFKC turns Thai SARA AM (U+0E33) into NIKHAHIT+SARA AA; fold it back so Thai literals match.
function normalizeText(text){return String(text??'').normalize('NFKC').replace(/\u0E4D\u0E32/g,'\u0E33').replace(/[\u200B-\u200D\u2060\uFEFF]/g,'').replace(/\r\n?/g,'\n').replace(/[\t\u00A0\u3000]/g,' ')}
function cleanLines(text){return normalizeText(text).split('\n').map(l=>l.replace(/ {2,}/g,' ').trim()).filter(Boolean)}

// For matching only: drop formatting symbols (*bold*, _italic_, ~strike~, `code`) and surrounding decorations
// (emoji, punctuation), collapse spaces, uppercase.
function matchForm(line){return line.replace(/[*_~`]/g,' ').replace(/^[^\p{L}\p{N}]+/u,'').replace(/[^\p{L}\p{N}]+$/u,'').replace(/\s+/g,' ').trim().toUpperCase()}

// Final line (strict): it must BE an approved summary, with nothing else on the line.
//   ACCEPT: ACCEPT LOT | ACC.LOT | ACC. LOT | ผลผ่าน | ACCEPT LOT / ผลผ่าน | ACC.LOT / ผลผ่าน (case/spacing-insensitive)
//   REJECT: <any reason> จึงขอทำการ Reject   (the phrase must end the line)
// Exception: ONE polite word from a fixed list (ค่ะ คะ ครับ นะคะ นะครับ) may end the line; it is cut, and what is
// left must still be an approved summary ("ACCEPT LOT ขอบคุณค่ะ" or "Reject ค่ะ LOT" stay UNKNOWN).
const POLITE_END_RE=/ ?(?:นะ ?)?(?:ค่ะ|คะ|ครับ)$/;
const dropPolite=m=>m.replace(POLITE_END_RE,'').replace(/[^\p{L}\p{N}]+$/u,'').trim();
const ACC_LOT='(?:ACCEPT ?LOT|ACC ?\\. ?LOT)',PASS='ผล ?ผ่าน';
const ACCEPT_FINAL_RE=new RegExp(`^(?:${ACC_LOT}(?: ?/ ?${PASS})?|${PASS})$`);
const REJECT_FINAL_RE=/^(?:.* )?จึง ?ขอ ?ทำ ?การ ?REJECT$/;
// Any line (loose): used only to detect conflicting or misplaced summaries. Defect lines ("Minor= ... ACCEPT15 ชิ้น",
// "... Reject 9 ชิ้น") match neither, because ACCEPT must start the line and REJECT needs the full phrase.
const ACCEPT_START_RE=new RegExp(`^(?:${ACC_LOT}|${PASS})(?![A-Z])`),ACCEPT_ANY_RE=new RegExp(`${ACC_LOT}|${PASS}`);
const REJECT_ANY_RE=/จึง ?ขอ ?ทำ ?การ ?REJECT(?![A-Z])/;
function finalSummaryOf(line){const m=dropPolite(matchForm(line));if(ACCEPT_FINAL_RE.test(m))return 'ACCEPT';if(REJECT_FINAL_RE.test(m))return ACCEPT_ANY_RE.test(m)?'CONFLICT':'REJECT';return null}
function looseSummaryOf(line){const m=matchForm(line),a=ACCEPT_START_RE.test(m),r=REJECT_ANY_RE.test(m);return a&&r?'CONFLICT':a?'ACCEPT':r?'REJECT':null}

// The final QC summary is the last non-empty line (after metadata mentions are removed) and nothing may follow it.
// Any other summary-like line that disagrees with it makes the result UNKNOWN.
function classifyLotResult(lines){
  if(!lines.length)return {result:'UNKNOWN',reason:'EMPTY_MESSAGE',summary_line:''};
  const last=lines[lines.length-1],final=finalSummaryOf(last),others=lines.slice(0,-1).map(looseSummaryOf).filter(Boolean);
  if(final==='CONFLICT'||(!final&&looseSummaryOf(last)==='CONFLICT'))return {result:'UNKNOWN',reason:'CONFLICTING_SUMMARY',summary_line:last};
  if(!final)return {result:'UNKNOWN',reason:looseSummaryOf(last)||others.length?'TEXT_AFTER_SUMMARY':'NO_FINAL_SUMMARY',summary_line:last};
  if(others.some(r=>r!==final))return {result:'UNKNOWN',reason:'CONFLICTING_SUMMARY',summary_line:last};
  return {result:final,reason:'FINAL_SUMMARY',summary_line:last};
}

const sapKey=v=>String(v||'').trim().replace(/-1$/i,''); // same rule as canonicalSap() in server.js
const num=v=>v==null?null:Number(String(v).replace(/,/g,''));

function extractInvoices(text){const found=new Set();for(const m of text.matchAll(/\bINV\s?(\d{2})\s?[-\u2013]?\s?([A-Z]{2,5})\s?(\d{2,5})\b/gi))found.add(`INV${m[1]}-${m[2]}${m[3]}`.toUpperCase());return [...found]}

// SAP NO.: number(s) at the very start of a line ("4211742 JOJI,..." or "4211742/4211743 ..."), or labelled "SAP NO: ...".
function extractSapNos(lines){
  const found=new Set();
  for(const line of lines){
    const lead=line.match(/^\d{6,10}(?:-1)?(?:\s*[\/,&+]\s*\d{6,10}(?:-1)?)*(?!\d|[.,\/]\d)/);
    if(lead)for(const m of lead[0].matchAll(/\d{6,10}(?:-1)?/g))found.add(sapKey(m[0]));
    for(const m of line.matchAll(/\bSAP\s*(?:NO\.?)?\s*[:#-]?\s*(\d{6,10}(?:-1)?)\b/gi))found.add(sapKey(m[1]));
  }
  return [...found];
}

function extractReceiptDate(text){
  const m=text.match(/ของ\s*เข้า\s*(?:วันที่)?\s*(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);if(!m)return null;
  let [d,mo,y]=[m[1],m[2],m[3]].map(Number);if(y>2400)y-=543;
  const dt=new Date(Date.UTC(y,mo-1,d));
  return dt.getUTCFullYear()===y&&dt.getUTCMonth()===mo-1&&dt.getUTCDate()===d?`${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`:null;
}

function extractDefects(lines){
  return lines.map(l=>l.match(/^(CRITICAL|MAJOR|MINOR)\s*=\s*(.+)$/i)).filter(Boolean).map(m=>{
    const detail=m[2].trim(),qty=detail.match(/([\d,]+)\s*ชิ้น/),pct=detail.match(/(\d+(?:\.\d+)?)\s*%/);
    return {level:m[1].toUpperCase(),detail,quantity:qty?num(qty[1]):null,percent:pct?Number(pct[1]):null};
  });
}

// Returns everything needed to decide matching; DB-level checks (invoice exists, SAP in invoice, duplicates,
// existing results) happen in the persistence layer.
function parseQcMessage(text,mention){
  const stripped=stripMentions(text,mention),lines=cleanLines(stripped.text),body=lines.join('\n');
  const verdict=classifyLotResult(lines),invoices=extractInvoices(body),sapNos=extractSapNos(lines);
  const received=body.match(/ยอด\s*([\d,]+)\s*ชิ้น/),sample=body.match(/สุ่ม\s*([\d,]+)\s*ชิ้น/);
  const issues=[];
  if(!invoices.length)issues.push('NO_INVOICE');else if(invoices.length>1)issues.push('MULTIPLE_INVOICE');
  if(!sapNos.length)issues.push('NO_SAP');else if(sapNos.length>1)issues.push('MULTIPLE_SAP');
  if(verdict.result==='UNKNOWN')issues.push('UNKNOWN_RESULT');
  return {
    parser_version:PARSER_VERSION,
    clean_text:body,
    mentions:stripped.mentions,
    mention_warnings:stripped.warnings,
    result:verdict.result,
    result_reason:verdict.reason,
    summary_line:verdict.summary_line,
    invoices,sap_nos:sapNos,
    invoice_no:invoices.length===1?invoices[0]:null,
    sap_no:sapNos.length===1?sapNos[0]:null,
    received_qty:received?num(received[1]):null,
    sample_qty:sample?num(sample[1]):null,
    receipt_date:extractReceiptDate(body),
    defects:extractDefects(lines),
    issues,
    auto_matchable:issues.length===0
  };
}

// Pure decision for one parsed message, given facts the caller looked up in the DB:
//   duplicate      - this LINE message id was already processed
//   invoiceFound   - parsed.invoice_no exists in packing_lists
//   sapInInvoice   - parsed.sap_no exists in that invoice's items (canonicalSap)
//   current        - current qc_results row for invoice+SAP: {result, received_at} or null
//   messageTime    - LINE event.timestamp (ms) or ISO string
// Actions: SKIP_DUPLICATE | NEEDS_REVIEW | CONFIRM_EXISTING (same result already current, write nothing) | APPLY.
// An existing ACCEPT/REJECT is never replaced automatically: a different result always goes to review.
function decideQcAction(parsed,{duplicate=false,invoiceFound=false,sapInInvoice=false,current=null,messageTime=null}={}){
  if(duplicate)return {action:'SKIP_DUPLICATE',reasons:['DUPLICATE_MESSAGE']};
  if(!parsed||!parsed.auto_matchable)return {action:'NEEDS_REVIEW',reasons:parsed?.issues?.length?[...parsed.issues]:['UNPARSEABLE']};
  if(!invoiceFound)return {action:'NEEDS_REVIEW',reasons:['INVOICE_NOT_FOUND']};
  if(!sapInInvoice)return {action:'NEEDS_REVIEW',reasons:['SAP_NOT_IN_INVOICE']};
  const existing=current&&['ACCEPT','REJECT'].includes(current.result)?current:null;
  if(!existing)return {action:'APPLY',reasons:[]};
  if(existing.result===parsed.result)return {action:'CONFIRM_EXISTING',reasons:['SAME_AS_CURRENT']};
  const toMs=v=>typeof v==='number'?v:Date.parse(v),msg=toMs(messageTime),cur=toMs(existing.received_at);
  if(Number.isFinite(msg)&&Number.isFinite(cur)&&msg<cur)return {action:'NEEDS_REVIEW',reasons:['OLDER_THAN_CURRENT','RESULT_CHANGED']};
  return {action:'NEEDS_REVIEW',reasons:['RESULT_CHANGED']};
}

module.exports={PARSER_VERSION,stripMentions,normalizeText,cleanLines,classifyLotResult,parseQcMessage,extractInvoices,extractSapNos,extractReceiptDate,extractDefects,decideQcAction};
