'use strict';

function normalizeContext(blockRef={}){
  return {documentToken:String(blockRef.docRef?.docToken||''),blockId:String(blockRef.blockId??'')};
}

function bindingMatches(binding,context){
  return Boolean(binding?.workspaceKey&&binding.documentToken===context.documentToken&&String(binding.blockId)===String(context.blockId));
}

function createBinding(workspaceKey,context){
  return {version:1,workspaceKey,documentToken:context.documentToken,blockId:String(context.blockId),boundAt:new Date().toISOString()};
}

module.exports={normalizeContext,bindingMatches,createBinding};
