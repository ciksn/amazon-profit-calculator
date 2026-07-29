'use strict';

const {validateDocumentPatch,validateSiteInput}=require('../selection-document');

const PROVIDERS=['codex','openai'];
const CHAPTERS={overview:'选品概览',sites:'站点机会',competitors:'竞品洞察',suppliers:'供应商决策',risks:'风险与自检'};
const DOCUMENT_AI_FIELDS=[
  'decision_reason','positioning','use_scenarios','competitive_points',
  'differentiation_items','review_issues','overview_summary','competitor_summary',
  'supplier_summary','patent_notes','checklist'
];
const SITE_AI_FIELDS=[
  'new_product_friendliness','same_product_performance','opportunity_status','opportunity_notes',
  'certification_required','certification_actual','supplier_certifications',
  'certification_gap','payback_period'
];

const OUTPUT_SCHEMA={
  type:'object',additionalProperties:false,required:['answer','proposal'],properties:{
    answer:{type:'string'},
    proposal:{
      type:'object',additionalProperties:false,required:['summary','changes'],properties:{
        summary:{type:'string'},
        changes:{
          type:'array',items:{
            type:'object',additionalProperties:false,
            required:['scope','country_code','field','value','reason'],properties:{
              scope:{type:'string',enum:['document','site']},
              country_code:{type:'string'},field:{type:'string'},value:{type:'string'},reason:{type:'string'}
            }
          }
        }
      }
    }
  }
};

const ARRAY_DOCUMENT_FIELDS=new Set(['differentiation_items','review_issues','checklist']);
const MAX_TEXT_LENGTH=10000;

function truncateText(value) {
  return String(value??'').trim().slice(0,MAX_TEXT_LENGTH);
}

function boundedValue(value) {
  return String(value??'').slice(0,MAX_TEXT_LENGTH);
}

function validateProvider(value) {
  if (!PROVIDERS.includes(value)) throw new Error('Provider 不正确');
  return value;
}

function proposalValue(field,value) {
  if (!ARRAY_DOCUMENT_FIELDS.has(field)) return value;
  if (typeof value!=='string') throw new Error('数组字段必须使用 JSON 字符串');
  return JSON.parse(value);
}

function normalizeProposal(raw,payload={}) {
  const proposal=raw?.proposal||raw;
  if (!proposal || typeof proposal!=='object' || !Array.isArray(proposal.changes)) return null;
  const changes=[];
  for (const change of proposal.changes) {
    if (changes.length>=30) break;
    if (!change || typeof change!=='object' || typeof change.value!=='string') continue;
    const {scope,field}=change;
    try {
      if (scope==='document') {
        if (change.country_code!=='' || !DOCUMENT_AI_FIELDS.includes(field)) continue;
        const value=proposalValue(field,boundedValue(change.value));
        const after=validateDocumentPatch({version:payload.document?.version,[field]:value})[field];
        changes.push({
          scope, country_code:'', field,
          before:payload.document?.[field], after,
          reason:truncateText(change.reason)
        });
      } else if (scope==='site') {
        if (!SITE_AI_FIELDS.includes(field) || typeof change.country_code!=='string' || !change.country_code) continue;
        const site=(payload.sites||[]).find((item)=>item.country_code===change.country_code);
        if (!site) continue;
        const after=validateSiteInput({[field]:boundedValue(change.value)})[field];
        changes.push({
          scope, country_code:change.country_code, field,
          before:site[field], after,
          reason:truncateText(change.reason)
        });
      }
    } catch {
      // Invalid provider output is omitted from the user-visible proposal.
    }
  }
  if (!changes.length) return null;
  return {summary:truncateText(proposal.summary),changes};
}

module.exports={
  PROVIDERS,
  CHAPTERS,
  DOCUMENT_AI_FIELDS,
  SITE_AI_FIELDS,
  OUTPUT_SCHEMA,
  validateProvider,
  normalizeProposal
};
