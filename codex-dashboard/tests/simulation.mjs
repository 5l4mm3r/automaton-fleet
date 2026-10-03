import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source = fs.readFileSync(fileURLToPath(new URL('../src/app/page.tsx', import.meta.url)),'utf8').split('const pages =')[0] + '\nexport { initialFleet, evolve, pence };';
const compiled = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const mod = {exports:{}};
new Function('exports','module',compiled)(mod.exports,mod);
const {initialFleet,evolve,pence}=mod.exports;
let s=initialFleet(), count=0;
function run(op,args={}){s=evolve(s,{id:`test-${++count}`,op,args});}
function total(){return s.treasury+s.agents.reduce((a,x)=>a+x.cash,0)+s.births.filter(x=>x.status==='queued').reduce((a,x)=>a+x.funding,0);}
assert.equal(pence('12.34'),1234); assert.throws(()=>pence('1.001'));assert.throws(()=>pence('-1'));assert.throws(()=>pence('Infinity'));
let before=total();run('fund',{agentId:'A-001',amount:'123.45',reason:'test'});assert.equal(total(),before);
before=total();run('transfer',{agentId:'A-001',target:'A-002',amount:'50',reason:'test'});assert.equal(total(),before);
before=total();run('birth',{name:'New operative',role:'Research',amount:'100'});assert.equal(total(),before);
run('provision',{birthId:s.births[0].id});assert.equal(total(),before);assert.throws(()=>run('provision',{birthId:s.births[0].id}));
before=total();run('kill',{agentId:'A-001',reason:'test'});assert.equal(total(),before);assert.equal(s.missions[0].status,'ended');assert(s.estates.some(x=>x.owner==='Atlas'));
assert.throws(()=>run('fund',{agentId:'A-001',amount:'100',reason:'test'}));
const stable=JSON.stringify(s);assert.throws(()=>run('withdraw',{amount:'99999999',reason:'test'}));assert.equal(JSON.stringify(s),stable);
const command={id:'duplicate',op:'topup',args:{amount:'10'}};s=evolve(s,command);const once=s.treasury;s=evolve(s,command);assert.equal(s.treasury,once);
run('mission',{agentId:'A-002',role:'Marketing',brief:'test mission'});run('mission_end',{missionId:s.missions[0].id,outcome:'Complete'});assert.equal(s.missions[0].status,'completed');
run('document',{name:'proof'});run('consent',{purpose:'fictional'});run('consent_revoke',{consentId:s.consents.at(-1).id});assert.equal(s.consents.at(-1).active,false);
run('scenario',{kind:'RED'});assert.equal(s.notices[0].level,'RED');run('ack',{noticeId:s.notices[0].id});assert.equal(s.notices[0].acknowledged,true);
run('logout');assert.equal(s.sessions[0].active,false);run('login');assert.equal(s.sessions[0].active,true);
console.log('PASS: amount parsing, balance conservation, birth/estate lifecycle, duplicate protection, failure atomicity, missions, identity, alerts and session simulation.');

