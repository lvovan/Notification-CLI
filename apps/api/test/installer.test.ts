import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const installerPath = resolve("../../installer/NotificationCLI.wxs");
const workflowPath = resolve("../../.github/workflows/deploy.yml");

const architectures = ["x64", "arm64"];

test("the installer embeds its cabinet", async () => {
  const installer = await readFile(installerPath, "utf8");

  // An external cab1.cab is left behind next to the MSI, so every download of
  // the installer on its own fails with "Source file not found".
  assert.match(installer, /<MediaTemplate\s+EmbedCab="yes"\s*\/>/);
});

test("the installer puts notify.exe on the PATH", async () => {
  const installer = await readFile(installerPath, "utf8");

  // The source file is named per architecture, so the installed name has to be
  // stated rather than inherited.
  assert.match(installer, /<File\s+Id="NotifyExe"\s+Name="notify\.exe"/);

  const environment = /<Environment[\s\S]*?\/>/.exec(installer)?.[0] ?? "";
  assert.match(environment, /Name="PATH"/);
  assert.match(environment, /Value="\[INSTALLFOLDER\]"/);
  // Appending to the machine PATH, and removing it again on uninstall.
  assert.match(environment, /Action="set"/);
  assert.match(environment, /Part="last"/);
  assert.match(environment, /System="yes"/);
  assert.match(environment, /Permanent="no"/);
});

test("the workflow ships an executable and an installer per architecture", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  for (const architecture of architectures) {
    assert.ok(
      workflow.includes(`artifacts/notify-${architecture}.exe`),
      `missing executable for ${architecture}`,
    );
    assert.ok(
      workflow.includes(`artifacts/NotificationCLI-${architecture}.msi`),
      `missing installer for ${architecture}`,
    );
  }

  // Both architectures come off the one x64 runner.
  assert.match(workflow, /GOOS: windows/);
  assert.match(workflow, /\$env:GOARCH = if \(\$architecture -eq "x64"\)/);
  // A stray cabinet means the embedded payload regressed.
  assert.match(workflow, /unexpected external cabinet/);
});

test("the workflow ships a universal macOS package", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /runs-on: macos-latest/);
  // One universal binary rather than one download per Mac architecture.
  assert.match(workflow, /lipo -create -output/);
  // /usr/local/bin is on the default PATH, which is what makes this the
  // equivalent of the MSI's PATH entry.
  assert.match(workflow, /--install-location \/usr\/local\/bin/);
  assert.ok(workflow.includes("artifacts/NotificationCLI-macos.pkg"));
});
