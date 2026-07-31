'use strict';

const path=require('node:path');
const fs=require('node:fs');
const webpack=require('webpack');
const HtmlWebpackPlugin=require('html-webpack-plugin');

const embedUrl=String(process.env.MARGINGO_EMBED_URL||'http://127.0.0.1:4173/embed.html').replace(/\/$/,'');
const appConfig=JSON.parse(fs.readFileSync(path.resolve(__dirname,'app.json'),'utf8'));

class FeishuManifestPlugin{
  apply(compiler){
    compiler.hooks.thisCompilation.tap('FeishuManifestPlugin',(compilation)=>{
      compilation.hooks.processAssets.tap({name:'FeishuManifestPlugin',stage:webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL},()=>{
        const project={appid:appConfig.appID,projectname:appConfig.projectName,blocks:['index']};
        const block={blockTypeID:appConfig.blockTypeID,blockRenderType:'offlineWeb',offlineWebConfig:{initialHeight:appConfig.initialHeight,contributes:appConfig.contributes}};
        compilation.emitAsset('project.config.json',new webpack.sources.RawSource(JSON.stringify(project)));
        compilation.emitAsset('index.json',new webpack.sources.RawSource(JSON.stringify(block)));
      });
    });
  }
}

module.exports={
  entry:'./src/index.js',
  output:{path:path.resolve(__dirname,'dist'),filename:'index.js',clean:true},
  module:{rules:[{test:/\.css$/i,use:['style-loader','css-loader']}]},
  plugins:[
    new HtmlWebpackPlugin({template:'./src/index.html'}),
    new webpack.DefinePlugin({'process.env.MARGINGO_EMBED_URL':JSON.stringify(embedUrl)}),
    new FeishuManifestPlugin()
  ],
  devServer:{port:8080,hot:false}
};
