import { type ReactElement, type ReactNode, memo, useMemo, useState } from 'react';
import type { ChatStatus } from 'ai';
import {
  AlertTriangleIcon,
  BellIcon,
  CheckCircle2Icon,
  CheckSquare2Icon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  Loader2Icon,
  PanelRightCloseIcon,
  RefreshCwIcon,
  SparklesIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SessionFilesPanel } from '@/features/chat/components/session-files-panel';
import { ToolbarTodoPanel } from '@/features/chat/components/prompt-toolbar/toolbar-todo';
import { useToolEventsStore, type TodoItem } from '@/features/tool/store';
import type { ActivityDetail } from '@/features/chat/components/activity-status-indicator';
import { useGitDiffStats } from '@/hooks/useGitDiffStats';
import type { SessionFileEntry } from '@/hooks/useSessions';
import type { LiveMessage } from '@/hooks/types';
import type { TokenUsage } from '@/hooks/wireTypes';
import type { GitDiffStats, Session } from '@/lib/api/models';
import { cn } from '@/lib/utils';

type WorkspacePanelTab = 'overview' | 'files' | 'changes' | 'tasks' | 'requests';

type MetricTone = 'default' | 'success' | 'danger' | 'warning';

export type WorkspacePendingRequestCounts = {
  approvals: number;
  questions: number;
  total: number;
};

export type WorkbenchStreamSnapshot = {
  chatStatus: ChatStatus;
  isConnected: boolean;
  isReplayingHistory: boolean;
  isAwaitingFirstResponse: boolean;
  contextUsage: number;
  tokenUsage: TokenUsage | null;
  currentStep: number;
  planMode: boolean;
  activity: ActivityDetail;
  pendingRequests: WorkspacePendingRequestCounts;
  errorMessage: string | null;
};

export const EMPTY_WORKBENCH_STREAM_SNAPSHOT: WorkbenchStreamSnapshot = {
  chatStatus: 'ready',
  isConnected: false,
  isReplayingHistory: false,
  isAwaitingFirstResponse: false,
  contextUsage: 0,
  tokenUsage: null,
  currentStep: 0,
  planMode: false,
  activity: {
    status: 'idle',
    description: 'Awaiting input',
  },
  pendingRequests: {
    approvals: 0,
    questions: 0,
    total: 0,
  },
  errorMessage: null,
};

type WorkspacePanelProps = {
  className?: string;
  sessionId?: string | null;
  currentSession?: Session;
  streamSnapshot: WorkbenchStreamSnapshot;
  onClose?: () => void;
  onListSessionDirectory?: (
    sessionId: string,
    path?: string,
  ) => Promise<SessionFileEntry[]>;
  onGetSessionFileUrl?: (sessionId: string, path: string) => string;
  onGetSessionFile?: (sessionId: string, path: string) => Promise<Blob>;
};

export function deriveWorkspacePendingRequestCounts(
  messages: LiveMessage[],
): WorkspacePendingRequestCounts {
  const approvalIds = new Set<string>();
  const questionIds = new Set<string>();

  for (const message of messages) {
    if (message.variant !== 'tool' || !message.toolCall) {
      continue;
    }

    const { approval, question, state } = message.toolCall;
    if (
      state === 'approval-requested' &&
      approval?.id &&
      !approval.submitted &&
      !approval.resolved
    ) {
      approvalIds.add(approval.id);
    }

    if (
      state === 'question-requested' &&
      question?.id &&
      !question.submitted &&
      !question.resolved
    ) {
      questionIds.add(question.id);
    }
  }

  return {
    approvals: approvalIds.size,
    questions: questionIds.size,
    total: approvalIds.size + questionIds.size,
  };
}

export function areWorkbenchStreamSnapshotsEqual(
  left: WorkbenchStreamSnapshot,
  right: WorkbenchStreamSnapshot,
): boolean {
  return (
    left.chatStatus === right.chatStatus &&
    left.isConnected === right.isConnected &&
    left.isReplayingHistory === right.isReplayingHistory &&
    left.isAwaitingFirstResponse === right.isAwaitingFirstResponse &&
    left.contextUsage === right.contextUsage &&
    areTokenUsagesEqual(left.tokenUsage, right.tokenUsage) &&
    left.currentStep === right.currentStep &&
    left.planMode === right.planMode &&
    left.activity.status === right.activity.status &&
    left.activity.description === right.activity.description &&
    left.pendingRequests.approvals === right.pendingRequests.approvals &&
    left.pendingRequests.questions === right.pendingRequests.questions &&
    left.pendingRequests.total === right.pendingRequests.total &&
    left.errorMessage === right.errorMessage
  );
}

function areTokenUsagesEqual(left: TokenUsage | null, right: TokenUsage | null): boolean {
  if (left === right) {
    return true;
  }
  if (!(left && right)) {
    return false;
  }
  return (
    left.input_other === right.input_other &&
    left.input_cache_read === right.input_cache_read &&
    left.input_cache_creation === right.input_cache_creation &&
    left.output === right.output
  );
}

export const WorkspacePanel = memo(function WorkspacePanelComponent({
  className,
  sessionId,
  currentSession,
  streamSnapshot,
  onClose,
  onListSessionDirectory,
  onGetSessionFileUrl,
  onGetSessionFile,
}: WorkspacePanelProps): ReactElement {
  const [activeTab, setActiveTab] = useState<WorkspacePanelTab>('overview');
  const todoItems = useToolEventsStore((state) => state.todoItems);
  const newFiles = useToolEventsStore((state) => state.newFiles);
  const {
    stats: gitDiffStats,
    isLoading: isGitDiffLoading,
    error: gitDiffError,
    refresh: refreshGitDiff,
  } = useGitDiffStats(sessionId ?? null);

  const fileCount = gitDiffStats?.files?.length ?? 0;
  const canBrowseFiles = Boolean(
    sessionId && currentSession?.workDir && onListSessionDirectory && (onGetSessionFile || onGetSessionFileUrl),
  );
  const tabs = useMemo(
    () => [
      { id: 'overview' as const, label: 'Overview', count: null },
      { id: 'files' as const, label: 'Files', count: null },
      {
        id: 'changes' as const,
        label: 'Changes',
        count: gitDiffStats?.hasChanges ? fileCount : null,
      },
      { id: 'tasks' as const, label: 'Tasks', count: todoItems.length || null },
      {
        id: 'requests' as const,
        label: 'Requests',
        count: streamSnapshot.pendingRequests.total || null,
      },
    ],
    [fileCount, gitDiffStats?.hasChanges, streamSnapshot.pendingRequests.total, todoItems.length],
  );

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 flex-col bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/85',
        className,
      )}
    >
      <div className='border-b px-3 py-3'>
        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0'>
            <div className='flex items-center gap-2'>
              <SparklesIcon className='size-4 text-primary' />
              <h2 className='text-sm font-semibold'>Workspace</h2>
              {streamSnapshot.planMode ? (
                <Badge variant='secondary' className='text-[10px]'>
                  Plan
                </Badge>
              ) : null}
            </div>
            <p
              className='mt-1 truncate text-xs text-muted-foreground'
              title={currentSession?.workDir ?? undefined}
            >
              {currentSession?.workDir ?? 'Select a session to inspect the workspace'}
            </p>
          </div>
          {onClose ? (
            <Button
              type='button'
              variant='ghost'
              size='icon-xs'
              onClick={onClose}
              aria-label='Collapse workspace panel'
            >
              <PanelRightCloseIcon className='size-3.5' />
            </Button>
          ) : null}
        </div>

        <div className='mt-3 grid grid-cols-2 gap-1.5'>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type='button'
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex h-8 items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-border bg-secondary text-foreground shadow-sm'
                  : 'border-border/60 bg-transparent text-muted-foreground hover:border-border hover:text-foreground',
              )}
            >
              <span>{tab.label}</span>
              {tab.count ? (
                <Badge variant='secondary' className='px-1.5 py-0 text-[10px]'>
                  {tab.count}
                </Badge>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'files' ? (
        canBrowseFiles ? (
          <SessionFilesPanel
            key={`workspace-files:${sessionId}`}
            className='min-h-0 flex-1'
            sessionId={sessionId ?? ''}
            workDir={currentSession?.workDir}
            onClose={onClose ?? (() => setActiveTab('overview'))}
            onListSessionDirectory={onListSessionDirectory}
            onGetSessionFileUrl={onGetSessionFileUrl}
            onGetSessionFile={onGetSessionFile}
          />
        ) : (
          <PanelBody>
            <EmptyState
              icon={<FolderIcon className='size-5' />}
              title='No workspace files'
              description='Select a session with a work directory to browse files.'
            />
          </PanelBody>
        )
      ) : (
        <ScrollArea className='min-h-0 flex-1'>
          <div className='space-y-3 p-3'>
            {activeTab === 'overview' ? (
              <OverviewTab
                sessionId={sessionId}
                currentSession={currentSession}
                streamSnapshot={streamSnapshot}
                changedFiles={fileCount}
                todoCount={todoItems.length}
                newFiles={newFiles}
              />
            ) : null}
            {activeTab === 'changes' ? (
              <ChangesTab
                isLoading={isGitDiffLoading}
                error={gitDiffError}
                stats={gitDiffStats}
                onRefresh={refreshGitDiff}
              />
            ) : null}
            {activeTab === 'tasks' ? <TasksTab todoItems={todoItems} /> : null}
            {activeTab === 'requests' ? (
              <RequestsTab counts={streamSnapshot.pendingRequests} />
            ) : null}
          </div>
        </ScrollArea>
      )}
    </aside>
  );
});
function PanelBody({ children }: { children: ReactNode }) {
  return <div className='min-h-0 flex-1 p-3'>{children}</div>;
}

function OverviewTab({
  sessionId,
  currentSession,
  streamSnapshot,
  changedFiles,
  todoCount,
  newFiles,
}: {
  sessionId?: string | null;
  currentSession?: Session;
  streamSnapshot: WorkbenchStreamSnapshot;
  changedFiles: number;
  todoCount: number;
  newFiles: string[];
}) {
  if (!sessionId) {
    return (
      <EmptyState
        icon={<SparklesIcon className='size-5' />}
        title='No active session'
        description='Create or select a session to start working with Kimi.'
      />
    );
  }

  const usagePercent = Math.round(streamSnapshot.contextUsage * 1000) / 10;

  return (
    <>
      <SectionCard title='Activity' icon={<SparklesIcon className='size-4' />}>
        <div className='space-y-3 text-sm'>
          <StatusRow label='State' value={streamSnapshot.activity.description} />
          <StatusRow
            label='Connection'
            value={streamSnapshot.isConnected ? 'Connected' : 'Disconnected'}
          />
          <StatusRow
            label='Step'
            value={streamSnapshot.currentStep > 0 ? `#${streamSnapshot.currentStep}` : 'Idle'}
          />
          <StatusRow label='Chat' value={streamSnapshot.chatStatus} />
          {streamSnapshot.errorMessage ? (
            <p className='rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-xs text-destructive'>
              {streamSnapshot.errorMessage}
            </p>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title='Context' icon={<FileTextIcon className='size-4' />}>
        <div className='space-y-2'>
          <div className='flex items-center justify-between text-xs'>
            <span className='text-muted-foreground'>Usage</span>
            <span className='font-medium'>{usagePercent.toFixed(1)}%</span>
          </div>
          <Progress value={usagePercent} />
          {streamSnapshot.tokenUsage ? (
            <div className='grid grid-cols-2 gap-2 text-xs text-muted-foreground'>
              <StatusPill label='Input' value={formatInputTokens(streamSnapshot.tokenUsage)} />
              <StatusPill label='Output' value={formatNumber(streamSnapshot.tokenUsage.output)} />
            </div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title='Session' icon={<FolderIcon className='size-4' />}>
        <div className='space-y-2 text-xs'>
          <StatusRow label='Title' value={currentSession?.title ?? 'Loading...'} />
          <StatusRow label='Work dir' value={currentSession?.workDir ?? 'Not available'} />
        </div>
      </SectionCard>

      <div className='grid grid-cols-3 gap-2'>
        <MetricCard label='Changes' value={changedFiles} />
        <MetricCard label='Tasks' value={todoCount} />
        <MetricCard label='Requests' value={streamSnapshot.pendingRequests.total} />
      </div>

      {newFiles.length > 0 ? (
        <SectionCard title='Recent files' icon={<FileTextIcon className='size-4' />}>
          <div className='space-y-1'>
            {newFiles.slice(-5).map((path) => (
              <div
                key={path}
                className='truncate rounded-md bg-muted/50 px-2 py-1 text-xs'
                title={path}
              >
                {path}
              </div>
            ))}
          </div>
        </SectionCard>
      ) : null}
    </>
  );
}

function ChangesTab({
  isLoading,
  error,
  stats,
  onRefresh,
}: {
  isLoading: boolean;
  error: string | null;
  stats: GitDiffStats | null;
  onRefresh: () => Promise<void>;
}) {
  const files = stats?.files ?? [];

  return (
    <SectionCard
      title='Git changes'
      icon={<GitBranchIcon className='size-4' />}
      action={
        <Button
          type='button'
          variant='ghost'
          size='icon-xs'
          onClick={() => {
            onRefresh().catch(() => undefined);
          }}
          disabled={isLoading}
          aria-label='Refresh git changes'
        >
          <RefreshCwIcon className={cn('size-3.5', isLoading && 'animate-spin')} />
        </Button>
      }
    >
      {isLoading && !stats ? (
        <div className='flex items-center gap-2 text-sm text-muted-foreground'>
          <Loader2Icon className='size-4 animate-spin' />
          <span>Checking changes...</span>
        </div>
      ) : null}

      {error || stats?.error ? (
        <Notice kind='error' text={error ?? stats?.error ?? 'Failed to load git changes'} />
      ) : null}

      {stats && !stats.isGitRepo ? (
        <Notice kind='muted' text='This workspace is not a git repository.' />
      ) : null}

      {stats?.isGitRepo && !stats.hasChanges ? (
        <Notice kind='success' text='No uncommitted changes.' />
      ) : null}

      {stats?.isGitRepo && stats.hasChanges ? (
        <div className='space-y-3'>
          <div className='grid grid-cols-3 gap-2'>
            <MetricCard label='Files' value={files.length} />
            <MetricCard label='Added' value={`+${stats.totalAdditions ?? 0}`} tone='success' />
            <MetricCard label='Deleted' value={`-${stats.totalDeletions ?? 0}`} tone='danger' />
          </div>
          <div className='space-y-1.5'>
            {files.map((file) => (
              <div key={file.path} className='rounded-lg border bg-card/60 px-2.5 py-2 text-xs'>
                <div className='flex items-center gap-2'>
                  <FileTextIcon className='size-3.5 shrink-0 text-muted-foreground' />
                  <span className='min-w-0 flex-1 truncate' title={file.path}>
                    {file.path}
                  </span>
                  <span className='shrink-0 text-emerald-600 dark:text-emerald-400'>
                    +{file.additions}
                  </span>
                  <span className='shrink-0 text-destructive'>-{file.deletions}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}

function TasksTab({ todoItems }: { todoItems: TodoItem[] }) {
  return (
    <SectionCard title='Tasks' icon={<CheckSquare2Icon className='size-4' />}>
      {todoItems.length > 0 ? (
        <div className='rounded-md border bg-card/60 py-1'>
          <ToolbarTodoPanel items={todoItems} />
        </div>
      ) : (
        <EmptyState
          icon={<CheckCircle2Icon className='size-5' />}
          title='No active task list'
          description='Kimi will show todo progress here when the SetTodoList tool is used.'
        />
      )}
    </SectionCard>
  );
}

function RequestsTab({ counts }: { counts: WorkspacePendingRequestCounts }) {
  return (
    <SectionCard title='Requests' icon={<BellIcon className='size-4' />}>
      {counts.total > 0 ? (
        <div className='space-y-2'>
          <Notice kind='warning' text='Kimi is waiting for your response in the chat area.' />
          <div className='grid grid-cols-2 gap-2'>
            <MetricCard label='Approvals' value={counts.approvals} tone='warning' />
            <MetricCard label='Questions' value={counts.questions} tone='warning' />
          </div>
        </div>
      ) : (
        <EmptyState
          icon={<BellIcon className='size-5' />}
          title='No pending requests'
          description='Approvals and structured questions will be summarized here.'
        />
      )}
    </SectionCard>
  );
}
function SectionCard({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: ReactElement;
  action?: ReactElement;
  children: ReactNode;
}) {
  return (
    <section className='rounded-xl border bg-card/60 p-3 shadow-sm'>
      <div className='mb-3 flex items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2 text-sm font-semibold'>
          <span className='text-muted-foreground'>{icon}</span>
          <span className='truncate'>{title}</span>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex items-start justify-between gap-3'>
      <span className='shrink-0 text-muted-foreground'>{label}</span>
      <span className='min-w-0 truncate text-right font-medium' title={value}>
        {value}
      </span>
    </div>
  );
}

function StatusPill({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-md border bg-background/60 px-2 py-1.5'>
      <div className='text-[10px] uppercase tracking-wide text-muted-foreground'>{label}</div>
      <div className='mt-0.5 font-mono text-foreground'>{value}</div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number | string;
  tone?: MetricTone;
}) {
  return (
    <div className='rounded-xl border bg-card/60 p-2 text-center'>
      <div
        className={cn(
          'text-base font-semibold',
          tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'danger' && 'text-destructive',
          tone === 'warning' && 'text-yellow-600 dark:text-yellow-400',
        )}
      >
        {value}
      </div>
      <div className='mt-0.5 truncate text-[10px] uppercase tracking-wide text-muted-foreground'>
        {label}
      </div>
    </div>
  );
}

function Notice({ kind, text }: { kind: 'muted' | 'success' | 'warning' | 'error'; text: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs',
        kind === 'muted' && 'bg-muted/40 text-muted-foreground',
        kind === 'success' && 'border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300',
        kind === 'warning' && 'border-yellow-500/20 bg-yellow-500/5 text-yellow-700 dark:text-yellow-300',
        kind === 'error' && 'border-destructive/20 bg-destructive/5 text-destructive',
      )}
    >
      {kind === 'error' ? <AlertTriangleIcon className='mt-0.5 size-3.5 shrink-0' /> : null}
      <span>{text}</span>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactElement;
  title: string;
  description: string;
}) {
  return (
    <div className='flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-center'>
      <div className='text-muted-foreground'>{icon}</div>
      <div className='text-sm font-medium'>{title}</div>
      <p className='max-w-56 text-xs text-muted-foreground'>{description}</p>
    </div>
  );
}

function formatInputTokens(tokenUsage: TokenUsage): string {
  return formatNumber(
    tokenUsage.input_other + tokenUsage.input_cache_read + tokenUsage.input_cache_creation,
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact' }).format(value);
}
