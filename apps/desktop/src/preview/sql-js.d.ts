// sql.js 的类型：只写浏览器预览用到的部分（不引入 @types/sql.js，它会把 Node 的类型带进工作区）。
declare module 'sql.js' {
  export type SqlJsValue = number | string | Uint8Array | null;

  export interface Statement {
    bind(values?: readonly SqlJsValue[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlJsValue>;
    free(): boolean;
  }

  export interface Database {
    exec(sql: string): unknown;
    run(sql: string, params?: readonly SqlJsValue[]): Database;
    prepare(sql: string): Statement;
    getRowsModified(): number;
  }

  export interface SqlJsStatic {
    readonly Database: new () => Database;
  }

  export default function initSqlJs(config?: { readonly locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}

declare module 'sql.js/dist/sql-wasm.wasm?url' {
  const url: string;
  export default url;
}
