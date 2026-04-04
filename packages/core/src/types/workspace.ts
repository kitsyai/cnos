export type WorkspaceSource = 'cli' | 'workspace-file' | 'manifest-default' | 'implicit';

export type GlobalRootSource = 'cli' | 'workspace-file' | 'manifest' | 'CNOS_HOME';

export interface WorkspaceFile {
  workspace?: string;
  profile?: string;
  globalRoot?: string;
}

export interface WorkspaceItemConfig {
  extends?: string | string[];
  globalId?: string;
}

export interface NormalizedWorkspaceItem {
  extends: string[];
  globalId?: string;
}

export interface WorkspaceRoot {
  scope: 'global' | 'local';
  workspaceId: string;
  path: string;
}

export interface WorkspaceContext {
  workspaceId: string;
  workspaceSource: WorkspaceSource;
  globalRoot?: string;
  globalRootSource?: GlobalRootSource;
  workspaceChain: string[];
  workspaceRoots: WorkspaceRoot[];
}
