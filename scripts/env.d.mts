export declare const REPO_ROOT: string;
export declare const LOCAL_DEFAULTS: Readonly<Record<string, string>>;
export declare function applyLocalDefaults<E extends Record<string, string | undefined>>(env?: E): E;
export declare function required(name: string): string;
export declare function adminUrl(database?: string): string;
