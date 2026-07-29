'use strict';

const {validateProvider}=require('./contracts');

const MESSAGE_ROLES=new Set(['user','assistant']);
const MESSAGE_STATUSES=new Set(['pending','streaming','completed','interrupted','failed']);

function now() { return new Date().toISOString(); }

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value==='string') {
    try {
      const parsed=JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeProposal(row) {
  if (!row) return null;
  return {...row,changes:jsonArray(row.changes),applied_changes:jsonArray(row.applied_changes)};
}

function validateMessageRole(role) {
  if (!MESSAGE_ROLES.has(role)) throw new Error('Message role is invalid');
  return role;
}

function validateMessageStatus(status) {
  if (!MESSAGE_STATUSES.has(status)) throw new Error('Message status is invalid');
  return status;
}

async function one(client,text,params=[]) {
  const result=await client.query(text,params);
  return result.rows[0]||null;
}

function historyLimit(limit) {
  const value=Number(limit);
  if (!Number.isFinite(value)) return 200;
  return Math.max(0,Math.min(200,Math.floor(value)));
}

function createSelectionAiRepository(db) {
  async function ensureConversation(projectId,client=db) {
    const createdAt=now();
    const result=await client.query(
      "INSERT INTO selection_ai_conversations(project_id,created_at,updated_at) VALUES ($1,$2,$2) ON CONFLICT (project_id) DO NOTHING RETURNING *",
      [projectId,createdAt]
    );
    return result.rows[0]||one(client,'SELECT * FROM selection_ai_conversations WHERE project_id=$1',[projectId]);
  }

  async function getState(projectId) {
    const conversation=await ensureConversation(projectId);
    const [messages,proposals]=await Promise.all([
      listRecentMessages(projectId,200),
      db.many('SELECT * FROM selection_ai_proposals WHERE project_id=$1 ORDER BY id ASC',[projectId])
    ]);
    return {conversation,messages,proposals:proposals.map(normalizeProposal)};
  }

  async function setProvider(projectId,provider) {
    validateProvider(provider);
    await ensureConversation(projectId);
    return one(db,'UPDATE selection_ai_conversations SET active_provider=$1,updated_at=$2 WHERE project_id=$3 RETURNING *',[provider,now(),projectId]);
  }

  async function setProviderState(projectId,patch={}) {
    await ensureConversation(projectId);
    const fields=[
      ['codexThreadId','codex_thread_id'],
      ['openaiStateId','openai_state_id']
    ].filter(([key])=>Object.hasOwn(patch,key));
    if (!fields.length) return one(db,'SELECT * FROM selection_ai_conversations WHERE project_id=$1',[projectId]);
    const values=fields.map(([key])=>String(patch[key]??''));
    values.push(now(),projectId);
    const assignments=fields.map(([,column],index)=>`${column}=$${index+1}`);
    assignments.push(`updated_at=$${values.length-1}`);
    return one(db,`UPDATE selection_ai_conversations SET ${assignments.join(',')} WHERE project_id=$${values.length} RETURNING *`,values);
  }

  async function createMessage(input={}) {
    const createdAt=now();
    const role=validateMessageRole(input.role);
    const provider=validateProvider(input.provider);
    const status=validateMessageStatus(input.status??'pending');
    return one(db,
      'INSERT INTO selection_ai_messages(project_id,role,provider,content,status,error_code,error_message,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *',
      [input.projectId,role,provider,String(input.content??''),status,String(input.errorCode??''),String(input.errorMessage??''),createdAt]
    );
  }

  async function updateMessage(id,patch={},client=db) {
    if (Object.hasOwn(patch,'status')) validateMessageStatus(patch.status);
    const fields=[
      ['content','content'],['status','status'],['errorCode','error_code'],['errorMessage','error_message']
    ].filter(([key])=>Object.hasOwn(patch,key));
    if (!fields.length) return one(client,'SELECT * FROM selection_ai_messages WHERE id=$1',[id]);
    const values=fields.map(([key])=>String(patch[key]??''));
    values.push(now(),id);
    const assignments=fields.map(([,column],index)=>`${column}=$${index+1}`);
    assignments.push(`updated_at=$${values.length-1}`);
    return one(client,`UPDATE selection_ai_messages SET ${assignments.join(',')} WHERE id=$${values.length} RETURNING *`,values);
  }

  async function createProposal(input={},client=db) {
    return normalizeProposal(await one(client,
      'INSERT INTO selection_ai_proposals(project_id,message_id,base_document_version,changes,created_at) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *',
      [input.projectId,input.messageId,Number(input.baseDocumentVersion)||0,JSON.stringify(jsonArray(input.changes)),now()]
    ));
  }

  async function resolveProposal(id,status,appliedChanges,client=db) {
    return normalizeProposal(await one(client,
      'UPDATE selection_ai_proposals SET status=$1,applied_changes=$2::jsonb,resolved_at=$3 WHERE id=$4 RETURNING *',
      [String(status),JSON.stringify(jsonArray(appliedChanges)),now(),id]
    ));
  }

  async function clear(projectId) {
    return db.transaction(async(client)=>{
      await client.query('DELETE FROM selection_ai_messages WHERE project_id=$1',[projectId]);
      await client.query('DELETE FROM selection_ai_conversations WHERE project_id=$1',[projectId]);
    });
  }

  async function listRecentMessages(projectId,limit=200) {
    const rows=await db.many(
      'SELECT * FROM selection_ai_messages WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2',
      [projectId,historyLimit(limit)]
    );
    return rows.reverse();
  }

  async function setSummary(projectId,summary) {
    await ensureConversation(projectId);
    return one(db,'UPDATE selection_ai_conversations SET summary=$1,updated_at=$2 WHERE project_id=$3 RETURNING *',[String(summary??''),now(),projectId]);
  }

  return {
    getState,setProvider,setProviderState,createMessage,updateMessage,createProposal,
    resolveProposal,clear,listRecentMessages,setSummary
  };
}

module.exports={createSelectionAiRepository};
