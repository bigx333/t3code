import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  THREAD_SECRET_FAILURE_MESSAGE,
  threadSecretInput,
  sortedThreadSecrets,
} from "@t3tools/client-runtime/thread-secrets";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId, ThreadSecretSummary } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsSecretsRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Secrets" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="text-sm text-foreground-muted">
            Secrets are available only to the thread that requested them. Child threads do not
            inherit them. Replace or delete saved values here. Values are never shown.
          </Text>
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">Select a connected environment.</Text>
          ) : (
            selectedTargets.map((target) => (
              <SettingsSection key={target.environmentId} title={target.label}>
                <ThreadSecrets environmentId={target.environmentId} />
              </SettingsSection>
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function ThreadSecrets({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(serverEnvironment.secretsAtom(environmentId));
  const canSet = useAtomValue(serverEnvironment.setSecret.permissionAtom(environmentId));
  const canRemove = useAtomValue(serverEnvironment.removeSecret.permissionAtom(environmentId));
  const remove = useAtomCommand(serverEnvironment.removeSecret, {
    reportFailure: false,
    reportDefect: false,
  });
  const [editor, setEditor] = useState<ThreadSecretSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removingRef = useRef(false);
  const secrets = sortedThreadSecrets(query.data?.secrets ?? []);

  const deleteSecret = async (secret: ThreadSecretSummary) => {
    if (!canRemove || removingRef.current) return;
    removingRef.current = true;
    setRemoving(true);
    setError(null);
    const result = await remove({
      environmentId,
      input: { threadId: secret.threadId, name: secret.name },
    });
    removingRef.current = false;
    setRemoving(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result))
      setError(THREAD_SECRET_FAILURE_MESSAGE);
  };

  return (
    <View>
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Refresh"
        loading={query.isPending}
        onPress={query.refresh}
      />
      {query.error ? (
        <Text accessibilityRole="alert" className="p-4 text-sm text-danger-foreground">
          Could not load secrets. Refresh to try again.
        </Text>
      ) : null}
      {query.isSuccess && secrets.length === 0 ? (
        <Text className="p-4 text-foreground-muted">No secrets saved.</Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="p-4 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {secrets.map((secret) => (
        <View key={`${secret.threadId}:${secret.name}`} className="border-t border-border">
          <View className="gap-1 px-4 pt-4 pb-2">
            <Text className="font-mono text-sm">${secret.name}</Text>
            <Text>{secret.label}</Text>
            <Text className="text-xs text-foreground-muted">
              Updated {new Date(secret.updatedAt).toLocaleString()}
            </Text>
            <SecretThreadLink environmentId={environmentId} threadId={secret.threadId} />
          </View>
          {canSet ? (
            <SettingsActionRow
              icon="pencil"
              label="Replace value"
              disabled={removing || editor !== null}
              onPress={() => setEditor(secret)}
            />
          ) : null}
          {canRemove ? (
            <SettingsActionRow
              icon="trash"
              label="Delete"
              tone="danger"
              disabled={removing || editor !== null}
              onPress={() =>
                Dialog.confirm({
                  title: `Delete $${secret.name}?`,
                  message:
                    "New processes in this thread will no longer receive it, and new output will no longer mask its value.",
                  confirmText: "Delete",
                  destructive: true,
                  onConfirm: () => void deleteSecret(secret),
                })
              }
            />
          ) : null}
        </View>
      ))}
      {canSet && editor !== null ? (
        <SecretForm
          key={`${editor.threadId}:${editor.name}`}
          environmentId={environmentId}
          secret={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </View>
  );
}

function SecretThreadLink({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const thread = useAtomValue(environmentThreadShells.threadShellAtom({ environmentId, threadId }));
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  if (!thread) {
    return (
      <Text selectable className="text-xs text-foreground-muted">
        Thread {threadId}
      </Text>
    );
  }
  return (
    <Text
      accessibilityRole="link"
      className="text-xs text-foreground-muted"
      onPress={() => {
        const destination = { environmentId, threadId };
        if (Platform.OS === "android")
          selectAndroidWorkspace({ name: "Thread", params: destination });
        else navigation.navigate("Thread", destination);
      }}
    >
      Thread {thread.title || threadId}
    </Text>
  );
}

function SecretForm({
  environmentId,
  secret,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly secret: ThreadSecretSummary;
  readonly onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Encoding failures can contain the submitted value.
  const setSecret = useAtomCommand(serverEnvironment.setSecret, {
    reportFailure: false,
    reportDefect: false,
  });
  const canSet = useAtomValue(serverEnvironment.setSecret.permissionAtom(environmentId));
  const input = threadSecretInput({
    threadId: secret.threadId,
    name: secret.name,
    label: secret.label,
    value,
    ...(secret.description ? { description: secret.description } : {}),
  });

  const save = async () => {
    if (input === null || inFlight.current || !canSet) return;
    inFlight.current = true;
    setSaving(true);
    setError(null);
    const result = await setSecret({ environmentId, input });
    inFlight.current = false;
    setSaving(false);
    if (result._tag === "Success") {
      setValue("");
      onClose();
    } else if (!isAtomCommandInterrupted(result)) {
      setError(THREAD_SECRET_FAILURE_MESSAGE);
    }
  };

  return (
    <View className="gap-3 border-t border-border p-4">
      <Text className="font-t3-bold">{`Replace $${secret.name}`}</Text>
      <Text>Value</Text>
      <TextInput
        accessibilityLabel="Secret value"
        value={value}
        onChangeText={setValue}
        editable={!saving && canSet}
        secureTextEntry
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        spellCheck={false}
        returnKeyType="done"
        onSubmitEditing={() => void save()}
      />
      <Text className="text-xs text-foreground-muted">
        Replaces the saved value for this thread
      </Text>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <SettingsActionRow
        label="Save"
        loading={saving}
        disabled={input === null || !canSet}
        onPress={() => void save()}
      />
      <SettingsActionRow label="Cancel" disabled={saving} onPress={onClose} />
    </View>
  );
}
