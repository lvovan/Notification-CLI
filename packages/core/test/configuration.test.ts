import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigurationError,
  PLACEHOLDER_PREFIX,
  hasSetting,
  isPlaceholderSetting,
  optionalSetting,
  requireSetting,
} from "@notification-cli/core/configuration";

const SETTING = "NOTIFICATION_CLI_EXAMPLE";
const placeholder = `${PLACEHOLDER_PREFIX} what belongs here`;

test("a real value is read back unchanged", () => {
  const env = { [SETTING]: "  value  " };

  assert.equal(optionalSetting(env, SETTING), "value");
  assert.equal(requireSetting(env, SETTING), "value");
  assert.equal(hasSetting(env, SETTING), true);
});

test("a placeholder counts as unset", () => {
  // The infrastructure template creates these so the App Service blade lists
  // every value an operator still has to supply. Reading one as configuration
  // would send a prompt to Entra ID as a client secret, or sign session
  // cookies with a key published in the repository.
  const env = { [SETTING]: placeholder };

  assert.equal(optionalSetting(env, SETTING), undefined);
  assert.equal(hasSetting(env, SETTING), false);
  assert.throws(
    () => requireSetting(env, SETTING),
    (error: unknown) =>
      error instanceof ConfigurationError && error.setting === SETTING,
  );
});

test("the marker is recognised despite leading whitespace", () => {
  assert.equal(isPlaceholderSetting(` ${placeholder}`), true);
  assert.equal(isPlaceholderSetting(undefined), false);
  assert.equal(isPlaceholderSetting(""), false);
  // The marker only counts at the start, so a value that merely mentions it is
  // still a value.
  assert.equal(isPlaceholderSetting(`key-${PLACEHOLDER_PREFIX}`), false);
});

test("a missing or blank setting is unset", () => {
  assert.equal(optionalSetting({}, SETTING), undefined);
  assert.equal(optionalSetting({ [SETTING]: "   " }, SETTING), undefined);
  assert.equal(hasSetting({}, SETTING), false);
});
