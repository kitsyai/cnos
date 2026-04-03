export function consumeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);

  if (index >= 0) {
    args.splice(index, 1);
    return true;
  }

  return false;
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
