import { i18n } from "@t3tools/shared/i18n";

/**
 * Access the statically bundled Simplified Chinese message catalog.
 *
 * Components that only need to render a string can import `t` directly from
 * `@t3tools/shared/i18n`; this hook exists for the call sites that already read
 * the catalog as an object.
 */
export function useI18n() {
  return i18n;
}
