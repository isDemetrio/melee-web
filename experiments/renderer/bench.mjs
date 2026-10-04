import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const dir=process.env.RUNNER_TEMP;
const server=createServer(async(req,res)=>{try {
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Renderer benchmark</title>');return;}
  if(!/^\/(baseline|candidate)\.(mjs|wasm)$/.test(req.url)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');
  res.end(await readFile(join(dir,req.url.slice(1))));
}catch(e){res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(4180,'127.0.0.1',r));
const browser=await chromium.launch({args:['--enable-unsafe-webgpu','--enable-unsafe-swiftshader']});
try {
 const result={browser:browser.version(),trials:[]};
 for(let trial=0;trial<3;trial++) for(const label of trial%2?['candidate','baseline']:['baseline','candidate']){
  const page=await browser.newPage();await page.goto('http://127.0.0.1:4180/');
  const row=await page.evaluate(async label=>{
    const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('no adapter');
    const device=await adapter.requestDevice();const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
    const xfb=device.createTexture({size:[640,480],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST});
    const gpu={device,xfb,format:'rgba8unorm',failure:null};
    const module=await (await import('/'+label+'.mjs')).default({gxWebgpu:gpu});
    if(module._gx_webgpu_attach()!==1)throw Error('attach failed');
    // Prototype interception preserves actual receivers and counts queue delivery separately.
    let active=false, apiMs=0;const methods={};
    function hook(proto,names){for(const name of names){const fn=proto[name];if(typeof fn!=='function')continue;
      proto[name]=function(...args){if(!active)return fn.apply(this,args);let t=performance.now();try{return fn.apply(this,args);}finally{let dt=performance.now()-t;apiMs+=dt;let s=methods[name]??={calls:0,ms:0};s.calls++;s.ms+=dt;}};
    }}
    hook(GPUQueue.prototype,['submit','writeBuffer','writeTexture']);
    hook(GPURenderPassEncoder.prototype,['drawIndexed','setBindGroup','setPipeline','setVertexBuffer','setIndexBuffer','setViewport','setScissorRect','end']);
    hook(GPUDevice.prototype,['createCommandEncoder','createBindGroup','createRenderPipeline','createShaderModule']);
    const batches=[];
    for(const geometry of [16,39]){
      for(let i=0;i<10;i++)module._gx_webgpu_selftest(0x204080ff,2,geometry);
      await device.queue.onSubmittedWorkDone();
      active=true;const start=performance.now();const apiStart=apiMs;
      for(let i=0;i<100;i++)module._gx_webgpu_selftest(0x204080ff,2,geometry);
      const cpuMs=performance.now()-start;active=false;
      const submitted=performance.now();await device.queue.onSubmittedWorkDone();const drainMs=performance.now()-submitted;
      const buffer=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:xfb,origin:[320,240,0]},{buffer,bytesPerRow:256},[1,1,1]);device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);const pixel=[...new Uint8Array(buffer.getMappedRange()).slice(0,4)];buffer.unmap();buffer.destroy();
      if(pixel.join(',')!=='128,64,32,192')throw Error('wrong pixel '+pixel);
      batches.push({geometry,iterations:100,draws:300,cpuMs,apiMs:apiMs-apiStart,drainMs,pixel});
    }
    if(gpu.failure||errors.length)throw Error(JSON.stringify({failure:gpu.failure,errors}));
    const info={...adapter.info};device.destroy();return {label,batches,methods,adapter:info};
  },label);
  result.trials.push({trial,...row});await page.close();
 }
 await writeFile(join(dir,'results/renderer.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();server.close();}
