'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createOpenAiProvider}=require('../lib/selection-ai/providers/openai');

function createFakeClient({
  events=[],response={id:'resp_1',status:'completed'},streamError,waitForAbort=false
}={}) {
  const requests=[];
  const options=[];
  const client={
    responses:{
      stream(request,requestOptions={}) {
        requests.push(request);
        options.push(requestOptions);
        if (streamError) throw streamError;
        return {
          async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
            if (waitForAbort) {
              await new Promise((resolve,reject)=>{
                const signal=requestOptions.signal;
                if (signal?.aborted) reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
                else signal?.addEventListener('abort',()=>{
                  reject(Object.assign(new Error('aborted'),{name:'AbortError'}));
                },{once:true});
              });
            }
          },
          async finalResponse() { return response; }
        };
      }
    },
    requests,
    options
  };
  return client;
}

async function collect(iterable) {
  const result=[];
  for await (const event of iterable) result.push(event);
  return result;
}

test('OpenAI Provider streams an exactly completed strict Responses result',async()=>{
  const previousModel=process.env.OPENAI_MODEL;
  delete process.env.OPENAI_MODEL;
  const client=createFakeClient({
    events:[
      {type:'response.output_text.delta',delta:'{"answer":"test the '},
      {type:'response.output_text.delta',delta:'US site","proposal":{"summary":"","changes":[]}}'},
      {type:'response.completed',response:{id:'resp_new',status:'completed'}}
    ],
    response:{id:'resp_new',status:'completed'}
  });
  const provider=createOpenAiProvider({client});

  try {
    const events=await collect(provider.streamTurn({
      state:{openai_state_id:'resp_previous'},system:'rules',input:'data',turnId:'local_1'
    }));
    const request=client.requests[0];
    assert.equal(request.model,'chat-latest');
    assert.equal(request.stream,true);
    assert.equal(request.text.format.type,'json_schema');
    assert.equal(request.text.format.strict,true);
    assert.equal(request.previous_response_id,'resp_previous');
    assert.deepEqual(request.input,[
      {role:'developer',content:'rules'},
      {role:'user',content:'data'}
    ]);
    assert.equal(events.map((event)=>event.delta||'').join(''),'test the US site');
    assert.deepEqual(events.at(-1),{
      type:'completed',
      result:{answer:'test the US site',proposal:{summary:'',changes:[]}},
      providerState:{openai_state_id:'resp_new'}
    });
  } finally {
    provider.dispose();
    if (previousModel===undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL=previousModel;
  }
});

test('OpenAI Provider omits previous_response_id without stored conversation state',async()=>{
  const client=createFakeClient({
    events:[{type:'response.output_text.delta',delta:'{"answer":"ok","proposal":{"summary":"","changes":[]}}'}]
  });
  const provider=createOpenAiProvider({client,model:'gpt-test'});

  await collect(provider.streamTurn({state:{},system:'s',input:'i'}));

  assert.equal(client.requests[0].model,'gpt-test');
  assert.equal(Object.hasOwn(client.requests[0],'previous_response_id'),false);
  provider.dispose();
});

test('OpenAI Provider reports a missing server API key with OPENAI_NOT_CONFIGURED',async()=>{
  const previousKey=process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const provider=createOpenAiProvider();

  try {
    await assert.rejects(provider.health(),(error)=>error.code==='OPENAI_NOT_CONFIGURED');
  } finally {
    provider.dispose();
    if (previousKey===undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY=previousKey;
  }
});

test('OpenAI Provider aborts an active turn and reports interrupted status',async()=>{
  const client=createFakeClient({waitForAbort:true});
  const provider=createOpenAiProvider({client});
  const running=collect(provider.streamTurn({state:{},system:'s',input:'i',turnId:'local_1'}));

  while (!client.requests.length) await new Promise((resolve)=>setImmediate(resolve));
  assert.deepEqual(await provider.interruptTurn('local_1'),{status:'interrupted'});
  await assert.rejects(running,(error)=>error.code==='OPENAI_INTERRUPTED');
  assert.equal(client.options[0].signal.aborted,true);
  provider.dispose();
});

test('OpenAI Provider never trusts an upstream OPENAI_* error code or diagnostic',async()=>{
  const upstream=Object.assign(new Error('Bearer sk-secret failed'),{
    code:'OPENAI_LEAK',
    headers:{authorization:'Bearer sk-secret','x-request-id':'req_private'}
  });
  const client=createFakeClient({streamError:upstream});
  const provider=createOpenAiProvider({client});

  await assert.rejects(collect(provider.streamTurn({state:{},system:'s',input:'i'})),(error)=>{
    assert.equal(error.code,'OPENAI_REQUEST_FAILED');
    assert.equal(error.message.includes('sk-secret'),false);
    assert.equal(error.message.includes('req_private'),false);
    assert.equal(error.message.includes('OPENAI_LEAK'),false);
    return true;
  });
  provider.dispose();
});

test('OpenAI Provider rejects non-completed or absent terminal response states',async(t)=>{
  for (const status of ['failed','incomplete','cancelled',undefined]) {
    await t.test(String(status),async()=>{
      const response={id:`resp_${status||'absent'}`};
      if (status!==undefined) response.status=status;
      const client=createFakeClient({
        events:[{type:'response.output_text.delta',delta:'{"answer":"unsafe","proposal":{"summary":"","changes":[]}}'}],
        response
      });
      const provider=createOpenAiProvider({client});

      await assert.rejects(collect(provider.streamTurn({
        state:{},system:'s',input:'i',turnId:`turn_${status||'absent'}`
      })),(error)=>{
        assert.equal(error.code,'OPENAI_REQUEST_FAILED');
        assert.equal(error.message.includes(String(status)),false);
        return true;
      });
      provider.dispose();
    });
  }
});

test('OpenAI Provider rejects duplicate active public turn IDs without overwriting abort state',async()=>{
  const client=createFakeClient({waitForAbort:true});
  const provider=createOpenAiProvider({client});
  const first=collect(provider.streamTurn({state:{},system:'s',input:'i',turnId:'duplicate'}));
  while (client.requests.length<1) await new Promise((resolve)=>setImmediate(resolve));
  const duplicate=collect(provider.streamTurn({state:{},system:'s',input:'i',turnId:'duplicate'}));
  const duplicateCheck=assert.rejects(duplicate,(error)=>error.code==='OPENAI_TURN_ACTIVE');
  await new Promise((resolve)=>setImmediate(resolve));

  const interrupted=provider.interruptTurn('duplicate');
  await duplicateCheck;
  assert.deepEqual(await interrupted,{status:'interrupted'});
  await assert.rejects(first,(error)=>error.code==='OPENAI_INTERRUPTED');
  assert.equal(client.requests.length,1);
  provider.dispose();
});

test('OpenAI Provider dispose aborts every active turn and clears interrupt bookkeeping',async()=>{
  const client=createFakeClient({waitForAbort:true});
  const provider=createOpenAiProvider({client});
  const first=collect(provider.streamTurn({state:{},system:'s',input:'1',turnId:'turn_1'}));
  const second=collect(provider.streamTurn({state:{},system:'s',input:'2',turnId:'turn_2'}));
  while (client.requests.length<2) await new Promise((resolve)=>setImmediate(resolve));

  provider.dispose();

  await assert.rejects(first,(error)=>error.code==='OPENAI_INTERRUPTED');
  await assert.rejects(second,(error)=>error.code==='OPENAI_INTERRUPTED');
  assert.equal(client.options.every((option)=>option.signal.aborted),true);
  await assert.rejects(provider.interruptTurn('turn_1'),(error)=>error.code==='OPENAI_TURN_NOT_FOUND');
});
