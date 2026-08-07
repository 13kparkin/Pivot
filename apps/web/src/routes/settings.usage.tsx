import { createFileRoute } from "@tanstack/react-router";

import { UsageSettings } from "../components/settings/UsageSettings";

export const Route = createFileRoute("/settings/usage")({
  component: UsageSettings,
});
