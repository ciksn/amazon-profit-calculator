'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');

const {
  extractTopReviews,
  fetchAmazonTopReviews,
  validateReviewAnalysis,
  analyzeReviewBatch
}=require('../lib/review-analysis');

function reviewHtml(count=3) {
  const rows=Array.from({length:count},(_,index)=>`
    <div id="R${index+1}" data-hook="review">
      <a class="a-profile" href="/gp/profile/private-${index+1}"><span class="a-profile-name">Reviewer ${index+1}</span></a>
      <i data-hook="review-star-rating"><span>${index===1?'2':'5'} out of 5 stars</span></i>
      <a data-hook="review-title"><span>${index===1?'Too heavy':'Fast and useful'}</span></a>
      <span data-hook="review-date">Reviewed in the United Kingdom on ${index+1} July 2026</span>
      ${index===0?'<span data-hook="avp-badge">Verified Purchase</span>':''}
      ${index!==1?'<span class="vine-review-badge">Vine Customer Review of Free Product</span>':''}
      <span data-hook="review-body"><span>${index===1?'Heavy when full and noisy.':index===0?'Heats quickly and removes creases well.':`Heats quickly and removes creases well. Review ${index+1}`}</span></span>
      <span data-hook="helpful-vote-statement">${index+1} people found this helpful</span>
    </div>`).join('');
  return `<!doctype html><html><body><div id="customerReviews">${rows}</div></body></html>`;
}

test('从商品页 Top Reviews 提取结构化评论且不保留评论者信息',()=>{
  const reviews=extractTopReviews(reviewHtml().replace('1 people found this helpful','One person found this helpful'));
  assert.equal(reviews.length,3);
  assert.deepEqual(reviews[0],{
    id:'R1',rating:5,title:'Fast and useful',
    body:'Heats quickly and removes creases well.',
    date:'Reviewed in the United Kingdom on 1 July 2026',
    verified:true,vine:true,helpful:1
  });
  assert.equal(JSON.stringify(reviews).includes('Reviewer 1'),false);
  assert.equal(JSON.stringify(reviews).includes('private-1'),false);
});

test('兼容 Amazon 新版 reviewText 和 reviewTitle 节点',()=>{
  const reviews=extractTopReviews(`
    <div data-hook="review" id="R-NEW-1">
      <span data-hook="review-star-rating">4.0 out of 5 stars</span>
      <a data-hook="reviewTitle">Works quickly</a>
      <span data-hook="reviewText">Removed creases in one pass.</span>
      <span data-hook="review-date">Reviewed on July 24, 2026</span>
    </div>`);
  assert.equal(reviews.length,1);
  assert.equal(reviews[0].title,'Works quickly');
  assert.equal(reviews[0].body,'Removed creases in one pass.');
});

test('Top Reviews 按正文去重并最多保留 10 条',()=>{
  const limited=extractTopReviews(reviewHtml(12));
  assert.equal(limited.length,10);
  assert.equal(new Set(limited.map((item)=>item.id)).size,10);
  const duplicateBody=reviewHtml(3).replace('Heats quickly and removes creases well. Review 3','Heats quickly and removes creases well.');
  assert.equal(extractTopReviews(duplicateBody).length,2);
});

test('Top Reviews 识别验证码和没有公开评论',()=>{
  assert.throws(()=>extractTopReviews('<title>Robot Check</title><p>Enter the characters you see below</p>'),/验证码/);
  assert.deepEqual(extractTopReviews('<div id="customerReviews"></div>'),[]);
});

test('Amazon 评论请求拒绝跨站跳转并限制页面体积',async()=>{
  await assert.rejects(
    fetchAmazonTopReviews('https://www.amazon.co.uk/dp/B0ABC12345','GB',{
      fetchImpl:async()=>new Response('',{status:302,headers:{location:'https://example.com/steal'}})
    }),
    /不允许的域名/
  );
  await assert.rejects(
    fetchAmazonTopReviews('https://www.amazon.co.uk/dp/B0ABC12345','GB',{
      maxHtmlBytes:20,
      fetchImpl:async()=>new Response(reviewHtml(),{status:200,headers:{'content-type':'text/html'}})
    }),
    /页面过大/
  );
});

test('Gemini 评论结果校验 ID、去重和数量上限',()=>{
  const validated=validateReviewAnalysis({
    products:[{
      competitor_id:1,
      pros:['快速预热','快速预热','吸附有效','操作简单','水箱够用','易于收纳','超出上限'],
      cons:['装水偏重','噪声略大']
    }],
    overview:{pros:['快速预热','操作简单'],cons:['机身偏重']}
  },new Set([1]));
  assert.deepEqual(validated.products[0].pros,['快速预热','吸附有效','操作简单','水箱够用','易于收纳']);
  assert.deepEqual(validated.products[0].cons,['装水偏重','噪声略大']);
  assert.deepEqual(validated.overview.pros,['快速预热','操作简单']);
  assert.throws(()=>validateReviewAnalysis({
    products:[
      {competitor_id:1,pros:['优点'],cons:[]},
      {competitor_id:1,pros:['重复'],cons:[]}
    ],
    overview:{pros:[],cons:[]}
  },new Set([1,2])),/重复/);
  const partial=validateReviewAnalysis({
    products:[{competitor_id:1,pros:['有效优点'],cons:[]}],
    overview:{pros:[],cons:[]}
  },new Set([1,2]));
  assert.deepEqual(partial.products.map((item)=>item.id),[1]);
});

test('批量分析抓取成功评论并生成服务端样本提醒',async()=>{
  let geminiItems;
  const result=await analyzeReviewBatch([{
    id:1,country_code:'GB',name:'Steamer',asin:'B0ABC12345',
    product_url:'https://www.amazon.co.uk/dp/B0ABC12345'
  }],{
    apiKey:'test-key',
    fetchImpl:async()=>new Response(reviewHtml(),{status:200,headers:{'content-type':'text/html'}}),
    geminiCall:async(items)=>{
      geminiItems=items;
      return {
        products:[{id:1,pros:['快速预热'],cons:['装水偏重'],status:'complete'}],
        overview:{pros:[],cons:[]}
      };
    }
  });
  assert.equal(geminiItems[0].reviews.length,3);
  assert.equal(result.rows[0].source,'amazon_page');
  assert.equal(result.rows[0].sampleCount,3);
  assert.match(result.rows[0].warning,/仅 3 条样本/);
  assert.match(result.rows[0].warning,/多数为 Vine/);
  assert.deepEqual(result.rows[0].pros,['快速预热']);
});

test('抓取失败时使用 URL Context，样本数保持未知',async()=>{
  const result=await analyzeReviewBatch([{
    id:9,country_code:'GB',name:'Steamer',asin:'B0ABC12345',
    product_url:'https://www.amazon.co.uk/dp/B0ABC12345'
  }],{
    apiKey:'test-key',retryDelayMs:0,
    fetchImpl:async()=>new Response('<title>Robot Check</title><p>Enter the characters you see below</p>',{status:200,headers:{'content-type':'text/html'}}),
    geminiCall:async(items)=>{
      assert.equal(items[0].reviews.length,0);
      assert.equal(items[0].product_url,'https://www.amazon.co.uk/dp/B0ABC12345');
      return {
        products:[{id:9,pros:['操作方便'],cons:['略显笨重'],status:'complete'}],
        overview:{pros:[],cons:[]}
      };
    }
  });
  assert.equal(result.rows[0].source,'url_context');
  assert.equal(result.rows[0].sampleCount,null);
  assert.deepEqual(result.rows[0].topReviews,[]);
  assert.match(result.rows[0].warning,/URL Context/);
});

test('重试失败项时把数据库已有总结一并交给 Gemini 更新共同结论',async()=>{
  let geminiItems;
  const result=await analyzeReviewBatch([{
    id:9,country_code:'GB',name:'Retry item',asin:'B0ABC12345',
    product_url:'https://www.amazon.co.uk/dp/B0ABC12345'
  }],{
    apiKey:'test-key',
    existingSummaries:[{competitor_id:1,title:'Saved item',pros:['操作方便'],cons:['机身偏重']}],
    fetchImpl:async()=>new Response(reviewHtml(),{status:200,headers:{'content-type':'text/html'}}),
    geminiCall:async(items)=>{
      geminiItems=items;
      return {
        products:[
          {id:9,pros:['快速预热'],cons:['水箱偏小'],status:'complete'},
          {id:1,pros:['操作方便'],cons:['机身偏重'],status:'complete'}
        ],
        overview:{pros:['操作方便'],cons:['机身偏重']}
      };
    }
  });
  assert.equal(geminiItems.length,2);
  assert.deepEqual(geminiItems[1],{
    competitor_id:1,title:'Saved item',reviews:[],product_url:'',prior_summary:{pros:['操作方便'],cons:['机身偏重']}
  });
  assert.deepEqual(result.overview,{pros:['操作方便'],cons:['机身偏重']});
  assert.equal(result.rows.length,1);
});

test('只接受 Amazon 商品详情路径，不把站内任意页面交给 URL Context',async()=>{
  let fetched=false,geminiCalled=false;
  const result=await analyzeReviewBatch([{
    id:12,country_code:'GB',name:'Invalid URL',asin:'',
    product_url:'https://www.amazon.co.uk/gp/help/customer/display.html'
  }],{
    apiKey:'test-key',
    fetchImpl:async()=>{fetched=true;return new Response(reviewHtml())},
    geminiCall:async()=>{geminiCalled=true;return {products:[],overview:{pros:[],cons:[]}}}
  });
  assert.equal(fetched,false);
  assert.equal(geminiCalled,false);
  assert.equal(result.rows[0].status,'failed');
  assert.match(result.rows[0].warning,/缺少有效 Amazon 商品链接/);
});

test('Gemini 少返回一个竞品时保留其他成功项并只标记缺失项失败',async()=>{
  const rows=[1,2].map((id)=>({
    id,country_code:'GB',name:`Item ${id}`,asin:`B0MISS000${id}`,
    product_url:`https://www.amazon.co.uk/dp/B0MISS000${id}`
  }));
  const result=await analyzeReviewBatch(rows,{
    apiKey:'test-key',
    fetchImpl:async()=>new Response(reviewHtml(),{status:200,headers:{'content-type':'text/html'}}),
    geminiCall:async()=>({
      products:[{competitor_id:1,pros:['有效优点'],cons:[]}],
      overview:{pros:[],cons:[]}
    })
  });
  assert.deepEqual(result.rows.map((item)=>item.status),['complete','failed']);
  assert.deepEqual(result.rows[0].pros,['有效优点']);
});
