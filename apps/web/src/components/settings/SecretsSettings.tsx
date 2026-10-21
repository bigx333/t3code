import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  THREAD_SECRET_FAILURE_MESSAGE,
  threadSecretInput,
  sortedThreadSecrets,
} from "@t3tools/client-runtime/thread-secrets";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId, ThreadSecretSummary } from "@t3tools/contracts";
import { useId, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function SecretsSettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  return (
    <SettingsPageContainer>
      <SettingsSection id={searchableSetting("secrets").id} title="Secrets">
        <div className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">
            Secrets are available only to the thread that requested them. Child threads do not
            inherit them. Replace or delete saved values here. Values are never shown.
          </p>
          {environmentId === null ? (
            <p className="text-sm text-muted-foreground">
              Connect an environment to manage its secrets.
            </p>
          ) : (
            <ThreadSecrets key={environmentId} environmentId={environmentId} />
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
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
    const confirmed = await requestConfirmDialog(
      `Delete $${secret.name} for this thread? New processes will no longer receive it, and new output will no longer mask its value.`,
      { variant: "destructive" },
    );
    if (!confirmed || removingRef.current) return;
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
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          Refresh
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load secrets. Refresh to try again.
        </p>
      ) : null}
      {query.isPending && query.data === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading secrets...
        </p>
      ) : null}
      {query.isSuccess && secrets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No secrets saved.</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {secrets.map((secret) => (
          <li
            key={`${secret.threadId}:${secret.name}`}
            className="flex flex-wrap items-start justify-between gap-3 py-3"
          >
            <div className="min-w-0 space-y-1">
              <p className="break-all font-mono text-sm">${secret.name}</p>
              <p className="text-sm">{secret.label}</p>
              <p className="text-xs text-muted-foreground">
                Updated{" "}
                <time dateTime={secret.updatedAt}>
                  {new Date(secret.updatedAt).toLocaleString()}
                </time>
              </p>
              <SecretThreadLink environmentId={environmentId} threadId={secret.threadId} />
            </div>
            <div className="flex gap-2">
              {canSet ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={removing || editor !== null}
                  onClick={() => setEditor(secret)}
                >
                  Replace value
                </Button>
              ) : null}
              {canRemove ? (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={removing || editor !== null}
                  onClick={() => void deleteSecret(secret)}
                >
                  Delete
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {canSet && editor !== null ? (
        <SecretForm
          key={`${editor.threadId}:${editor.name}`}
          environmentId={environmentId}
          secret={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </div>
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
  return (
    <p className="text-xs text-muted-foreground">
      Thread{" "}
      {thread ? (
        <InlineButton
          render={
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams({ environmentId, threadId })}
            />
          }
        >
          {thread.title || threadId}
        </InlineButton>
      ) : (
        threadId
      )}
    </p>
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
  const id = useId();
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
    <form
      className="space-y-3 rounded-lg border border-border p-4"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-medium">{`Replace $${secret.name}`}</h3>
      <fieldset className="space-y-3" disabled={saving || !canSet}>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-value`}>Value</Label>
          <Input
            id={`${id}-value`}
            type="text"
            mask
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">Replaces the saved value for this thread</p>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={input === null}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
