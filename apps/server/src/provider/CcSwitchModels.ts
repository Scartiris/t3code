import type { ProviderInstanceEnvironment, ServerProvider } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeCatalog = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      selected: Schema.NonEmptyString,
      models: Schema.Array(Schema.NonEmptyString),
    }),
  ),
);

/** A gateway instance advertises only the models routed by its CC Switch profile. */
export function withCcSwitchModels<A>(
  environment: ProviderInstanceEnvironment,
  stamp: (value: A) => ServerProvider,
): (value: A) => ServerProvider {
  const catalog = decodeCatalog(
    environment.find((entry) => entry.name === "T3CODE_CC_SWITCH_MODELS")?.value,
  );
  if (Option.isNone(catalog)) return stamp;
  const { selected, models } = catalog.value;
  return (value) => {
    const snapshot = stamp(value);
    return {
      ...snapshot,
      modelsAreComplete: true,
      models: models.map((slug) => {
        const existing = snapshot.models.find((model) => model.slug === slug);
        return {
          ...(existing ?? { slug, name: slug, isCustom: true, capabilities: null }),
          aliases: [],
          isDefault: slug === selected,
        };
      }),
    };
  };
}
