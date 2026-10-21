import { useAtomValue } from "@effect/atom-react";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  SECRET_REQUEST_LEGACY_PRIVACY_NOTE,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/Button";

const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };
const PRIVATE_SYMBOL: AppSymbolName = { ios: "checkmark.shield", android: "lock" };

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "secret_request") return null;
  const display = secretRequestDisplay(item, visibility);
  if (display.kind === "pending") {
    return (
      <PendingSecretRequestForm
        environmentId={props.environmentId}
        item={item}
        iconColor={props.iconColor}
      />
    );
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere"
      ? LOCK_SYMBOL
      : display.outcome === "saved"
        ? "checkmark"
        : "minus";
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {item.label}
        {item.name ? <Text className="font-mono"> · ${item.name}</Text> : null} · {display.label}
      </Text>
    </View>
  );
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly iconColor: ColorValue;
}) {
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const canAnswer = useAtomValue(
    serverEnvironment.answerSecretRequest.permissionAtom(props.environmentId),
  );
  const summaries = useEnvironmentQuery(serverEnvironment.secretsAtom(props.environmentId));
  const replacesValue =
    item.name !== undefined &&
    summaries.data?.secrets.some(
      (secret) => secret.threadId === item.threadId && secret.name === item.name,
    );
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (
    reply: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current || !canAnswer) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setSecret("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">{item.label}</Text>
        {item.name ? (
          <Text className="font-mono text-sm text-foreground-muted">${item.name}</Text>
        ) : null}
        {replacesValue ? (
          <Text className="text-sm text-foreground-muted">Replaces the saved value</Text>
        ) : null}
        {item.reason.trim() ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">{item.reason}</Text>
        ) : null}
      </View>
      <TextInput
        accessibilityLabel={item.label}
        placeholder={item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
        value={secret}
        onChangeText={setSecret}
        editable={!submitting && canAnswer}
        secureTextEntry
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        spellCheck={false}
        returnKeyType="done"
        onSubmitEditing={() => void send({ type: "save", secret })}
      />
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <Button
        label="Save securely"
        tone="primary"
        fullWidth
        disabled={submitting || !canAnswer || secret.trim().length === 0}
        onPress={() => void send({ type: "save", secret })}
      />
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1 flex-row items-center gap-1.5">
          <SymbolView
            name={PRIVATE_SYMBOL}
            size={13}
            tintColor={props.iconColor}
            type="monochrome"
          />
          <Text className="flex-1 font-sans text-xs text-foreground-muted">
            {item.name === undefined
              ? SECRET_REQUEST_LEGACY_PRIVACY_NOTE
              : `Available to this thread as $${item.name}`}
          </Text>
        </View>
        <Button
          label="Decline"
          tone="text"
          disabled={submitting || !canAnswer}
          onPress={() => void send({ type: "decline" })}
        />
      </View>
    </View>
  );
}
