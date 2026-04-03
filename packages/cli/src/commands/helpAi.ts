import { consumeOption } from '../cli/commandOptions.js';
import { findHelpCommand, HELP_DOCUMENT } from '../cli/helpRegistry.js';
import { printJson } from '../format/printJson.js';

export function runHelpAi(topic?: string, cliArgs: string[] = []): string {
  const helpArgs = [...cliArgs];
  const format = consumeOption(helpArgs, '--format') ?? 'json';
  const command = topic ? findHelpCommand(topic) : undefined;

  if (helpArgs.length > 0) {
    throw new Error(`Unsupported help-ai arguments: ${helpArgs.join(' ')}`);
  }

  const payload = topic
    ? {
        cli: HELP_DOCUMENT.name,
        summary: HELP_DOCUMENT.summary,
        globalOptions: HELP_DOCUMENT.globalOptions,
        command,
      }
    : {
        cli: HELP_DOCUMENT.name,
        summary: HELP_DOCUMENT.summary,
        usage: HELP_DOCUMENT.usage,
        description: HELP_DOCUMENT.description,
        globalOptions: HELP_DOCUMENT.globalOptions,
        commands: HELP_DOCUMENT.commands,
      };

  if (topic && !command) {
    throw new Error(`Unknown help topic: ${topic}`);
  }

  if (format === 'text') {
    return topic
      ? `cnos help-ai ${topic} emits JSON by default. Re-run with --format json for structured output.`
      : 'cnos help-ai emits JSON by default. Re-run with --format json for structured output.';
  }

  if (format !== 'json') {
    throw new Error(`Unsupported help-ai format: ${format}`);
  }

  return printJson(payload);
}
