import { findHelpCommand, HELP_DOCUMENT, type HelpCommand, type HelpOption } from '../cli/helpRegistry.js';

function formatOptions(title: string, options: HelpOption[] | undefined): string[] {
  if (!options || options.length === 0) {
    return [];
  }

  return [title, ...options.map((option) => `  ${option.flag.padEnd(24, ' ')} ${option.description}`)];
}

function formatCommandHelp(command: HelpCommand): string {
  const lines = [`Usage: ${command.usage}`, '', command.summary, '', command.description];

  if (command.arguments && command.arguments.length > 0) {
    lines.push('', 'Arguments');
    lines.push(
      ...command.arguments.map((argument) => {
        const suffix = argument.required ? ' (required)' : '';
        return `  ${argument.name}${suffix}: ${argument.description}`;
      }),
    );
  }

  lines.push(...(command.options && command.options.length > 0 ? ['', ...formatOptions('Options', command.options)] : []));
  lines.push('', ...formatOptions('Global options', HELP_DOCUMENT.globalOptions));

  if (command.examples && command.examples.length > 0) {
    lines.push('', 'Examples', ...command.examples.map((example) => `  ${example}`));
  }

  return lines.join('\n');
}

function formatRootHelp(): string {
  const lines = [
    HELP_DOCUMENT.summary,
    '',
    `Usage: ${HELP_DOCUMENT.usage}`,
    '',
    'Commands',
    ...HELP_DOCUMENT.commands
      .filter((command) => !command.id.includes(' '))
      .map((command) => `  ${command.id.padEnd(12, ' ')} ${command.summary}`),
    '',
    'Framework integrations',
    ...HELP_DOCUMENT.integrations.map(
      (integration) =>
        `  ${integration.id.padEnd(12, ' ')} ${integration.packageName} via ${integration.entrypoint}`,
    ),
    '',
    ...formatOptions('Global options', HELP_DOCUMENT.globalOptions),
    '',
    'Examples',
    ...HELP_DOCUMENT.examples.map((example) => `  ${example}`),
  ];

  return lines.join('\n');
}

export function runHelp(topic?: string): string {
  const command = findHelpCommand(topic);

  if (!command) {
    return formatRootHelp();
  }

  return formatCommandHelp(command);
}
