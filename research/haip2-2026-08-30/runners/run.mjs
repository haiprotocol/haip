import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createPrivateKey,sign} from 'node:crypto';
import {canonicalise} from '@haip/protocol/crypto';
const python=process.env.HAIP_PROBE_PYTHON??'.local/primitive-python/bin/python';
const base='research/haip2-2026-08-30/runners';
const manifest=base+'/rust/Cargo.toml';
execFileSync('cargo',['build','--locked','--quiet','--manifest-path',manifest],{stdio:'inherit'});
const rust=base+'/rust/target/debug/haip-primitive-probe';
const vectors=[null,true,0,-0,42,'a\n€',{z:2,a:1},{'\uE000':1,'😀':2},[0.1,1.5,1e-7,1e-27],{choice:'accept',score:0.1},9007199254740991];
const checks=[];
for(const value of vectors){
 const input=JSON.stringify(value),expected=canonicalise(value);
 for(const [language,program,args] of [['Python',python,[base+'/probe.py','canonical']],['Rust',rust,['canonical']]]){
  const actual=execFileSync(program,args,{input,encoding:'utf8'});if(actual!==expected)throw new Error(language+' canonical mismatch');checks.push({language,input,expected,actual,passed:true});
 }
}
const seed='9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const expected='e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
const key=createPrivateKey({key:Buffer.from('302e020100300506032b657004220420'+seed,'hex'),format:'der',type:'pkcs8'});
for(const [language,actual] of [['Node',sign(null,Buffer.alloc(0),key).toString('hex')],['Python',execFileSync(python,[base+'/probe.py','sign',seed],{input:'',encoding:'utf8'})],['Rust',execFileSync(rust,['sign',seed],{input:'',encoding:'utf8'})]]){
 if(actual!==expected)throw new Error(language+' RFC 8032 mismatch');checks.push({language,vector:'RFC 8032 section 7.1 test 1',expected,actual,passed:true});
}
const result={recorded_at:new Date().toISOString(),node:process.version,python:execFileSync(python,['--version'],{encoding:'utf8'}).trim(),rust:execFileSync('rustc',['--version'],{encoding:'utf8'}).trim(),checks,scope:'Primitive cross-language evidence, not full protocol or Plasm conformance'};
writeFileSync(base+'/results.json',JSON.stringify(result,null,2)+'\n');console.log(`${checks.length} cross-language checks passed`);
