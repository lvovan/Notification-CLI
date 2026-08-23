export class ConfigurationError extends Error {
  constructor(
    public readonly setting: string,
    message = `${setting} is not configured.`,
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function requireSetting(
  env: NodeJS.ProcessEnv,
  setting: string,
): string {
  const value = env[setting]?.trim();
  if (!value) {
    throw new ConfigurationError(setting);
  }
  return value;
}

export function hasSetting(
  env: NodeJS.ProcessEnv,
  setting: string,
): boolean {
  return Boolean(env[setting]?.trim());
}
