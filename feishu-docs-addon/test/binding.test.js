'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { normalizeContext,bindingMatches,createBinding }=require('../src/binding');

test('同一文档同一组件复用已有测算实例',()=>{
  const context=normalizeContext({docRef:{docToken:'doc-a'},blockId:12});
  const binding=createBinding('workspace-a',context);
  assert.equal(bindingMatches(binding,context),true);
});

test('复制文档或复制组件后必须创建新实例',()=>{
  const original={documentToken:'doc-a',blockId:'12'};
  const binding=createBinding('workspace-a',original);
  assert.equal(bindingMatches(binding,{documentToken:'doc-b',blockId:'12'}),false);
  assert.equal(bindingMatches(binding,{documentToken:'doc-a',blockId:'13'}),false);
  assert.equal(bindingMatches({},original),false);
});
