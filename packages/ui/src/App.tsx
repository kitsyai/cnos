import { startTransition, useDeferredValue, useEffect, useState } from 'react';

type NamespaceTab = 'value' | 'secret' | 'public' | 'env' | 'meta';

interface SummaryPayload {
  project: string;
  workspace: string;
  workspaceSource: string;
  workspaceChain: string[];
  profile: string;
  profileSource: string;
  counts: Record<string, number>;
  envMapping: Array<{
    envVar: string;
    logicalKey: string;
    secret: boolean;
  }>;
  promoted: string[];
  workspaces: string[];
  profiles: string[];
  runtimeNamespaces: string[];
  vaults: string[];
}

interface ListEntry {
  key: string;
  value: unknown;
  derived?: boolean;
}

interface ListPayload {
  namespace: NamespaceTab;
  entries: ListEntry[];
}

interface InspectPayload {
  key: string;
  value: unknown;
  namespace: string;
  profile: string;
  profileSource: string;
  workspace: {
    id: string;
    source: string;
    chain: string[];
  };
  winner: {
    sourceId: string;
    pluginId: string;
    workspaceId: string;
    origin?: {
      file?: string;
      line?: number;
      envVar?: string;
      cliArg?: string;
    };
  };
  overridden: Array<{
    sourceId: string;
    pluginId: string;
    workspaceId: string;
    value: unknown;
  }>;
  derived?: {
    type: string;
    expression: string;
    runtimeDependent: boolean;
    runtimeNamespaces: string[];
  };
}

const tabs: NamespaceTab[] = ['value', 'secret', 'public', 'env', 'meta'];

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as T;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function StatCard(props: { label: string; value: string | number; tone: string }) {
  return (
    <div className={`rounded-[1.75rem] border ${props.tone} p-5 shadow-[0_20px_70px_rgba(15,23,42,0.08)] backdrop-blur`}>
      <div className="text-[0.7rem] uppercase tracking-[0.24em] text-slate-500">{props.label}</div>
      <div className="mt-3 text-3xl font-semibold text-slate-950">{props.value}</div>
    </div>
  );
}

export function App() {
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [listPayload, setListPayload] = useState<ListPayload | null>(null);
  const [inspectPayload, setInspectPayload] = useState<InspectPayload | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');
  const [secretPassphrase, setSecretPassphrase] = useState('');
  const [namespace, setNamespace] = useState<NamespaceTab>('value');
  const [prefix, setPrefix] = useState('');
  const [inspectKey, setInspectKey] = useState('value.app.name');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingInspect, setLoadingInspect] = useState(false);
  const [revealingList, setRevealingList] = useState(false);
  const [revealingInspect, setRevealingInspect] = useState(false);
  const deferredPrefix = useDeferredValue(prefix);

  function buildSelectionQuery(): string {
    const query = new URLSearchParams();

    if (selectedWorkspace.trim()) {
      query.set('workspace', selectedWorkspace.trim());
    }

    if (selectedProfile.trim()) {
      query.set('profile', selectedProfile.trim());
    }

    return query.toString();
  }

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);

    const query = buildSelectionQuery();

    void requestJson<SummaryPayload>(`/api/summary${query ? `?${query}` : ''}`)
      .then((payload) => {
        if (!cancelled) {
          setSummary(payload);
          if (!selectedWorkspace) {
            setSelectedWorkspace(payload.workspace);
          }
          if (!selectedProfile) {
            setSelectedProfile(payload.profile);
          }
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace, selectedProfile]);

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);

    const query = new URLSearchParams({
      namespace,
    });

    if (selectedWorkspace.trim()) {
      query.set('workspace', selectedWorkspace.trim());
    }

    if (selectedProfile.trim()) {
      query.set('profile', selectedProfile.trim());
    }

    if (deferredPrefix.trim()) {
      query.set('prefix', deferredPrefix.trim());
    }

    void requestJson<ListPayload>(`/api/list?${query.toString()}`)
      .then((payload) => {
        if (!cancelled) {
          setListPayload(payload);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingList(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [namespace, deferredPrefix, selectedWorkspace, selectedProfile]);

  async function inspectCurrentKey(nextKey = inspectKey): Promise<void> {
    setLoadingInspect(true);
    setError(null);

    try {
      const query = new URLSearchParams({
        key: nextKey.trim(),
      });

      if (selectedWorkspace.trim()) {
        query.set('workspace', selectedWorkspace.trim());
      }

      if (selectedProfile.trim()) {
        query.set('profile', selectedProfile.trim());
      }

      const payload = await requestJson<InspectPayload>(
        `/api/inspect?${query.toString()}`,
      );
      setInspectPayload(payload);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingInspect(false);
    }
  }

  async function revealSecretList(): Promise<void> {
    setRevealingList(true);
    setError(null);

    try {
      const payload = await fetch('/api/reveal/list', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspace: selectedWorkspace,
          profile: selectedProfile,
          prefix: deferredPrefix,
          passphrase: secretPassphrase,
        }),
      });

      if (!payload.ok) {
        throw new Error(await payload.text());
      }

      setListPayload((await payload.json()) as ListPayload);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevealingList(false);
    }
  }

  async function revealSecretInspect(): Promise<void> {
    setRevealingInspect(true);
    setError(null);

    try {
      const response = await fetch('/api/reveal/inspect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          key: inspectKey.trim(),
          workspace: selectedWorkspace,
          profile: selectedProfile,
          passphrase: secretPassphrase,
        }),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      setInspectPayload((await response.json()) as InspectPayload);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevealingInspect(false);
    }
  }

  useEffect(() => {
    void inspectCurrentKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspace, selectedProfile]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(253,224,71,0.24),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(56,189,248,0.22),_transparent_24%),linear-gradient(180deg,_#f8fafc_0%,_#fff7ed_100%)] px-4 py-6 text-slate-900 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="overflow-hidden rounded-[2rem] border border-white/70 bg-white/80 p-6 shadow-[0_30px_90px_rgba(14,18,28,0.08)] backdrop-blur sm:p-8">
          <div className="grid gap-8 lg:grid-cols-[1.25fr_0.85fr]">
            <div className="space-y-5">
              <div className="inline-flex items-center rounded-full border border-amber-300/80 bg-amber-100/80 px-3 py-1 text-[0.7rem] font-medium uppercase tracking-[0.28em] text-amber-900">
                CNOS Control Surface
              </div>
              <div className="space-y-3">
                <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.06em] text-slate-950 sm:text-5xl">
                  Browse workspaces, env mappings, public projections, and inspect trails without leaving the terminal flow.
                </h1>
                <p className="max-w-2xl text-sm leading-7 text-slate-600 sm:text-base">
                  This local UI is backed by your live CNOS workspace and profile selection. It is optimized for adoption work:
                  trace what is public, what is secret, and what will actually land in env artifacts.
                </p>
              </div>
              {summary ? (
                <div className="flex flex-wrap gap-3 text-sm text-slate-600">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                    Project: <strong className="text-slate-900">{summary.project}</strong>
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                    Workspace: <strong className="text-slate-900">{summary.workspace}</strong>
                  </span>
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                    Profile: <strong className="text-slate-900">{summary.profile}</strong>
                  </span>
                </div>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <StatCard label="Resolved Keys" value={summary?.counts.all ?? '...'} tone="border-cyan-200/80 bg-cyan-50/80" />
              <StatCard label="Env Mappings" value={summary?.envMapping.length ?? '...'} tone="border-amber-200/80 bg-amber-50/80" />
              <StatCard label="Public Keys" value={summary?.counts.public ?? '...'} tone="border-emerald-200/80 bg-emerald-50/80" />
              <StatCard label="Vaults" value={summary?.vaults.length ?? '...'} tone="border-rose-200/80 bg-rose-50/80" />
            </div>
          </div>
        </section>

        {error ? (
          <section className="rounded-[1.5rem] border border-rose-300 bg-rose-50 px-5 py-4 text-sm text-rose-900">
            {error}
          </section>
        ) : null}

        <section className="grid gap-6 lg:grid-cols-[1.35fr_0.9fr]">
          <div className="rounded-[2rem] border border-white/70 bg-white/88 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
            <div className="flex flex-col gap-4 border-b border-slate-200/80 pb-4 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-xs uppercase tracking-[0.26em] text-slate-500">Namespace Browser</div>
                <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">Effective Config Surface</h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.22em] text-slate-500">Workspace</span>
                  <select
                    value={selectedWorkspace}
                    onChange={(event) => setSelectedWorkspace(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-cyan-400 focus:bg-white sm:w-44"
                  >
                    {summary?.workspaces.map((workspace) => (
                      <option key={workspace} value={workspace}>
                        {workspace}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.22em] text-slate-500">Profile</span>
                  <select
                    value={selectedProfile}
                    onChange={(event) => setSelectedProfile(event.target.value)}
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-cyan-400 focus:bg-white sm:w-44"
                  >
                    {summary?.profiles.map((profile) => (
                      <option key={profile} value={profile}>
                        {profile}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.22em] text-slate-500">Prefix Filter</span>
                  <input
                    value={prefix}
                    onChange={(event) => setPrefix(event.target.value)}
                    placeholder="app. or API_"
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-cyan-400 focus:bg-white sm:w-64"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.22em] text-slate-500">Vault Passphrase</span>
                  <input
                    type="password"
                    value={secretPassphrase}
                    onChange={(event) => setSecretPassphrase(event.target.value)}
                    placeholder="Optional"
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition focus:border-cyan-400 focus:bg-white sm:w-56"
                  />
                </label>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() =>
                    startTransition(() => {
                      setNamespace(tab);
                    })
                  }
                  className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                    namespace === tab
                      ? 'bg-slate-950 text-white shadow-[0_10px_25px_rgba(15,23,42,0.16)]'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {tab}
                </button>
              ))}
              {namespace === 'secret' ? (
                <button
                  type="button"
                  onClick={() => void revealSecretList()}
                  disabled={revealingList}
                  className="ml-auto rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-800 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {revealingList ? 'Revealing…' : 'Reveal Secrets'}
                </button>
              ) : null}
            </div>

            <div className="mt-5 overflow-hidden rounded-[1.5rem] border border-slate-200">
              <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs uppercase tracking-[0.22em] text-slate-500">
                <div>Key</div>
                <div>Value</div>
              </div>
              <div className="max-h-[36rem] overflow-auto">
                {loading || loadingList ? (
                  <div className="px-4 py-6 text-sm text-slate-500">Loading namespace data…</div>
                ) : listPayload && listPayload.entries.length > 0 ? (
                  listPayload.entries.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      onClick={() => {
                        const nextKey = entry.key;
                        setInspectKey(nextKey);
                        void inspectCurrentKey(nextKey);
                      }}
                      className="grid w-full grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-4 border-b border-slate-100 px-4 py-3 text-left transition hover:bg-slate-50"
                    >
                      <div className="overflow-hidden">
                        <div className="truncate font-mono text-sm text-slate-900">{entry.key}</div>
                        {entry.derived ? (
                          <div className="mt-1 text-[0.7rem] uppercase tracking-[0.18em] text-cyan-700">Derived</div>
                        ) : null}
                      </div>
                      <div className="overflow-hidden font-mono text-xs leading-6 text-slate-600">
                        <pre className="whitespace-pre-wrap break-words">{formatValue(entry.value)}</pre>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-6 text-sm text-slate-500">No entries match this namespace and prefix.</div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <section className="rounded-[2rem] border border-white/70 bg-white/88 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
              <div className="text-xs uppercase tracking-[0.26em] text-slate-500">Inspect</div>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">Trace One Key</h2>
              <div className="mt-4 flex gap-3">
                <input
                  value={inspectKey}
                  onChange={(event) => setInspectKey(event.target.value)}
                  className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-mono text-sm outline-none transition focus:border-cyan-400 focus:bg-white"
                />
                <button
                  type="button"
                  onClick={() => void inspectCurrentKey()}
                  className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-slate-800"
                >
                  Inspect
                </button>
                {inspectKey.trim().startsWith('secret.') ? (
                  <button
                    type="button"
                    onClick={() => void revealSecretInspect()}
                    disabled={revealingInspect}
                    className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {revealingInspect ? 'Revealing…' : 'Reveal'}
                  </button>
                ) : null}
              </div>

              <div className="mt-5 rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
                {loadingInspect ? (
                  <div className="text-sm text-slate-500">Inspecting…</div>
                ) : inspectPayload ? (
                  <div className="space-y-4">
                    <div>
                      <div className="text-[0.7rem] uppercase tracking-[0.18em] text-slate-500">Value</div>
                      <pre className="mt-2 overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-slate-950/95 px-4 py-3 font-mono text-xs text-slate-100">
                        {formatValue(inspectPayload.value)}
                      </pre>
                    </div>
                    <div className="grid gap-3 text-sm text-slate-600">
                      <div>
                        <span className="text-slate-500">Namespace:</span> {inspectPayload.namespace}
                      </div>
                      <div>
                        <span className="text-slate-500">Winner:</span> {inspectPayload.winner.sourceId} via {inspectPayload.winner.pluginId}
                      </div>
                      <div>
                        <span className="text-slate-500">Workspace Chain:</span> {inspectPayload.workspace.chain.join(' → ')}
                      </div>
                      {inspectPayload.derived ? (
                        <div>
                          <span className="text-slate-500">Derived:</span> {inspectPayload.derived.expression}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">Select a key to inspect its provenance.</div>
                )}
              </div>
            </section>

            <section className="rounded-[2rem] border border-white/70 bg-white/88 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur">
              <div className="text-xs uppercase tracking-[0.26em] text-slate-500">Mappings</div>
              <h2 className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-slate-950">Env and Public Intent</h2>
              <div className="mt-4 grid gap-4">
                <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 text-[0.7rem] uppercase tracking-[0.18em] text-slate-500">Explicit Env Mapping</div>
                  <div className="space-y-3">
                    {summary && summary.envMapping.length > 0 ? (
                      summary.envMapping.slice(0, 8).map((entry) => (
                        <div key={entry.envVar} className="flex items-start justify-between gap-3 text-sm">
                          <code className="font-mono text-slate-900">{entry.envVar}</code>
                          <div className="text-right text-slate-500">
                            <div>{entry.logicalKey}</div>
                            {entry.secret ? (
                              <div className="mt-1 text-[0.7rem] uppercase tracking-[0.16em] text-rose-700">Secret mapped</div>
                            ) : null}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-sm text-slate-500">No explicit env mappings.</div>
                    )}
                  </div>
                </div>

                <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 text-[0.7rem] uppercase tracking-[0.18em] text-slate-500">Promoted Public Keys</div>
                  <div className="space-y-2">
                    {summary && summary.promoted.length > 0 ? (
                      summary.promoted.slice(0, 8).map((entry) => (
                        <code key={entry} className="block text-sm text-slate-700">
                          {entry}
                        </code>
                      ))
                    ) : (
                      <div className="text-sm text-slate-500">No public promotions.</div>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
