/**
 * Re-export of the shared message catalog.
 *
 * The catalog lives in @t3tools/i18n rather than here so that packages/contracts
 * can translate its error messages too: contracts is a leaf that everything else
 * depends on, so it cannot import from @t3tools/shared without creating a cycle.
 *
 * This subpath stays as the public entry point for the apps.
 */
export * from "@t3tools/i18n";
