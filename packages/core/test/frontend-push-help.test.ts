import assert from "node:assert/strict";
import test from "node:test";
import {
  pushHelpGuidance,
  type PushHelpEnvironment,
} from "../../../apps/web/src/push-help.js";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  iphoneEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 EdgiOS/121.0.2277.107 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1",
  ipadOsSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15",
  macosSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  androidEdge:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.2210.144",
  androidFirefox:
    "Mozilla/5.0 (Android 13; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.144",
  windowsFirefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
} as const;

function env(overrides: Partial<PushHelpEnvironment>): PushHelpEnvironment {
  return {
    userAgent: "",
    standalone: false,
    secureContext: true,
    touchPoints: 0,
    ...overrides,
  };
}

function joined(steps: string[]): string {
  return steps.join(" \u2016 ");
}

test("insecure context wins over every user-agent branch", () => {
  const guidance = pushHelpGuidance(
    env({ userAgent: UA.windowsChrome, secureContext: false }),
  );
  assert.match(guidance.title, /HTTPS/i);
  assert.match(joined(guidance.steps), /HTTPS/i);
});

test("iPhone Safari, not installed, points at the Share sheet", () => {
  const guidance = pushHelpGuidance(env({ userAgent: UA.iphoneSafari }));
  assert.match(guidance.title, /iPhone/);
  assert.match(guidance.title, /Home Screen/);
  const steps = joined(guidance.steps);
  assert.match(steps, /Share/);
  assert.match(steps, /Add to Home Screen/);
  assert.match(guidance.note ?? "", /16\.4/);
});

test("iPhone Edge (EdgiOS) still uses the Add to Home Screen path", () => {
  const guidance = pushHelpGuidance(env({ userAgent: UA.iphoneEdge }));
  assert.match(guidance.title, /iPhone/);
  assert.match(joined(guidance.steps), /Add to Home Screen/);
  // Every iOS browser is WebKit, so the note should say so.
  assert.match(guidance.note ?? "", /Safari, Edge, Chrome/);
});

test("iPhone Chrome (CriOS) is detected as iOS, not desktop Chrome", () => {
  const guidance = pushHelpGuidance(env({ userAgent: UA.iphoneChrome }));
  assert.match(guidance.title, /Home Screen/);
  assert.match(joined(guidance.steps), /Add to Home Screen/);
});

test("iPadOS Safari (Macintosh UA + touch) is treated as an iPad", () => {
  const guidance = pushHelpGuidance(
    env({ userAgent: UA.ipadOsSafari, touchPoints: 5 }),
  );
  assert.match(guidance.title, /iPad/);
  assert.match(joined(guidance.steps), /Add to Home Screen/);
});

test("iOS already installed but unsupported asks to update to 16.4", () => {
  const guidance = pushHelpGuidance(
    env({ userAgent: UA.iphoneSafari, standalone: true }),
  );
  assert.match(guidance.title, /Update/);
  assert.match(joined(guidance.steps), /16\.4/);
  assert.match(joined(guidance.steps), /Software Update/);
});

test("macOS Safari (no touch) advises updating Safari and the Dock", () => {
  const guidance = pushHelpGuidance(
    env({ userAgent: UA.macosSafari, touchPoints: 0 }),
  );
  assert.match(guidance.title, /Safari/);
  const steps = joined(guidance.steps);
  assert.match(steps, /16\.1/);
  assert.match(steps, /Dock/);
});

test("Android Chrome checks site permission and offers Install app", () => {
  const guidance = pushHelpGuidance(env({ userAgent: UA.androidChrome }));
  const steps = joined(guidance.steps);
  assert.match(steps, /Notifications/);
  assert.match(steps, /Install app/);
  assert.match(steps, /lock icon/);
});

test("Android Edge (EdgA) is handled like the other Chromium browsers", () => {
  const guidance = pushHelpGuidance(env({ userAgent: UA.androidEdge }));
  assert.match(joined(guidance.steps), /Notifications/);
  assert.match(joined(guidance.steps), /Install app/);
});

test("Android Firefox checks site permissions", () => {
  const guidance = pushHelpGuidance(env({ userAgent: UA.androidFirefox }));
  const steps = joined(guidance.steps);
  assert.match(steps, /Firefox/);
  assert.match(steps, /Site permissions|permissions/i);
  assert.match(steps, /Notifications/);
});

test("Windows Chrome blames private windows / policy and OS settings", () => {
  const guidance = pushHelpGuidance(env({ userAgent: UA.windowsChrome }));
  assert.match(joined(guidance.steps), /Notifications/);
  assert.match(joined(guidance.steps), /Focus assist|Do not disturb/);
  assert.match(guidance.note ?? "", /private|guest|policy/i);
});

test("Windows Edge is detected before Chrome despite the shared UA", () => {
  const guidance = pushHelpGuidance(env({ userAgent: UA.windowsEdge }));
  // The ⋯ menu wording is Edge-specific.
  assert.match(joined(guidance.steps), /\u22EF/);
  assert.match(guidance.note ?? "", /private|guest|policy/i);
});

test("Windows Firefox mentions Private Browsing and site permissions", () => {
  const guidance = pushHelpGuidance(env({ userAgent: UA.windowsFirefox }));
  assert.match(joined(guidance.steps), /Notifications/);
  assert.match(guidance.note ?? "", /Private Browsing/i);
});

test("an unknown user agent falls back to generic, safe advice", () => {
  const guidance = pushHelpGuidance(
    env({ userAgent: "SomeUnknownBot/1.0" }),
  );
  const steps = joined(guidance.steps);
  assert.match(steps, /Safari, Chrome, Edge or Firefox/);
  assert.match(steps, /Allow notifications|allow notifications/);
  assert.match(guidance.note ?? "", /private|incognito/i);
});

test("every branch returns a non-empty title and at least two steps", () => {
  for (const userAgent of Object.values(UA)) {
    for (const standalone of [false, true]) {
      const guidance = pushHelpGuidance(
        env({ userAgent, standalone, touchPoints: 5 }),
      );
      assert.ok(guidance.title.length > 0, `empty title for ${userAgent}`);
      assert.ok(
        guidance.steps.length >= 2,
        `too few steps for ${userAgent}`,
      );
      for (const step of guidance.steps) {
        assert.ok(step.trim().length > 0, "empty step");
      }
    }
  }
});
