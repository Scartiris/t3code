import { t } from "@t3tools/shared/i18n";
import * as Schema from "effect/Schema";

export class NativeViewResolutionError extends Schema.TaggedError<NativeViewResolutionError>()(
  "NativeViewResolutionError",
  {
    nativeModuleName: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return t("native.nativeViewResolutionError.resolveFailed", {
      nativeModuleName: this.nativeModuleName,
    });
  }
}
