export function consumeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);

  if (index >= 0) {
    args.splice(index, 1);
    return true;
  }

  return false;
}

export function consumePrivateFlag(args: string[]): boolean {
  let consumed = false;

  for (const flag of ['--private', '--incog', '--anonymous']) {
    while (consumeFlag(args, flag)) {
      consumed = true;
    }
  }

  return consumed;
}

export function consumeOption(args: string[], flag: string): string | undefined {
  const inline = args.find((entry) => entry.startsWith(`${flag}=`));

  if (inline) {
    args.splice(args.indexOf(inline), 1);
    return inline.slice(flag.length + 1);
  }

  const index = args.indexOf(flag);

  if (index >= 0) {
    const value = args[index + 1];

    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }

    args.splice(index, 2);
    return value;
  }

  return undefined;
}

export function consumeOptions(args: string[], flag: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (!token) {
      continue;
    }

    if (token.startsWith(`${flag}=`)) {
      values.push(token.slice(flag.length + 1));
      args.splice(index, 1);
      index -= 1;
      continue;
    }

    if (token === flag) {
      const value = args[index + 1];

      if (!value) {
        throw new Error(`Missing value for ${flag}`);
      }

      values.push(value);
      args.splice(index, 2);
      index -= 1;
    }
  }

  return values;
}
