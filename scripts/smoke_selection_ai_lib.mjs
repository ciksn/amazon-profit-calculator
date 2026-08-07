import assert from 'node:assert/strict';
import {randomUUID as cryptoRandomUUID} from 'node:crypto';

function isRecord(value) {
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

export function createSmokeProjectName({now=Date.now,randomUUID=cryptoRandomUUID}={}) {
  return `AI 冒烟测试 ${now()} ${randomUUID()}`;
}

export function validateCodexHealth(health) {
  assert.ok(isRecord(health),'Codex health response must be an object');
  assert.ok(isRecord(health.providers),'Codex health providers must be an object');
  const codex=health.providers.codex;
  assert.ok(isRecord(codex),'Codex health result must be an object');
  assert.equal(typeof codex.ok,'boolean','Codex health ok must be a boolean');
  assert.ok(
    ['ready','not_installed','unavailable'].includes(codex.status),
    `Codex health returned an invalid status: ${String(codex.status)}`
  );
  assert.equal(codex.status,'ready',`Codex health is not ready: ${codex.status}`);
  assert.equal(codex.ok,true,'Codex health ready status must have ok=true');
  return codex;
}

export function codexSmokeTerminalTimeoutMs({
  baseTimeoutMs,
  retryGraceMs,
  transportMarginMs=30_000
}) {
  for (const [name,value] of Object.entries({baseTimeoutMs,retryGraceMs,transportMarginMs})) {
    assert.ok(Number.isFinite(value)&&value>=0,`${name} must be a finite non-negative number`);
  }
  return baseTimeoutMs+retryGraceMs+transportMarginMs;
}

async function exactProjectIds(db,projectName) {
  const rows=await db.many('SELECT id FROM projects WHERE name=$1 ORDER BY id',[projectName]);
  return rows
    .map((row)=>Number(row.id))
    .filter((id)=>Number.isSafeInteger(id)&&id>0);
}

export async function cleanupTemporaryProjects({
  db,
  baseUrl='',
  projectId=null,
  projectName,
  fetchImpl=globalThis.fetch
}) {
  assert.equal(typeof projectName,'string','temporary project name is required for exact cleanup');
  assert.ok(projectName.length>0,'temporary project name is required for exact cleanup');

  const projectIds=new Set(await exactProjectIds(db,projectName));
  const numericProjectId=Number(projectId);
  if (Number.isSafeInteger(numericProjectId)&&numericProjectId>0) projectIds.add(numericProjectId);
  const sortedProjectIds=[...projectIds].sort((left,right)=>left-right);

  for (const id of sortedProjectIds) {
    if (baseUrl&&typeof fetchImpl==='function') {
      try {
        const response=await fetchImpl(`${baseUrl}/api/projects/${id}`,{method:'DELETE'});
        if (!response.ok&&response.status!==404) {
          throw new Error(`temporary project delete returned HTTP ${response.status}`);
        }
      } catch {
        // The database fallback below is authoritative for local smoke cleanup.
      }
    }

    let remaining=await db.one('SELECT COUNT(*)::int AS count FROM projects WHERE id=$1',[id]);
    if (Number(remaining?.count)>0) {
      await db.query('DELETE FROM projects WHERE id=$1',[id]);
      remaining=await db.one('SELECT COUNT(*)::int AS count FROM projects WHERE id=$1',[id]);
    }
    assert.equal(Number(remaining?.count),0,`temporary smoke project ${id} was not deleted`);
  }

  const matchingIds=await exactProjectIds(db,projectName);
  assert.deepEqual(matchingIds,[],'temporary smoke project name still exists after cleanup');
  return {confirmed:true,projectIds:sortedProjectIds};
}

export async function runAllCleanupSteps({primaryError=null,steps=[]}={}) {
  const errors=primaryError?[primaryError]:[];
  for (const [,step] of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length===0) return null;
  if (errors.length===1) return errors[0];
  const primaryMessage=primaryError?.message||'cleanup failed';
  return new AggregateError(errors,`Primary failure: ${primaryMessage}; one or more cleanup steps also failed`,{
    cause:primaryError||errors[0]
  });
}
