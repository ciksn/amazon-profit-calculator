'use strict';

const {OUTPUT_SCHEMA}=require('../contracts');
const {createStructuredAnswerStream}=require('../structured-stream');

function providerError(code,message) {
  return Object.assign(new Error(message),{code});
}

function createOpenAiProvider({client:providedClient,model:providedModel}={}) {
  let client=null;
  let disposed=false;
  let generatedTurnId=0;
  const activeTurns=new Map();

  function getClient() {
    if (disposed) throw providerError('OPENAI_REQUEST_FAILED','OpenAI Provider has been disposed');
    if (client) return client;
    if (providedClient) {
      client=providedClient;
      return client;
    }
    const apiKey=process.env.OPENAI_API_KEY;
    if (!apiKey) throw providerError('OPENAI_NOT_CONFIGURED','OpenAI API key is not configured on the server');
    const OpenAI=require('openai');
    client=new OpenAI({apiKey});
    return client;
  }

  function getModel() {
    return providedModel||process.env.OPENAI_MODEL||'chat-latest';
  }

  async function health() {
    getClient();
    return {ok:true};
  }

  async function startOrResumeConversation(state={}) {
    getClient();
    return {openai_state_id:state?.openai_state_id||null};
  }

  async function* streamTurn({state={},system='',input='',turnId:requestedTurnId}={}) {
    const sdk=getClient();
    const conversation=await startOrResumeConversation(state);
    const turnId=requestedTurnId||`openai_turn_${++generatedTurnId}`;
    const controller=new AbortController();
    activeTurns.set(turnId,controller);
    const request={
      model:getModel(),
      input:[
        {role:'developer',content:system},
        {role:'user',content:input}
      ],
      text:{
        format:{
          type:'json_schema',
          name:'selection_document_response',
          schema:OUTPUT_SCHEMA,
          strict:true
        }
      },
      stream:true
    };
    if (conversation.openai_state_id) request.previous_response_id=conversation.openai_state_id;

    try {
      const stream=sdk.responses.stream(request,{signal:controller.signal});
      const parser=createStructuredAnswerStream();
      let completedResponse=null;
      for await (const event of stream) {
        if (event.type==='response.output_text.delta') {
          let delta;
          try { delta=parser.push(event.delta); }
          catch { throw providerError('OPENAI_RESPONSE_INVALID','OpenAI returned invalid structured output'); }
          if (delta) yield {type:'text_delta',delta};
        } else if (event.type==='response.completed') {
          completedResponse=event.response;
        }
      }
      const response=typeof stream.finalResponse==='function'
        ? await stream.finalResponse()
        : completedResponse;
      if (!response?.id) throw providerError('OPENAI_RESPONSE_INVALID','OpenAI did not return a response ID');
      let result;
      try { result=parser.finish(); }
      catch { throw providerError('OPENAI_RESPONSE_INVALID','OpenAI returned invalid structured output'); }
      yield {
        type:'completed',
        result,
        providerState:{openai_state_id:response.id}
      };
    } catch (error) {
      if (controller.signal.aborted||error?.name==='AbortError') {
        throw providerError('OPENAI_INTERRUPTED','OpenAI turn was interrupted');
      }
      if (typeof error?.code==='string'&&error.code.startsWith('OPENAI_')) throw error;
      throw providerError('OPENAI_REQUEST_FAILED','OpenAI request failed');
    } finally {
      if (activeTurns.get(turnId)===controller) activeTurns.delete(turnId);
    }
  }

  async function interruptTurn(turnId) {
    const controller=activeTurns.get(turnId);
    if (!controller) throw providerError('OPENAI_TURN_NOT_FOUND','OpenAI turn is not active');
    controller.abort();
    return {status:'interrupted'};
  }

  function dispose() {
    if (disposed) return;
    disposed=true;
    for (const controller of activeTurns.values()) controller.abort();
    activeTurns.clear();
  }

  return {health,startOrResumeConversation,streamTurn,interruptTurn,dispose};
}

module.exports={createOpenAiProvider};
