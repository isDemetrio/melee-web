#!/usr/bin/env python3
"""Build a derivative ONLY in RUNNER_TEMP; wasm/render sources are read-only.

The candidate caches pure uniform preparation for consecutive segments of one
DrawCall. It retains every upload/bind, shader lookup, draw, copy and flush.
"""
import os,sys
from pathlib import Path
assert os.environ.get('GITHUB_ACTIONS')=='true'
label=sys.argv[1];tmp=Path(os.environ['RUNNER_TEMP'])
s=Path('wasm/render/gx_webgpu.cpp').read_text()
# Both sides get the same synthetic multi-segment fixture; game decoder untouched.
marker='extern "C" EMSCRIPTEN_KEEPALIVE int gx_webgpu_selftest('
s=s.replace(marker,'''static int experiment_segments=1;
extern "C" EMSCRIPTEN_KEEPALIVE void experiment_set_segments(int n) {
  if(n<1 || n>8)std::abort();experiment_segments=n;
}
'''+marker)
needle='frame.segments.push_back({dc.first_vertex,uint32_t(vertices),dc.primitive});'
assert s.count(needle)==1
s=s.replace(needle, 'dc.segment_count=experiment_segments;\n      for(int k=0;k<experiment_segments;++k)'+needle)
if label=='candidate':
 start=s.index('  float vp[6], proj[6];',s.index('bool draw_segment('))
 end=s.index('  const gxw::ShaderUid uid=gxw::make_uid(dc);',start)
 prep=s[start:end]
 prep=prep.replace('return true;', 'return false;')
 prep=prep.replace('  float u[gxw::MAX_ROWS][4] = {};','  auto& u=prepared.u;std::memset(u,0,sizeof u);')
 old='  float r[10]={x,y,w,h,std::clamp(1-vp[5]/16777216.0f,0.0f,1.0f),std::clamp(1-(vp[5]-vp[2])/16777216.0f,0.0f,1.0f)};'
 assert old in prep
 prep=prep.replace(old,old.replace('float r[10]','const float initial_r[10]')+'\n  auto& r=prepared.r;std::memcpy(r,initial_r,sizeof r);')
 definitions='''struct PreparedDraw {
  float u[gxw::MAX_ROWS][4],r[10];bool ready=false,drawable=false;
};
bool prepare_draw(const gx::DrawCall& dc,PreparedDraw& prepared) {
'''+prep+'  return true;\n}\n'
 replacement='''  if(!prepared.ready){prepared.ready=true;prepared.drawable=prepare_draw(dc,prepared);}
  if(!prepared.drawable)return true;
  auto& u=prepared.u;auto& r=prepared.r;
'''
 s=s[:start]+replacement+s[end:]
 signature='bool draw_segment(const gx::Frame& frame, const gx::DrawCall& dc, const gx::DrawSegment& segment) {'
 assert s.count(signature)==1
 s=s.replace(signature,definitions+signature.replace('segment) {','segment, PreparedDraw& prepared) {'))
 s=s.replace('        bool ok = true;','        bool ok = true;PreparedDraw prepared;')
 s=s.replace('draw_segment(frame,dc,frame.segments[dc.first_segment+i])','draw_segment(frame,dc,frame.segments[dc.first_segment+i],prepared)')
 s=s.replace('draw_segment(frame,dc,{dc.first_vertex,dc.vertex_count,dc.primitive})','draw_segment(frame,dc,{dc.first_vertex,dc.vertex_count,dc.primitive},prepared)')
(tmp/f'{label}-renderer.cpp').write_text(s)
