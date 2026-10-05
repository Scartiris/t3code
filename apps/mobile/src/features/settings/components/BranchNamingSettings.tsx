import { BranchNamingMode, type ServerSettingsPatch } from "@t3tools/contracts";
import { t } from "@t3tools/shared/i18n";
import { useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";

const MODES = {
  static: {
    label: t("components.branchNamingSettings.modeStaticLabel"),
    description: t("components.branchNamingSettings.modeStaticDescription"),
  },
  semantic: {
    label: t("components.branchNamingSettings.modeSemanticLabel"),
    description: t("components.branchNamingSettings.modeSemanticDescription"),
  },
  custom: {
    label: t("components.branchNamingSettings.modeCustomLabel"),
    description: t("components.branchNamingSettings.modeCustomDescription"),
  },
} satisfies Record<BranchNamingMode, { label: string; description: string }>;

export function BranchNamingSettings(props: {
  mode: BranchNamingMode | null;
  prefix: string | null;
  instructions: string | null;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const prefixEdited = useRef(false);
  const instructionsEdited = useRef(false);
  return (
    <SettingsSection
      title={t("components.branchNamingSettings.sectionTitle")}
      trailing={
        props.mode === null ? (
          <Text className="text-xs text-foreground-muted">
            {t("components.branchNamingSettings.mixed")}
          </Text>
        ) : null
      }
    >
      {BranchNamingMode.literals.map((mode, index) => (
        <SettingsChoiceRow
          key={mode}
          label={MODES[mode].label}
          description={MODES[mode].description}
          selected={props.mode === mode}
          separated={index > 0}
          disabled={props.disabled}
          onPress={() => props.onChange({ branchNamingMode: mode })}
        />
      ))}
      {props.mode === "static" ? (
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            {t("components.branchNamingSettings.prefixHint")}
          </Text>
          <AppTextInput
            key={props.prefix}
            accessibilityLabel={t("components.branchNamingSettings.prefixA11y")}
            onChangeText={() => {
              prefixEdited.current = true;
            }}
            defaultValue={props.prefix ?? ""}
            placeholder={
              props.prefix === null
                ? t("components.branchNamingSettings.mixed")
                : t("components.branchNamingSettings.noPrefix")
            }
            editable={!props.disabled}
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
            onEndEditing={(event) => {
              const value = event.nativeEvent.text.trim();
              if (
                !props.disabled &&
                prefixEdited.current &&
                (props.prefix === null || value !== props.prefix)
              )
                props.onChange({ branchNamePrefix: value });
              prefixEdited.current = false;
            }}
          />
        </View>
      ) : null}
      {props.mode === "custom" ? (
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            {t("components.branchNamingSettings.customHint")}
          </Text>
          <AppTextInput
            key={props.instructions}
            accessibilityLabel={t("components.branchNamingSettings.instructionsA11y")}
            onChangeText={() => {
              instructionsEdited.current = true;
            }}
            defaultValue={props.instructions ?? ""}
            placeholder={
              props.instructions === null
                ? t("components.branchNamingSettings.instructionsMixedPlaceholder")
                : t("components.branchNamingSettings.instructionsPlaceholder")
            }
            editable={!props.disabled}
            multiline
            autoCapitalize="sentences"
            className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
            onEndEditing={(event) => {
              const value = event.nativeEvent.text.trim();
              if (
                !props.disabled &&
                instructionsEdited.current &&
                (props.instructions === null || value !== props.instructions)
              )
                props.onChange({ branchNameInstructions: value });
              instructionsEdited.current = false;
            }}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}
