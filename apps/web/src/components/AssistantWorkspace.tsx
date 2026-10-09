import { HOME_INTERNAL_AGENT_ID } from 'agentdock-sdk/schemas';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ChatPanel } from '@/components/chat/chat-panel';
import { agentA2aUrl, chatPersistence } from '@/lib/api';

const SURFACE_WIDTH_STORAGE_KEY = 'agentdock-surface-width';
const DEFAULT_SURFACE_WIDTH = 540;
const MIN_SURFACE_WIDTH = 360;
const MIN_ASSISTANT_WIDTH = 360;
const KEYBOARD_RESIZE_STEP = 24;

type ResizeGesture = {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  readonly previousCursor: string;
  readonly previousUserSelect: string;
};

const readStoredSurfaceWidth = (): number => {
  const stored = window.localStorage.getItem(SURFACE_WIDTH_STORAGE_KEY);
  if (stored === null) return DEFAULT_SURFACE_WIDTH;

  const width = Number(stored);
  return Number.isFinite(width) ? width : DEFAULT_SURFACE_WIDTH;
};

const clampSurfaceWidth = (width: number, containerWidth: number): number => {
  const maximum = Math.max(MIN_SURFACE_WIDTH, Math.floor(containerWidth) - MIN_ASSISTANT_WIDTH);
  return Math.max(MIN_SURFACE_WIDTH, Math.min(maximum, width));
};

export function AssistantWorkspace({ children }: { readonly children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeGestureRef = useRef<ResizeGesture | null>(null);
  const surfaceWidthRef = useRef(DEFAULT_SURFACE_WIDTH);
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  const [surfaceWidth, setSurfaceWidth] = useState(readStoredSurfaceWidth);
  const clampedSurfaceWidth = clampSurfaceWidth(surfaceWidth, containerWidth);
  const maximumSurfaceWidth = Math.max(MIN_SURFACE_WIDTH, containerWidth - MIN_ASSISTANT_WIDTH);
  surfaceWidthRef.current = clampedSurfaceWidth;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => setContainerWidth(container.clientWidth);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const finishResize = () => {
    const gesture = resizeGestureRef.current;
    if (!gesture) return;

    resizeGestureRef.current = null;
    document.documentElement.style.cursor = gesture.previousCursor;
    document.documentElement.style.userSelect = gesture.previousUserSelect;
    window.localStorage.setItem(SURFACE_WIDTH_STORAGE_KEY, String(surfaceWidthRef.current));
  };

  useEffect(() => finishResize, []);

  const resizeSurface = (width: number) => {
    const nextWidth = clampSurfaceWidth(width, containerWidth);
    surfaceWidthRef.current = nextWidth;
    setSurfaceWidth(nextWidth);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: clampedSurfaceWidth,
      previousCursor: document.documentElement.style.cursor,
      previousUserSelect: document.documentElement.style.userSelect,
    };
    document.documentElement.style.cursor = 'col-resize';
    document.documentElement.style.userSelect = 'none';
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = resizeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    resizeSurface(gesture.startWidth - (event.clientX - gesture.startX));
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = resizeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishResize();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? KEYBOARD_RESIZE_STEP * 3 : KEYBOARD_RESIZE_STEP;
    const nextWidth =
      event.key === 'ArrowLeft'
        ? clampedSurfaceWidth + step
        : event.key === 'ArrowRight'
          ? clampedSurfaceWidth - step
          : event.key === 'Home'
            ? MIN_SURFACE_WIDTH
            : event.key === 'End'
              ? maximumSurfaceWidth
              : null;

    if (nextWidth === null) return;
    event.preventDefault();
    resizeSurface(nextWidth);
    window.localStorage.setItem(SURFACE_WIDTH_STORAGE_KEY, String(surfaceWidthRef.current));
  };

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <AssistantPane />
      <section
        aria-label="Workspace page"
        className="relative h-full min-h-0 max-w-full shrink-0 border-l border-border bg-background"
        style={{ width: clampedSurfaceWidth }}
      >
        <hr
          aria-label="Resize workspace page"
          aria-orientation="vertical"
          aria-valuemin={MIN_SURFACE_WIDTH}
          aria-valuemax={maximumSurfaceWidth}
          aria-valuenow={Math.round(clampedSurfaceWidth)}
          tabIndex={0}
          className="absolute inset-y-0 -left-1 z-20 m-0 h-full w-2 cursor-col-resize touch-none select-none border-0 bg-transparent outline-none before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors hover:before:bg-border focus-visible:before:bg-ring active:before:bg-primary/60"
          onDoubleClick={() => {
            resizeSurface(DEFAULT_SURFACE_WIDTH);
            window.localStorage.removeItem(SURFACE_WIDTH_STORAGE_KEY);
          }}
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onLostPointerCapture={finishResize}
        />
        <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">{children}</div>
      </section>
    </div>
  );
}

const assistantPersistence = chatPersistence(HOME_INTERNAL_AGENT_ID);
const assistantUrl = agentA2aUrl(HOME_INTERNAL_AGENT_ID);

function AssistantPane() {
  return (
    <aside aria-label="Agentdock Assistant" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <ChatPanel
        url={assistantUrl}
        persistence={assistantPersistence}
        title="Agentdock Assistant"
        description="Your internal assistant for this Agentdock instance."
        suggestions={[
          { label: 'What agents are configured?' },
          { label: 'Show recent failed runs' },
          { label: 'Create a new agent' },
        ]}
      />
    </aside>
  );
}
