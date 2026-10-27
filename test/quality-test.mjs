import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {ESLint} from 'eslint';
import ts from 'typescript';

const SOURCE=path.resolve(import.meta.dirname,'..'),base=path.join(SOURCE,'dist');fs.mkdirSync(base,{recursive:true});
const ROOT=fs.mkdtempSync(path.join(base,'quality-gate-'));
fs.mkdirSync(path.join(ROOT,'server'));fs.mkdirSync(path.join(ROOT,'public/js'),{recursive:true});
for(const name of ['eslint.config.mjs','tsconfig.json','tsconfig.lint.json','server/path-guard.js','public/js/reconnect.js'])fs.copyFileSync(path.join(SOURCE,name),path.join(ROOT,name));
const lint=new ESLint({cwd:ROOT,overrideConfigFile:path.join(ROOT,'eslint.config.mjs'),ignore:false});
const file=path.join(ROOT,'server/note-store.js'),original=fs.readFileSync(path.join(SOURCE,'server/note-store.js'),'utf8');
try {
// CI 单次类型程序按磁盘建 AST；虚拟追加的 lintText 不能代表真实文件的类型信息。
fs.writeFileSync(file,original+'\nreadDiskNote(".", "fixture.md");\nmissingGateIdentifier();\nconst gateUnusedBinding=1;\n');
const floating=await lint.lintFiles([file]);
assert.ok(floating[0].messages.some(message=>message.ruleId==='@typescript-eslint/no-floating-promises'),JSON.stringify(floating[0].messages));
assert.ok(floating[0].messages.some(message=>message.ruleId==='no-undef'));
assert.ok(floating[0].messages.some(message=>message.ruleId==='no-unused-vars'));
const home=fs.mkdtempSync(path.join(os.tmpdir(),'tracery-type-gate-')),fixture=path.join(home,'fixture.js');
fs.writeFileSync(fixture,'/** @param {number} value */\nfunction square(value){return value*value;}\nsquare("invalid");');
const program=ts.createProgram([fixture],{allowJs:true,checkJs:true,noEmit:true,types:[],skipLibCheck:true,target:ts.ScriptTarget.ES2022});
assert.ok(ts.getPreEmitDiagnostics(program).some(diagnostic=>diagnostic.code===2345));
console.log('PASS 实际 ESLint 配置拒绝遗漏 await/未定义/无用绑定，checkJs 拒绝错误参数类型；未写入或破坏生产源码');
} finally {
  if(!path.resolve(ROOT).startsWith(path.resolve(base)+path.sep))throw Error('静态检查临时目录越界');
  fs.rmSync(ROOT,{recursive:true,force:true});
}
