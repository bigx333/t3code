import { createFileRoute } from "@tanstack/react-router";
import { SecretsSettingsPanel } from "../components/settings/SecretsSettings";

export const Route = createFileRoute("/settings/secrets")({ component: SecretsSettingsPanel });
