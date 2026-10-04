/**
 * Render pipelines compiled before the game starts, instead of inside the frame that first draws
 * with them.
 *
 * Why before, and not asynchronously during the game: the game is one `callMain` that never yields
 * (worker.ts), so a promise -- `createRenderPipelineAsync`'s included -- cannot settle until it
 * returns. Inside the frame the backend can only call `createRenderPipeline`, and on the iPhone that
 * is where the freezes were: 31 frames of up to 8.9 s, with 19 pipelines created in the worst
 * (operator report doc_b8bb558c2eb3). Before `callMain` the worker can await.
 *
 * Which pipelines: the ones this device's earlier sessions of the same core compiled inside a frame.
 * The backend reports each (gx_webgpu.cpp, `gpu.onPipeline`) with its draw state and WGSL; the page
 * keeps them in IndexedDB under the core's commit; the next session compiles them all at once here
 * and hands them to the backend (`gpu.warm`), which then compiles in a frame only what is new. The
 * first session of a core compiles in its frames as before.
 */

/** A pipeline's draw state and shader: what gxw_draw passes to `gpu.pipelineDescriptor`. */
export interface PipelineRecipe {
  lines: number;
  cull: number;
  zmode: number;
  blendBits: number;
  efbAlpha: number;
  code: string;
}

/** The backend side this module uses: gx_webgpu.cpp's gxw_open defines the descriptor function. */
export interface WarmableGpu {
  device: {
    createShaderModule(descriptor: { label?: string; code: string }): unknown;
    createRenderPipelineAsync(descriptor: unknown): Promise<unknown>;
  };
  pipelineDescriptor?: (module: unknown, label: string, lines: number, cull: number, zmode: number,
    blendBits: number, efbAlpha: number) => unknown;
  warm?: Map<string, unknown>;
  warmHits?: number;
  onPipeline?: (recipe: PipelineRecipe) => void;
}

export interface WarmResult {
  requested: number;
  ready: number;
  failed: number;
  ms: number;
  firstError: string | null;
}

/** gxw_draw's key for a pipeline in `gpu.warm`. */
export function recipeKey(r: PipelineRecipe): string {
  return `${r.lines}:${r.cull}:${r.zmode}:${r.blendBits}:${r.efbAlpha}\n${r.code}`;
}

export function isRecipe(value: unknown): value is PipelineRecipe {
  const r = value as PipelineRecipe | null;
  return !!r && typeof r === 'object' && typeof r.code === 'string' &&
    [r.lines, r.cull, r.zmode, r.blendBits, r.efbAlpha].every((n) => Number.isInteger(n));
}

/**
 * Compile every recipe at once and put each pipeline that compiles into `gpu.warm`. One module per
 * distinct WGSL text, as the backend shares one per shader. A recipe that fails is left out: the
 * backend compiles it in its frame, as it would have without this.
 */
export async function warmPipelines(gpu: WarmableGpu, recipes: readonly PipelineRecipe[],
  now: () => number): Promise<WarmResult> {
  const started = now();
  const result: WarmResult = { requested: 0, ready: 0, failed: 0, ms: 0, firstError: null };
  const describe = gpu.pipelineDescriptor;
  if (!describe) return result;
  const warm = gpu.warm ?? new Map<string, unknown>();
  gpu.warm = warm;
  const modules = new Map<string, unknown>();
  const unique = new Map<string, PipelineRecipe>();
  for (const r of recipes) if (isRecipe(r)) unique.set(recipeKey(r), r);
  result.requested = unique.size;
  await Promise.all([...unique].map(async ([key, r]) => {
    try {
      let module = modules.get(r.code);
      if (!module) modules.set(r.code, module = gpu.device.createShaderModule({ label: 'gx shader (warm)', code: r.code }));
      const descriptor = describe(module, `warm ${r.lines}:${r.cull}:${r.zmode}:${r.blendBits}:${r.efbAlpha}`,
        r.lines, r.cull, r.zmode, r.blendBits, r.efbAlpha);
      warm.set(key, await gpu.device.createRenderPipelineAsync(descriptor));
      result.ready++;
    } catch (error) {
      result.failed++;
      result.firstError ??= String(error);
    }
  }));
  result.ms = now() - started;
  return result;
}

/** The report's line for a warm-up. */
export function warmNote(result: WarmResult, cached: number): string {
  if (!cached) return 'render pipelines: none known for this core yet; the ones this session needs are compiled in the frame that first draws with them, and kept for the next session';
  return `render pipelines: ${result.ready} of ${result.requested} compiled before the game in ${Math.round(result.ms)} ms` +
    (result.failed ? ` (${result.failed} failed: ${result.firstError})` : '');
}

const DB = 'melee-render-pipelines', STORE = 'recipes';
/** Recipes kept per core; past it, a new one is not kept (a core's game uses about a hundred). */
export const RECIPE_LIMIT = 2000;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function open(factory: IDBFactory): Promise<IDBDatabase> {
  const r = factory.open(DB, 1);
  r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
  return request(r);
}
/** Records are keyed `<commit>\n<recipe key>`: one core's recipes are one key range. */
const range = (commit: string): IDBKeyRange => IDBKeyRange.bound(`${commit}\n`, `${commit}\n￿`);

/** This core's recipes; every other core's are deleted, since their WGSL is not this core's. */
export async function loadRecipes(factory: IDBFactory, commit: string): Promise<PipelineRecipe[]> {
  const db = await open(factory);
  try {
    const all = await request(db.transaction(STORE).objectStore(STORE).getAll(range(commit)));
    const write = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const keys = await request(write.getAllKeys());
    for (const key of keys) if (typeof key !== 'string' || !key.startsWith(`${commit}\n`)) write.delete(key);
    return all.filter(isRecipe);
  } finally {
    db.close();
  }
}

/** Keeps the recipes the page received; a store that cannot be opened keeps nothing. */
export class RecipeStore {
  private db: Promise<IDBDatabase> | null = null;
  private count: Promise<number> | null = null;
  constructor(private readonly factory: IDBFactory | undefined, private readonly commit: string) {}

  async add(recipe: PipelineRecipe): Promise<void> {
    if (!this.factory || !isRecipe(recipe)) return;
    this.db ??= open(this.factory);
    const db = await this.db;
    this.count ??= request(db.transaction(STORE).objectStore(STORE).count(range(this.commit)));
    const n = await this.count;
    if (n >= RECIPE_LIMIT) return;
    this.count = Promise.resolve(n + 1);
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(recipe, `${this.commit}\n${recipeKey(recipe)}`));
  }

  close(): void {
    void this.db?.then((db) => db.close(), () => {});
    this.db = null;
  }
}
