import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repoPath } from "./paths.js";
import test from "node:test";

const installerPath = repoPath("installer", "NotificationCLI.wxs");
const workflowPath = repoPath(".github", "workflows", "deploy.yml");

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
  const windowsArtifactBlocks = [
    ...workflow.matchAll(
      /^([^\S\r\n]*)- name: .*(?:\r?\n(?!\1- name: ).*)*/gm,
    ),
  ]
    .map((match) => match[0])
    .filter(
      (step) =>
        step.includes("uses: actions/upload-artifact@") &&
        /^\s+name: NotificationCLI-windows[^\r\n]*/m.test(step),
    );

  assert.equal(
    windowsArtifactBlocks.length,
    architectures.length,
    `expected ${architectures.length} NotificationCLI-windows upload-artifact steps`,
  );

  for (const architecture of architectures) {
    const artifactName = `NotificationCLI-windows-${architecture}`;
    const artifact = windowsArtifactBlocks.find((step) =>
      new RegExp(`^\\s+name: ${artifactName}$`, "m").test(step),
    );
    assert.ok(artifact, `missing ${artifactName} artifact`);
    const payload = artifact;

    assert.ok(
      payload.includes(`artifacts/notify-${architecture}.exe`),
      `missing executable for ${architecture}`,
    );
    assert.ok(
      payload.includes(`artifacts/NotificationCLI-${architecture}.msi`),
      `missing installer for ${architecture}`,
    );
    assert.match(
      artifact,
      /^\s+if-no-files-found: error$/m,
      `${artifactName} must fail when files are missing`,
    );
  }

  for (const artifact of windowsArtifactBlocks) {
    const artifactName =
      /^\s+name: (NotificationCLI-windows[^\r\n]*)/m.exec(artifact)?.[1] ?? "";
    const payloadArchitectures = architectures.filter(
      (architecture) =>
        artifact.includes(`artifacts/notify-${architecture}.exe`) ||
        artifact.includes(`artifacts/NotificationCLI-${architecture}.msi`),
    );
    assert.equal(
      payloadArchitectures.length,
      1,
      `${artifactName} must not publish multiple Windows architectures`,
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
