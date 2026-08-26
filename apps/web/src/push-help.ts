/**
 * Pure, DOM-free guidance for the "Notifications unavailable" help dialog.
 *
 * Given a user-agent string and a couple of environment booleans gathered at
 * the call site, this maps a device/browser combination to concise, accurate
 * instructions for enabling Web Push (or installing the app so push becomes
 * available). It is intentionally free of any DOM or global access so it can
 * be unit-tested without a browser.
 */

export interface PushHelpEnvironment {
  /** `navigator.userAgent`. */
  userAgent: string;
  /** Whether the page is running as an installed / standalone web app. */
  standalone: boolean;
  /** `window.isSecureContext` — Web Push requires a secure context. */
  secureContext: boolean;
  /**
   * `navigator.maxTouchPoints`. iPadOS Safari reports a Macintosh user agent,
   * so the platform can only be told apart from a desktop Mac by the presence
   * of touch. Pass it in rather than sniffing globals inside this function.
   */
  touchPoints?: number;
}

export interface PushHelpGuidance {
  title: string;
  steps: string[];
  note?: string;
}

type Brand = "edge" | "chrome" | "firefox" | "safari" | "other";

/**
 * Detects the browser brand. Order matters: Edge's UA contains both "Chrome"
 * and "Safari", and Chrome's contains "Safari", so the more specific brands
 * are checked first. The iOS variants (EdgiOS/CriOS/FxiOS) and the Android
 * Edge variant (EdgA) are matched too.
 */
function detectBrand(ua: string): Brand {
  if (/Edg(iOS|A|)?\//.test(ua)) {
    return "edge";
  }
  if (/CriOS\//.test(ua) || /Chrome\//.test(ua) || /Chromium\//.test(ua)) {
    return "chrome";
  }
  if (/FxiOS\//.test(ua) || /Firefox\//.test(ua)) {
    return "firefox";
  }
  if (/Safari\//.test(ua)) {
    return "safari";
  }
  return "other";
}

/**
 * True for iPhone/iPod/iPad, and for iPadOS Safari which masquerades as a
 * Macintosh but reports more than one touch point.
 */
function isApplePlatform(ua: string, touchPoints: number): boolean {
  if (/iPhone|iPod|iPad/.test(ua)) {
    return true;
  }
  return /Macintosh/.test(ua) && touchPoints > 1;
}

function isIPad(ua: string, touchPoints: number): boolean {
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

function appleDeviceNoun(ua: string, touchPoints: number): string {
  return isIPad(ua, touchPoints) ? "iPad" : "iPhone";
}

function iosNotInstalled(env: PushHelpEnvironment): PushHelpGuidance {
  const device = appleDeviceNoun(env.userAgent, env.touchPoints ?? 0);
  const brand = detectBrand(env.userAgent);
  const openStep =
    "Open Notification CLI from its new Home Screen icon and enable notifications here.";

  if (brand === "safari") {
    return {
      title: `Add to your ${device}'s Home Screen`,
      steps: [
        "Tap the Share button (the square with an arrow) in Safari's toolbar.",
        'Choose "Add to Home Screen", then tap "Add".',
        openStep,
      ],
      note: "On iPhone and iPad, notifications only work for web apps opened from the Home Screen (iOS/iPadOS 16.4 or later).",
    };
  }

  return {
    title: `Add to your ${device}'s Home Screen`,
    steps: [
      'Open the browser menu (the "..." or Share icon).',
      'Choose "Add to Home Screen", then confirm with "Add".',
      openStep,
    ],
    note: "On iPhone and iPad, notifications only work for web apps opened from the Home Screen (iOS/iPadOS 16.4 or later). Every iOS browser uses the same engine, so this works in Safari, Edge, Chrome and Firefox.",
  };
}

function iosInstalled(env: PushHelpEnvironment): PushHelpGuidance {
  const device = appleDeviceNoun(env.userAgent, env.touchPoints ?? 0);
  return {
    title: `Update your ${device}`,
    steps: [
      "Web Push needs iOS/iPadOS 16.4 or later.",
      `Open Settings → General → Software Update and install the latest ${device} update.`,
      "Reopen this app from the Home Screen and try again.",
    ],
  };
}

function macosSafari(): PushHelpGuidance {
  return {
    title: "Update Safari to enable notifications",
    steps: [
      "Web Push works in Safari 16.1 or later, so install the latest macOS and Safari updates.",
      "Check Safari → Settings → Websites → Notifications and allow this site.",
      "On macOS Sonoma or later you can also add this site to the Dock (File → Add to Dock) and open it from there.",
    ],
  };
}

function androidChromiumBrand(brand: Brand): PushHelpGuidance {
  const menu = brand === "edge" ? "⋯" : "⋮";
  return {
    title: "Allow notifications for this site",
    steps: [
      `Tap the ${menu} menu → Settings → Site settings → Notifications and make sure this site is allowed.`,
      "Alternatively tap the lock icon in the address bar → Permissions → Notifications.",
      `Install the app for reliable delivery: ${menu} menu → "Install app" / "Add to Home screen".`,
      "In Android Settings → Apps → your browser → Notifications, confirm notifications are turned on.",
    ],
  };
}

function androidFirefox(): PushHelpGuidance {
  return {
    title: "Allow notifications for this site",
    steps: [
      "Tap the ⋮ menu → Settings → Site permissions → Notifications and allow this site.",
      "Or tap the lock icon in the address bar → Clear permissions, then allow notifications when prompted.",
      "In Android Settings → Apps → Firefox → Notifications, confirm notifications are turned on.",
    ],
  };
}

function desktopChromiumBrand(brand: Brand): PushHelpGuidance {
  const menu = brand === "edge" ? "⋯" : "⋮";
  return {
    title: "Allow notifications for this site",
    steps: [
      "Click the lock / tune icon in the address bar → Site settings, and set Notifications to Allow.",
      `Or open the ${menu} menu → Settings → Privacy and security → Site settings → Notifications.`,
      "In Windows, check Settings → System → Notifications and turn off Do not disturb / Focus assist.",
    ],
    note: "Web Push is disabled in private / guest windows and can be blocked by an enterprise policy — try a normal window or a personal profile.",
  };
}

function desktopFirefox(): PushHelpGuidance {
  return {
    title: "Allow notifications for this site",
    steps: [
      "Click the lock icon in the address bar → Connection secure → More information → Permissions, then clear or allow Send Notifications.",
      "Or open Settings → Privacy & Security → Permissions → Notifications → Settings and allow this site.",
      "In Windows, check Settings → System → Notifications and turn off Do not disturb / Focus assist.",
    ],
    note: "Web Push is disabled in Private Browsing windows — try a normal window.",
  };
}

function insecureContext(): PushHelpGuidance {
  return {
    title: "Open this app over HTTPS",
    steps: [
      "Web Push is only available on secure (HTTPS) connections.",
      "Reload this page using its https:// address.",
      "If you are running it locally, use https or localhost rather than a plain http address.",
    ],
  };
}

function genericFallback(): PushHelpGuidance {
  return {
    title: "Enable notifications for this app",
    steps: [
      "Use a current version of Safari, Chrome, Edge or Firefox.",
      "Allow notifications for this site in your browser's site settings.",
      'If the browser offers "Install app" or "Add to Home Screen", install it and open the app from there.',
    ],
    note: "Web Push is disabled in private / incognito windows.",
  };
}

/**
 * Maps an environment to help content. Precedence is deliberate:
 *   1. Insecure context (a hard HTTPS requirement, whatever the browser).
 *   2. Apple platforms (iOS/iPadOS is a hard platform restriction regardless
 *      of the browser brand, because every iOS browser is WebKit).
 *   3. macOS Safari.
 *   4. Android (Chromium brands, then Firefox).
 *   5. Desktop (Chromium brands, then Firefox).
 *   6. A generic fallback for anything unrecognised.
 */
export function pushHelpGuidance(env: PushHelpEnvironment): PushHelpGuidance {
  if (env.secureContext === false) {
    return insecureContext();
  }

  const ua = env.userAgent;
  const touchPoints = env.touchPoints ?? 0;
  const brand = detectBrand(ua);

  if (isApplePlatform(ua, touchPoints)) {
    return env.standalone ? iosInstalled(env) : iosNotInstalled(env);
  }

  if (/Macintosh/.test(ua) && brand === "safari") {
    return macosSafari();
  }

  if (/Android/.test(ua)) {
    if (brand === "firefox") {
      return androidFirefox();
    }
    if (brand === "chrome" || brand === "edge") {
      return androidChromiumBrand(brand);
    }
    return genericFallback();
  }

  if (brand === "chrome" || brand === "edge") {
    return desktopChromiumBrand(brand);
  }
  if (brand === "firefox") {
    return desktopFirefox();
  }

  return genericFallback();
}
