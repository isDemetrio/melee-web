import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { recipeKey, warmNote, warmPipelines, type PipelineRecipe, type WarmableGpu } from '../../src/play/pipelines';

const recipe = (code: string, blendBits = 24): PipelineRecipe => ({ lines: 0, cull: 1, zmode: 23, blendBits, efbAlpha: 1, code });

function fakeGpu(fail: (code: string) => boolean = () => false) {
  const modules: string[] = [];
  const described: unknown[][] = [];
  const gpu: WarmableGpu = {
    device: {
      createShaderModule: ({ code }) => { modules.push(code); return { code }; },
      createRenderPipelineAsync: (d) => {
        const { module } = d as { module: { code: string } };
        return fail(module.code) ? Promise.reject(new Error(`bad ${module.code}`)) : Promise.resolve({ pipeline: d });
      },
    },
    pipelineDescriptor: (module, label, ...state) => { described.push([label, ...state]); return { module }; },
  };
  return { gpu, modules, described };
}

describe('render pipelines compiled before the game', () => {
  it('keys a pipeline the way gxw_draw looks it up', () => {
    expect(recipeKey(recipe('fn x() {}'))).toBe('0:1:23:24:1\nfn x() {}');
    const backend = readFileSync(new URL('../../../wasm/render/gx_webgpu.cpp', import.meta.url), 'utf8');
    expect(backend).toContain('const warmKey = [lines,cull,zmode,blendBits,efbAlpha].join(":") + "\\n" + text;');
  });

  it('compiles each recipe once, one module per WGSL text, into gpu.warm', async () => {
    const { gpu, modules, described } = fakeGpu();
    const result = await warmPipelines(gpu, [recipe('a'), recipe('a', 25), recipe('b'), recipe('a')], () => 0);
    expect(result).toMatchObject({ requested: 3, ready: 3, failed: 0, firstError: null });
    expect(modules.sort()).toEqual(['a', 'b']);
    expect(described).toContainEqual(['warm 0:1:23:25:1', 0, 1, 23, 25, 1]);
    expect([...gpu.warm!.keys()].sort()).toEqual([recipeKey(recipe('a')), recipeKey(recipe('a', 25)), recipeKey(recipe('b'))].sort());
  });

  it('leaves out a pipeline that fails, for the backend to compile in its frame', async () => {
    const { gpu } = fakeGpu((code) => code === 'bad');
    const result = await warmPipelines(gpu, [recipe('good'), recipe('bad')], () => 0);
    expect(result).toMatchObject({ requested: 2, ready: 1, failed: 1 });
    expect(result.firstError).toContain('bad');
    expect(gpu.warm!.has(recipeKey(recipe('bad')))).toBe(false);
  });

  it('ignores records that are not recipes, and a core without the descriptor', async () => {
    const { gpu } = fakeGpu();
    const result = await warmPipelines(gpu, [recipe('a'), { code: 'x' } as unknown as PipelineRecipe], () => 0);
    expect(result.requested).toBe(1);
    const old = fakeGpu().gpu;
    delete old.pipelineDescriptor;
    expect((await warmPipelines(old, [recipe('a')], () => 0)).requested).toBe(0);
    expect(old.warm).toBeUndefined();
  });

  it('says in the report what was compiled before the game', () => {
    expect(warmNote({ requested: 0, ready: 0, failed: 0, ms: 0, firstError: null }, 0)).toContain('none known for this core yet');
    expect(warmNote({ requested: 112, ready: 111, failed: 1, ms: 2345.6, firstError: 'e' }, 112))
      .toBe('render pipelines: 111 of 112 compiled before the game in 2346 ms (1 failed: e)');
  });
});
