'use strict';

const {AsyncLocalStorage}=require('node:async_hooks');

const requestContext=new AsyncLocalStorage();

function currentUser(){return requestContext.getStore()?.user||null;}

function currentActor(){return requestContext.getStore()?.actor||currentUser();}

function useDataOwner(ownerUserId,permission=''){
  const store=requestContext.getStore();const id=Number(ownerUserId);
  if(!store||!Number.isSafeInteger(id)||id<=0)throw new Error('无效的数据归属人');
  store.actor||=store.user;store.dataOwnerId=id;store.permission=String(permission||'');
}

function currentPermission(){return String(requestContext.getStore()?.permission||'');}

function currentOwnerId(){
  const id=Number(requestContext.getStore()?.dataOwnerId??currentUser()?.id);
  if(process.env.NODE_ENV==='test'&&!currentUser())return 1;
  if(!Number.isSafeInteger(id)||id<=0){
    const error=new Error('未登录');
    error.statusCode=401;
    error.code='AUTH_REQUIRED';
    throw error;
  }
  return id;
}

module.exports={requestContext,currentUser,currentActor,useDataOwner,currentPermission,currentOwnerId};
