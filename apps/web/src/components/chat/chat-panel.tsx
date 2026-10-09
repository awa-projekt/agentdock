import { SquarePenIcon } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { Composer } from '@/components/chat/composer';
import { AssistantMessage, UserMessage } from '@/components/chat/messages';
import { SessionMenu } from '@/components/chat/session-menu';
import { Transcript } from '@/components/chat/transcript';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ChatPersistence } from '@/lib/chat/persistence';
import { ChatProvider, useChat } from '@/lib/chat/use-chat';
import { cn } from '@/lib/utils';

export type PromptSuggestion = { readonly label: string; readonly prompt?: string; readonly icon?: ReactNode };

export type ChatPanelProps = {
  /** The agent's A2A base URL. */
  readonly url: string;
  readonly persistence?: ChatPersistence;
  readonly title: string;
  readonly description?: string;
  readonly welcome?: string;
  readonly suggestions?: ReadonlyArray<PromptSuggestion>;
  readonly placeholder?: string;
  readonly className?: string;
};

function ConnectionDot() {
  const { connection } = useChat();
  const label =
    connection.status === 'connected'
      ? `Connected to ${connection.agentName}`
      : connection.status === 'connecting'
        ? 'Connecting…'
        : connection.message;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="status" className="inline-flex size-4 items-center justify-center" aria-label={label} />}
        delay={200}
      >
        <span
          className={cn(
            'size-2 rounded-full',
            connection.status === 'connected' && 'bg-success',
            connection.status === 'connecting' && 'animate-pulse bg-muted-foreground',
            connection.status === 'error' && 'bg-destructive',
          )}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Header({ title, description }: { title: string; description: string | undefined }) {
  const { sessions, sessionsLoading, sessionsError, activeSession, selectSession, deleteSession, newSession } =
    useChat();
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <ConnectionDot />
      <div className="min-w-0 flex-1 leading-tight">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        {description ? <p className="truncate text-[11px] text-muted-foreground">{description}</p> : null}
      </div>
      <SessionMenu
        sessions={sessions}
        loading={sessionsLoading}
        error={sessionsError}
        activeContextId={activeSession?.contextId}
        onSelect={selectSession}
        onDelete={deleteSession}
      />
      <Tooltip>
        <TooltipTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="New chat" onClick={newSession} />}
          delay={300}
        >
          <SquarePenIcon />
        </TooltipTrigger>
        <TooltipContent>New chat</TooltipContent>
      </Tooltip>
    </header>
  );
}

function Welcome({ welcome, suggestions }: { welcome: string; suggestions: ReadonlyArray<PromptSuggestion> }) {
  const { send, connection } = useChat();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 px-6 py-10 text-center">
      <h3 className="text-xl font-medium tracking-tight">{welcome}</h3>
      {suggestions.length > 0 ? (
        <ul className="flex flex-wrap justify-center gap-2">
          {suggestions.map((suggestion) => (
            <li key={suggestion.label}>
              <Button
                variant="outline"
                className="h-8 rounded-full px-3"
                disabled={connection.status !== 'connected'}
                onClick={() => send(suggestion.prompt ?? suggestion.label)}
              >
                {suggestion.icon}
                {suggestion.label}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Body({
  welcome,
  suggestions,
  placeholder,
}: Required<Pick<ChatPanelProps, 'welcome' | 'suggestions' | 'placeholder'>>) {
  const { activeSession, isStreaming, connection, input, setInput, send, cancel } = useChat();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messages = activeSession?.messages ?? [];

  return (
    <>
      {messages.length === 0 ? (
        <Welcome welcome={welcome} suggestions={suggestions} />
      ) : (
        <Transcript>
          {messages.map((message) =>
            message.role === 'user' ? (
              <UserMessage key={message.id} message={message} />
            ) : (
              <AssistantMessage key={message.id} message={message} />
            ),
          )}
        </Transcript>
      )}
      <Composer
        textareaRef={textareaRef}
        value={input}
        onChange={setInput}
        onSubmit={() => send()}
        onStop={cancel}
        streaming={isStreaming}
        disabled={connection.status !== 'connected'}
        placeholder={connection.status === 'error' ? connection.message : placeholder}
      />
    </>
  );
}

/** A complete chat surface for one A2A agent: header, transcript and composer. */
export function ChatPanel({
  url,
  persistence,
  title,
  description,
  welcome = 'How can I help?',
  suggestions = [],
  placeholder = 'Ask anything',
  className,
}: ChatPanelProps) {
  return (
    <ChatProvider url={url} persistence={persistence}>
      <TooltipProvider>
        <section className={cn('flex h-full min-h-0 min-w-0 flex-col bg-background', className)} aria-label={title}>
          <Header title={title} description={description} />
          <Body welcome={welcome} suggestions={suggestions} placeholder={placeholder} />
        </section>
      </TooltipProvider>
    </ChatProvider>
  );
}
