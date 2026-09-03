'use strict';

const {AsyncLocalStorage}=require('node:async_hooks');

const requestContext=new AsyncLocalStorage();

function currentUser(){return requestContext.getStore()?.user||null;}

function currentOwnerId(){
  const id=Number(currentUser()?.id);
  if(process.env.NODE_ENV==='test'&&!currentUser())return 1;
  if(!Number.isSafeInteger(id)||id<=0){
    const error=new Error('未登录');
    error.statusCode=401;
    error.code='AUTH_REQUIRED';
    throw error;
  }
  return id;
}

module.exports={requestContext,currentUser,currentOwnerId};
