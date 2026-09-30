// The project owns these types instead of using PagesFunction/EventContext. The Pages runtime passes
// a superset of this contract, but the generated types require every binding (e.g. ASSETS) and the
// IncomingRequestCfProperties flavour of Request, which makes the handlers impossible to test with
// plain objects. Handlers declare only what they read; bindings are optional and checked at runtime.

/** Structural subset of R2Bucket that the functions use. */
export interface AssetBucket {
  get(key: string): Promise<{ body: ReadableStream | null } | null>;
}

export interface AppEnv {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
  TURN_TTL_SECONDS?: string;
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_DEV_BYPASS?: string;
  CF_PAGES_BRANCH?: string;
  CF_PAGES_COMMIT_SHA?: string;
  ASSETS_R2?: AssetBucket;
}

export interface AppContext {
  readonly request: Request;
  readonly env: AppEnv;
  next(): Promise<Response>;
}
