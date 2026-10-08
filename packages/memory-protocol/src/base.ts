import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/** Trims both ends on decode and encode, so a stored value never carries padding. */
export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);

export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** Milliseconds since the Unix epoch. Chosen over ISO strings because every consumer sorts and ages them. */
export const EpochMillis = NonNegativeInt;

export const UnitInterval = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1 }),
).annotate({ description: "A number between 0 and 1 inclusive." });

export const MemoryId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("MemoryId"),
);
export type MemoryId = typeof MemoryId.Type;
