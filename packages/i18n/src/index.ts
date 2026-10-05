import { zhCNMessages, type MessageKey } from "./zh-CN.ts";

export type { MessageKey } from "./zh-CN.ts";
export { zhCNMessages } from "./zh-CN.ts";

export const LOCALE = "zh-CN" as const;

/**
 * Substitution values.
 *
 * Typed as `unknown` because every call site this replaced used template
 * interpolation, which accepts anything: `null` and `undefined` stringify to
 * "null" and "undefined" rather than disappearing, and an Effect `catch`
 * parameter arrives as `unknown`. `String()` below reproduces exactly that, so
 * converting a call site cannot change what the user sees. The *key* stays
 * strongly typed, which is where the real safety is.
 */
type Params = Readonly<Record<string, unknown>>;

/**
 * Translate a typed message key from this fork's single Simplified Chinese
 * catalog.
 *
 * Locale data is statically bundled, so web, desktop and mobile never depend on
 * a runtime fetch and can never silently fall back to English. The key type is
 * derived from the catalog, so a typo or a key that was never added fails the
 * typecheck instead of rendering as a raw identifier.
 *
 * Placeholders use `{name}` and are substituted verbatim; Chinese has no plural
 * forms, so there is no count-based branching to model here.
 */
export function t(key: MessageKey, params?: Params): string {
  let message: string = zhCNMessages[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      message = message.split(`{${name}}`).join(String(value));
    }
  }
  return message;
}

export const i18n = {
  locale: LOCALE,
  t,
} as const;

export function createI18n() {
  return i18n;
}
