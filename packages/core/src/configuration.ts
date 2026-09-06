export class ConfigurationError extends Error {
  constructor(
    public readonly setting: string,
    message = `${setting} is not configured.`,
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Marks a setting the infrastructure template created but nobody has filled in
 * yet.
 *
 * The template writes a placeholder for every value it cannot derive, so each
 * one is visible in the App Service configuration blade carrying a note saying
 * what belongs there. Without that, a missing setting is invisible: the blade
 * shows nothing at all, and the operator has to consult the documentation to
 * discover which variables even exist.
 *
 * The cost of making them visible is that the process now starts with values
 * that look configured but are not, so every read has to recognise the marker
 * and report the setting as absent. Doing that here, rather than at each call
 * site, is what keeps a placeholder from being sent to Entra ID as a client
 * secret or used to sign session cookies.
 */
export const PLACEHOLDER_PREFIX = "TODO:";

export function isPlaceholderSetting(value: string | undefined): boolean {
  return value?.trimStart().startsWith(PLACEHOLDER_PREFIX) ?? false;
}

/** The setting's value, or undefined when it is unset or still a placeholder. */
export function optionalSetting(
  env: NodeJS.ProcessEnv,
  setting: string,
): string | undefined {
  const value = env[setting]?.trim();
  return value && !isPlaceholderSetting(value) ? value : undefined;
}

export function requireSetting(
  env: NodeJS.ProcessEnv,
  setting: string,
): string {
  const value = optionalSetting(env, setting);
  if (!value) {
    throw new ConfigurationError(setting);
  }
  return value;
}

export function hasSetting(
  env: NodeJS.ProcessEnv,
  setting: string,
): boolean {
  return optionalSetting(env, setting) !== undefined;
}
