'use strict';

const crypto=require('node:crypto');

const PREFIX='v1';
const AAD=Buffer.from('margingo:gemini-api-key:v1','utf8');

function decodeMasterKey(value) {
  const text=String(value||'').trim();
  let key;
  try { key=Buffer.from(text,'base64url'); } catch { throw new Error('GEMINI_KEY_ENCRYPTION_KEY 格式不正确'); }
  if(key.length!==32)throw new Error('GEMINI_KEY_ENCRYPTION_KEY 必须是 32 字节 Base64 密钥');
  return key;
}

function encryptGeminiApiKey(apiKey,masterKeyValue) {
  const plain=String(apiKey||'').trim();if(!plain)throw new Error('Gemini API 密钥不能为空');
  const key=decodeMasterKey(masterKeyValue);const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(AAD);const encrypted=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]);const tag=cipher.getAuthTag();
  key.fill(0);return [PREFIX,iv.toString('base64url'),tag.toString('base64url'),encrypted.toString('base64url')].join('.');
}

function decryptGeminiApiKey(value,masterKeyValue) {
  const parts=String(value||'').trim().split('.');if(parts.length!==4||parts[0]!==PREFIX)throw new Error('GEMINI_API_KEY_ENCRYPTED 格式不正确');
  const key=decodeMasterKey(masterKeyValue);
  try {
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(parts[1],'base64url'));
    decipher.setAAD(AAD);decipher.setAuthTag(Buffer.from(parts[2],'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3],'base64url')),decipher.final()]).toString('utf8').trim();
  } catch { throw new Error('Gemini 密钥解密失败，请检查密文和解密主密钥是否匹配'); }
  finally { key.fill(0); }
}

function getGeminiApiKey(env=process.env) {
  if(env.GEMINI_API_KEY){const error=new Error('不允许使用明文 GEMINI_API_KEY，请先运行 npm run encrypt:gemini-key');error.statusCode=503;throw error}
  if(!env.GEMINI_API_KEY_ENCRYPTED){const error=new Error('未配置 GEMINI_API_KEY_ENCRYPTED');error.statusCode=503;throw error}
  if(!env.GEMINI_KEY_ENCRYPTION_KEY){const error=new Error('未注入 GEMINI_KEY_ENCRYPTION_KEY 解密主密钥');error.statusCode=503;throw error}
  try{return decryptGeminiApiKey(env.GEMINI_API_KEY_ENCRYPTED,env.GEMINI_KEY_ENCRYPTION_KEY)}
  catch(error){error.statusCode=503;throw error}
}

module.exports={decodeMasterKey,encryptGeminiApiKey,decryptGeminiApiKey,getGeminiApiKey};
