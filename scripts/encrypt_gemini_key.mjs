import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const {encryptGeminiApiKey}=require('../lib/gemini-secret');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const envFile=path.join(root,'.env');

function hiddenPrompt(label) {
  if(!process.stdin.isTTY||!process.stdin.setRawMode)throw new Error('请在可交互的 PowerShell 终端中运行此命令');
  return new Promise((resolve,reject)=>{
    process.stdout.write(label);process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');let value='';
    const finish=(error)=>{process.stdin.setRawMode(false);process.stdin.pause();process.stdin.off('data',onData);process.stdout.write('\n');error?reject(error):resolve(value)};
    const onData=(chunk)=>{for(const char of chunk){if(char==='\u0003')return finish(new Error('已取消'));if(char==='\r'||char==='\n')return finish();if(char==='\u007f'||char==='\b'){value=value.slice(0,-1);continue}value+=char}};
    process.stdin.on('data',onData);
  });
}

const apiKey=(await hiddenPrompt('请输入 Gemini API 密钥（输入内容不会显示）：')).trim();
if(!apiKey)throw new Error('Gemini API 密钥不能为空');
const existingMaster=String(process.env.GEMINI_KEY_ENCRYPTION_KEY||'').trim();
const masterKey=existingMaster||crypto.randomBytes(32).toString('base64url');
const encrypted=encryptGeminiApiKey(apiKey,masterKey);
let content=fs.existsSync(envFile)?fs.readFileSync(envFile,'utf8'):'';
content=content.split(/\r?\n/).filter((line)=>!/^GEMINI_API_KEY(?:_ENCRYPTED)?=/.test(line.trim())).join('\n').replace(/\s*$/,'');
content+=`${content?'\n':''}GEMINI_API_KEY_ENCRYPTED=${encrypted}\n`;
fs.writeFileSync(envFile,content,'utf8');
process.stdout.write('\n已将加密密文写入 .env。请把下面的解密主密钥保存到密码管理器，并分别注入本机和云服务器的 Secret 环境变量：\n\n');
process.stdout.write(`GEMINI_KEY_ENCRYPTION_KEY=${masterKey}\n\n`);
process.stdout.write('不要把解密主密钥写入 .env、代码或提交到 Git。\n');
