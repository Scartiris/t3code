import { createFileRoute } from "@tanstack/react-router";
import { OpenVikingSettingsPanel } from "../components/settings/OpenVikingSettings";

export const Route = createFileRoute("/settings/openviking")({
  component: OpenVikingSettingsPanel,
});
