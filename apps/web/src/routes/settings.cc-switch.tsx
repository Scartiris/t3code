import { createFileRoute } from "@tanstack/react-router";
import { CcSwitchSettingsPanel } from "../components/settings/CcSwitchSettings";

export const Route = createFileRoute("/settings/cc-switch")({ component: CcSwitchSettingsPanel });
