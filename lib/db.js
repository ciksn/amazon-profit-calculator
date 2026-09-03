'use strict';

const fs=require('node:fs');
const path=require('node:path');

const DB_SCHEMA='margin';
const MAX_POOL_SIZE=4;
let pool;
let readyPromise;

function createPool(){
  if(process.env.NODE_ENV==='test'&&!process.env.DATABASE_URL){
    const {newDb}=require('pg-mem');
    const memory=newDb({autoCreateForeignKeyIndices:true});
    const adapter=memory.adapters.createPg();
    return new adapter.Pool({max:1});
  }
  if(!process.env.DATABASE_URL)throw new Error('缺少 DATABASE_URL，无法连接 PostgreSQL');
  const {Pool}=require('pg');
  return new Pool({
    connectionString:process.env.DATABASE_URL,
    max:Math.min(MAX_POOL_SIZE,Math.max(1,Number(process.env.PG_POOL_MAX)||MAX_POOL_SIZE)),
    options:`-c search_path=${DB_SCHEMA}`,
    ssl:process.env.PGSSL==='require'?{rejectUnauthorized:false}:undefined
  });
}

function migrationFiles(){
  const directory=path.join(__dirname,'..','migrations');
  return fs.readdirSync(directory).filter((name)=>/^\d+_.+\.sql$/.test(name)).sort();
}

async function runMigrations(client){
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
  await client.query(`SET search_path TO ${DB_SCHEMA}`);
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied=new Set((await client.query('SELECT filename FROM schema_migrations')).rows.map((row)=>row.filename));
  for(const filename of migrationFiles()){
    if(applied.has(filename))continue;
    const sql=fs.readFileSync(path.join(__dirname,'..','migrations',filename),'utf8');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)',[filename]);
  }
}

async function seedRules(client){
  const {rows:[count]}=await client.query('SELECT COUNT(*)::int AS count FROM countries');
  if(count.count)return;
  const rules=JSON.parse(fs.readFileSync(path.join(__dirname,'..','docs','data','rules.json'),'utf8'));
  for(const table of ['countries','commission_rules','size_tiers','fba_rules','freight_rules']){
    for(const row of rules[table]){
      const columns=Object.keys(row);
      const values=columns.map((column)=>table==='countries'&&column==='active'?Boolean(row[column]):row[column]);
      const placeholders=values.map((_,index)=>`$${index+1}`).join(',');
      await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`,values);
    }
  }
  await client.query("INSERT INTO app_meta(key,value) VALUES ('rules_seed_generated_at',$1)",[rules.generatedAt]);
}

async function addTestOwnershipDefaults(client){
  if(process.env.NODE_ENV!=='test')return;
  for(const table of ['projects','project_countries','project_competitors','competitor_review_overviews','site_card_records',
    'selection_documents','selection_site_assessments','selection_suppliers','selection_ai_conversations','selection_ai_messages','selection_ai_proposals']){
    await client.query(`ALTER TABLE ${table} ALTER COLUMN owner_user_id SET DEFAULT 1`);
  }
}

async function initialize(){
  pool||=createPool();
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await runMigrations(client);
    await addTestOwnershipDefaults(client);
    await seedRules(client);
    await client.query('COMMIT');
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client.release();}
}

function ready(){return readyPromise||=initialize();}
async function query(text,params=[]){await ready();return pool.query(text,params);}
async function one(text,params=[]){const result=await query(text,params);return result.rows[0]||null;}
async function many(text,params=[]){return(await query(text,params)).rows;}
async function transaction(callback){
  await ready();
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const result=await callback(client);
    await client.query('COMMIT');
    return result;
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client.release();}
}
async function close(){if(pool){await pool.end();pool=null;readyPromise=null;}}

module.exports={DB_SCHEMA,MAX_POOL_SIZE,ready,query,one,many,transaction,close};
