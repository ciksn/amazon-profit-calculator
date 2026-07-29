'use strict';

(function selectionAiModule(root){
  const CACHE_KEY='margingo-selection-ai-v1';
  const EMPTY_CACHE=()=>({messages:[],proposals:[]});
  const QUICK_PROMPTS={
    chapter:'分析当前章节，给出关键判断、证据、风险和下一步建议。',
    summary:'总结当前品类的机会、主要风险与待验证事项。',
    risks:'检查当前品类的认证、专利、利润、供应链和市场风险。',
    differentiation:'生成可执行的差异化建议，并说明依据与优先级。'
  };
  const FIELD_LABELS={
    positioning:'产品定位',use_scenarios:'使用场景',competitive_points:'核心竞争点',
    differentiation_items:'差异化方案',review_issues:'差评问题',overview_summary:'概览结论',
    competitor_summary:'竞品结论',supplier_summary:'供应商结论',patent_notes:'专利风险笔记',
    decision_reason:'决策理由',checklist:'最终自查',new_product_friendliness:'新品友好度',
    same_product_performance:'同款表现',opportunity_status:'机会判断',opportunity_notes:'站点结论',
    certification_required:'认证要求',certification_actual:'实际认证需求',
    supplier_certifications:'厂家已有认证',certification_gap:'认证缺口',payback_period:'费用回本周期'
  };

  function createSseParser(onEvent) {
    const decoder=new TextDecoder();
    let buffer='';
    function dispatch(block) {
      let type='message';
      const data=[];
      for (const line of block.replace(/\r\n?/g,'\n').split('\n')) {
        if (line.startsWith('event:')) type=line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /,''));
      }
      if (!data.length) return;
      onEvent(type,JSON.parse(data.join('\n')));
    }
    function drain(final=false) {
      let boundary;
      while ((boundary=buffer.match(/\r?\n\r?\n/))) {
        const index=boundary.index;
        const block=buffer.slice(0,index);
        buffer=buffer.slice(index+boundary[0].length);
        if (block) dispatch(block);
      }
      if (final&&buffer.trim()) {
        dispatch(buffer);
        buffer='';
      }
    }
    return {
      push(chunk){buffer+=decoder.decode(chunk,{stream:true});drain()},
      finish(){buffer+=decoder.decode();drain(true)}
    };
  }

  function readCacheRoot(storage) {
    try {
      const parsed=JSON.parse(storage?.getItem(CACHE_KEY)||'{}');
      return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
    } catch { return {}; }
  }

  function readProjectCache(storage,projectId) {
    const value=readCacheRoot(storage)[String(projectId)];
    return value&&Array.isArray(value.messages)&&Array.isArray(value.proposals)
      ? {messages:value.messages,proposals:value.proposals}
      : EMPTY_CACHE();
  }

  function writeProjectCache(storage,projectId,value) {
    if (!storage) return;
    const cache=readCacheRoot(storage);
    cache[String(projectId)]={
      messages:Array.isArray(value?.messages)?value.messages:[],
      proposals:Array.isArray(value?.proposals)?value.proposals:[]
    };
    try { storage.setItem(CACHE_KEY,JSON.stringify(cache)); } catch {}
  }

  async function interruptBeforeAbort(interrupt,abort,{timeoutMs=1500}={}) {
    let timer;
    const timeout=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('停止生成请求超时')),timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(interrupt),timeout]); }
    finally { clearTimeout(timer);abort(); }
  }

  async function requestProviderSwitch({provider,userInitiated,request}) {
    if (!userInitiated) throw new Error('Provider 切换必须来自用户操作');
    if (provider!=='codex'&&provider!=='openai') throw new Error('Provider 无效');
    return request(provider);
  }

  function composerValueAfterFailure(originalMessage,generatedText) {
    return generatedText?'':String(originalMessage??'');
  }

  function createPanel(panelRoot=root) {
    const view=panelRoot;
    const state={
      app:null,apiBase:'',projectId:null,chapter:'overview',provider:'codex',
      messages:[],proposals:[],generatingProjectId:null,turnId:null,
      controller:null,lastMessage:'',generatedText:'',initialized:false
    };
    let elements={};
    let drawerMedia=null;
    const $=(selector,scope=view.document)=>scope.querySelector(selector);
    const escapeHtml=(value)=>String(value??'').replace(/[&<>"']/g,(character)=>({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[character]);
    const displayValue=(value)=>{
      if (Array.isArray(value)) return value.map((item)=>typeof item==='object'?JSON.stringify(item):String(item)).join('\n');
      if (value&&typeof value==='object') return JSON.stringify(value,null,2);
      return String(value??'');
    };
    const providerLabel=(provider)=>provider==='openai'?'OpenAI API':'本机 Codex';
    const endpoint=(suffix='')=>`${state.apiBase}/api/projects/${state.projectId}/selection-ai${suffix}`;

    async function request(suffix='',options={}) {
      const response=await view.fetch(endpoint(suffix),{
        headers:{'Content-Type':'application/json',...(options.headers||{})},...options
      });
      const payload=await response.json().catch(()=>({}));
      if (!response.ok) {
        const error=new Error(payload.error||'AI 请求失败');
        error.code=payload.code||'AI_REQUEST_FAILED';
        error.status=response.status;
        throw error;
      }
      return payload;
    }

    function cacheDisplay() {
      writeProjectCache(view.localStorage,state.projectId,{messages:state.messages,proposals:state.proposals});
    }

    function timeLabel(value) {
      if (!value) return '';
      const date=new Date(value);
      return Number.isNaN(date.getTime())?'':date.toLocaleString('zh-CN',{hour:'2-digit',minute:'2-digit'});
    }

    function messageHtml(message) {
      const assistant=message.role==='assistant';
      const status=message.status&&message.status!=='completed'?` · ${escapeHtml(message.status)}`:'';
      return `<article class="ai-message ${assistant?'assistant':'user'}" data-message-id="${escapeHtml(message.id||'')}">
        <header><b>${assistant?'AI 助手':'你'}</b><span>${escapeHtml(providerLabel(message.provider||state.provider))}${status} ${escapeHtml(timeLabel(message.created_at))}</span></header>
        <div class="ai-message-content">${escapeHtml(message.content||'')}</div>
      </article>`;
    }

    function renderMessages() {
      elements.messages.innerHTML=state.messages.length
        ? state.messages.map(messageHtml).join('')
        : '<div class="ai-empty">选择快捷问题，或直接输入你想分析的内容。</div>';
      elements.messages.scrollTop=elements.messages.scrollHeight;
    }

    function proposalHtml(proposal) {
      const pending=proposal.status==='pending'||!proposal.status;
      const conflict=Boolean(proposal.conflicted);
      const actionable=pending&&!conflict;
      const rows=(proposal.changes||[]).map((change,index)=>`<label class="ai-change-row">
        <input type="checkbox" data-change-index="${index}" ${actionable?'checked':'disabled'}>
        <span><b>${escapeHtml(change.scope==='site'?(change.country_code||'站点'):'主文档')} · ${escapeHtml(FIELD_LABELS[change.field]||change.field)}</b>
        <small>原内容</small><del>${escapeHtml(displayValue(change.before))||'（空）'}</del>
        <small>建议内容</small><ins>${escapeHtml(displayValue(change.after))||'（空）'}</ins>
        <em>${escapeHtml(change.reason||'')}</em></span>
      </label>`).join('');
      return `<article class="ai-proposal ${conflict?'conflicted':''}" data-proposal-id="${proposal.id}">
        <header><div><small>修改提案</small><h3>${escapeHtml(proposal.summary||'AI 建议修改')}</h3></div><span>${conflict?'版本冲突':escapeHtml(proposal.status||'pending')}</span></header>
        ${rows||'<p class="ai-empty">此提案没有可应用的文本修改。</p>'}
        ${actionable?`<footer>
          <button type="button" class="ai-primary" data-apply-proposal>应用已选修改</button>
          <button type="button" data-reject-proposal>拒绝提案</button>
        </footer>`:conflict?`<footer>
          <button type="button" data-refresh-document>刷新文档</button>
          <button type="button" data-regenerate-proposal>基于最新文档重新生成</button>
        </footer>`:''}
      </article>`;
    }

    function renderProposals() {
      const visible=state.proposals.filter((proposal)=>proposal.status==='pending'||proposal.conflicted);
      elements.proposals.innerHTML=visible.map(proposalHtml).join('');
      elements.proposals.hidden=!visible.length;
    }

    function renderState() {
      renderMessages();
      renderProposals();
      elements.provider.value=state.provider;
      updateControls();
    }

    function updateControls() {
      const generating=state.generatingProjectId===state.projectId;
      elements.send.disabled=generating;
      elements.composer.disabled=generating;
      elements.provider.disabled=generating;
      elements.stop.hidden=!generating;
      elements.stop.disabled=!generating||!state.turnId;
      elements.panel.setAttribute('aria-busy',String(generating));
    }

    function setStatus(text,kind='') {
      elements.status.textContent=text;
      elements.status.dataset.state=kind;
    }

    function showFailure(error) {
      const isCodex=state.provider==='codex';
      elements.errorActions.hidden=false;
      elements.errorActions.innerHTML=`<p>${escapeHtml(error.message||'生成失败')}</p><div>
        <button type="button" data-retry-message>重试</button>
        ${isCodex?'<button type="button" data-switch-provider="openai">切换到 OpenAI API</button>':''}
      </div>`;
      setStatus('生成失败','error');
    }

    function clearFailure() {
      elements.errorActions.hidden=true;
      elements.errorActions.innerHTML='';
    }

    async function replaceWithServerState() {
      const serverState=await request();
      state.provider=serverState.conversation?.active_provider==='openai'?'openai':'codex';
      state.messages=Array.isArray(serverState.messages)?serverState.messages:[];
      state.proposals=Array.isArray(serverState.proposals)?serverState.proposals:[];
      cacheDisplay();
      renderState();
      return serverState;
    }

    async function loadHealth() {
      setStatus('检查连接中…','loading');
      try {
        const health=await request('/health');
        const active=health.providers?.[state.provider]||health[state.provider]||{};
        setStatus(active.ok?'可用':(active.status==='inactive'?'未启用':'不可用'),active.ok?'ready':'error');
      } catch (error) { setStatus(error.message,'error'); }
    }

    function appendStreamingMessage() {
      const article=view.document.createElement('article');
      article.className='ai-message assistant streaming';
      article.innerHTML=`<header><b>AI 助手</b><span>${escapeHtml(providerLabel(state.provider))} · 生成中</span></header><div class="ai-message-content"></div>`;
      elements.messages.append(article);
      elements.messages.scrollTop=elements.messages.scrollHeight;
      return $('.ai-message-content',article);
    }

    async function readTurnStream(response,onEvent) {
      if (!response.ok) {
        const payload=await response.json().catch(()=>({}));
        const error=new Error(payload.error||'生成请求失败');
        error.code=payload.code||'AI_REQUEST_FAILED';
        throw error;
      }
      if (!response.body?.getReader) throw new Error('浏览器不支持流式响应');
      let streamError=null;
      const parser=createSseParser((type,payload)=>{
        onEvent(type,payload);
        if (type==='error') {
          streamError=new Error(payload.error||'生成失败');
          streamError.code=payload.code||'AI_REQUEST_FAILED';
        }
      });
      const reader=response.body.getReader();
      while (true) {
        const {done,value}=await reader.read();
        if (done) break;
        parser.push(value);
      }
      parser.finish();
      if (streamError) throw streamError;
    }

    async function send(message=elements.composer.value) {
      const snapshot=state.app.getSnapshot();
      state.projectId=snapshot.projectId;
      state.chapter=snapshot.chapter;
      const original=String(message??'').trim();
      if (!original||state.generatingProjectId===state.projectId) return;
      state.lastMessage=original;
      state.generatedText='';
      state.turnId=null;
      state.generatingProjectId=state.projectId;
      state.controller=new AbortController();
      clearFailure();
      elements.composer.value='';
      state.messages.push({role:'user',provider:state.provider,content:original,status:'completed',created_at:new Date().toISOString()});
      renderMessages();
      const output=appendStreamingMessage();
      updateControls();
      setStatus('生成中','generating');
      try {
        const response=await view.fetch(endpoint('/turns'),{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({chapter:state.chapter,message:original}),signal:state.controller.signal
        });
        await readTurnStream(response,(type,payload)=>{
          if (payload.turnId) state.turnId=payload.turnId;
          if (type==='status') { setStatus(payload.status==='started'?'生成中':payload.status,'generating');updateControls(); }
          if (type==='text_delta') {
            const delta=String(payload.delta??'');
            state.generatedText+=delta;
            output.append(view.document.createTextNode(delta));
            elements.messages.scrollTop=elements.messages.scrollHeight;
          }
          if (type==='proposal'&&payload.proposal) {
            state.proposals.push(payload.proposal);
            renderProposals();
          }
        });
        setStatus('可用','ready');
        await replaceWithServerState();
      } catch (error) {
        if (error.name==='AbortError') setStatus('已停止','');
        else showFailure(error);
        elements.composer.value=composerValueAfterFailure(original,state.generatedText);
        await replaceWithServerState().catch(()=>{});
      } finally {
        state.generatingProjectId=null;
        state.turnId=null;
        state.controller=null;
        updateControls();
        cacheDisplay();
      }
    }

    async function stop() {
      if (state.generatingProjectId!==state.projectId||!state.turnId||!state.controller) return;
      const turnId=state.turnId;
      const controller=state.controller;
      elements.stop.disabled=true;
      try {
        await interruptBeforeAbort(
          ()=>request(`/turns/${encodeURIComponent(turnId)}/interrupt`,{method:'POST'}),
          ()=>controller.abort()
        );
      } catch (error) {
        showFailure(error);
      }
    }

    async function switchProvider(provider,userInitiated) {
      const previous=state.provider;
      try {
        const conversation=await requestProviderSwitch({
          provider,userInitiated,
          request:(selected)=>request('/provider',{method:'PUT',body:JSON.stringify({provider:selected})})
        });
        state.provider=conversation.active_provider;
        elements.provider.value=state.provider;
        clearFailure();
        await loadHealth();
      } catch (error) {
        state.provider=previous;
        elements.provider.value=previous;
        showFailure(error);
      }
    }

    async function applyProposal(card) {
      const proposalId=Number(card.dataset.proposalId);
      const change_indexes=[...card.querySelectorAll('[data-change-index]:checked')]
        .map((input)=>Number(input.dataset.changeIndex));
      if (!change_indexes.length) { view.alert('请至少选择一项修改');return; }
      if (!view.confirm(`确认应用选中的 ${change_indexes.length} 项文本修改？`)) return;
      try {
        await request(`/proposals/${proposalId}/apply`,{
          method:'POST',body:JSON.stringify({change_indexes})
        });
        await state.app.reload();
        await replaceWithServerState();
      } catch (error) {
        if (error.code==='PROPOSAL_CONFLICT') {
          const proposal=state.proposals.find((item)=>Number(item.id)===proposalId);
          if (proposal) proposal.conflicted=true;
          renderProposals();
        }
        showFailure(error);
      }
    }

    async function rejectProposal(card) {
      const proposalId=Number(card.dataset.proposalId);
      if (!view.confirm('确认拒绝整份修改提案？')) return;
      try {
        await request(`/proposals/${proposalId}/reject`,{method:'POST'});
        await replaceWithServerState();
      } catch (error) { showFailure(error); }
    }

    async function refreshConflictedProposal(card) {
      const proposalId=Number(card.dataset.proposalId);
      try {
        await state.app.reload();
        await replaceWithServerState();
        const proposal=state.proposals.find((item)=>Number(item.id)===proposalId);
        if (proposal) proposal.conflicted=true;
        cacheDisplay();
        renderProposals();
      } catch (error) { showFailure(error); }
    }

    async function clearHistory() {
      if (!view.confirm('清空当前品类的全部 AI 对话？此操作不可撤销。')) return;
      try {
        await request('/messages',{method:'DELETE',body:JSON.stringify({confirm:true})});
        state.messages=[];state.proposals=[];cacheDisplay();renderState();
      } catch (error) { showFailure(error); }
    }

    function syncDrawerAccessibility() {
      const hidden=Boolean(drawerMedia?.matches)&&!elements.panel.classList.contains('open');
      elements.panel.inert=hidden;
      if (hidden) elements.panel.setAttribute('aria-hidden','true');
      else elements.panel.removeAttribute('aria-hidden');
    }

    function toggleDrawer(force,{restoreFocus=true}={}) {
      const open=typeof force==='boolean'?force:!elements.panel.classList.contains('open');
      elements.panel.classList.toggle('open',open);
      elements.drawerToggle.setAttribute('aria-expanded',String(open));
      elements.drawerToggle.textContent=open?'关闭 AI':'AI 助手';
      syncDrawerAccessibility();
      if (open) elements.provider.focus();
      else if (restoreFocus) elements.drawerToggle.focus();
    }

    function bind() {
      elements.provider.addEventListener('change',(event)=>switchProvider(event.target.value,true));
      elements.send.addEventListener('click',()=>send());
      elements.stop.addEventListener('click',stop);
      elements.composer.addEventListener('keydown',(event)=>{
        if ((event.ctrlKey||event.metaKey)&&event.key==='Enter') {event.preventDefault();send()}
      });
      elements.quick.addEventListener('click',(event)=>{
        const button=event.target.closest('[data-ai-prompt]');
        if (button) send(QUICK_PROMPTS[button.dataset.aiPrompt]);
      });
      elements.errorActions.addEventListener('click',(event)=>{
        if (event.target.closest('[data-retry-message]')) send(state.lastMessage);
        const switchButton=event.target.closest('[data-switch-provider]');
        if (switchButton) switchProvider(switchButton.dataset.switchProvider,true);
      });
      elements.proposals.addEventListener('click',async(event)=>{
        const card=event.target.closest('[data-proposal-id]');
        if (!card) return;
        if (event.target.closest('[data-apply-proposal]')) return applyProposal(card);
        if (event.target.closest('[data-reject-proposal]')) return rejectProposal(card);
        if (event.target.closest('[data-refresh-document]')) return refreshConflictedProposal(card);
        if (event.target.closest('[data-regenerate-proposal]')) {
          return send('请基于当前最新文档重新生成一份修改提案。');
        }
      });
      elements.clear.addEventListener('click',clearHistory);
      elements.drawerToggle.addEventListener('click',()=>toggleDrawer());
      elements.drawerClose.addEventListener('click',()=>toggleDrawer(false));
      view.addEventListener('selection-chapter-changed',(event)=>{state.chapter=event.detail?.chapter||state.chapter});
      view.addEventListener('keydown',(event)=>{
        if (event.key==='Escape'&&drawerMedia?.matches&&elements.panel.classList.contains('open')) toggleDrawer(false);
      });
      drawerMedia?.addEventListener?.('change',()=>{
        if (!drawerMedia.matches) elements.panel.classList.toggle('open',false);
        syncDrawerAccessibility();
      });
    }

    async function init({app,apiBase=''}) {
      if (!app?.getSnapshot||!app?.reload) throw new TypeError('SelectionDocumentApp bridge is required');
      const snapshot=app.getSnapshot();
      state.app=app;
      state.apiBase=String(apiBase||'').replace(/\/$/,'');
      state.projectId=snapshot.projectId;
      state.chapter=snapshot.chapter;
      elements={
        panel:$('#selectionAiPanel'),provider:$('#aiProvider'),status:$('#aiProviderStatus'),
        messages:$('#aiMessages'),proposals:$('#aiProposals'),composer:$('#aiComposer'),
        send:$('#aiSend'),stop:$('#aiStop'),errorActions:$('#aiErrorActions'),
        quick:$('#aiQuickPrompts'),clear:$('#aiClearHistory'),drawerToggle:$('#aiDrawerToggle'),
        drawerClose:$('#aiDrawerClose')
      };
      drawerMedia=view.matchMedia?.('(max-width:1100px)')||{matches:false};
      if (!state.initialized) {bind();state.initialized=true}
      syncDrawerAccessibility();
      const cached=readProjectCache(view.localStorage,state.projectId);
      state.messages=cached.messages;
      state.proposals=cached.proposals;
      renderState();
      try { await replaceWithServerState(); }
      catch (error) { showFailure(error); }
      await loadHealth();
    }

    return {init};
  }

  const exports={
    CACHE_KEY,createSseParser,readProjectCache,writeProjectCache,createPanel,
    interruptBeforeAbort,requestProviderSwitch,composerValueAfterFailure
  };
  if (typeof module!=='undefined'&&module.exports) module.exports=exports;
  if (root?.document) {
    const panel=createPanel();
    root.SelectionAiPanel=panel;
    const start=()=>panel.init({
      app:root.SelectionDocumentApp,
      apiBase:String(root.MARGINGO_API_BASE||'')
    });
    root.addEventListener('selection-document-ready',()=>start().catch(()=>{}),{once:true});
    if (root.SelectionDocumentApp) start().catch(()=>{});
  }
})(typeof window!=='undefined'?window:globalThis);
