import * as Schema from 'effect/Schema';

export class CliError extends Schema.TaggedError<CliError>()('CliError', {
  message: Schema.String,
}) {}

export const cliError = (message: string): CliError => new CliError({ message });

export const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
