// Pure-function tests for line-qc-parser.js. No DB, network or env access.
// Run: npm test  (node --test "test/*.test.js")
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const p=require('../line-qc-parser.js');

const HEADER=`4211742 JOJI,SECRET HYA,MAGIC LIP,2.4G,C/B

INV26-CWZ103

ของเข้าวันที่ 12/10/2026 ยอด 20,686 ชิ้น สุ่ม 630 ชิ้น 2เท่าของ AQL

Minor= ขนแปรงประกอบไม่สุด 24 ชิ้น 3.80% *ACCEPT15 ชิ้น* Reject 9ชิ้น แยกชิ้นงานออก

Minor= จุดสี 3 ชิ้น 0.47% ACCEPT

Minor = คราบสกปรก 3 ชิ้น 0.47% Reject แก้ไขทำความสะอาด

Minor= รอยขีด 2 ชิ้น 0.31% ACCEPT`;
const SAMPLE=`${HEADER}

*ACCEPT LOT* @T. Vacation 16-19 @dpployz`;

// Build LINE mention metadata the way LINE does: UTF-16 index/length of each "@name" in the text.
function mentionFor(text,...names){
  let from=0;
  return {mentionees:names.map(n=>{const index=text.indexOf(n,from);if(index<0)throw Error('name not in text: '+n);from=index+n.length;return {index,length:n.length,type:'user',userId:'U'+'0'.repeat(32)}})};
}
const withSummary=summary=>`${HEADER}\n\n${summary}`;
const resultOf=(text,mention)=>p.parseQcMessage(text,mention).result;
const deepFreeze=o=>{if(o&&typeof o==='object'){Object.values(o).forEach(deepFreeze);Object.freeze(o)}return o};

test('sample message with real mention metadata', ()=>{
  const r=p.parseQcMessage(SAMPLE,mentionFor(SAMPLE,'@T. Vacation 16-19','@dpployz'));
  assert.equal(r.result,'ACCEPT');
  assert.equal(r.result_reason,'FINAL_SUMMARY');
  assert.equal(r.summary_line,'*ACCEPT LOT*');
  assert.equal(r.invoice_no,'INV26-CWZ103');
  assert.equal(r.sap_no,'4211742');
  assert.equal(r.received_qty,20686);
  assert.equal(r.sample_qty,630);
  assert.equal(r.receipt_date,'2026-10-12');
  assert.equal(r.defects.length,4);
  assert.deepEqual(r.issues,[]);
  assert.equal(r.auto_matchable,true);
  assert.equal(r.parser_version,p.PARSER_VERSION);
});

test('ACCEPT formats on the final line', async t=>{
  for(const s of ['ACCEPT LOT','Accept Lot','accept lot','ACCEPTLOT','ACCEPT   LOT','*ACCEPT LOT*','_ACCEPT LOT_','~ACCEPT LOT~','✅ ACCEPT LOT',
    'ACC.LOT','acc.lot','ACC. LOT','ACC .LOT','*ACC.LOT*','ผลผ่าน','ผล ผ่าน','*ผลผ่าน*',
    'ACCEPT LOT / ผลผ่าน','ACCEPT LOT/ผลผ่าน','ACC.LOT / ผลผ่าน','ACC. LOT/ผลผ่าน','**ACC.LOT / ผลผ่าน**','ＡＣＣＥＰＴ ＬＯＴ',
    'ACCEPT LOT ✅','ACCEPT LOT.','ACCEPT LOT !!','(ACCEPT LOT)'])
    await t.test(s,()=>assert.equal(resultOf(withSummary(s)),'ACCEPT'));
});

test('REJECT requires the phrase จึงขอทำการ Reject on the final line', async t=>{
  for(const s of ['จึงขอทำการ Reject','จึงขอทำการ reject','จึงขอทำการ REJECT','จึงขอทำการReject','จึง ขอ ทำการ  Reject','*จึงขอทำการ Reject*',
    'พบขนแปรงประกอบไม่สุดเกินเกณฑ์ AQL จึงขอทำการ Reject','Major เกิน AQL 2 ชิ้น จึงขอทำการ Reject','*พบปัญหา จึงขอทำการ Reject*','จึงขอทำการ Reject.',
    'จึงขอท\u0E4D\u0E32การ Reject']) // decomposed SARA AM (NIKHAHIT + SARA AA)
    await t.test(s,()=>assert.equal(resultOf(withSummary(s)),'REJECT'));
});

test('UNKNOWN: summary phrases that are not recognized', async t=>{
  for(const s of ['Reject','REJECT LOT','ขอทำการ Reject','Reject 9 ชิ้น','ACCEPT','ACCEPTED LOT','ACCEPT LOTS','ผลไม่ผ่าน','ไม่ผ่าน',
    'ผลตรวจ ACCEPT LOT','ส่งผล ACC.LOT','OK LOT','LOT ACCEPT'])
    await t.test(s,()=>{const r=p.parseQcMessage(withSummary(s));assert.equal(r.result,'UNKNOWN');assert.equal(r.result_reason,'NO_FINAL_SUMMARY');assert.ok(r.issues.includes('UNKNOWN_RESULT'));assert.equal(r.auto_matchable,false)});
});

test('UNKNOWN when no summary exists (last line is a defect line)', async t=>{
  await t.test('header only',()=>{const r=p.parseQcMessage(HEADER);assert.equal(r.result,'UNKNOWN');assert.equal(r.result_reason,'NO_FINAL_SUMMARY');assert.equal(r.summary_line,'Minor= รอยขีด 2 ชิ้น 0.31% ACCEPT')});
  for(const d of ['Minor= ขนแปรงประกอบไม่สุด 24 ชิ้น 3.80% *ACCEPT15 ชิ้น* Reject 9 ชิ้น แยกชิ้นงานออก','Minor = คราบสกปรก 3 ชิ้น 0.47% Reject แก้ไขทำความสะอาด','Minor= จุดสี 3 ชิ้น 0.47% ACCEPT15 ชิ้น'])
    await t.test('last line: '+d,()=>assert.equal(resultOf(withSummary(d)),'UNKNOWN'));
});

test('UNKNOWN when text appears after the summary (next line)', async t=>{
  for(const tail of ['ขอบคุณค่ะ','รบกวนด้วยนะคะ','OK','@T. Vacation 16-19']) // the last one has no metadata: it is plain text
    await t.test(tail,()=>{const r=p.parseQcMessage(withSummary(`*ACCEPT LOT*\n${tail}`));assert.equal(r.result,'UNKNOWN');assert.equal(r.result_reason,'TEXT_AFTER_SUMMARY')});
  await t.test('reject followed by text',()=>{const r=p.parseQcMessage(withSummary('จึงขอทำการ Reject\nขอบคุณค่ะ'));assert.equal(r.result,'UNKNOWN');assert.equal(r.result_reason,'TEXT_AFTER_SUMMARY')});
});

test('UNKNOWN when arbitrary text follows the summary on the same line', async t=>{
  for(const s of ['ACCEPT LOT ขอบคุณค่ะ','ACC.LOT OK','ACCEPT LOT 2','ACCEPT LOT / ACC.LOT',
    'ผลผ่าน / ACCEPT LOT','*ACCEPT LOT* @T. Vacation 16-19 @dpployz', // @ text without metadata is plain text
    'จึงขอทำการ Reject LOT','Major เกิน AQL จึงขอทำการ Reject แยกงาน',
    // only one polite word from the fixed list, only at the very end; anything else is still trailing text
    'ACCEPT LOT ค่ะ ค่ะ','ACCEPT LOT ครับ OK','ACCEPT LOT นะ','ACCEPT LOT จ้า','ACCEPT LOT ค่ะ ขอบคุณ','จึงขอทำการ Reject ค่ะ LOT',
    'จึงขอทำการ Reject ขอบคุณค่ะ','ผลผ่าน รบกวนด้วยนะคะ','*ACCEPT LOT* @dpployz ค่ะ'])
    await t.test(s,()=>{const r=p.parseQcMessage(withSummary(s));assert.equal(r.result,'UNKNOWN');assert.equal(r.result_reason,'TEXT_AFTER_SUMMARY');assert.equal(r.auto_matchable,false)});
  await t.test('sample without mention metadata -> UNKNOWN',()=>assert.equal(resultOf(SAMPLE),'UNKNOWN'));
});

test('one polite word (ค่ะ คะ ครับ นะคะ นะครับ) may end the final summary', async t=>{
  const cases={'ACCEPT LOT ค่ะ':'ACCEPT','ACC. LOT ครับ':'ACCEPT','ผลผ่าน ค่ะ':'ACCEPT','ผลผ่านค่ะ':'ACCEPT','ACCEPT LOT / ผลผ่าน ครับ':'ACCEPT',
    '*ACCEPT LOT* นะคะ':'ACCEPT','*ACCEPT LOT ค่ะ*':'ACCEPT','Accept Lot. ค่ะ 🙏':'ACCEPT','ACC.LOT นะครับ':'ACCEPT','ACCEPT LOT คะ':'ACCEPT',
    'จึงขอทำการ Reject ค่ะ':'REJECT','Defect เกินเกณฑ์การยอมรับ จึงขอทำการ Reject ค่ะ':'REJECT','จึงขอทำการ Rejectครับ':'REJECT','จึงขอทำการ Reject นะคะ':'REJECT'};
  for(const [s,want] of Object.entries(cases))
    await t.test(s,()=>{const r=p.parseQcMessage(withSummary(s));assert.equal(r.result,want);assert.equal(r.result_reason,'FINAL_SUMMARY');assert.equal(r.auto_matchable,true)});
  await t.test('polite word on its own line after the summary is still text after it',()=>{
    const r=p.parseQcMessage(withSummary('ACCEPT LOT\nค่ะ'));assert.equal(r.result,'UNKNOWN');assert.equal(r.result_reason,'TEXT_AFTER_SUMMARY');
  });
  await t.test('polite word does not hide a conflict',()=>{
    for(const s of ['ACCEPT LOT จึงขอทำการ Reject ค่ะ','จึงขอทำการ Reject\nACCEPT LOT ค่ะ','ACCEPT LOT\nพบปัญหา จึงขอทำการ Reject ครับ'])
      assert.equal(p.parseQcMessage(withSummary(s)).result_reason,'CONFLICTING_SUMMARY',s);
  });
});

test('trailing blank lines and whitespace do not count as text after the summary', ()=>{
  assert.equal(resultOf(withSummary('*ACCEPT LOT*\n\n   \n\u200B\n')),'ACCEPT');
  assert.equal(resultOf(withSummary('*ACCEPT LOT*').replace(/\n/g,'\r\n')),'ACCEPT');
});

test('UNKNOWN when ACCEPT and REJECT summaries conflict', async t=>{
  const cases={
    'same line: accept then reject':'ACCEPT LOT / จึงขอทำการ Reject',
    'same line: reject reason with ACC.LOT first':'ACC.LOT จึงขอทำการ Reject',
    'earlier reject summary, final accept':'จึงขอทำการ Reject\nACCEPT LOT',
    'earlier accept summary, final reject':'ACCEPT LOT\nพบปัญหา จึงขอทำการ Reject',
    'earlier ผลผ่าน, final reject':'ผลผ่าน\nจึงขอทำการ Reject',
    'same line with trailing text':'ACCEPT LOT จึงขอทำการ Reject ค่ะ',
    'earlier reject reason line, final accept':'พบปัญหา จึงขอทำการ Reject แก้ไข\nACCEPT LOT'
  };
  for(const [name,s] of Object.entries(cases))
    await t.test(name,()=>{const r=p.parseQcMessage(withSummary(s));assert.equal(r.result,'UNKNOWN');assert.equal(r.result_reason,'CONFLICTING_SUMMARY')});
  await t.test('repeated same summary is not a conflict',()=>assert.equal(resultOf(withSummary('ACCEPT LOT\nACC.LOT / ผลผ่าน')),'ACCEPT'));
});

test('defect lines with Reject/ACCEPT words never change the LOT result', async t=>{
  const defects=['Minor= ขนแปรงประกอบไม่สุด 24 ชิ้น 3.80% *ACCEPT15 ชิ้น* Reject 9 ชิ้น แยกชิ้นงานออก','Minor = คราบสกปรก 3 ชิ้น 0.47% Reject แก้ไขทำความสะอาด','Major= สีเพี้ยน 5 ชิ้น Reject','Minor= รอยขีด 2 ชิ้น ACCEPT LOT ได้'];
  const body=`4211742 X\nINV26-CWZ103\n${defects.join('\n')}`;
  await t.test('final ACCEPT LOT stays ACCEPT',()=>assert.equal(resultOf(`${body}\n*ACCEPT LOT*`),'ACCEPT'));
  await t.test('final reject phrase stays REJECT',()=>assert.equal(resultOf(`${body}\nจึงขอทำการ Reject`),'REJECT'));
  await t.test('no final summary stays UNKNOWN',()=>assert.equal(resultOf(body),'UNKNOWN'));
  await t.test('sample defect lines are parsed, not classified',()=>{
    const d=p.parseQcMessage(SAMPLE).defects;
    assert.deepEqual(d.map(x=>[x.level,x.quantity,x.percent]),[['MINOR',24,3.8],['MINOR',3,0.47],['MINOR',3,0.47],['MINOR',2,0.31]]);
    assert.match(d[0].detail,/ACCEPT15 ชิ้น\* Reject 9ชิ้น/);
  });
});

test('mentions are removed by metadata only', async t=>{
  const names=['@T. Vacation 16-19','@dpployz','@Ploy 🌸','@น้องเมย์ 💕 QC.2','@J. Smith Jr. 3rd','@👩‍🔬Lab'];
  for(const n of names)
    await t.test('summary line + '+n,()=>{
      const text=withSummary(`*ACCEPT LOT* ${n}`),r=p.parseQcMessage(text,mentionFor(text,n));
      assert.equal(r.result,'ACCEPT');assert.deepEqual(r.mentions,[{display_text:n,type:'user'}]);assert.ok(!r.clean_text.includes(n));assert.deepEqual(r.mention_warnings,[]);
    });
  await t.test('mention-only trailing line with metadata is dropped, summary stays final',()=>{
    const text=withSummary('*ACCEPT LOT*\n@T. Vacation 16-19 @Ploy 🌸'),r=p.parseQcMessage(text,mentionFor(text,'@T. Vacation 16-19','@Ploy 🌸'));
    assert.equal(r.result,'ACCEPT');assert.equal(r.mentions.length,2);
  });
  await t.test('emoji before the mention shifts UTF-16 offsets correctly',()=>{
    const text=withSummary('🔥🔥 *ACCEPT LOT* @Ploy 🌸 @dpployz'),r=p.parseQcMessage(text,mentionFor(text,'@Ploy 🌸','@dpployz'));
    assert.equal(r.result,'ACCEPT');assert.equal(r.mentions.length,2);assert.ok(!r.clean_text.includes('@'));
  });
  await t.test('mention in the middle of text keeps surrounding text',()=>{
    const text=withSummary('ฝาก @dpployz ตรวจ\n*ACCEPT LOT*'),r=p.parseQcMessage(text,mentionFor(text,'@dpployz'));
    assert.ok(r.clean_text.includes('ฝาก ตรวจ'));assert.equal(r.result,'ACCEPT');
  });
  await t.test('@all mention keeps type all',()=>{
    const text=withSummary('*ACCEPT LOT* @All'),i=text.indexOf('@All'),r=p.parseQcMessage(text,{mentionees:[{index:i,length:4,type:'all'}]});
    assert.deepEqual(r.mentions,[{display_text:'@All',type:'all'}]);
  });
  await t.test('numbers inside a mention are not read as data',()=>{
    const text=`@QC 4211743 ทีม\n${SAMPLE}`,r=p.parseQcMessage(text,mentionFor(text,'@QC 4211743 ทีม','@T. Vacation 16-19','@dpployz'));
    assert.deepEqual(r.sap_nos,['4211742']);assert.equal(r.result,'ACCEPT');
  });
  await t.test('without metadata no @ text is removed',()=>{
    const r=p.parseQcMessage(SAMPLE);
    assert.ok(r.clean_text.includes('@T. Vacation 16-19 @dpployz'));assert.deepEqual(r.mentions,[]);
    assert.equal(r.result,'UNKNOWN','unremoved @ text is arbitrary trailing text');assert.equal(r.result_reason,'TEXT_AFTER_SUMMARY');
  });
});

// Real LINE webhook message shape (captured 2026-11-01): keys id,markAsReadToken,quoteToken,text,type; `mention` only
// when the text holds a real mention. LINE's docs do not say whether index/length count UTF-16 units or code points,
// so both encodings are tested. IDs/tokens below are fake.
const REAL_QC=`42711909 SRP,MATTE,L-CUSH,02MM,10G,GB R3 (25H)
LOT INV26-CWZ111
ของเข้าวันที่ 29/10/2026 ยอด 63494 ชิ้น  สุ่ม 500
Minor= สีไม่ตรง STD  474  ชิ้น   97.8%   ACCEPT
Minor=จุดสี 26 ชิ้น 5.2% ACCEPT
ACCEPT LOT`;
const cpLen=s=>[...s].length;
// unit 'utf16' (JS string indexes) or 'cp' (Unicode code points)
function realMessage(text,names,unit='utf16'){
  let from=0;
  const mentionees=names.map((n,i)=>{const at=text.indexOf(n,from);if(at<0)throw Error('name not in text: '+n);from=at+n.length;
    const index=unit==='cp'?cpLen(text.slice(0,at)):at,length=unit==='cp'?cpLen(n):n.length;
    return {index,length,userId:'U'+String(i).repeat(32),type:'user',isSelf:false}});
  return {type:'text',id:'600000000000000001',quoteToken:'q'.repeat(20),markAsReadToken:'m'.repeat(20),text,...(names.length?{mention:{mentionees}}:{})};
}
const parseReal=msg=>p.parseQcMessage(msg.text,msg.mention);

test('real LINE payload: mentions after the summary', async t=>{
  await t.test('observed payload without mention key (pasted/forwarded @names) stays UNKNOWN, text untouched',()=>{
    const text=`${REAL_QC}\n@tantannus ✨ @PCM12_Parn`,r=parseReal(realMessage(text,[]));
    assert.equal(r.result,'UNKNOWN');assert.equal(r.result_reason,'TEXT_AFTER_SUMMARY');assert.ok(r.clean_text.endsWith('@tantannus ✨ @PCM12_Parn'));
    assert.deepEqual(r.mentions,[]);assert.deepEqual(r.mention_warnings,[]);
  });
  for(const unit of ['utf16','cp']){
    await t.test(`${unit}: Thai text + emoji display name, two mentions on the last line`,()=>{
      const text=`${REAL_QC}\n@tantannus ✨ @PCM12_Parn`,r=parseReal(realMessage(text,['@tantannus ✨','@PCM12_Parn'],unit));
      assert.equal(r.result,'ACCEPT');assert.equal(r.sap_no,'42711909');assert.equal(r.invoice_no,'INV26-CWZ111');
      assert.deepEqual(r.mentions.map(m=>m.display_text),['@tantannus ✨','@PCM12_Parn']);assert.deepEqual(r.mention_warnings,[]);
      assert.ok(!r.clean_text.includes('@'));assert.ok(r.clean_text.startsWith('42711909 SRP'));
    });
    await t.test(`${unit}: astral emoji before and inside mentions, mention at the very end`,()=>{
      const text=`🔥😀 ${REAL_QC} 👍🏻\nฝาก @น้องเมย์ 💕 QC.2 ตรวจ\n${'ACCEPT LOT'} @👩‍🔬Lab @Ploy 🌸`;
      const r=parseReal(realMessage(text,['@น้องเมย์ 💕 QC.2','@👩‍🔬Lab','@Ploy 🌸'],unit));
      assert.equal(r.result,'ACCEPT');assert.equal(r.mentions.length,3);assert.deepEqual(r.mention_warnings,[]);
      assert.ok(r.clean_text.includes('ฝาก ตรวจ'),'text around a mid-line mention is kept');assert.ok(r.clean_text.includes('👍🏻'));
    });
    await t.test(`${unit}: Accept Lot. on its own line then @names, three mentions incl. short name`,()=>{
      const text=`${REAL_QC.replace('ACCEPT LOT','Accept Lot.')}\n@Maythanol @T. @dpployz`,r=parseReal(realMessage(text,['@Maythanol','@T.','@dpployz'],unit));
      assert.equal(r.result,'ACCEPT');assert.equal(r.summary_line,'Accept Lot.');assert.equal(r.mentions.length,3);
    });
  }
  await t.test('reject summary with mentions keeps REJECT',()=>{
    const text=`${REAL_QC.replace('ACCEPT LOT','สีไม่ตรงเกินเกณฑ์ จึงขอทำการ Reject')} @PCM12_Parn 😀`,r=parseReal(realMessage(text,['@PCM12_Parn'],'cp'));
    assert.equal(r.result,'REJECT');
  });
});

// Real LINE payloads captured 2026-11-01 16:21/16:23 (+07) with mentions chosen from LINE's mention picker. Text,
// index and length are exactly as received: one mentionee each, index 348, length 12 and 15, UTF-16 units (the 🐯
// name proves it: 15 code points would also swallow the trailing space). The personal display name is replaced by a
// synthetic one of the same UTF-16 length that keeps ♡🐯; userId/isSelf are fake. Both first went to review because
// "ค่ะ" after "จึงขอทำการ Reject" was not allowed; the mention itself was always removed correctly.
const PICKER_BODY="4210597 ICT,EMPTY PLASTIC,NATURAL,D12*H12.8,PLUG\nLOT INV26-CWZ103\nของเข้าวันที่ 12/10/2026 ยอด  20,686  ชิ้น สุ่ม 315  ชิ้น \nMinor=  สีไม่ตรง std.267  ชิ้น 84.76%  ` *ACCEPT`*\nMinor= พลาสติกยื่น 32 ชิ้น 10.1% ` `REJECT`\nMinor=คราบสกปรก  9  ชิ้น 2.85% `REJECT`  \nMinor= จุดสี  7 ชิ้น 2.22% *ACCEPT`* \nDefect เกินเกณฑ์การยอมรับ จึงขอทำการ Reject ค่ะ ";
const pickerMessage=(name,body=PICKER_BODY)=>({type:'text',id:'600000000000000002',quoteToken:'q'.repeat(20),markAsReadToken:'m'.repeat(20),
  text:`${body}${name} `,mention:{mentionees:[{index:body.length,length:name.length,userId:'U'+'1'.repeat(32),type:'user',isSelf:false}]}});

test('real LINE mention-picker payloads', async t=>{
  await t.test('fixture matches the captured offsets',()=>{
    assert.equal(PICKER_BODY.length,348);
    assert.deepEqual(pickerMessage('@PLM QC Test').mention.mentionees.map(m=>[m.index,m.length]),[[348,12]]);
    assert.deepEqual(pickerMessage('@ทดสอบ_คิวซี♡🐯').mention.mentionees.map(m=>[m.index,m.length]),[[348,15]]);
  });
  for(const name of ['@PLM QC Test','@ทดสอบ_คิวซี♡🐯']){
    await t.test(`${name}: mention is removed exactly (UTF-16), no warnings`,()=>{
      const r=parseReal(pickerMessage(name));
      assert.deepEqual(r.mentions,[{display_text:name,type:'user'}]);assert.deepEqual(r.mention_warnings,[]);
      assert.ok(!r.clean_text.includes('@'));assert.ok(r.clean_text.endsWith('จึงขอทำการ Reject ค่ะ'));
      assert.equal(r.invoice_no,'INV26-CWZ103');assert.equal(r.sap_no,'4210597');
    });
    await t.test(`${name}: "จึงขอทำการ Reject ค่ะ" is an auto-matchable REJECT`,()=>{
      const r=parseReal(pickerMessage(name));
      assert.equal(r.result,'REJECT');assert.equal(r.result_reason,'FINAL_SUMMARY');assert.deepEqual(r.issues,[]);assert.equal(r.auto_matchable,true);
    });
    await t.test(`${name}: same payload without "ค่ะ" is an auto-matchable REJECT`,()=>{
      const r=parseReal(pickerMessage(name,PICKER_BODY.replace('Reject ค่ะ ','Reject ')));
      assert.equal(r.result,'REJECT');assert.equal(r.auto_matchable,true);assert.deepEqual(r.mention_warnings,[]);
    });
  }
  await t.test('same text without mention metadata keeps the @name and stays in review',()=>{
    const {text}=pickerMessage('@PLM QC Test',PICKER_BODY.replace('Reject ค่ะ ','Reject ')),r=p.parseQcMessage(text);
    assert.equal(r.result,'UNKNOWN');assert.ok(r.clean_text.endsWith('@PLM QC Test'));assert.deepEqual(r.mentions,[]);
  });
});

test('mention offset encoding is never mixed or guessed', async t=>{
  const text=`😀 ${REAL_QC}\n@tantannus ✨ @PCM12_Parn`,u=realMessage(text,['@tantannus ✨','@PCM12_Parn']).mention,c=realMessage(text,['@tantannus ✨','@PCM12_Parn'],'cp').mention;
  await t.test('code-point offsets differ from UTF-16 here (sanity)',()=>assert.notEqual(u.mentionees[0].index,c.mentionees[0].index));
  await t.test('one mentionee in each encoding -> nothing removed under the other encoding',()=>{
    const r=p.parseQcMessage(text,{mentionees:[u.mentionees[0],c.mentionees[1]]});
    assert.equal(r.result,'UNKNOWN');assert.ok(r.mention_warnings.includes('MENTION_TEXT_MISMATCH'));
    assert.ok(r.clean_text.includes('@PCM12_Parn')||r.clean_text.includes('@tantannus ✨'),'the unresolved mention stays in the text');
    assert.ok(r.clean_text.includes('ACCEPT LOT'));
  });
  await t.test('range must not cross a line break',()=>{
    const s=`${REAL_QC.replace(/ACCEPT LOT$/,'@Parn')}\nACCEPT LOT`,at=s.indexOf('@Parn'),r=p.parseQcMessage(s,{mentionees:[{index:at,length:'@Parn\nACCEPT LOT'.length,type:'user'}]});
    assert.ok(r.mention_warnings.includes('MENTION_TEXT_MISMATCH'));assert.deepEqual(r.mentions,[]);assert.ok(r.clean_text.endsWith('ACCEPT LOT'));
  });
  await t.test('code-point reading is used only when every mentionee validates under it',()=>{
    const bad={mentionees:[c.mentionees[0],{...c.mentionees[1],index:c.mentionees[1].index-1}]};
    const r=p.parseQcMessage(text,bad);assert.equal(r.result,'UNKNOWN');assert.ok(r.clean_text.includes('@PCM12_Parn'));
  });
});

test('mention output never contains user ids (privacy)', ()=>{
  const r=p.parseQcMessage(SAMPLE,mentionFor(SAMPLE,'@T. Vacation 16-19','@dpployz'));
  for(const m of r.mentions)assert.deepEqual(Object.keys(m).sort(),['display_text','type']);
  assert.ok(!JSON.stringify(r).includes('U'+'0'.repeat(32)));
});

test('invalid mention metadata never removes the wrong text', async t=>{
  const text=withSummary('*ACCEPT LOT* @dpployz'),at=text.indexOf('@dpployz'),acc=text.indexOf('*ACCEPT LOT*');
  const cases={
    'index past end':[{index:text.length+5,length:3},'MENTION_OUT_OF_RANGE'],
    'range overruns end':[{index:at,length:100},'MENTION_OUT_OF_RANGE'],
    'negative index':[{index:-1,length:3},'MENTION_OUT_OF_RANGE'],
    'zero length':[{index:at,length:0},'MENTION_OUT_OF_RANGE'],
    'non-integer index':[{index:at+0.5,length:3},'MENTION_OUT_OF_RANGE'],
    'string index':[{index:String(at),length:8},'MENTION_OUT_OF_RANGE'],
    'missing fields':[{},'MENTION_OUT_OF_RANGE'],
    'points at the summary, not @':[{index:acc,length:12},'MENTION_TEXT_MISMATCH'],
    'off by one (code-point offsets)':[{index:at-1,length:8},'MENTION_TEXT_MISMATCH']
  };
  for(const [name,[m,warning]] of Object.entries(cases))
    await t.test(name,()=>{
      const r=p.parseQcMessage(text,{mentionees:[m]});
      assert.ok(r.clean_text.includes('*ACCEPT LOT* @dpployz'),'text must be untouched');
      assert.deepEqual(r.mentions,[]);assert.ok(r.mention_warnings.includes(warning));
      assert.equal(r.result,'UNKNOWN','mention not removed -> trailing text -> manual review');
    });
  await t.test('overlapping ranges: only the first is removed',()=>{
    const r=p.parseQcMessage(text,{mentionees:[{index:at,length:8},{index:at+2,length:3}]});
    assert.equal(r.mentions.length,1);assert.ok(r.mention_warnings.includes('MENTION_OVERLAP'));assert.equal(r.result,'ACCEPT');
  });
  await t.test('partial range that starts with @ only removes that range',()=>{
    const s=withSummary('*ACCEPT LOT*\n@T. Vacation 16-19'),i=s.indexOf('@T.'),r=p.parseQcMessage(s,{mentionees:[{index:i,length:3}]});
    assert.equal(r.result,'UNKNOWN','leftover "Vacation 16-19" is text after the summary');
  });
  await t.test('garbage mention objects are ignored',()=>{
    for(const m of [null,undefined,'x',42,{mentionees:null},{mentionees:'x'},{mentionees:[null,7,'a']}])
      {const r=p.parseQcMessage(text,m);assert.equal(r.result,'UNKNOWN');assert.ok(r.clean_text.includes('*ACCEPT LOT* @dpployz'))}
  });
  await t.test('mentionees given out of order are handled',()=>{
    const s=withSummary('*ACCEPT LOT* @a1 @b2'),m=mentionFor(s,'@a1','@b2');m.mentionees.reverse();
    const r=p.parseQcMessage(s,m);assert.deepEqual(r.mentions.map(x=>x.display_text),['@a1','@b2']);assert.equal(r.result,'ACCEPT');
  });
});

test('Invoice extraction', async t=>{
  await t.test('normalizes spacing/case',()=>{for(const s of ['INV26-CWZ103','inv26-cwz103','INV26 CWZ103','INV26CWZ103','INV 26-CWZ103','Invoice: INV26-CWZ103','INV26-CWZ103ค่ะ'])assert.deepEqual(p.extractInvoices(s),['INV26-CWZ103'],s)});
  await t.test('same invoice twice counts once',()=>{const r=p.parseQcMessage(`4211742 X\nINV26-CWZ103\nINV26-CWZ103\nACCEPT LOT`);assert.equal(r.invoice_no,'INV26-CWZ103');assert.deepEqual(r.issues,[])});
  await t.test('multiple invoices -> review',()=>{const r=p.parseQcMessage(`4211742 X\nINV26-CWZ103 / INV26-CWZ107\nACCEPT LOT`);assert.equal(r.invoice_no,null);assert.deepEqual(r.invoices,['INV26-CWZ103','INV26-CWZ107']);assert.deepEqual(r.issues,['MULTIPLE_INVOICE']);assert.equal(r.auto_matchable,false)});
  await t.test('missing invoice -> review',()=>{const r=p.parseQcMessage(`4211742 X\nACCEPT LOT`);assert.equal(r.invoice_no,null);assert.deepEqual(r.issues,['NO_INVOICE'])});
});

test('SAP NO. extraction', async t=>{
  const sap=text=>p.parseQcMessage(text).sap_nos;
  await t.test('leading number variants',()=>{for(const s of ['4211742 JOJI','4211742,JOJI','4211742, JOJI','4211742-1 JOJI','4211742','4211742 '])assert.deepEqual(sap(s),['4211742'],s)});
  await t.test('labelled SAP NO',()=>{assert.deepEqual(sap('SAP NO: 4211742'),['4211742']);assert.deepEqual(sap('สินค้า SAP No.4211742'),['4211742'])});
  await t.test('same SAP with and without -1 counts once',()=>assert.deepEqual(sap('4211742 X\nSAP NO: 4211742-1'),['4211742']));
  await t.test('not SAP: quantities, dates, decimals, short numbers',()=>{for(const s of ['20,686 ชิ้น','630 ชิ้น','12/10/2026 ของเข้า','123456,789 ชิ้น','1234567.5 kg','12345 X','ยอด 4211742 ชิ้น'])assert.deepEqual(sap(s),[],s)});
  await t.test('multiple SAP on first line -> review',()=>{for(const s of ['4211742/4211743 X','4211742 / 4211743 X','4211742,4211743 X','4211742 & 4211743 X']){const r=p.parseQcMessage(`${s}\nINV26-CWZ103\nACCEPT LOT`);assert.deepEqual(r.sap_nos,['4211742','4211743'],s);assert.equal(r.sap_no,null);assert.deepEqual(r.issues,['MULTIPLE_SAP'])}});
  await t.test('second LOT block in the same message -> review',()=>{const r=p.parseQcMessage(`4211742 A\nINV26-CWZ103\nACCEPT LOT\n4211743 B\nINV26-CWZ103\nACCEPT LOT`);assert.deepEqual(r.issues,['MULTIPLE_SAP'])});
  await t.test('missing SAP -> review',()=>{const r=p.parseQcMessage(`JOJI\nINV26-CWZ103\nACCEPT LOT`);assert.equal(r.sap_no,null);assert.deepEqual(r.issues,['NO_SAP'])});
});

test('missing required information combines issues', async t=>{
  await t.test('empty / whitespace / null',()=>{for(const s of ['','   \n\n',null,undefined]){const r=p.parseQcMessage(s);assert.equal(r.result,'UNKNOWN');assert.equal(r.result_reason,'EMPTY_MESSAGE');assert.deepEqual(r.issues,['NO_INVOICE','NO_SAP','UNKNOWN_RESULT']);assert.equal(r.auto_matchable,false)}});
  await t.test('summary only',()=>assert.deepEqual(p.parseQcMessage('ACCEPT LOT').issues,['NO_INVOICE','NO_SAP']));
  await t.test('invoice + SAP but no summary',()=>assert.deepEqual(p.parseQcMessage(HEADER).issues,['UNKNOWN_RESULT']));
  await t.test('everything multiple and unknown',()=>assert.deepEqual(p.parseQcMessage('4211742/4211743 X\nINV26-CWZ103 INV26-CWZ107\nขอบคุณ').issues,['MULTIPLE_INVOICE','MULTIPLE_SAP','UNKNOWN_RESULT']));
});

test('quantities and receipt date', async t=>{
  await t.test('missing values are null',()=>{const r=p.parseQcMessage('4211742 X\nINV26-CWZ103\nACCEPT LOT');assert.equal(r.received_qty,null);assert.equal(r.sample_qty,null);assert.equal(r.receipt_date,null);assert.deepEqual(r.defects,[])});
  await t.test('Buddhist year',()=>assert.equal(p.extractReceiptDate('ของเข้าวันที่ 12/10/2569'),'2026-10-12'));
  await t.test('other separators',()=>{assert.equal(p.extractReceiptDate('ของเข้า 1.2.2026'),'2026-02-01');assert.equal(p.extractReceiptDate('ของเข้าวันที่ 01-02-2026'),'2026-02-01')});
  await t.test('impossible date is null',()=>{assert.equal(p.extractReceiptDate('ของเข้าวันที่ 31/02/2026'),null);assert.equal(p.extractReceiptDate('ของเข้าวันที่ 12/13/2026'),null)});
  await t.test('date not after ของเข้า is ignored',()=>assert.equal(p.extractReceiptDate('วันที่ 12/10/2026'),null));
});

test('duplicate messages: parsing is deterministic and does not mutate input', ()=>{
  const m=deepFreeze(mentionFor(SAMPLE,'@T. Vacation 16-19','@dpployz'));
  const a=p.parseQcMessage(SAMPLE,m),b=p.parseQcMessage(SAMPLE,m);
  assert.deepEqual(a,b);
  assert.equal(m.mentionees[0].userId,'U'+'0'.repeat(32));
});

test('decideQcAction: duplicates, missing data and conflicting results', async t=>{
  const ok=p.parseQcMessage(SAMPLE,mentionFor(SAMPLE,'@T. Vacation 16-19','@dpployz')); // ACCEPT
  const rej=p.parseQcMessage(withSummary('จึงขอทำการ Reject'));
  const found={invoiceFound:true,sapInInvoice:true};
  const T=Date.parse('2026-10-27T02:33:18.323Z');
  await t.test('duplicate message id is skipped before anything else',()=>{
    assert.deepEqual(p.decideQcAction(ok,{...found,duplicate:true}),{action:'SKIP_DUPLICATE',reasons:['DUPLICATE_MESSAGE']});
    assert.equal(p.decideQcAction(p.parseQcMessage(''),{duplicate:true}).action,'SKIP_DUPLICATE');
  });
  await t.test('parse issues -> review with the same reasons',()=>{
    const r=p.decideQcAction(p.parseQcMessage(HEADER),found);assert.equal(r.action,'NEEDS_REVIEW');assert.deepEqual(r.reasons,['UNKNOWN_RESULT']);
    assert.deepEqual(p.decideQcAction(null,found),{action:'NEEDS_REVIEW',reasons:['UNPARSEABLE']});
  });
  await t.test('invoice not in DB / SAP not in invoice -> review',()=>{
    assert.deepEqual(p.decideQcAction(ok,{invoiceFound:false,sapInInvoice:false}).reasons,['INVOICE_NOT_FOUND']);
    assert.deepEqual(p.decideQcAction(ok,{invoiceFound:true,sapInInvoice:false}).reasons,['SAP_NOT_IN_INVOICE']);
    assert.equal(p.decideQcAction(ok).action,'NEEDS_REVIEW','defaults are safe');
  });
  await t.test('no current result -> APPLY',()=>{
    assert.equal(p.decideQcAction(ok,found).action,'APPLY');
    assert.equal(p.decideQcAction(rej,found).action,'APPLY');
    assert.equal(p.decideQcAction(ok,{...found,current:{result:'PENDING',received_at:'2026-10-27T02:33:18.323Z'}}).action,'APPLY','legacy PENDING row is not a decided result');
  });
  await t.test('UNKNOWN never overwrites an existing result',()=>{
    const unk=p.parseQcMessage(HEADER);
    for(const result of ['ACCEPT','REJECT'])assert.equal(p.decideQcAction(unk,{...found,current:{result,received_at:'2026-10-27T02:33:18.323Z'},messageTime:T+1e9}).action,'NEEDS_REVIEW');
  });
  await t.test('same result as current -> CONFIRM_EXISTING (no write)',()=>{
    assert.deepEqual(p.decideQcAction(ok,{...found,current:{result:'ACCEPT',received_at:'2026-10-27T02:33:18.323Z'},messageTime:T+1000}),{action:'CONFIRM_EXISTING',reasons:['SAME_AS_CURRENT']});
    assert.equal(p.decideQcAction(ok,{...found,current:{result:'ACCEPT',received_at:'2026-10-27T02:33:18.323Z'},messageTime:T-1000}).action,'CONFIRM_EXISTING');
  });
  await t.test('newer message with a different result -> review, never replace',()=>{
    assert.deepEqual(p.decideQcAction(rej,{...found,current:{result:'ACCEPT',received_at:'2026-10-27T02:33:18.323Z'},messageTime:T+1000}),{action:'NEEDS_REVIEW',reasons:['RESULT_CHANGED']});
    assert.deepEqual(p.decideQcAction(ok,{...found,current:{result:'REJECT',received_at:'2026-10-27T02:33:18.323Z'},messageTime:T+1000}).reasons,['RESULT_CHANGED']);
  });
  await t.test('older message with a different result -> review and flagged older',()=>{
    assert.deepEqual(p.decideQcAction(rej,{...found,current:{result:'ACCEPT',received_at:'2026-10-27T02:33:18.323Z'},messageTime:T-1000}).reasons,['OLDER_THAN_CURRENT','RESULT_CHANGED']);
    assert.deepEqual(p.decideQcAction(rej,{...found,current:{result:'ACCEPT',received_at:'2026-10-27T02:33:18.323Z'},messageTime:'2026-10-01T00:00:00Z'}).reasons,['OLDER_THAN_CURRENT','RESULT_CHANGED']);
  });
  await t.test('unparseable timestamps still go to review on change',()=>{
    assert.deepEqual(p.decideQcAction(rej,{...found,current:{result:'ACCEPT',received_at:'garbage'},messageTime:null}).reasons,['RESULT_CHANGED']);
  });
});
