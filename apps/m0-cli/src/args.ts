/** 极简的命令行参数解析：位置参数与 `--name value`、`--flag`。 */
export type Args = {
  readonly positionals: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
};

export function parseArgs(argv: readonly string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const [name = '', inline] = arg.slice(2).split('=', 2);
      const next = argv[i + 1];
      if (inline !== undefined) flags[name] = inline;
      else if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

export const flagString = (args: Args, name: string): string | undefined => {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
};

export function flagInt(args: Args, name: string): number | undefined | 'invalid' {
  const v = flagString(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : 'invalid';
}
